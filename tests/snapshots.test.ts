/**
 * Snapshots, serialization and restoration: validation of restored data, immutability guarantees
 * and the requirement that restoration is never a transition.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createMachine,
  MachineConfigurationError,
  SnapshotValidationError,
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

  const invalid: Array<{ name: string; snapshot: unknown }> = [
    { name: "null", snapshot: null },
    { name: "undefined", snapshot: undefined },
    { name: "a string", snapshot: "order" },
    { name: "a number", snapshot: 7 },
    { name: "an array", snapshot: [] },
    { name: "a missing id", snapshot: { state: "confirmed", context: {} } },
    { name: "a mismatched id", snapshot: { id: "other", state: "confirmed", context: {} } },
    { name: "a missing state", snapshot: { id: "order", context: {} } },
    { name: "an undeclared state", snapshot: { id: "order", state: "ghost", context: {} } },
    {
      name: "a prototype state name",
      snapshot: { id: "order", state: "toString", context: {} },
    },
    { name: "a missing context", snapshot: { id: "order", state: "confirmed" } },
    { name: "a null context", snapshot: { id: "order", state: "confirmed", context: null } },
    { name: "a primitive context", snapshot: { id: "order", state: "confirmed", context: 7 } },
    {
      name: "an unclonable context",
      snapshot: { id: "order", state: "confirmed", context: { run: () => 1 } },
    },
  ];

  it.each(invalid)("rejects $name", async ({ snapshot }) => {
    const machine = orderMachine();
    await expect(machine.restore(snapshot)).rejects.toBeInstanceOf(SnapshotValidationError);
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

  it("rejects a snapshot written by a different schema version", async () => {
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
      machine.restore({ id: "order", state: "pending", context: { value: 1 }, schemaVersion: 1 }),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
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

    await expect(
      machine.restore({ id: "order", state: "pending", context: { value: 4 } }),
    ).resolves.toMatchObject({ context: { value: 4 }, schemaVersion: 1 });
  });

  it("rejects invalid options at creation time", () => {
    const definition = {
      id: "order",
      initial: "pending",
      context: {},
      states: { pending: {} },
    };

    expect(() => createLooseMachine(definition, { schemaVersion: -1 })).toThrow(
      MachineConfigurationError,
    );
    expect(() => createLooseMachine(definition, { schemaVersion: 1.5 })).toThrow(
      MachineConfigurationError,
    );
    expect(() => createLooseMachine(definition, { schemaVersion: "1" as never })).toThrow(
      MachineConfigurationError,
    );
    expect(() => createLooseMachine(definition, { parseContext: "nope" as never })).toThrow(
      MachineConfigurationError,
    );
    expect(() => createLooseMachine(definition, { schemaVersion: 3 })).not.toThrow();
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
