/**
 * Deterministic event processing: FIFO ordering, queue recovery, error propagation and the
 * guarantee that concurrent submissions never commit against stale state.
 */

import { describe, expect, it, vi } from "vitest";
import { QueueOverflowError, createMachine } from "../src/index.js";
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

describe("queue depth", () => {
  /**
   * A machine whose only event is gated: every submission stays pending until the gate settles,
   * which lets a test hold the queue open and observe the depth exactly.
   */
  const gatedMachine = (maxQueueDepth: number) => {
    const gate = deferred<boolean>();
    const machine = createMachine(
      {
        id: "gated",
        initial: "idle",
        context: { ticks: 0 },
        states: {
          idle: {
            on: {
              TICK: {
                guard: () => gate.promise,
                actions: [
                  ({ context }) => {
                    context.ticks += 1;
                  },
                ],
              },
            },
          },
        },
      },
      { maxQueueDepth },
    );

    return { machine, gate };
  };

  it("accepts submissions up to the configured depth", async () => {
    const { machine, gate } = gatedMachine(2);

    const first = machine.send("TICK");
    const second = machine.send("TICK");

    await expect(machine.send("TICK")).rejects.toBeInstanceOf(QueueOverflowError);

    gate.resolve(true);
    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(second).resolves.toMatchObject({ revision: 2 });
    expect(machine.context).toEqual({ ticks: 2 });
  });

  it("refuses without queueing, so a refused submission never runs", async () => {
    const { machine, gate } = gatedMachine(2);

    const first = machine.send("TICK");
    const second = machine.send("TICK");
    const refused = machine.send("TICK");

    await expect(refused).rejects.toBeInstanceOf(QueueOverflowError);

    gate.resolve(true);
    await Promise.all([first, second]);
    await machine.whenIdle();

    // Two events ran, not three.
    expect(machine.context).toEqual({ ticks: 2 });
    expect(machine.snapshot().revision).toBe(2);
  });

  it("counts the running submission against the cap", async () => {
    const { machine, gate } = gatedMachine(1);

    const running = machine.send("TICK");
    await expect(machine.can("TICK")).rejects.toBeInstanceOf(QueueOverflowError);

    gate.resolve(true);
    await running;

    // The slot is free again once the queue drains.
    await expect(machine.can("TICK")).resolves.toBe(true);
  });

  it("counts queued reads and restores the same as queued events", async () => {
    const { machine, gate } = gatedMachine(2);

    const check = machine.can("TICK");
    const restored = machine.restore(machine.snapshot());

    await expect(machine.send("TICK")).rejects.toBeInstanceOf(QueueOverflowError);

    gate.resolve(true);
    await expect(check).resolves.toBe(true);
    await expect(restored).resolves.toMatchObject({ state: "idle", revision: 0 });
  });

  it("leaves the queue unbounded when the option is absent", async () => {
    const machine = createMachine({
      id: "unbounded",
      initial: "idle",
      context: {},
      states: { idle: { on: { TICK: {} } } },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => machine.send("TICK")),
    );

    expect(results).toHaveLength(50);
    expect(machine.snapshot().revision).toBe(50);
  });
});
