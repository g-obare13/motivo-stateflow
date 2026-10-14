/**
 * Smoke test for the published artifact.
 *
 * Imports the built ESM bundle exactly as a consumer would (`import ... from "motivo-stateflow"`)
 * and verifies the documented semantics still hold outside the test runner. Run with
 * `node scripts/smoke-test.mjs` after `pnpm build`.
 */

import assert from "node:assert/strict";
import { createMachine, GuardRejectedError, InvalidEventError } from "motivo-stateflow";

const orderMachine = createMachine({
  id: "order",
  initial: "pending",
  context: { orderId: "order_123", paymentAuthorized: false },
  states: {
    pending: { on: { CONFIRM: "confirmed" } },
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

assert.equal(orderMachine.state, "pending");

await orderMachine.send("CONFIRM");
assert.equal(orderMachine.state, "confirmed");

await assert.rejects(orderMachine.send("PROCESS"), GuardRejectedError);
assert.equal(orderMachine.state, "confirmed");

await assert.rejects(orderMachine.send("toString"), InvalidEventError);

const notifications = [];
const unsubscribe = orderMachine.subscribe((snapshot) => notifications.push(snapshot.state));
await orderMachine.send("PROCESS").catch(() => undefined);
unsubscribe();

const serialized = JSON.stringify(orderMachine);
const restored = createMachine({
  id: "order",
  initial: "pending",
  context: { orderId: "", paymentAuthorized: true },
  states: {
    pending: { on: { CONFIRM: "confirmed" } },
    confirmed: { on: { PROCESS: "processing" } },
    processing: { on: { SHIP: "shipped" } },
    shipped: {},
  },
});
await restored.restore(JSON.parse(serialized));
assert.equal(restored.state, "confirmed");
assert.equal(restored.snapshot().revision, 0);

console.log("smoke test passed");
