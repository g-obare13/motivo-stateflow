/**
 * Snapshots, serialization and restoration: validation of restored data, immutability guarantees
 * and the requirement that restoration is never a transition.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMachine,
  MachineConfigurationError,
  migrateSnapshotV1ToV2,
  SnapshotValidationError,
  UNSUPPORTED_SNAPSHOT_VERSION_CODE,
  UnsupportedSnapshotVersionError,
} from "../src/index.js";
import { deferred, createLooseMachine } from "./helpers.js";

const orderMachine = () =>
  createMachine({
    id: "order",
    initial: "pending",
    context: { orderId: "order_123", lines: [{ sku: "a", quantity: 1 }] },
    states: {
      pending: { on: { CONFIRM: "confirmed" } },
      confirmed: { on: { RESET: "pending" } },
    },
  });

describe("snapshots", () => {
  it("captures machine identity, state, context and transition metadata", async () => {
    const machine = orderMachine();
    const initial = machine.snapshot();
    const committed = await machine.send("CONFIRM");

    expect(initial).toMatchObject({
      id: "order",
      state: "pending",
      event: null,
      previous: null,
      revision: 0,
      done: false,
    });
    expect(committed).toMatchObject({
      state: "confirmed",
      event: "CONFIRM",
      previous: "pending",
      revision: 1,
    });
  });

  it("does not expose internal state through the snapshot context", async () => {
    const machine = orderMachine();
    const snapshot = machine.snapshot();

    snapshot.context.orderId = "tampered";
    snapshot.context.lines[0]!.sku = "tampered";

    expect(machine.context.orderId).toBe("order_123");
    expect(machine.context.lines[0]!.sku).toBe("a");
  });

  it("does not expose internal state through the context accessor", () => {
    const machine = orderMachine();
    machine.context.orderId = "tampered";
    expect(machine.snapshot().context.orderId).toBe("order_123");
  });

  it("serialises through JSON.stringify", async () => {
    const machine = orderMachine();
    await machine.send("CONFIRM");

    const parsed: unknown = JSON.parse(JSON.stringify(machine));

    expect(parsed).toMatchObject({ id: "order", state: "confirmed", revision: 1 });
  });
});

describe("restoration", () => {
  it("restores a valid snapshot without running lifecycle hooks", async () => {
    const entryHook = vi.fn();
    const hookMachine = createMachine({
      id: "order",
      initial: "pending",
      context: { orderId: "order_123" },
      states: {
        pending: { on: { CONFIRM: "confirmed" } },
        confirmed: { entry: [entryHook] },
      },
    });

    const restored = await hookMachine.restore({
      id: "order",
      state: "confirmed",
      context: { orderId: "restored" },
    });

    expect(restored).toMatchObject({ state: "confirmed", event: null, previous: null });
    expect(hookMachine.state).toBe("confirmed");
    expect(hookMachine.context).toEqual({ orderId: "restored" });
    expect(entryHook).not.toHaveBeenCalled();
  });

  it("continues processing events after restoration", async () => {
    const machine = orderMachine();

    await machine.restore(machine.snapshot());
    await machine.send("CONFIRM");
    await machine.send("RESET");

    expect(machine.state).toBe("pending");
    expect(machine.snapshot().revision).toBe(2);
  });

  it("round-trips through JSON", async () => {
    const machine = orderMachine();
    await machine.send("CONFIRM");
    const serialised = JSON.parse(JSON.stringify(machine.snapshot())) as unknown;

    const target = orderMachine();
    await target.restore(serialised);

    expect(target.state).toBe("confirmed");
    expect(target.context).toEqual(machine.context);
  });

  it("ignores fields it does not need and keeps its own revision counter", async () => {
    const machine = orderMachine();
    await machine.send("CONFIRM");

    const restored = await machine.restore({
      id: "order",
      state: "pending",
      context: { orderId: "order_123", lines: [] },
      event: "IGNORED",
      previous: "IGNORED",
      revision: 999,
      extra: "ignored",
    });

    expect(restored.state).toBe("pending");
    expect(restored.revision).toBe(1);
  });

  /** Each rejection reports what is wrong with the snapshot, not just that something is. */
  const invalid: Array<{ name: string; snapshot: unknown; message: RegExp }> = [
    { name: "null", snapshot: null, message: /Snapshot must be a plain object/ },
    { name: "undefined", snapshot: undefined, message: /Snapshot must be a plain object/ },
    { name: "a string", snapshot: "order", message: /Snapshot must be a plain object/ },
    { name: "a number", snapshot: 7, message: /Snapshot must be a plain object/ },
    { name: "an array", snapshot: [], message: /Snapshot must be a plain object/ },
    {
      name: "a missing id",
      snapshot: { state: "confirmed", context: {} },
      message: /Snapshot id undefined does not match machine id "order"/,
    },
    {
      name: "a mismatched id",
      snapshot: { id: "other", state: "confirmed", context: {} },
      message: /Snapshot id "other" does not match machine id "order"/,
    },
    {
      name: "a missing state",
      snapshot: { id: "order", context: {} },
      // Without a `state` or a `configuration` there is nothing to activate, so the derived
      // configuration is the first thing that fails.
      message: /Snapshot configuration for machine "order" must name at least one active state/,
    },
    {
      name: "an undeclared state",
      snapshot: { id: "order", state: "ghost", context: {} },
      message: /Snapshot state "ghost" is not declared/,
    },
    {
      name: "a prototype state name",
      snapshot: { id: "order", state: "toString", context: {} },
      message: /Snapshot state "toString" is not declared/,
    },
    {
      name: "a missing context",
      snapshot: { id: "order", state: "confirmed" },
      message: /Snapshot context for machine "order" must be a plain object/,
    },
    {
      name: "a null context",
      snapshot: { id: "order", state: "confirmed", context: null },
      message: /Snapshot context for machine "order" must be a plain object/,
    },
    {
      name: "a primitive context",
      snapshot: { id: "order", state: "confirmed", context: 7 },
      message: /Snapshot context for machine "order" must be a plain object/,
    },
    {
      name: "an unclonable context",
      snapshot: { id: "order", state: "confirmed", context: { run: () => 1 } },
      message: /Snapshot context for machine "order" must be structured-cloneable/,
    },
  ];

  it.each(invalid)("rejects $name", async ({ snapshot, message, name }) => {
    const machine = orderMachine();
    await expect(machine.restore(snapshot), name).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(machine.restore(snapshot), name).rejects.toThrow(message);
  });

  it("leaves the machine untouched when a snapshot is rejected", async () => {
    const machine = orderMachine();
    await machine.send("CONFIRM");

    await expect(machine.restore({ id: "order", state: "ghost", context: {} })).rejects.toBeInstanceOf(
      SnapshotValidationError,
    );

    expect(machine.state).toBe("confirmed");
    expect(machine.context).toEqual({ orderId: "order_123", lines: [{ sku: "a", quantity: 1 }] });
    expect(machine.snapshot().revision).toBe(1);
  });

  it("queues restoration behind pending events", async () => {
    const gate = deferred<boolean>();
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { value: 1 },
      states: {
        pending: {
          on: { CONFIRM: { target: "confirmed", guard: () => gate.promise } },
        },
        confirmed: {},
      },
    });

    const transition = machine.send("CONFIRM");
    const restoration = machine.restore({ id: "order", state: "pending", context: { value: 2 } });

    expect(machine.state).toBe("pending");

    gate.resolve(true);
    await transition;
    await restoration;

    expect(machine.state).toBe("pending");
    expect(machine.context).toEqual({ value: 2 });
    expect(machine.snapshot().revision).toBe(1);
  });
});

describe("snapshot schema version", () => {
  it("stamps the machine's schema version into every snapshot", async () => {
    const machine = createMachine(
      {
        id: "order",
        initial: "pending",
        context: { value: 1 },
        states: { pending: { on: { CONFIRM: "confirmed" } }, confirmed: {} },
      },
      { schemaVersion: 2 },
    );

    expect(machine.snapshot().schemaVersion).toBe(2);
    await expect(machine.send("CONFIRM")).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("rejects a snapshot written by an unknown or future schema version", async () => {
    const machine = createMachine(
      {
        id: "order",
        initial: "pending",
        context: { value: 1 },
        states: { pending: {} },
      },
      { schemaVersion: 2 },
    );

    await expect(
      machine.restore({ id: "order", state: "pending", context: { value: 1 }, schemaVersion: 9 }),
    ).rejects.toBeInstanceOf(UnsupportedSnapshotVersionError);
    expect(machine.context).toEqual({ value: 1 });

    await expect(
      machine.restore({ id: "order", state: "pending", context: { value: 9 }, schemaVersion: 2 }),
    ).resolves.toMatchObject({ schemaVersion: 2, context: { value: 9 } });
  });

  it("accepts a snapshot that predates versioning", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: { value: 1 },
      states: { pending: {} },
    });

    // A 0.1.0 snapshot has no configuration and no history, so it is migrated and the machine
    // reports the current format version from then on.
    await expect(
      machine.restore({ id: "order", state: "pending", context: { value: 4 } }),
    ).resolves.toMatchObject({
      context: { value: 4 },
      schemaVersion: 2,
      configuration: ["pending"],
      history: {},
    });
  });

  it("rejects invalid options at creation time", () => {
    const definition = {
      id: "order",
      initial: "pending",
      context: {},
      states: { pending: {} },
    };

    // Each rejection names the option and the shape it needs, so a check that stops firing is
    // caught by its message rather than only by the class every option shares.
    const rejected: Array<[Record<string, unknown>, RegExp]> = [
      [{ schemaVersion: -1 }, /option "schemaVersion" must be a non-negative integer/],
      [{ schemaVersion: 1.5 }, /option "schemaVersion" must be a non-negative integer/],
      [{ schemaVersion: "1" }, /option "schemaVersion" must be a non-negative integer/],
      [{ parseContext: "nope" }, /option "parseContext" must be a function/],
      [{ maxQueueDepth: 0 }, /option "maxQueueDepth" must be a positive integer/],
      [{ maxQueueDepth: -1 }, /option "maxQueueDepth" must be a positive integer/],
      [{ maxQueueDepth: 2.5 }, /option "maxQueueDepth" must be a positive integer/],
      [{ maxQueueDepth: "2" }, /option "maxQueueDepth" must be a positive integer/],
    ];

    for (const [options, message] of rejected) {
      expect(() => createLooseMachine(definition, options as never), JSON.stringify(options)).toThrow(
        MachineConfigurationError,
      );
      expect(() => createLooseMachine(definition, options as never), JSON.stringify(options)).toThrow(
        message,
      );
    }

    expect(() => createLooseMachine(definition, { schemaVersion: 3 })).not.toThrow();
    expect(() => createLooseMachine(definition, { maxQueueDepth: 1 })).not.toThrow();
    // Zero is a non-negative integer, so it is accepted and stamped into snapshots.
    expect(() => createLooseMachine(definition, { schemaVersion: 0 })).not.toThrow();
    expect(createLooseMachine(definition, { schemaVersion: 0 }).snapshot().schemaVersion).toBe(0);
  });
});

describe("context validation on restore", () => {
  type DatedContext = { when: Date; label: string };

  const createDatedMachine = (parseContext?: (input: unknown) => DatedContext) => {
    const context: DatedContext = { when: new Date("2020-01-01T00:00:00.000Z"), label: "start" };

    return createMachine(
      {
        id: "report",
        initial: "open",
        context,
        states: { open: { on: { CLOSE: "closed" } }, closed: {} },
      },
      parseContext ? { parseContext } : {},
    );
  };

  it("applies the stored context as-is when no validator is configured", async () => {
    const machine = createDatedMachine();

    await machine.restore({
      id: "report",
      state: "open",
      context: { when: "2020-01-01T00:00:00.000Z", label: "restored" },
    });

    // Documented limitation: shape-only validation cannot know the context's static type.
    expect(typeof machine.context.when).toBe("string");
  });

  it("rehydrates values JSON cannot carry when a validator is configured", async () => {
    const parseContext = (input: unknown): DatedContext => {
      const raw = input as { when: string; label: string };
      return { when: new Date(raw.when), label: raw.label };
    };
    const machine = createDatedMachine(parseContext);

    await machine.send("CLOSE");
    const stored = JSON.parse(JSON.stringify(machine.snapshot())) as unknown;

    const resumed = createDatedMachine(parseContext);
    await resumed.restore(stored);

    expect(resumed.context.when).toBeInstanceOf(Date);
    expect(resumed.context.when.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(resumed.state).toBe("closed");
  });

  it("rejects the snapshot and preserves the cause when the validator throws", async () => {
    const failure = new Error("unexpected context shape");
    const machine = createDatedMachine(() => {
      throw failure;
    });

    const outcome = await machine.restore({ id: "report", state: "open", context: { nope: true } })
      .then(
        () => "restored",
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(SnapshotValidationError);
    expect((outcome as SnapshotValidationError).cause).toBe(failure);
    expect(machine.state).toBe("open");
  });

  it("leaves the machine untouched when the validated context is not cloneable", async () => {
    const machine = createDatedMachine(() => ({ when: new Date(0), label: () => "fn" }) as never);

    await expect(
      machine.restore({ id: "report", state: "open", context: { label: "x" } }),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
    expect(machine.state).toBe("open");
  });
});

describe("snapshot format version 2", () => {
  /** The frozen 0.1.0 fixture, captured from the released code before this change. */
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "snapshot-v1.json"), "utf8"),
  ) as {
    machines: {
      order: {
        snapshots: {
          initial: Record<string, unknown>;
          afterSubmit: Record<string, unknown>;
          afterPublish: Record<string, unknown>;
        };
      };
      flat: { snapshots: { initial: Record<string, unknown>; afterStart: Record<string, unknown> } };
    };
  };

  const nestedOrderMachine = () =>
    createMachine({
      id: "order",
      initial: "draft",
      context: { orderId: "order_123", approved: false },
      states: {
        draft: {
          initial: "editing",
          on: { PUBLISH: "published" },
          states: { editing: { on: { SUBMIT: "reviewing" } }, reviewing: {} },
        },
        published: {},
      },
    });

  const flatMachineAgain = () =>
    createMachine({
      id: "flat",
      initial: "idle",
      context: { count: 0 },
      states: { idle: { on: { START: "running" } }, running: { on: { STOP: "idle" } } },
    });

  const historyMachine = () =>
    createMachine({
      id: "history-format",
      initial: "away",
      context: {},
      states: {
        editing: {
          initial: "idle",
          states: {
            idle: {},
            sub: { initial: "s1", states: { s1: {} } },
            hist: { type: "history", history: "deep" },
          },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });

  const restoreError = async (machine: { restore: (input: unknown) => Promise<unknown> }, input: unknown) =>
    machine.restore(input).then(
      () => undefined,
      (error: unknown) => error,
    );

  it("SR2, SR3: restores the frozen 0.1.0 snapshots and reports the current format", async () => {
    const order = nestedOrderMachine();
    await order.restore(fixture.machines.order.snapshots.afterSubmit);

    expect(order.state).toBe("draft.reviewing");
    expect(order.context).toEqual({ orderId: "order_123", approved: false });
    expect(order.snapshot()).toMatchObject({
      schemaVersion: 2,
      configuration: ["draft.reviewing"],
      history: {},
    });

    const flat = flatMachineAgain();
    await flat.restore(fixture.machines.flat.snapshots.afterStart);
    expect(flat.state).toBe("running");
    expect(flat.snapshot().configuration).toEqual(["running"]);
  });

  it("SR3: derives the configuration without mutating the snapshot it is given", () => {
    const stored = { ...fixture.machines.order.snapshots.initial };
    const before = JSON.stringify(stored);

    const migrated = migrateSnapshotV1ToV2(stored);

    expect(migrated.configuration).toEqual(["draft.editing"]);
    expect(migrated.history).toEqual({});
    expect(migrated.schemaVersion).toBe(2);
    // The 0.1.0 fields are carried across untouched.
    expect(migrated.state).toBe("draft.editing");
    expect(migrated.event).toBeNull();
    expect(migrated.previous).toBeNull();
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("SR3: migrates, snapshots and restores repeatedly", async () => {
    const machine = nestedOrderMachine();
    await machine.restore(fixture.machines.order.snapshots.afterPublish);

    const first = JSON.parse(JSON.stringify(machine));
    const again = nestedOrderMachine();
    await again.restore(first);

    expect(JSON.parse(JSON.stringify(again))).toEqual(first);
    expect(again.state).toBe("published");
  });

  it("SR4: refuses a version it does not know, with a stable code and the received version", async () => {
    const machine = nestedOrderMachine();

    const failure = await restoreError(machine, {
      id: "order",
      state: "draft",
      context: {},
      schemaVersion: 9,
    });

    expect(failure).toBeInstanceOf(UnsupportedSnapshotVersionError);
    expect(failure).toBeInstanceOf(SnapshotValidationError);
    expect((failure as UnsupportedSnapshotVersionError).code).toBe(
      UNSUPPORTED_SNAPSHOT_VERSION_CODE,
    );
    expect((failure as UnsupportedSnapshotVersionError).receivedVersion).toBe(9);
    expect(machine.state).toBe("draft.editing");
  });

  it("SR4: refuses a version that is not even a number, without inventing one", async () => {
    const machine = nestedOrderMachine();

    const failure = await restoreError(machine, {
      id: "order",
      state: "draft.editing",
      context: {},
      configuration: ["draft.editing"],
      schemaVersion: "9",
    });

    expect(failure).toBeInstanceOf(UnsupportedSnapshotVersionError);
    expect((failure as UnsupportedSnapshotVersionError).receivedVersion).toBeUndefined();
    expect(machine.state).toBe("draft.editing");
  });

  it("SR5, SR6: rejects malformed version 2 snapshots", async () => {
    const machine = nestedOrderMachine();
    const valid = {
      id: "order",
      state: "draft.editing",
      context: {},
      configuration: ["draft.editing"],
      history: {},
    };

    const rejected: Array<[string, Record<string, unknown>, RegExp]> = [
      ["a configuration that is not an array", { ...valid, configuration: "draft.editing" }, /must be an array/],
      ["an empty configuration", { ...valid, configuration: [], state: undefined }, /at least one active state/],
      ["an undeclared path", { ...valid, configuration: ["draft.ghost"] }, /is not declared/],
      ["a compound path", { ...valid, configuration: ["draft"] }, /is a compound state/],
      ["a parallel path", { ...valid, configuration: ["draft"] }, /cannot be in on its own/],
      [
        "a configuration naming two children of one compound state",
        { ...valid, configuration: ["draft.editing", "draft.reviewing"] },
        /exactly one must be active/,
      ],
      [
        "a state that contradicts the configuration",
        { ...valid, state: "published" },
        /does not match its configuration/,
      ],
      ["history that is not an object", { ...valid, history: [] }, /must be an object/],
    ];

    for (const [name, input, message] of rejected) {
      await expect(machine.restore(input), name).rejects.toThrow(message);
      expect(machine.state, name).toBe("draft.editing");
    }
  });

  it("SR6: rejects history memory a pseudo-state could not have recorded", async () => {
    const machine = historyMachine();
    const valid = {
      id: "history-format",
      state: "away",
      context: {},
      configuration: ["away"],
      history: {},
    };

    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["an entry for a path that is not a pseudo-state", { ...valid, history: { editing: ["editing.idle"] } }, /is not a history pseudo-state/],
      ["a remembered value that is not an array", { ...valid, history: { "editing.hist": "editing.idle" } }, /must be an array/],
      ["a remembered entry that is not a state path", { ...valid, history: { "editing.hist": [42] } }, /is not a state inside/],
      ["a remembered state outside the parent", { ...valid, history: { "editing.hist": ["away"] } }, /is not a state inside/],
      ["a deep entry that is not atomic", { ...valid, history: { "editing.hist": ["editing.sub"] } }, /is not an atomic state/],
      ["a configuration naming a history pseudo-state", { ...valid, configuration: ["editing.hist"] }, /which is never active/],
    ];

    for (const [name, input, message] of cases) {
      await expect(machine.restore(input), name).rejects.toThrow(message);
    }

    // The same pseudo-state accepts memory it could have recorded.
    await expect(
      machine.restore({ ...valid, history: { "editing.hist": ["editing.idle"] } }),
    ).resolves.toMatchObject({ state: "away", history: { "editing.hist": ["editing.idle"] } });
  });

  it("SR6: rejects every other malformed configuration and history payload", async () => {
    const order = createMachine({
      id: "order",
      initial: "draft",
      context: { orderId: "order_123", approved: false },
      states: {
        draft: {
          initial: "editing",
          on: { PUBLISH: "published" },
          states: { editing: { on: { SUBMIT: "reviewing" } }, reviewing: {} },
        },
        published: {},
      },
    });
    const valid = {
      id: "order",
      state: "draft.editing",
      context: {},
      configuration: ["draft.editing"],
      history: {},
    };

    // A configuration entry that is not a path at all.
    await expect(order.restore({ ...valid, configuration: [42] })).rejects.toThrow(
      /is not a state path/,
    );

    // Two active top-level states, which no configuration can have.
    await expect(
      order.restore({ ...valid, configuration: ["draft.editing", "published"] }),
    ).rejects.toThrow(/activates 2 top-level states/);

    // A version 2 snapshot may omit history entirely, which is read as no memory.
    await expect(
      order.restore({
        id: "order",
        state: "draft.editing",
        context: {},
        configuration: ["draft.editing"],
      }),
    ).resolves.toMatchObject({ history: {}, configuration: ["draft.editing"] });

    // A shallow pseudo-state can only remember direct children of its parent.
    const shallow = createMachine({
      id: "shallow-format",
      initial: "away",
      context: {},
      states: {
        parent: {
          initial: "c1",
          states: {
            c1: { initial: "c1x", states: { c1x: {} } },
            hist: { type: "history", history: "shallow" },
          },
        },
        away: { on: { RESUME: "parent.hist" } },
      },
    });

    await expect(
      shallow.restore({
        id: "shallow-format",
        state: "away",
        context: {},
        configuration: ["away"],
        history: { "parent.hist": ["parent.c1.c1x"] },
      }),
    ).rejects.toThrow(/not a direct child/);
  });

  it("SR7: records each state once, however often the snapshot repeats it", async () => {
    const history = historyMachine();

    // A repeated configuration entry collapses into one leaf.
    await expect(
      history.restore({
        id: "history-format",
        state: "editing.idle",
        context: {},
        configuration: ["editing.idle", "editing.idle"],
        history: { "editing.hist": ["editing.idle", "editing.idle"] },
      }),
    ).resolves.toMatchObject({
      configuration: ["editing.idle"],
      history: { "editing.hist": ["editing.idle"] },
    });
  });

  it("SR7, CF4: normalises a restored configuration and memory into document order", async () => {
    // A stored configuration and a stored memory are sets, so either may arrive in any order; what
    // the machine reports is document order.
    const parallel = createMachine({
      id: "shuffled",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: {
            r1: { initial: "a", states: { a: {}, b: {} } },
            r2: { initial: "c", states: { c: {}, d: {} } },
          },
        },
      },
    });

    await expect(
      parallel.restore({
        id: "shuffled",
        state: "p",
        context: {},
        configuration: ["p.r2.d", "p.r1.b"],
        history: {},
      }),
    ).resolves.toMatchObject({ configuration: ["p.r1.b", "p.r2.d"] });

    const history = historyMachine();

    await expect(
      history.restore({
        id: "history-format",
        state: "away",
        context: {},
        configuration: ["away"],
        history: { "editing.hist": ["editing.sub.s1", "editing.idle"] },
      }),
    ).resolves.toMatchObject({ history: { "editing.hist": ["editing.idle", "editing.sub.s1"] } });
  });

  it("SR6: accepts memory each pseudo-state could have recorded", async () => {
    const history = historyMachine();

    // Deep memory is a set of atomic descendants, which may sit below a direct child.
    await expect(
      history.restore({
        id: "history-format",
        state: "away",
        context: {},
        configuration: ["away"],
        history: { "editing.hist": ["editing.sub.s1"] },
      }),
    ).resolves.toMatchObject({ history: { "editing.hist": ["editing.sub.s1"] } });

    // Shallow memory is a set of direct children, which may be compound.
    const shallow = createMachine({
      id: "shallow-accept",
      initial: "away",
      context: {},
      states: {
        parent: {
          initial: "c1",
          states: { c1: { initial: "c1x", states: { c1x: {} } }, hist: { type: "history", history: "shallow" } },
        },
        away: { on: { RESUME: "parent.hist" } },
      },
    });

    await expect(
      shallow.restore({
        id: "shallow-accept",
        state: "away",
        context: {},
        configuration: ["away"],
        history: { "parent.hist": ["parent.c1"] },
      }),
    ).resolves.toMatchObject({ history: { "parent.hist": ["parent.c1"] } });
  });

  it("SR3: derives the configuration from a version 2 snapshot that carries no state field", async () => {
    const machine = nestedOrderMachine();

    const restored = await machine.restore({
      id: "order",
      context: {},
      configuration: ["draft.editing"],
      history: {},
    });

    expect(restored.state).toBe("draft.editing");
    expect(machine.snapshot().configuration).toEqual(["draft.editing"]);
  });
});