/**
 * Isolation and regression coverage: independent instances, definition reuse, nested context,
 * unusual identifiers and mutation attempts against public values.
 */

import { describe, expect, it, vi } from "vitest";
import { createMachine } from "../src/index.js";
import type { MachineDefinition } from "../src/index.js";
import { deferred } from "./helpers.js";

const definition = () =>
  ({
    id: "order",
    initial: "pending",
    context: { orderId: "shared", attempts: 0 },
    states: {
      pending: {
        on: {
          BUMP: {
            target: "pending",
            actions: [
              ({ context }) => {
                context.attempts += 1;
              },
            ],
          },
          CONFIRM: "confirmed",
        },
      },
      confirmed: {},
    },
  }) satisfies MachineDefinition<{ orderId: string; attempts: number }, "pending" | "confirmed", "BUMP" | "CONFIRM">;

describe("instance isolation", () => {
  it("does not share context between machines built from one definition", async () => {
    const shared = definition();
    const first = createMachine(shared);
    const second = createMachine(shared);

    await first.send("BUMP");

    expect(first.context.attempts).toBe(1);
    expect(second.context.attempts).toBe(0);
    expect(shared.context.attempts).toBe(0);
  });

  it("does not share queues or state between machines", async () => {
    const gate = deferred<boolean>();
    const first = createMachine({
      id: "first",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { GO: { target: "busy", guard: () => gate.promise } } },
        busy: {},
      },
    });
    const second = createMachine({
      id: "second",
      initial: "idle",
      context: {},
      states: { idle: { on: { GO: "busy" } }, busy: {} },
    });

    const blocked = first.send("GO");
    await second.send("GO");

    expect(first.state).toBe("idle");
    expect(second.state).toBe("busy");

    gate.resolve(true);
    await blocked;
    expect(first.state).toBe("busy");
  });

  it("is immune to later mutation of the definition object", async () => {
    const shared = definition();
    const machine = createMachine(shared);
    const hook = vi.fn();
    const loose = shared.states as unknown as Record<
      string,
      { entry?: unknown[]; on?: Record<string, unknown> }
    >;

    loose.pending!.on!.BUMP = "ghost";
    loose.pending!.entry = [hook];
    loose.pending!.on!.CONFIRM = { target: "confirmed", actions: [hook] };
    loose.ghost = {};

    await machine.send("BUMP");
    await machine.send("CONFIRM");

    expect(hook).not.toHaveBeenCalled();
    expect(machine.state).toBe("confirmed");
    expect(machine.context).toEqual({ orderId: "shared", attempts: 1 });
  });
});

describe("context handling", () => {
  it("deep clones nested context structures", async () => {
    const machine = createMachine({
      id: "nested",
      initial: "active",
      context: {
        items: [{ sku: "a", tags: ["new"] }],
        meta: { nested: { depth: 3 } },
      },
      states: {
        active: {
          on: {
            MUTATE: {
              target: "active",
              actions: [({ context }) => {
                context.items[0]!.tags.push("changed");
                context.meta.nested.depth = 4;
              }],
            },
          },
        },
      },
    });

    await machine.send("MUTATE");
    const snapshot = machine.snapshot();

    snapshot.context.items[0]!.tags.push("tampered");
    snapshot.context.meta.nested.depth = 99;

    expect(machine.context).toEqual({
      items: [{ sku: "a", tags: ["new", "changed"] }],
      meta: { nested: { depth: 4 } },
    });
  });
});

describe("unusual identifiers", () => {
  it("supports special characters in ids, states and events", async () => {
    const machine = createMachine({
      id: "order #42 / v2",
      initial: "état-initial",
      context: {},
      states: {
        "état-initial": { on: { "traité ✅": "terminé" } },
        "terminé": {},
      },
    });

    await machine.send("traité ✅");

    expect(machine.state).toBe("terminé");
    expect(machine.id).toBe("order #42 / v2");
  });

  it("supports empty-string state and event names", async () => {
    const machine = createMachine({
      id: "edge",
      initial: "",
      context: {},
      states: {
        "": { on: { "": "next" } },
        next: {},
      },
    });

    await machine.send("");
    expect(machine.state).toBe("next");
  });
});

describe("failure resilience", () => {
  it("survives rapid alternation between success and failure", async () => {
    const machine = createMachine({
      id: "flaky",
      initial: "idle",
      context: { ok: 0, bad: 0 },
      states: {
        idle: {
          on: {
            GOOD: {
              target: "idle",
              actions: [({ context }) => {
                context.ok += 1;
              }],
            },
            BAD: {
              target: "idle",
              actions: [
                ({ context }) => {
                  context.bad += 1;
                  throw new Error("bad");
                },
              ],
            },
          },
        },
      },
    });

    const results = await Promise.allSettled([
      machine.send("GOOD"),
      machine.send("BAD"),
      machine.send("GOOD"),
      machine.send("BAD"),
      machine.send("GOOD"),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(machine.context).toEqual({ ok: 3, bad: 0 });
    expect(machine.snapshot().revision).toBe(3);
  });

  it("keeps parallel instances independent under load", async () => {
    const machines = Array.from({ length: 5 }, (_, index) =>
      createMachine({
        id: `counter-${index}`,
        initial: "counting",
        context: { value: 0 },
        states: {
          counting: {
            on: {
              TICK: {
                target: "counting",
                actions: [({ context }) => {
                  context.value += 1;
                }],
              },
            },
          },
        },
      }),
    );

    await Promise.all(
      machines.flatMap((machine, index) =>
        Array.from({ length: index + 1 }, () => machine.send("TICK")),
      ),
    );

    expect(machines.map((machine) => machine.context.value)).toEqual([1, 2, 3, 4, 5]);
  });
});
