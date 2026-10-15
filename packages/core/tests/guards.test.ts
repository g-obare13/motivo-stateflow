/**
 * Guard evaluation: synchronous and asynchronous acceptance and rejection, argument shape, and
 * the guarantee that a rejected or throwing guard never commits.
 */

import { describe, expect, it } from "vitest";
import { createMachine, GuardRejectedError } from "../src/index.js";
import { deferred } from "./helpers.js";

const guardedMachine = () =>
  createMachine({
    id: "payment",
    initial: "pending",
    context: { amount: 100, authorized: false },
    states: {
      pending: {
        on: {
          PAY: {
            target: "paid",
            guard: ({ context }) => context.authorized,
          },
          FORCE: {
            target: "paid",
            guard: async ({ context }) => context.amount > 0,
          },
        },
      },
      paid: { on: { RESET: "pending" } },
    },
  });

describe("guards", () => {
  it("commits when a synchronous guard returns true", async () => {
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: { authorized: true },
      states: {
        pending: { on: { PAY: { target: "paid", guard: ({ context }) => context.authorized } } },
        paid: {},
      },
    });

    await expect(machine.send("PAY")).resolves.toMatchObject({ state: "paid" });
  });

  it("rejects with GuardRejectedError when a synchronous guard returns false", async () => {
    const machine = guardedMachine();
    await expect(machine.send("PAY")).rejects.toBeInstanceOf(GuardRejectedError);
    expect(machine.state).toBe("pending");
    expect(machine.snapshot().revision).toBe(0);
  });

  it("commits when an asynchronous guard resolves true", async () => {
    const machine = guardedMachine();
    await expect(machine.send("FORCE")).resolves.toMatchObject({ state: "paid" });
  });

  it("rejects with GuardRejectedError when an asynchronous guard resolves false", async () => {
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { PAY: { target: "paid", guard: async () => false } } },
        paid: {},
      },
    });

    await expect(machine.send("PAY")).rejects.toBeInstanceOf(GuardRejectedError);
    expect(machine.state).toBe("pending");
  });

  it("propagates a thrown guard error unchanged and commits nothing", async () => {
    const failure = new Error("gateway unreachable");
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: {},
      states: {
        pending: {
          on: {
            PAY: {
              target: "paid",
              guard: () => {
                throw failure;
              },
            },
          },
        },
        paid: {},
      },
    });

    await expect(machine.send("PAY")).rejects.toBe(failure);
    expect(machine.state).toBe("pending");
  });

  it("propagates a rejected guard promise unchanged and commits nothing", async () => {
    const failure = new Error("timeout");
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { PAY: { target: "paid", guard: async () => Promise.reject(failure) } } },
        paid: {},
      },
    });

    await expect(machine.send("PAY")).rejects.toBe(failure);
    expect(machine.state).toBe("pending");
  });

  it("receives the current state, the event and the staged context", async () => {
    const calls: Array<{ state: string; event: string; amount: number }> = [];
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: { amount: 100, authorized: true },
      states: {
        pending: {
          on: {
            PAY: {
              target: "paid",
              guard: ({ state, event, context }) => {
                calls.push({ state, event, amount: context.amount });
                return context.authorized;
              },
            },
          },
        },
        paid: {},
      },
    });

    await machine.send("PAY");
    expect(calls).toEqual([{ state: "pending", event: "PAY", amount: 100 }]);
  });

  it("discards context mutations made by a guard that rejects", async () => {
    const machine = createMachine({
      id: "payment",
      initial: "pending",
      context: { attempts: 0 },
      states: {
        pending: {
          on: {
            PAY: {
              target: "paid",
              guard: ({ context }) => {
                context.attempts += 1;
                return false;
              },
            },
          },
        },
        paid: {},
      },
    });

    await expect(machine.send("PAY")).rejects.toBeInstanceOf(GuardRejectedError);
    expect(machine.context).toEqual({ attempts: 0 });
  });

  it("evaluates each queued event against the state committed by the previous one", async () => {
    const observed: string[] = [];
    const machine = createMachine({
      id: "gate",
      initial: "closed",
      context: {},
      states: {
        closed: { on: { OPEN: "open" } },
        open: {
          on: {
            OPEN: {
              target: "open",
              // Declared in `open`, so this guard can only run in `open`. Recording the state it
              // observes pins that the queued event is evaluated against the state the previous
              // event committed, not the stale one.
              guard: ({ state }) => {
                observed.push(state);
                return false;
              },
            },
          },
        },
      },
    });

    await machine.send("OPEN");
    await expect(machine.send("OPEN")).rejects.toBeInstanceOf(GuardRejectedError);
    expect(machine.state).toBe("open");
    expect(observed).toEqual(["open"]);
  });

  it("does not let a slow guard commit against stale state", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "gate",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { GO: { target: "running", guard: () => gate.promise } } },
        running: { on: { GO: "idle" } },
      },
    });

    const first = machine.send("GO");
    const second = machine.send("GO");
    gate.resolve(true);

    await first;
    await expect(second).resolves.toMatchObject({ state: "idle", previous: "running" });
    expect(machine.state).toBe("idle");
    expect(machine.snapshot().revision).toBe(2);
  });
});
