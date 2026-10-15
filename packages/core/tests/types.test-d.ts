/**
 * Compile-time tests.
 *
 * These assertions are verified by `vitest --typecheck` and by `tsc --noEmit`. Every
 * `@ts-expect-error` must stay necessary: if a rejected usage starts compiling, the directive
 * becomes unused and the suite fails.
 */

import { expectTypeOf, test } from "vitest";
import { createMachine } from "../src/index.js";
import type { MachineDefinition, MachineSnapshot, NestedMachineDefinition } from "../src/index.js";

type OrderContext = { orderId: string; paymentAuthorized: boolean };
type OrderState = "pending" | "confirmed" | "processing" | "shipped";
type OrderEvent = "CONFIRM" | "PROCESS" | "SHIP";

/** Annotating the context value keeps the machine's context type exactly `OrderContext`. */
const orderContext: OrderContext = { orderId: "order_123", paymentAuthorized: false };

const orderMachine = createMachine({
  id: "order",
  initial: "pending",
  context: orderContext,
  states: {
    pending: {
      on: { CONFIRM: "confirmed" },
    },
    confirmed: {
      on: {
        PROCESS: {
          target: "processing",
          guard: ({ context }) => context.paymentAuthorized,
        },
      },
    },
    processing: { on: { SHIP: "shipped" } },
    shipped: {},
  },
});

test("infers state names, context shape and event names", () => {
  expectTypeOf(orderMachine.state).toEqualTypeOf<OrderState>();
  expectTypeOf(orderMachine.context).toEqualTypeOf<OrderContext>();
  expectTypeOf<Parameters<typeof orderMachine.send>[0]>().toEqualTypeOf<OrderEvent>();
  expectTypeOf(orderMachine.snapshot().revision).toEqualTypeOf<number>();
  expectTypeOf(orderMachine.snapshot().done).toEqualTypeOf<boolean>();
  expectTypeOf(orderMachine.restore).parameter(0).toEqualTypeOf<unknown>();
  expectTypeOf(orderMachine.snapshot().context).toEqualTypeOf<OrderContext>();
});

test("infers snapshot types from the machine definition", () => {
  expectTypeOf<Awaited<ReturnType<typeof orderMachine.send>>>().toEqualTypeOf<
    MachineSnapshot<OrderContext, OrderState, OrderEvent>
  >();
});

test("accepts declared events", async () => {
  await orderMachine.send("CONFIRM");
  await orderMachine.send("PROCESS");
  await orderMachine.send("SHIP");
});

test("rejects undeclared events", async () => {
  // @ts-expect-error "UNKNOWN_EVENT" is not declared by the machine
  await orderMachine.send("UNKNOWN_EVENT");
});

test("rejects events that belong to another machine", async () => {
  // @ts-expect-error "TOGGLE" is not an event of this machine
  await orderMachine.send("TOGGLE");
});

test("rejects undeclared transition targets", () => {
  // @ts-expect-error "ghost" is not a declared state
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { on: { GO: "ghost" } } } });
});

test("rejects an undeclared initial state", () => {
  // @ts-expect-error "ghost" is not a declared state
  createMachine({ id: "x", initial: "ghost", context: {}, states: { a: {} } });
});

test("rejects context that does not match the guard usage", () => {
  createMachine({
    id: "x",
    initial: "a",
    context: { count: 0 },
    states: {
      a: {
        // @ts-expect-error "missing" does not exist on the inferred context
        on: { GO: { target: "b", guard: ({ context }) => context.missing > 0 } },
      },
      b: {},
    },
  });
});

test("keeps an annotated context exactly as declared and mutable", () => {
  const context: { count: number } = { count: 0 };
  const machine = createMachine({
    id: "counter",
    initial: "counting",
    context,
    states: {
      counting: {
        on: {
          BUMP: {
            target: "counting",
            actions: [
              ({ context: staged }) => {
                staged.count += 1;
              },
            ],
          },
        },
      },
    },
  });

  expectTypeOf(machine.context).toEqualTypeOf<{ count: number }>();
});

test("infers guard, action and lifecycle arguments", () => {
  createMachine({
    id: "typed",
    initial: "a",
    context: { count: 0 },
    states: {
      a: {
        entry: [
          (args) => {
            expectTypeOf(args.context).toEqualTypeOf<{ count: number }>();
            expectTypeOf(args.state).toEqualTypeOf<"a">();
          },
        ],
        exit: [
          (args) => {
            expectTypeOf(args.state).toEqualTypeOf<"a">();
          },
        ],
        on: {
          GO: {
            target: "b",
            guard: (args) => {
              expectTypeOf(args.event).toEqualTypeOf<"GO">();
              return args.context.count >= 0;
            },
            actions: [
              (args) => {
                expectTypeOf(args.context).toEqualTypeOf<{ count: number }>();
              },
            ],
          },
        },
      },
      b: {},
    },
  });
});

test("derives the state union from the states map, including states nothing targets", () => {
  const machine = createMachine({
    id: "pipeline",
    initial: "queued",
    context: { jobId: "J-1" },
    states: {
      queued: { on: { START: "running", CANCEL: "cancelled" } },
      running: { on: { FINISH: "succeeded" } },
      succeeded: {},
      cancelled: {},
      // Nothing targets these two, so they exist only as declarations. They must still be part
      // of the state union, and declaring them must not be a type error.
      maintenance: { entry: [({ state }) => void state] },
      archived: {},
    },
  });

  expectTypeOf(machine.state).toEqualTypeOf<
    "queued" | "running" | "succeeded" | "cancelled" | "maintenance" | "archived"
  >();

  // The event union still comes only from the declared `on` maps.
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<
    "START" | "CANCEL" | "FINISH"
  >();
});

test("supports a state declared before the state that targets it", () => {
  const machine = createMachine({
    id: "onboarding",
    initial: "profile",
    context: {},
    states: {
      invite_team: { on: { BACK: "profile" } },
      profile: { on: { NEXT: "invite_team" } },
    },
  });

  expectTypeOf(machine.state).toEqualTypeOf<"invite_team" | "profile">();
});

test("keeps prototype-named states in the union, including states nothing targets", () => {
  const machine = createMachine({
    id: "prototype-names",
    initial: "idle",
    context: {},
    states: {
      idle: { on: { GO: "toString" } },
      toString: { on: { BACK: "idle" } },
      constructor: {},
      valueOf: {},
    },
  });

  expectTypeOf(machine.state).toEqualTypeOf<"idle" | "toString" | "constructor" | "valueOf">();

  // @ts-expect-error a prototype member is not an event unless it is declared
  void machine.send("hasOwnProperty");
});

test("supports empty-string state and event names", () => {
  const machine = createMachine({
    id: "edge",
    initial: "",
    context: {},
    states: { "": { on: { "": "next" } }, next: {} },
  });

  expectTypeOf(machine.state).toEqualTypeOf<"" | "next">();
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<"">();
});

test("accepts a separately typed guard and a widened event variable", () => {
  type MachineCtx = { count: number };
  type StateName = "a" | "b";
  type EventName = "GO";

  const guard: (args: { context: MachineCtx; state: StateName; event: EventName }) => boolean = ({
    context,
  }) => context.count > 0;

  const machine = createMachine<MachineCtx, StateName, EventName>({
    id: "typed-separately",
    initial: "a",
    context: { count: 1 },
    states: { a: { on: { GO: { target: "b", guard } } }, b: {} },
  });

  const event: EventName = "GO";
  void machine.send(event);
});

test("validates initial and every target form against the declared states", () => {
  // @ts-expect-error "ghost" is not a declared state
  createMachine({ id: "x", initial: "ghost", context: {}, states: { a: {} } });

  // @ts-expect-error "ghost" is not a declared state
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { on: { GO: "ghost" } } } });

  // The object form is validated too. The directive sits on the line TypeScript reports the
  // error on, so it survives formatting of the surrounding call.
  createMachine({
    id: "x",
    initial: "a",
    context: {},
    // @ts-expect-error "ghost" is not a declared state
    states: { a: { on: { GO: { target: "ghost" } } } },
  });
});

test("keeps the state union precise when a definition is annotated", () => {
  type OrderState = "pending" | "confirmed";
  type OrderEvent = "CONFIRM";

  const definition: MachineDefinition<Record<string, never>, OrderState, OrderEvent> = {
    id: "order",
    initial: "pending",
    context: {},
    states: {
      pending: { on: { CONFIRM: "confirmed" } },
      confirmed: {},
    },
  };

  const machine = createMachine(definition);
  expectTypeOf(machine.state).toEqualTypeOf<OrderState>();
});

test("documents what a definition held in a mutable variable needs", () => {
  type OrderState = "pending" | "confirmed";
  type OrderEvent = "CONFIRM";
  type OrderContext = Record<string, never>;

  // A plain mutable variable widens `initial` to `string` and the target to `string`, so there is
  // nothing left for the compiler to check against the state union.
  const widened = {
    id: "order",
    initial: "pending",
    context: {},
    states: {
      pending: { on: { CONFIRM: "confirmed" } },
      confirmed: {},
    },
  };

  // @ts-expect-error `initial` has widened to string; annotate or assert the definition instead
  createMachine(widened);

  // `satisfies` checks the shape without widening the literals, which keeps the union precise.
  const checked = {
    id: "order",
    initial: "pending",
    context: {},
    states: {
      pending: { on: { CONFIRM: "confirmed" } },
      confirmed: {},
    },
  } satisfies MachineDefinition<OrderContext, OrderState, OrderEvent>;

  const machine = createMachine(checked);
  expectTypeOf(machine.state).toEqualTypeOf<OrderState>();
});

test("types the machine options", () => {
  type ReportContext = { when: Date };

  const context: ReportContext = { when: new Date(0) };
  const definition = {
    id: "report",
    initial: "open",
    context,
    states: { open: {} },
  } as const;

  createMachine(definition, {
    schemaVersion: 2,
    parseContext: (input) => {
      expectTypeOf(input).toEqualTypeOf<unknown>();
      return context;
    },
  });

  // @ts-expect-error parseContext must return the machine's context type
  createMachine(definition, { parseContext: () => ({ wrong: true }) });

  // @ts-expect-error schemaVersion is a number
  createMachine(definition, { schemaVersion: "2" });

  createMachine(definition, { maxQueueDepth: 4 });

  // @ts-expect-error maxQueueDepth is a number
  createMachine(definition, { maxQueueDepth: "4" });
});

test("narrows the state and event a transition is declared under", () => {
  createMachine({
    id: "narrowed",
    initial: "a",
    context: { count: 0 },
    states: {
      a: {
        on: {
          GO: {
            target: "b",
            guard: (args) => {
              expectTypeOf(args.state).toEqualTypeOf<"a">();
              expectTypeOf(args.event).toEqualTypeOf<"GO">();
              return args.context.count >= 0;
            },
            actions: [
              (args) => {
                expectTypeOf(args.state).toEqualTypeOf<"a">();
                expectTypeOf(args.event).toEqualTypeOf<"GO">();
              },
            ],
          },
          CANCEL: {
            guard: (args) => {
              expectTypeOf(args.event).toEqualTypeOf<"CANCEL">();
              return true;
            },
          },
        },
      },
      b: {
        entry: [
          (args) => {
            // Entry hooks keep the machine-wide event union: which event enters varies, but the
            // state being entered does not.
            expectTypeOf(args.state).toEqualTypeOf<"b">();
            expectTypeOf(args.event).toEqualTypeOf<"GO" | "CANCEL" | "BACK">();
          },
        ],
        exit: [
          (args) => {
            expectTypeOf(args.state).toEqualTypeOf<"b">();
          },
        ],
        on: {
          BACK: {
            guard: (args) => {
              expectTypeOf(args.state).toEqualTypeOf<"b">();
              expectTypeOf(args.event).toEqualTypeOf<"BACK">();
              return true;
            },
          },
        },
      },
    },
  });
});

test("rejects a guard that reaches for a state it is not declared in", () => {
  createMachine({
    id: "cross-state",
    initial: "a",
    context: {},
    states: {
      a: { on: { GO: "b" } },
      b: {
        on: {
          BACK: {
            target: "a",
            guard: ({ state }) => {
              // @ts-expect-error a transition declared in "b" only ever runs while in "b"
              return state === "a";
            },
          },
        },
      },
    },
  });
});

test("rejects a guard that reads an event its own state does not declare", () => {
  createMachine({
    id: "cross-event",
    initial: "a",
    context: {},
    states: {
      a: { on: { GO: "b" } },
      b: {
        on: {
          BACK: {
            target: "a",
            guard: ({ event }) => {
              // @ts-expect-error "GO" is declared in "a", not in "b"
              return event === "GO";
            },
          },
        },
      },
    },
  });
});

test("accepts a definition written with as const", () => {
  const definition = {
    id: "frozen",
    initial: "pending",
    context: {},
    states: {
      pending: { on: { CONFIRM: "confirmed" } },
      confirmed: { entry: [() => undefined] },
    },
  } as const;

  const machine = createMachine(definition);
  expectTypeOf(machine.state).toEqualTypeOf<"pending" | "confirmed">();
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<"CONFIRM">();
});

test("types can() and getNextEvents()", () => {
  expectTypeOf(orderMachine.can).returns.toEqualTypeOf<Promise<boolean>>();
  expectTypeOf(orderMachine.getNextEvents()).toEqualTypeOf<OrderEvent[]>();
  expectTypeOf(orderMachine.can("CONFIRM")).resolves.toEqualTypeOf<boolean>();

  // @ts-expect-error "UNKNOWN_EVENT" is not declared by the machine
  void orderMachine.can("UNKNOWN_EVENT");

  // @ts-expect-error the returned array is the declared event union
  const events: "TOGGLE"[] = orderMachine.getNextEvents();
  void events;

  expectTypeOf(orderMachine.matches).parameter(0).toEqualTypeOf<OrderState>();
  // @ts-expect-error "ghost" is not a declared state
  void orderMachine.matches("ghost");
});

test("types a nested machine through NestedMachineDefinition", () => {
  type DocPath = "draft" | "draft.editing" | "draft.reviewing" | "published";
  type DocEvent = "SUBMIT" | "BACK" | "DISCARD";
  type DocContext = { paymentAuthorized: boolean };

  const definition: NestedMachineDefinition<DocContext, DocPath, DocEvent> = {
    id: "doc",
    initial: "draft",
    context: { paymentAuthorized: false },
    states: {
      draft: {
        initial: "editing",
        entry: [
          (args) => {
            // The declaring state is narrowed, and a nested state narrows to its own path.
            expectTypeOf(args.state).toEqualTypeOf<"draft">();
          },
        ],
        states: {
          editing: {
            on: {
              SUBMIT: {
                target: "draft.reviewing",
                guard: (args) => {
                  expectTypeOf(args.state).toEqualTypeOf<"draft.editing">();
                  expectTypeOf(args.event).toEqualTypeOf<"SUBMIT">();
                  return args.context.paymentAuthorized;
                },
              },
            },
          },
          reviewing: { on: { BACK: "editing" } },
        },
        on: { DISCARD: "published" },
      },
      published: {},
    },
  };

  const machine = createMachine(definition);

  // The machine reports paths, so nested states are part of the state union.
  expectTypeOf(machine.state).toEqualTypeOf<DocPath>();
  expectTypeOf(machine.matches).parameter(0).toEqualTypeOf<DocPath>();
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<DocEvent>();
  expectTypeOf(machine.snapshot().previous).toEqualTypeOf<DocPath | null>();

  // Typed so the test can ask about a path the machine does not declare.
  void machine.matches("draft.ghost" as DocPath);

  const badInitial: NestedMachineDefinition<DocContext, DocPath, DocEvent> = {
    id: "doc",
    // @ts-expect-error the machine's initial state is a top-level state, not a path into one
    initial: "draft.editing",
    context: { paymentAuthorized: false },
    states: {
      draft: { initial: "editing", states: { editing: {}, reviewing: {} } },
      published: {},
    },
  };
  void badInitial;

  const missingChildren: NestedMachineDefinition<DocContext, DocPath, DocEvent> = {
    id: "doc",
    initial: "draft",
    context: { paymentAuthorized: false },
    // @ts-expect-error a compound state must declare its children
    states: { draft: { on: { DISCARD: "published" } }, published: {} },
  };
  void missingChildren;
});
