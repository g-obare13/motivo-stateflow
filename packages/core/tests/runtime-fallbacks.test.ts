/**
 * Runtime fallbacks and error-rendering robustness.
 *
 * These paths only run in unusual conditions: a runtime without `structuredClone`, and values
 * whose own methods throw while an error message is being built. They are pinned here because a
 * library must not fail while reporting a failure, and because the JSON fallback is documented
 * behaviour that older runtimes depend on.
 */

import { describe, expect, it } from "vitest";
import { createMachine, InvalidEventError, SnapshotValidationError } from "../src/index.js";

/** Runs a callback with `structuredClone` unavailable, restoring it afterwards. */
const withoutStructuredClone = async <T>(run: () => T | Promise<T>): Promise<T> => {
  const original = globalThis.structuredClone;
  const host = globalThis as unknown as { structuredClone: typeof original | undefined };
  host.structuredClone = undefined;
  try {
    return await run();
  } finally {
    host.structuredClone = original;
  }
};

/** A value whose own string conversion throws, to prove messages never blow up. */
const hostile = {
  toString: () => {
    throw new Error("toString is not available");
  },
};

describe("runtimes without structuredClone", () => {
  it("creates, transitions, snapshots and restores through the JSON fallback", async () => {
    await withoutStructuredClone(async () => {
      const machine = createMachine({
        id: "order",
        initial: "pending",
        context: { orderId: "order_123", attempts: 0 },
        states: {
          pending: {
            on: {
              CONFIRM: {
                target: "confirmed",
                actions: [
                  ({ context }) => {
                    context.attempts += 1;
                  },
                ],
              },
            },
          },
          confirmed: {},
        },
      });

      expect(machine.state).toBe("pending");

      const committed = await machine.send("CONFIRM");
      expect(committed).toMatchObject({ state: "confirmed", previous: "pending", revision: 1 });
      expect(machine.context).toEqual({ orderId: "order_123", attempts: 1 });

      // Callers still receive independent clones.
      const snapshot = machine.snapshot();
      snapshot.context.attempts = 99;
      expect(machine.context.attempts).toBe(1);

      await expect(
        machine.restore({ id: "order", state: "pending", context: { orderId: "x", attempts: 7 } }),
      ).resolves.toMatchObject({ state: "pending", context: { attempts: 7 } });
    });
  });

  it("narrows what a context can carry, because JSON cannot represent every value", async () => {
    await withoutStructuredClone(async () => {
      const machine = createMachine({
        id: "report",
        initial: "open",
        context: { generatedAt: new Date("2020-01-01T00:00:00.000Z") },
        states: { open: {} },
      });

      // A Date survives structuredClone but not JSON, which is why `parseContext` exists.
      expect(typeof machine.context.generatedAt).toBe("string");
    });
  });

  it("propagates the raw failure when no clone handler is configured", async () => {
    const machine = createMachine({
      id: "counter",
      initial: "counting",
      context: { total: 1n },
      states: { counting: {} },
    });

    await withoutStructuredClone(async () => {
      // Reading the context clones it; JSON cannot serialise a BigInt, and this call site has no
      // custom handler, so the original error surfaces unchanged.
      expect(() => machine.context).toThrow(TypeError);
    });

    // With structuredClone back, the same machine reads normally again.
    expect(machine.context).toEqual({ total: 1n });
  });
});

describe("error message rendering", () => {
  it("renders a value whose string conversion throws, instead of failing", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: { pending: {} },
    });

    const outcome = await machine
      .send(hostile as never)
      .then(() => null, (error: unknown) => error as Error);

    expect(outcome).toBeInstanceOf(InvalidEventError);
    expect(outcome?.message).toContain("[object Object]");
  });

  it("renders a snapshot field whose string conversion throws", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: { pending: {} },
    });

    const outcome = await machine
      .restore({ id: hostile, state: "pending", context: {} })
      .then(() => null, (error: unknown) => error as Error);

    expect(outcome).toBeInstanceOf(SnapshotValidationError);
    expect(outcome?.message).toContain("[object Object]");
  });
});
