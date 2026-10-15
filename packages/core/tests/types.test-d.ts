/**
 * Compile-time tests.
 *
 * These assertions are verified by `vitest --typecheck` and by `tsc --noEmit`. Every
 * `@ts-expect-error` must stay necessary: if a rejected usage starts compiling, the directive
 * becomes unused and the suite fails.
 */

import { expectTypeOf, test } from "vitest";
import { createMachine } from "../src/index.js";
import type { MachineDefinition, MachineSnapshot } from "../src/index.js";

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

  // @ts-expect-error "ghost" is not a declared state
  createMachine({
    id: "x",
    initial: "a",
    context: {},
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

test("infers nested paths and narrows nested transition arguments", () => {
  const machine = createMachine({
    id: "doc",
    initial: "draft",
    context: { paymentAuthorized: false },
    events: { SUBMIT: undefined, BACK: undefined, DISCARD: undefined },
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
  });

  type DocPath = "draft" | "draft.editing" | "draft.reviewing" | "published";
  type DocEvent = "SUBMIT" | "BACK" | "DISCARD";
  expectTypeOf(machine.state).toEqualTypeOf<DocPath>();
  expectTypeOf(machine.matches).parameter(0).toEqualTypeOf<DocPath>();
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<DocEvent>();
  expectTypeOf(machine.snapshot().previous).toEqualTypeOf<DocPath | null>();

  // @ts-expect-error undeclared nested paths are rejected
  void machine.matches("draft.ghost");

  // @ts-expect-error the machine's initial state is top-level, not a nested path
  createMachine({ id: "doc", initial: "draft.editing", context: {}, states: { draft: {} } });

  // @ts-expect-error a compound state needs an initial child
  createMachine({
    id: "doc",
    initial: "draft",
    context: {},
    states: { draft: { states: { editing: {} } } },
  });
});

test("infers typed event payloads and keeps payload-free string events", () => {
  type Payloads = {
    ADD: { amount: number };
    RESET: undefined;
  };
  type AddEvent = { type: "ADD" } & Payloads["ADD"];
  type Event = AddEvent | "RESET";

  const machine = createMachine({
    id: "payload-counter",
    initial: "counting",
    context: { count: 0 },
    events: {} as Payloads,
    states: {
      counting: {
        entry: [
          ({ event }) => {
            expectTypeOf(event).toEqualTypeOf<Event>();
          },
        ],
        on: {
          ADD: {
            target: "counting",
            guard: ({ event }) => event.amount > 0,
            actions: [
              ({ context, event }) => {
                context.count += event.amount;
                expectTypeOf(event).toEqualTypeOf<AddEvent>();
              },
            ],
          },
          RESET: {
            actions: [({ context, event }) => {
              context.count = 0;
              expectTypeOf(event).toEqualTypeOf<"RESET">();
            }],
          },
        },
      },
    },
  });

  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<Event>();
  expectTypeOf(machine.snapshot().event).toEqualTypeOf<Event | null>();
  expectTypeOf(machine.getNextEvents()).toEqualTypeOf<Array<"ADD" | "RESET">>();
  expectTypeOf<Parameters<typeof machine.subscribe>[0]>().parameter(0).toEqualTypeOf<
    MachineSnapshot<{ count: number }, "counting", Event>
  >();

  void machine.send({ type: "ADD", amount: 2 });
  void machine.send("RESET");
  void machine.can({ type: "ADD", amount: 1 });

  // @ts-expect-error payload events require their object form
  void machine.send("ADD");
  // @ts-expect-error payload event is missing its required amount
  void machine.send({ type: "ADD" });
  // @ts-expect-error payload values must match their declared shape
  void machine.send({ type: "ADD", amount: "two" });
  // @ts-expect-error no-payload events use their string shorthand
  void machine.send({ type: "RESET" });
  // @ts-expect-error unknown event names are rejected
  void machine.send({ type: "UNKNOWN" });
  // @ts-expect-error unknown payload-free event names are rejected
  void machine.send("UNKNOWN");
});

test("infers dotted paths recursively through three nested levels", () => {
  const machine = createMachine({
    id: "deeply-nested",
    initial: "root",
    context: {},
    events: { FINISH: {} as { result: number } },
    states: {
      root: {
        initial: "middle",
        states: {
          middle: {
            initial: "leaf",
            states: {
              leaf: {
                on: {
                  FINISH: {
                    target: "done",
                    guard: ({ event }) => event.result > 0,
                  },
                },
              },
            },
          },
        },
      },
      done: {},
    },
  });

  type DeepPath = "root" | "root.middle" | "root.middle.leaf" | "done";
  expectTypeOf(machine.state).toEqualTypeOf<DeepPath>();
  expectTypeOf(machine.matches).parameter(0).toEqualTypeOf<DeepPath>();
  expectTypeOf(machine.snapshot().state).toEqualTypeOf<DeepPath>();
  expectTypeOf(machine.snapshot().previous).toEqualTypeOf<DeepPath | null>();
  expectTypeOf<Awaited<ReturnType<typeof machine.restore>>["state"]>().toEqualTypeOf<DeepPath>();
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<
    { type: "FINISH" } & { result: number }
  >();

  void machine.matches("root.middle.leaf");
  void machine.send({ type: "FINISH", result: 1 });
  // @ts-expect-error unknown nested paths are rejected
  void machine.matches("root.middle.missing");
  // @ts-expect-error intermediate paths must match the actual tree
  void machine.matches("root.leaf");
});

test("TY1, TY2, TY3: infers parallel paths and keeps history out of the state union", () => {
  const machine = createMachine({
    id: "typed-parallel",
    initial: "away",
    context: { ready: false },
    states: {
      work: {
        type: "parallel",
        on: { PAUSE: "away" },
        states: {
          left: { initial: "l1", states: { l1: { on: { NEXT: "l2" } }, l2: {} } },
          right: { initial: "r1", states: { r1: { on: { NEXT: "r2" } }, r2: {} } },
          memory: { type: "history", history: "deep", target: "l1" },
        },
      },
      away: { on: { RESUME: "work.memory" } },
    },
  });

  type Path =
    | "work"
    | "work.left"
    | "work.left.l1"
    | "work.left.l2"
    | "work.right"
    | "work.right.r1"
    | "work.right.r2"
    | "away";

  expectTypeOf(machine.state).toEqualTypeOf<Path>();
  expectTypeOf(machine.configuration).toEqualTypeOf<readonly Path[]>();
  expectTypeOf(machine.matches).parameter(0).toEqualTypeOf<Path>();
  expectTypeOf(machine.snapshot().configuration).toEqualTypeOf<readonly Path[]>();
  expectTypeOf(machine.snapshot().history).toEqualTypeOf<
    Readonly<Record<string, readonly Path[]>>
  >();
  expectTypeOf<Parameters<typeof machine.send>[0]>().toEqualTypeOf<
    "PAUSE" | "NEXT" | "RESUME"
  >();

  // A history pseudo-state is a legal target, and the region paths are part of the union.
  void machine.send("RESUME");
  void machine.matches("work.right.r2");

  // @ts-expect-error a history pseudo-state is never active, so it is not a state path
  void machine.matches("work.memory");

  // @ts-expect-error a typo in a history default target is caught against the state tree
  createMachine({
    id: "bad-target",
    initial: "away",
    context: {},
    states: {
      work: {
        type: "parallel",
        states: {
          left: { initial: "l1", states: { l1: {} } },
          memory: { type: "history", target: "work.ghost" },
        },
      },
      away: {},
    },
  });
});

test("TY4: rejects state declarations whose kind and fields disagree", () => {
  // @ts-expect-error a parallel state declares no initial child
  createMachine({ id: "x", initial: "p", context: {}, states: { p: { type: "parallel", initial: "a", states: { r: { initial: "a", states: { a: {} } } } } } });

  // @ts-expect-error a parallel state needs at least one region
  createMachine({ id: "x", initial: "p", context: {}, states: { p: { type: "parallel" } } });

  // @ts-expect-error a history pseudo-state declares no transitions
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { initial: "b", states: { b: {}, h: { type: "history", on: { GO: "b" } } } } } });

  // @ts-expect-error a history pseudo-state declares no nested states
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { initial: "b", states: { b: {}, h: { type: "history", states: { c: {} } } } } } });

  // @ts-expect-error "sometimes" is not a history depth
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { initial: "b", states: { b: {}, h: { type: "history", history: "sometimes" } } } } });

  // @ts-expect-error only the four declared state kinds exist
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { type: "compoundish" } } });

  // @ts-expect-error internal transitions are not supported in this version
  createMachine({ id: "x", initial: "a", context: {}, states: { a: { on: { GO: { target: "b", type: "internal" } } }, b: {} } });
});