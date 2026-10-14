/**
 * Regression coverage for defects that were reported against the initial implementation.
 *
 * Each test names the reported symptom and asserts the corrected behaviour, so a re-introduction
 * of any of these defects fails the suite.
 */

import { describe, expect, it, vi } from "vitest";
import { createMachine, MachineConfigurationError } from "../src/index.js";
import { asEvent, createLooseMachine, deferred } from "./helpers.js";

describe("reported defects", () => {
  it("does not resolve prototype members as transitions", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { CONFIRM: "confirmed" } },
        confirmed: {},
      },
    });

    for (const event of ["toString", "constructor", "valueOf", "__proto__"]) {
      await expect(machine.send(asEvent<"CONFIRM">(event))).rejects.toMatchObject({
        name: "InvalidEventError",
      });
    }
    expect(machine.state).toBe("pending");
  });

  it("rejects prototype members as transition targets at creation time", () => {
    expect(() =>
      createMachine({
        id: "order",
        initial: "pending",
        context: {},
        states: {
          pending: { on: { CONFIRM: "toString" } },
        },
      } as never),
    ).toThrow(MachineConfigurationError);
  });

  it("rejects undeclared targets at creation time instead of at runtime", () => {
    expect(() =>
      createLooseMachine({
        id: "order",
        initial: "pending",
        context: {},
        states: {
          pending: { on: { CONFIRM: { target: "confirmed" } } },
        },
      }),
    ).toThrow(MachineConfigurationError);
  });

  it("does not commit or notify when an entry action fails", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { value: 1 },
      states: {
        pending: { on: { CONFIRM: "confirmed" } },
        confirmed: {
          entry: [
            () => {
              throw new Error("entry failed");
            },
          ],
        },
      },
    });
    const listener = vi.fn();
    machine.subscribe(listener);

    const outcome = await machine.send("CONFIRM").then(
      () => "committed",
      (error: unknown) => (error as Error).message,
    );

    expect(outcome).toBe("entry failed");
    expect(machine.state).toBe("pending");
    expect(machine.context).toEqual({ value: 1 });
    expect(machine.snapshot().revision).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("lets each subscription of the same function be removed independently", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { CONFIRM: "confirmed" } },
        confirmed: { on: { RESET: "pending" } },
      },
    });
    const listener = vi.fn();

    const first = machine.subscribe(listener);
    machine.subscribe(listener);

    await machine.send("CONFIRM");
    expect(listener).toHaveBeenCalledTimes(2);

    first();
    await machine.send("RESET");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("serialises restoration with queued events", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { value: 1 },
      states: {
        pending: { on: { CONFIRM: { target: "confirmed", guard: () => gate.promise } } },
        confirmed: {},
      },
    });

    const transition = machine.send("CONFIRM");
    const restoration = machine.restore({ id: "order", state: "pending", context: { value: 2 } });

    expect(machine.state).toBe("pending");

    gate.resolve(true);
    await transition;
    await restoration;

    expect(machine.snapshot().revision).toBe(1);
    expect(machine.context).toEqual({ value: 2 });
  });
});
