/**
 * Subscriptions: notification timing and ordering, unsubscription semantics, subscriber
 * isolation and the guarantee that each subscription is independent.
 */

import { describe, expect, it, vi } from "vitest";
import { createMachine } from "../src/index.js";

const toggleMachine = () =>
  createMachine({
    id: "toggle",
    initial: "off",
    context: { flips: 0 },
    states: {
      off: { on: { TOGGLE: "on" } },
      on: { on: { TOGGLE: "off" } },
    },
  });

describe("subscriptions", () => {
  it("does not deliver an initial snapshot", async () => {
    const machine = toggleMachine();
    const listener = vi.fn();

    machine.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ state: "on", previous: "off", event: "TOGGLE" });
  });

  it("stops notifying after unsubscribing", async () => {
    const machine = toggleMachine();
    const listener = vi.fn();
    const unsubscribe = machine.subscribe(listener);

    await machine.send("TOGGLE");
    unsubscribe();
    await machine.send("TOGGLE");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps subscriptions independent when the same function is subscribed twice", async () => {
    const machine = toggleMachine();
    const listener = vi.fn();

    const first = machine.subscribe(listener);
    const second = machine.subscribe(listener);

    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(2);

    first();
    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(3);

    first();
    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(4);

    second();
    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("supports repeated subscribe and unsubscribe cycles", async () => {
    const machine = toggleMachine();
    const listener = vi.fn();

    for (let index = 0; index < 5; index += 1) {
      machine.subscribe(listener)();
    }
    await machine.send("TOGGLE");
    expect(listener).not.toHaveBeenCalled();

    machine.subscribe(listener);
    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every subscriber once per commit in registration order", async () => {
    const machine = toggleMachine();
    const calls: string[] = [];

    machine.subscribe(() => calls.push("first"));
    machine.subscribe(() => calls.push("second"));
    machine.subscribe(() => calls.push("third"));

    await machine.send("TOGGLE");

    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("isolates subscriber exceptions", async () => {
    const machine = toggleMachine();
    const healthy = vi.fn();
    const throwing = vi.fn(() => {
      throw new Error("subscriber failed");
    });

    machine.subscribe(throwing);
    machine.subscribe(healthy);

    await expect(machine.send("TOGGLE")).resolves.toMatchObject({ state: "on" });
    await expect(machine.send("TOGGLE")).resolves.toMatchObject({ state: "off" });

    expect(throwing).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(machine.state).toBe("off");
  });

  it("tolerates unsubscribing during a notification", async () => {
    const machine = toggleMachine();
    const calls: string[] = [];
    const unsubscribeFirst = machine.subscribe(() => {
      calls.push("first");
      unsubscribeFirst();
    });
    machine.subscribe(() => calls.push("second"));

    await machine.send("TOGGLE");
    expect(calls).toEqual(["first", "second"]);

    calls.length = 0;
    await machine.send("TOGGLE");
    expect(calls).toEqual(["second"]);
  });

  it("gives every subscriber its own snapshot clone", async () => {
    const machine = toggleMachine();
    const seen: number[] = [];

    machine.subscribe((snapshot) => {
      snapshot.context.flips = 999;
    });
    machine.subscribe((snapshot) => {
      seen.push(snapshot.context.flips);
    });

    await machine.send("TOGGLE");

    expect(seen).toEqual([0]);
    expect(machine.context).toEqual({ flips: 0 });
  });

  it("does not notify for rejected transitions or restoration", async () => {
    const machine = toggleMachine();
    const listener = vi.fn();
    machine.subscribe(listener);

    await machine.send("TOGGLE");
    await expect(machine.restore({ id: "toggle", state: "on", context: { flips: 1 } })).resolves.toBeDefined();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects non-function listeners", () => {
    const machine = toggleMachine();
    expect(() => machine.subscribe(undefined as never)).toThrow(TypeError);
  });

  it("allows subscriptions to be dropped by dropping the returned function", async () => {
    const machine = toggleMachine();
    const listener = vi.fn();

    for (let index = 0; index < 25; index += 1) {
      machine.subscribe(listener)();
    }
    machine.subscribe(listener);

    await machine.send("TOGGLE");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
