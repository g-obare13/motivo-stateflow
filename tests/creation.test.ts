/**
 * Machine creation and definition validation.
 *
 * Configuration problems must surface at creation time, never during event processing.
 */

import { describe, expect, it } from "vitest";
import {
  createMachine,
  MachineConfigurationError,
  SnapshotValidationError,
} from "../src/index.js";
import { createLooseMachine } from "./helpers.js";

describe("createMachine", () => {
  it("creates a machine that starts in the declared initial state", () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { orderId: "o-1", paymentAuthorized: false },
      states: {
        pending: { on: { CONFIRM: "confirmed" } },
        confirmed: {},
      },
    });

    expect(machine.id).toBe("order");
    expect(machine.state).toBe("pending");
    expect(machine.context).toEqual({ orderId: "o-1", paymentAuthorized: false });
  });

  it("exposes the initial snapshot without a transition", () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { paymentAuthorized: false },
      states: { pending: {} },
    });

    expect(machine.snapshot()).toEqual({
      id: "order",
      state: "pending",
      context: { paymentAuthorized: false },
      event: null,
      previous: null,
      revision: 0,
      done: true,
    });
  });

  it("supports definitions whose state names collide with Object.prototype members", () => {
    const machine = createMachine({
      id: "prototype-names",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { START: "toString" } },
        toString: { on: { STOP: "constructor" } },
        constructor: {},
      },
    });

    expect(machine.state).toBe("idle");
  });

  it("scopes the machine id used in error messages", () => {
    const machine = createMachine({
      id: "special £$ machine",
      initial: "start",
      context: {},
      states: { start: {} },
    });

    expect(machine.id).toBe("special £$ machine");
  });
});

describe("definition validation", () => {
  const cases: Array<{ name: string; definition: unknown; error: new (message: string) => Error }> = [
    {
      name: "missing id",
      definition: { initial: "a", context: {}, states: { a: {} } },
      error: MachineConfigurationError,
    },
    {
      name: "blank id",
      definition: { id: "   ", initial: "a", context: {}, states: { a: {} } },
      error: MachineConfigurationError,
    },
    {
      name: "missing states",
      definition: { id: "m", initial: "a", context: {} },
      error: MachineConfigurationError,
    },
    {
      name: "empty states",
      definition: { id: "m", initial: "a", context: {}, states: {} },
      error: MachineConfigurationError,
    },
    {
      name: "states that are not an object",
      definition: { id: "m", initial: "a", context: {}, states: [] },
      error: MachineConfigurationError,
    },
    {
      name: "state definition that is not an object",
      definition: { id: "m", initial: "a", context: {}, states: { a: null } },
      error: MachineConfigurationError,
    },
    {
      name: "context that is not an object",
      definition: { id: "m", initial: "a", context: 42, states: { a: {} } },
      error: MachineConfigurationError,
    },
    {
      name: "context that cannot be cloned",
      definition: { id: "m", initial: "a", context: { run: () => 1 }, states: { a: {} } },
      error: MachineConfigurationError,
    },
    {
      name: "initial state that is not declared",
      definition: { id: "m", initial: "missing", context: {}, states: { a: {} } },
      error: MachineConfigurationError,
    },
    {
      name: "initial state that is a prototype member",
      definition: { id: "m", initial: "toString", context: {}, states: { a: {} } },
      error: MachineConfigurationError,
    },
    {
      name: "string target that is not declared",
      definition: { id: "m", initial: "a", context: {}, states: { a: { on: { GO: "nope" } } } },
      error: MachineConfigurationError,
    },
    {
      name: "object target that is not declared",
      definition: {
        id: "m",
        initial: "a",
        context: {},
        states: { a: { on: { GO: { target: "nope" } } } },
      },
      error: MachineConfigurationError,
    },
    {
      name: "target that is a prototype member",
      definition: {
        id: "m",
        initial: "a",
        context: {},
        states: { a: { on: { GO: "hasOwnProperty" } } },
      },
      error: MachineConfigurationError,
    },
    {
      name: "non-string target",
      definition: { id: "m", initial: "a", context: {}, states: { a: { on: { GO: 7 } } } },
      error: MachineConfigurationError,
    },
    {
      name: "guard that is not a function",
      definition: {
        id: "m",
        initial: "a",
        context: {},
        states: { a: { on: { GO: { target: "a", guard: true } } } },
      },
      error: MachineConfigurationError,
    },
    {
      name: "actions that are not functions",
      definition: {
        id: "m",
        initial: "a",
        context: {},
        states: { a: { on: { GO: { target: "a", actions: [1] } } } },
      },
      error: MachineConfigurationError,
    },
    {
      name: "entry hooks that are not an array",
      definition: { id: "m", initial: "a", context: {}, states: { a: { entry: () => 1 } } },
      error: MachineConfigurationError,
    },
    {
      name: "exit hooks that contain a non-function",
      definition: { id: "m", initial: "a", context: {}, states: { a: { exit: ["no"] } } },
      error: MachineConfigurationError,
    },
    {
      name: "on map that is not an object",
      definition: { id: "m", initial: "a", context: {}, states: { a: { on: "GO" } } },
      error: MachineConfigurationError,
    },
    {
      name: "transition that is neither a string nor an object",
      definition: { id: "m", initial: "a", context: {}, states: { a: { on: { GO: 3 } } } },
      error: MachineConfigurationError,
    },
  ];

  it.each(cases)("rejects $name", ({ definition, error }) => {
    expect(() => createLooseMachine(definition)).toThrow(error);
    expect(() => createLooseMachine(definition)).toThrow(MachineConfigurationError);
  });

  it("reports the offending target in the message", () => {
    expect(() =>
      createLooseMachine({
        id: "order",
        initial: "pending",
        context: {},
        states: { pending: { on: { CONFIRM: "confirmed" } } },
      }),
    ).toThrow(/"confirmed"/);
  });

  it("keeps SnapshotValidationError distinct from configuration errors", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: { pending: {} },
    });

    await expect(machine.restore(null)).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(machine.restore(null)).rejects.not.toBeInstanceOf(MachineConfigurationError);
  });
});
