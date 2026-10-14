/**
 * Compile-time tests.
 *
 * These assertions are verified by `vitest --typecheck` and by `tsc --noEmit`. Every
 * `@ts-expect-error` must stay necessary: if a rejected usage starts compiling, the directive
 * becomes unused and the suite fails.
 */

import { expectTypeOf, test } from "vitest";
import { createMachine } from "../src/index.js";
import type { MachineSnapshot } from "../src/index.js";

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
            expectTypeOf(args.state).toEqualTypeOf<"a" | "b">();
          },
        ],
        exit: [
          (args) => {
            expectTypeOf(args.state).toEqualTypeOf<"a" | "b">();
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
