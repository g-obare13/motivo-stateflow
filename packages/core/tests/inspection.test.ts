/**
 * Inspection helpers: `getNextEvents()` for the structural list of events a state declares, and
 * `can()` for a guard-aware answer that commits nothing.
 *
 * Both helpers are read-only views of the engine. `getNextEvents()` is synchronous and reports
 * what the state declares, while `can()` is queued and evaluates the guard exactly as `send()`
 * would, which is what makes it safe to use as a gate in front of `send()`.
 */

import { describe, expect, it } from "vitest";
import { InvalidEventError } from "../src/index.js";
import { createMachine } from "../src/index.js";
import { asEvent, deferred } from "./helpers.js";

const orderMachine = () =>
  createMachine({
    id: "order",
    initial: "pending",
    context: { attempts: 0 },
    states: {
      pending: { on: { CONFIRM: "confirmed", CANCEL: "cancelled" } },
      confirmed: { on: { SHIP: "shipped" } },
      cancelled: {},
      shipped: {},
    },
  });

describe("getNextEvents()", () => {
  it("lists the events the committed state declares, in declaration order", () => {
    const machine = orderMachine();

    expect(machine.getNextEvents()).toEqual(["CONFIRM", "CANCEL"]);
  });

  it("follows the committed state as it changes", async () => {
    const machine = orderMachine();

    await machine.send("CONFIRM");
    expect(machine.getNextEvents()).toEqual(["SHIP"]);

    await machine.send("SHIP");
    expect(machine.getNextEvents()).toEqual([]);
  });

  it("returns an empty list for a state that declares no events", () => {
    const machine = createMachine({
      id: "single",
      initial: "only",
      context: {},
      states: { only: {} },
    });

    expect(machine.getNextEvents()).toEqual([]);
    expect(machine.snapshot().done).toBe(true);
  });

  it("returns a fresh array that cannot be used to reach machine internals", () => {
    const machine = orderMachine();
    const events: string[] = machine.getNextEvents();

    events.push("INJECTED");
    events.length = 0;

    expect(machine.getNextEvents()).toEqual(["CONFIRM", "CANCEL"]);
  });

  it("reports declaration, not guard outcomes", async () => {
    const machine = createMachine({
      id: "gated",
      initial: "locked",
      context: {},
      states: {
        locked: {
          on: { OPEN: { target: "open", guard: () => false } },
        },
        open: {},
      },
    });

    expect(machine.getNextEvents()).toEqual(["OPEN"]);
    expect(await machine.can("OPEN")).toBe(false);
  });

  it("lists explicitly declared prototype-named events", () => {
    const machine = createMachine({
      id: "prototype",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { toString: "done", valueOf: "done" } },
        done: {},
      },
    });

    expect(machine.getNextEvents()).toEqual(["toString", "valueOf"]);
  });

  it("reads the committed state without waiting for queued events", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "queued",
      initial: "off",
      context: {},
      states: {
        off: { on: { START: { target: "on", guard: () => gate.promise } } },
        on: { on: { STOP: "off" } },
      },
    });

    const send = machine.send("START");
    expect(machine.getNextEvents()).toEqual(["START"]);

    gate.resolve(true);
    await send;
    expect(machine.getNextEvents()).toEqual(["STOP"]);
    expect(machine.state).toBe("on");
  });
});

describe("can()", () => {
  it("resolves true for a declared event with no guard", async () => {
    const machine = orderMachine();

    await expect(machine.can("CONFIRM")).resolves.toBe(true);
    // Asking does not consume the event.
    await expect(machine.send("CONFIRM")).resolves.toMatchObject({ state: "confirmed" });
  });

  it("resolves false for an event the committed state does not declare", async () => {
    const machine = orderMachine();
    await machine.send("CONFIRM");

    // CANCEL is declared by "pending", which is no longer the committed state.
    await expect(machine.can("CANCEL")).resolves.toBe(false);
    await expect(machine.can("SHIP")).resolves.toBe(true);
  });

  it("resolves false for an event no state declares, instead of throwing", async () => {
    const machine = orderMachine();

    await expect(machine.can(asEvent("MONITOR"))).resolves.toBe(false);
    expect(machine.snapshot().revision).toBe(0);
  });

  it("rejects a non-string event the way send() does", async () => {
    const machine = orderMachine();

    await expect(machine.can(42 as unknown as "CONFIRM")).rejects.toBeInstanceOf(InvalidEventError);
  });

  it("evaluates a synchronous guard against the committed context", async () => {
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: { authorised: false },
      states: {
        pending: {
          on: {
            AUTHORISE: {
              actions: [
                ({ context }) => {
                  context.authorised = true;
                },
              ],
            },
            PAY: { target: "paid", guard: ({ context }) => context.authorised },
          },
        },
        paid: {},
      },
    });

    await expect(machine.can("PAY")).resolves.toBe(false);

    await machine.send("AUTHORISE");
    await expect(machine.can("PAY")).resolves.toBe(true);
    expect(machine.state).toBe("pending");
  });

  it("awaits an asynchronous guard", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "async-guard",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { GO: { target: "running", guard: () => gate.promise } } },
        running: {},
      },
    });

    const answer = machine.can("GO");
    gate.resolve(true);

    await expect(answer).resolves.toBe(true);
    expect(machine.state).toBe("idle");
  });

  it("rejects with the original error when a guard throws", async () => {
    const failure = new Error("guard exploded");
    const machine = createMachine({
      id: "throwing",
      initial: "idle",
      context: {},
      states: {
        idle: {
          on: {
            GO: {
              target: "done",
              guard: () => {
                throw failure;
              },
            },
          },
        },
        done: {},
      },
    });

    await expect(machine.can("GO")).rejects.toBe(failure);
    await expect(machine.send("GO")).rejects.toBe(failure);
    expect(machine.state).toBe("idle");
  });

  it("commits nothing: no revision, no notification, no state change", async () => {
    const machine = orderMachine();
    const observed: string[] = [];
    machine.subscribe((snapshot) => observed.push(snapshot.state));

    await expect(machine.can("CONFIRM")).resolves.toBe(true);

    expect(machine.state).toBe("pending");
    expect(machine.snapshot().revision).toBe(0);
    expect(observed).toEqual([]);
  });

  it("discards context mutations made by a guard", async () => {
    const machine = createMachine({
      id: "mutating",
      initial: "idle",
      context: { probes: 0 },
      states: {
        idle: {
          on: {
            PROBE: {
              guard: ({ context }) => {
                context.probes += 1;
                return true;
              },
            },
          },
        },
      },
    });

    await expect(machine.can("PROBE")).resolves.toBe(true);
    expect(machine.context).toEqual({ probes: 0 });
  });

  it("passes the committed state and the tested event to the guard", async () => {
    const seen: Array<{ state: string; event: string }> = [];
    const machine = createMachine({
      id: "args",
      initial: "a",
      context: {},
      states: {
        a: {
          on: {
            GO: {
              target: "b",
              guard: ({ state, event }) => {
                seen.push({ state, event });
                return true;
              },
            },
          },
        },
        b: {},
      },
    });

    await machine.can("GO");
    expect(seen).toEqual([{ state: "a", event: "GO" }]);
  });

  it("evaluates the transition as it would run after queued events settle", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "queued-can",
      initial: "off",
      context: {},
      states: {
        off: { on: { TOGGLE: { target: "on", guard: () => gate.promise } } },
        on: { on: { TOGGLE: "off" } },
      },
    });

    const send = machine.send("TOGGLE");
    const queued = machine.can("TOGGLE");
    gate.resolve(true);

    await send;
    // By the time the queued check runs, "on" is committed, so its own transition is what the
    // answer describes.
    await expect(queued).resolves.toBe(true);
    expect(machine.state).toBe("on");
  });

  it("keeps the queue flowing after a rejected check", async () => {
    const failure = new Error("nope");
    const machine = createMachine({
      id: "recovery",
      initial: "idle",
      context: {},
      states: {
        idle: {
          on: {
            BREAK: {
              target: "done",
              guard: () => {
                throw failure;
              },
            },
            STAY: {},
          },
        },
        done: {},
      },
    });

    await expect(machine.can("BREAK")).rejects.toBe(failure);
    await expect(machine.can("STAY")).resolves.toBe(true);
    await expect(machine.send("STAY")).resolves.toMatchObject({ state: "idle" });
  });

  it("counts as pending work for whenIdle()", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "idle-check",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { GO: { target: "done", guard: () => gate.promise } } },
        done: {},
      },
    });

    let settled = false;
    const pending = machine.can("GO").then((answer) => {
      settled = true;
      return answer;
    });
    const idle = machine.whenIdle().then(() => settled);

    gate.resolve(true);

    await expect(pending).resolves.toBe(true);
    await expect(idle).resolves.toBe(true);
  });
});
