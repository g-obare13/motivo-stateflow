/**
 * Actions and lifecycle hooks: execution order, argument shape, asynchronous hooks, failure
 * handling, and atomic context updates.
 */

import { describe, expect, it, vi } from "vitest";
import { createMachine, MachineConfigurationError } from "../src/index.js";
import { deferred } from "./helpers.js";

const stageMachine = (log: string[]) =>
  createMachine({
    id: "order",
    initial: "pending",
    context: { count: 0 },
    states: {
      pending: {
        exit: [({ context }) => log.push(`exit:${context.count}`)],
        on: {
          NEXT: {
            target: "done",
            actions: [({ context }) => log.push(`action:${context.count}`)],
          },
        },
      },
      done: {
        entry: [({ context }) => log.push(`entry:${context.count}`)],
      },
    },
  });

describe("lifecycle ordering", () => {
  it("runs exit hooks, transition actions and entry hooks in that order", async () => {
    const log: string[] = [];
    await stageMachine(log).send("NEXT");

    expect(log).toEqual(["exit:0", "action:0", "entry:0"]);
  });

  it("runs hooks in declaration order and awaits asynchronous hooks", async () => {
    const log: string[] = [];
    const first = deferred<void>();
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: {
          exit: [
            async () => {
              await first.promise;
              log.push("exit-1");
            },
            () => log.push("exit-2"),
          ],
          on: { NEXT: "done" },
        },
        done: {},
      },
    });

    const pending = machine.send("NEXT");
    expect(log).toEqual([]);

    first.resolve();
    await pending;

    expect(log).toEqual(["exit-1", "exit-2"]);
  });

  it("reports the target state and event to entry hooks", async () => {
    const observed: Array<{ state: string; event: string }> = [];
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { NEXT: "done" } },
        done: {
          entry: [({ state, event }) => observed.push({ state, event })],
        },
      },
    });

    await machine.send("NEXT");
    expect(observed).toEqual([{ state: "done", event: "NEXT" }]);
  });

  it("gives exit hooks the state being left", async () => {
    const observed: string[] = [];
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: {
          exit: [({ state }) => observed.push(state)],
          on: { NEXT: "done" },
        },
        done: {},
      },
    });

    await machine.send("NEXT");
    expect(observed).toEqual(["pending"]);
  });
});

describe("context updates", () => {
  it("commits staged context mutations with the transition", async () => {
    const machine = createMachine({
      id: "counter",
      initial: "counting",
      context: { value: 0, history: [] as string[] },
      states: {
        counting: {
          on: {
            BUMP: {
              target: "counting",
              actions: [
                ({ context }) => {
                  context.value += 1;
                  context.history.push("bump");
                },
              ],
            },
          },
        },
      },
    });

    await machine.send("BUMP");
    await machine.send("BUMP");

    expect(machine.context).toEqual({ value: 2, history: ["bump", "bump"] });
  });

  it("discards staged context when a hook throws", async () => {
    const machine = createMachine({
      id: "counter",
      initial: "counting",
      context: { value: 0 },
      states: {
        counting: {
          on: {
            BUMP: {
              target: "counting",
              actions: [
                ({ context }) => {
                  context.value += 1;
                },
                () => {
                  throw new Error("action failed");
                },
              ],
            },
          },
        },
      },
    });

    await expect(machine.send("BUMP")).rejects.toThrow("action failed");
    expect(machine.context).toEqual({ value: 0 });
    expect(machine.state).toBe("counting");
    expect(machine.snapshot().revision).toBe(0);
  });
});

describe("hook failures", () => {
  const failingMachine = (stage: "exit" | "action" | "entry") =>
    createMachine({
      id: "order",
      initial: "pending",
      context: { value: 1 },
      states: {
        pending: {
          exit:
            stage === "exit"
              ? [({ context }) => {
                  context.value = 99;
                  throw new Error("exit failed");
                }]
              : [],
          on: {
            NEXT: {
              target: "done",
              actions:
                stage === "action"
                  ? [({ context }) => {
                      context.value = 99;
                      throw new Error("action failed");
                    }]
                  : [],
            },
          },
        },
        done: {
          entry:
            stage === "entry"
              ? [({ context }) => {
                  context.value = 99;
                  throw new Error("entry failed");
                }]
              : [],
        },
      },
    });

  it.each(["exit", "action", "entry"] as const)(
    "does not commit state, context or revision when a %s hook throws",
    async (stage) => {
      const machine = failingMachine(stage);
      const listener = vi.fn();
      machine.subscribe(listener);

      await expect(machine.send("NEXT")).rejects.toThrow(`${stage} failed`);

      expect(machine.state).toBe("pending");
      expect(machine.context).toEqual({ value: 1 });
      expect(machine.snapshot().revision).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it.each(["exit", "action", "entry"] as const)(
    "keeps processing later events after a %s hook failed",
    async (stage) => {
      let shouldFail = true;
      const fail = () => {
        if (shouldFail) {
          throw new Error(`${stage} failed`);
        }
      };
      const machine = createMachine({
        id: "order",
        initial: "pending",
        context: {},
        states: {
          pending: {
            exit: stage === "exit" ? [fail] : [],
            on: {
              NEXT: {
                target: "done",
                actions: stage === "action" ? [fail] : [],
              },
            },
          },
          done: { entry: stage === "entry" ? [fail] : [] },
        },
      });

      await expect(machine.send("NEXT")).rejects.toThrow(`${stage} failed`);
      expect(machine.state).toBe("pending");

      shouldFail = false;
      await expect(machine.send("NEXT")).resolves.toMatchObject({ state: "done" });

      expect(machine.state).toBe("done");
      expect(machine.snapshot().revision).toBe(1);
    },
  );

  it("propagates a rejected lifecycle promise unchanged", async () => {
    const failure = new Error("async entry failed");
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { NEXT: "done" } },
        done: { entry: [async () => Promise.reject(failure)] },
      },
    });

    await expect(machine.send("NEXT")).rejects.toBe(failure);
    expect(machine.state).toBe("pending");
  });

  it("runs each queued action sequence exactly once", async () => {
    const action = vi.fn();
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { NEXT: { target: "done", actions: [action] } } },
        done: {},
      },
    });

    await Promise.all([machine.send("NEXT"), machine.send("NEXT").catch(() => undefined)]);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("aborts the transition when an action makes the context unclonable", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { value: 1 },
      states: {
        pending: {
          on: {
            NEXT: {
              target: "done",
              actions: [
                ({ context }) => {
                  (context as { value: unknown }).value = () => "not clonable";
                },
              ],
            },
          },
        },
        done: {},
      },
    });

    await expect(machine.send("NEXT")).rejects.toBeInstanceOf(MachineConfigurationError);
    expect(machine.state).toBe("pending");
    expect(machine.context).toEqual({ value: 1 });
  });
});
