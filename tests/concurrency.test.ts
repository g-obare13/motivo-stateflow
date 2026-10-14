/**
 * Deterministic event processing: FIFO ordering, queue recovery, error propagation and the
 * guarantee that concurrent submissions never commit against stale state.
 */

import { describe, expect, it, vi } from "vitest";
import { createMachine } from "../src/index.js";
import { asEvent, deferred } from "./helpers.js";

const toggleMachine = () =>
  createMachine({
    id: "toggle",
    initial: "off",
    context: { flips: 0 },
    states: {
      off: {
        on: {
          TOGGLE: {
            target: "on",
            actions: [({ context }) => {
              context.flips += 1;
            }],
          },
        },
      },
      on: {
        on: {
          TOGGLE: {
            target: "off",
            actions: [({ context }) => {
              context.flips += 1;
            }],
          },
        },
      },
    },
  });

describe("FIFO processing", () => {
  it("processes concurrent submissions in submission order", async () => {
    const machine = toggleMachine();
    const observed: string[] = [];
    machine.subscribe((snapshot) => observed.push(snapshot.state));

    const results = await Promise.all([
      machine.send("TOGGLE"),
      machine.send("TOGGLE"),
      machine.send("TOGGLE"),
    ]);

    expect(results.map((snapshot) => snapshot.state)).toEqual(["on", "off", "on"]);
    expect(observed).toEqual(["on", "off", "on"]);
    expect(machine.context).toEqual({ flips: 3 });
  });

  it("resolves each caller with the snapshot its own event committed", async () => {
    const machine = toggleMachine();
    const first = machine.send("TOGGLE");
    const second = machine.send("TOGGLE");

    await expect(first).resolves.toMatchObject({ state: "on", previous: "off", revision: 1 });
    await expect(second).resolves.toMatchObject({ state: "off", previous: "on", revision: 2 });
  });

  it("queues events submitted while an action is still executing", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const order: string[] = [];
    const machine = createMachine({
      id: "pipeline",
      initial: "idle",
      context: {},
      states: {
        idle: {
          on: {
            START: {
              target: "running",
              actions: [
                async () => {
                  order.push("start-1");
                  started.resolve();
                  await gate.promise;
                  order.push("end-1");
                },
              ],
            },
          },
        },
        running: {
          on: {
            FINISH: {
              target: "done",
              actions: [() => order.push("start-2")],
            },
          },
        },
        done: {},
      },
    });

    const first = machine.send("START");
    const second = machine.send("FINISH");

    await started.promise;
    expect(order).toEqual(["start-1"]);

    gate.resolve();
    await first;
    await second;

    expect(order).toEqual(["start-1", "end-1", "start-2"]);
    expect(machine.state).toBe("done");
  });

  it("processes long queues without losing events", async () => {
    const machine = toggleMachine();
    const submissions = Array.from({ length: 250 }, () => machine.send("TOGGLE"));

    await Promise.all(submissions);

    expect(machine.state).toBe("off");
    expect(machine.context).toEqual({ flips: 250 });
    expect(machine.snapshot().revision).toBe(250);
  });
});

describe("queue recovery", () => {
  it("rejects only the caller whose event failed and keeps later events running", async () => {
    const failure = new Error("boom");
    const machine = createMachine({
      id: "pipeline",
      initial: "idle",
      context: {},
      states: {
        idle: {
          on: {
            FAIL: {
              target: "running",
              actions: [
                () => {
                  throw failure;
                },
              ],
            },
            SKIP: "skipped",
          },
        },
        running: {},
        skipped: {},
      },
    });

    const failing = machine.send("FAIL");
    const succeeding = machine.send(asEvent<"SKIP" | "FAIL">("SKIP"));

    await expect(failing).rejects.toBe(failure);
    await expect(succeeding).resolves.toMatchObject({ state: "skipped" });
    expect(machine.state).toBe("skipped");
  });

  it("recovers after a rejected guard", async () => {
    const machine = createMachine({
      id: "gate",
      initial: "closed",
      context: {},
      states: {
        closed: {
          on: {
            TRY: { target: "open", guard: async () => false },
            FORCE: "open",
          },
        },
        open: {},
      },
    });

    await expect(machine.send("TRY")).rejects.toThrow(/Guard rejected/);
    await expect(machine.send("FORCE")).resolves.toMatchObject({ state: "open" });
  });

  it("recovers after an unknown event", async () => {
    const machine = toggleMachine();

    await expect(machine.send(asEvent<"TOGGLE">("NOPE"))).rejects.toThrow(/not recognised/);
    await expect(machine.send("TOGGLE")).resolves.toMatchObject({ state: "on" });
    expect(machine.snapshot().revision).toBe(1);
  });
});

describe("whenIdle", () => {
  it("resolves immediately when nothing is pending", async () => {
    await expect(toggleMachine().whenIdle()).resolves.toBeUndefined();
  });

  it("resolves after every submitted event has settled", async () => {
    const machine = toggleMachine();
    const settled = vi.fn();

    machine.send("TOGGLE").then(settled);
    machine.send("TOGGLE").then(settled);
    await machine.whenIdle();

    expect(settled).toHaveBeenCalledTimes(2);
    expect(machine.state).toBe("off");
  });

  it("resolves when the queue only contains failing events", async () => {
    const machine = toggleMachine();
    const rejections: unknown[] = [];

    machine.send(asEvent<"TOGGLE">("NOPE")).catch((error: unknown) => rejections.push(error));
    await machine.whenIdle();

    expect(rejections).toHaveLength(1);
  });
});

describe("notification ordering", () => {
  it("notifies in commit order", async () => {
    const machine = toggleMachine();
    const revisions: number[] = [];
    machine.subscribe((snapshot) => revisions.push(snapshot.revision));

    await Promise.all([machine.send("TOGGLE"), machine.send("TOGGLE")]);

    expect(revisions).toEqual([1, 2]);
  });

  it("notifies before the next queued event starts", async () => {
    const order: string[] = [];
    const machine = createMachine({
      id: "pipeline",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { GO: { target: "running", actions: [() => order.push("action")] } } },
        running: { on: { NEXT: { target: "done", actions: [() => order.push("action-2")] } } },
        done: {},
      },
    });
    machine.subscribe(() => order.push("notify"));

    await Promise.all([machine.send("GO"), machine.send("NEXT")]);

    expect(order).toEqual(["action", "notify", "action-2", "notify"]);
  });
});
