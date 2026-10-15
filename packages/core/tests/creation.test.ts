/**
 * Machine creation and definition validation.
 *
 * Configuration problems must surface at creation time, never during event processing.
 */

import { describe, expect, it } from "vitest";
import {
  createMachine,
  GuardRejectedError,
  InvalidEventError,
  InvalidTransitionError,
  MachineConfigurationError,
  QueueOverflowError,
  SnapshotValidationError,
  StateflowError,
  SUPPORTED_SNAPSHOT_VERSIONS,
  UNSUPPORTED_DEFINITION_KEY_CODE,
  UnsupportedDefinitionKeyError,
  UnsupportedSnapshotVersionError,
  UnsupportedTransitionTypeError,
  UNSUPPORTED_SNAPSHOT_VERSION_CODE,
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
      schemaVersion: 2,
      configuration: ["pending"],
      history: {},
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
  const cases: Array<{
    name: string;
    definition: unknown;
    /** The error class the definition must raise; never constructed by the test itself. */
    error: abstract new (...args: never[]) => Error;
  }> = [
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
      name: "target value that is not a state name",
      definition: { id: "m", initial: "a", context: {}, states: { a: { on: { GO: { target: 7 } } } } },
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
    {
      name: "compound state without a declared initial child",
      definition: {
        id: "m",
        initial: "a",
        context: {},
        states: { a: { initial: "ghost", states: { b: {} } } },
      },
      error: MachineConfigurationError,
    },
    {
      name: "top-level on",
      definition: { id: "m", initial: "a", context: {}, on: { GO: "a" }, states: { a: {} } },
      error: UnsupportedDefinitionKeyError,
    },
    {
      // A number that happens to be a key: the guard has to reject it by type, not only by lookup.
      name: "initial state that is not a string but is a key",
      definition: { id: "m", initial: 7, context: {}, states: { "7": {} } },
      error: MachineConfigurationError,
    },
    {
      name: "compound initial that is not a string but is a key",
      definition: {
        id: "m",
        initial: "a",
        context: {},
        states: { a: { initial: 7, states: { "7": {} } } },
      },
      error: MachineConfigurationError,
    },
  ];

  /** Runs a definition the compiler rejects and returns the error it raised. */
  const caught = (definition: unknown): unknown => {
    try {
      createLooseMachine(definition);
    } catch (error) {
      return error;
    }
    throw new Error("expected the definition to be refused");
  };

  it.each(cases)("rejects $name", ({ definition, error, name }) => {
    expect(caught(definition), name).toBeInstanceOf(error);
    expect(caught(definition), name).toBeInstanceOf(MachineConfigurationError);
  });

  /**
   * The message fragment each rejected definition must produce.
   *
   * Asserting the error class alone lets an individual validation stop firing unnoticed, because a
   * later check usually raises the same class; the fragment pins the check that has to reject it.
   */
  const messages: Record<string, RegExp> = {
    "missing id": /non-empty string "id"/,
    "blank id": /non-empty string "id"/,
    "missing states": /must declare a "states" object/,
    "empty states": /must declare at least one state/,
    "states that are not an object": /must declare a "states" object/,
    "state definition that is not an object": /must be a plain object/,
    "context that is not an object": /context must be a plain object/,
    "context that cannot be cloned": /must be structured-cloneable/,
    "initial state that is not declared": /initial state "missing" is not declared/,
    "initial state that is a prototype member": /initial state "toString" is not declared/,
    "string target that is not declared": /targets undeclared state "nope"/,
    "object target that is not declared": /targets undeclared state "nope"/,
    "target that is a prototype member": /targets undeclared state "hasOwnProperty"/,
    "non-string target": /must be a state name or a transition object/,
    "target value that is not a state name": /targets 7, which is not a state name/,
    "guard that is not a function": /has an invalid "guard"/,
    "actions that are not functions": /has an invalid "actions"/,
    "entry hooks that are not an array": /has an invalid "entry" hook/,
    "exit hooks that contain a non-function": /has an invalid "exit" hook/,
    "on map that is not an object": /has an invalid "on" map/,
    "transition that is neither a string nor an object": /must be a state name or a transition object/,
    "compound state without a declared initial child": /must declare an "initial" child state/,
    "top-level on": /transitions belong to states/,
    "initial state that is not a string but is a key": /initial state 7 is not declared/,
    "compound initial that is not a string but is a key": /must declare an "initial" child state, but 7 is not one of its states/,
  };

  it.each(cases)("rejects $name for the reason it reports", ({ definition, name }) => {
    const message = messages[name];
    expect(message, `a message fragment declared for "${name}"`).toBeDefined();
    expect(() => createLooseMachine(definition), name).toThrow(message as RegExp);
  });

  it("declares a message fragment for every rejected definition", () => {
    expect(Object.keys(messages).sort()).toEqual(cases.map((entry) => entry.name).sort());
  });

  it("rejects a top-level on with a stable code and the offending key", () => {
    const failure = (() => {
      try {
        createLooseMachine({
          id: "top-level-on",
          initial: "a",
          context: {},
          on: { GO: "a" },
          states: { a: {} },
        });
        return undefined;
      } catch (error) {
        return error as UnsupportedDefinitionKeyError;
      }
    })();

    expect(failure).toBeInstanceOf(UnsupportedDefinitionKeyError);
    expect(failure).toBeInstanceOf(MachineConfigurationError);
    expect(failure?.code).toBe(UNSUPPORTED_DEFINITION_KEY_CODE);
    expect(failure?.code).toBe("ERR_UNSUPPORTED_DEFINITION_KEY");
    expect(failure?.key).toBe("on");

    // The field has to be absent, not merely falsy: `on: undefined` is what an optional field
    // evaluates to when a caller spreads a definition together.
    expect(() =>
      createLooseMachine({
        id: "no-on",
        initial: "a",
        context: {},
        on: undefined,
        states: { a: {} },
      }),
    ).not.toThrow();
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

  it("names every error class, so logs and stack traces identify the failure", () => {
    // The `name` field is part of the published surface, so it is asserted literally.
    const errors: Array<[Error, string]> = [
      [new StateflowError("message"), "StateflowError"],
      [new MachineConfigurationError("message"), "MachineConfigurationError"],
      [new UnsupportedTransitionTypeError("message"), "UnsupportedTransitionTypeError"],
      [new InvalidEventError("message"), "InvalidEventError"],
      [new InvalidTransitionError("message"), "InvalidTransitionError"],
      [new GuardRejectedError("message"), "GuardRejectedError"],
      [new QueueOverflowError("message"), "QueueOverflowError"],
      [new SnapshotValidationError("message"), "SnapshotValidationError"],
      [
        new UnsupportedSnapshotVersionError("message", 9, SUPPORTED_SNAPSHOT_VERSIONS),
        "UnsupportedSnapshotVersionError",
      ],
      [new UnsupportedDefinitionKeyError("message", "on"), "UnsupportedDefinitionKeyError"],
    ];

    for (const [error, name] of errors) {
      expect(error, name).toHaveProperty("name", name);
      expect(error, name).toBeInstanceOf(StateflowError);
    }
  });

  it("publishes a literal version code and the versions it reads", () => {
    // Asserting the literal keeps the code stable for consumers that switch on it.
    expect(UNSUPPORTED_SNAPSHOT_VERSION_CODE).toBe("ERR_UNSUPPORTED_SNAPSHOT_VERSION");
    expect(SUPPORTED_SNAPSHOT_VERSIONS).toEqual([1, 2]);
  });
});
