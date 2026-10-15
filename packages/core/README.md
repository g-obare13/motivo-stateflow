# Motivo Stateflow

A framework-independent **state machine engine for TypeScript**.

Declare the states of a process once, drive it with events, and let the library enforce the rules -
instead of scattering `status` checks, boolean flags and ad-hoc conditionals across your codebase.

```ts
import { createMachine } from "motivo-stateflow";
```

- **Typed end to end** - state names, event names and context shape are inferred from the definition.
  Event payloads are checked too: payload-free events may be sent as strings, and payload events
  use a typed object with a `type` discriminator.
- **Atomic transitions** - guards, exit hooks, actions and entry hooks all run against staged values.
  The machine commits only when every one of them succeeds, so a failure changes nothing.
- **Deterministic concurrency** - events are processed FIFO per machine. Concurrent `send()` calls
  can never commit against stale state.
- **Immutable snapshots** - every read hands out a clone; callers cannot corrupt internal state.
- **Serialization and validated restoration** - persist a snapshot and resume later.
- **Zero runtime dependencies**, ESM-first, `strict` TypeScript, no `any`.

---

## Table of contents

- [Why](#why)
- [Install](#install)
- [Five-minute tutorial](#five-minute-tutorial)
- [Core concepts](#core-concepts)
- [Nested states](#nested-states)
- [Parallel states](#parallel-states)
- [History states](#history-states)
- [Targetless transitions](#targetless-transitions)
- [Typed event payloads](#typed-event-payloads)
- [Examples](#examples)
  - [1. Guarded transition with async work](#1-guarded-transition-with-async-work)
  - [2. Updating context safely](#2-updating-context-safely)
  - [3. Entry and exit hooks](#3-entry-and-exit-hooks)
  - [4. Retry loop with a self-transition](#4-retry-loop-with-a-self-transition)
  - [5. Reacting to state changes](#5-reacting-to-state-changes)
  - [6. Persisting and restoring a machine](#6-persisting-and-restoring-a-machine)
  - [7. Handling failures](#7-handling-failures)
  - [8. Submitting concurrent events](#8-submitting-concurrent-events)
  - [9. Running several machines](#9-running-several-machines)
  - [10. Testing a machine](#10-testing-a-machine)
  - [11. Encapsulating a machine in a service](#11-encapsulating-a-machine-in-a-service)
  - [12. Gating actions with can()](#12-gating-actions-with-can)
- [Use cases](#use-cases)
  - [Order fulfillment](#order-fulfillment)
  - [Payment and subscription lifecycle](#payment-and-subscription-lifecycle)
  - [User onboarding](#user-onboarding)
  - [Multi-step approval workflow](#multi-step-approval-workflow)
  - [Background job lifecycle](#background-job-lifecycle)
  - [Document review loop](#document-review-loop)
  - [Resumable multi-step application](#resumable-multi-step-application)
  - [When not to use a state machine](#when-not-to-use-a-state-machine)
- [API reference](#api-reference)
- [Semantics](#semantics)
- [Type safety](#type-safety)
- [Known limitations and roadmap](#known-limitations-and-roadmap)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Why

Business processes are usually written as a pile of flags and checks that drift apart:

```js
// Before: the rules live in the call sites, and nothing stops an invalid order.
if (order.status !== "pending") throw new Error("cannot confirm");
order.status = "confirmed";
if (!order.paymentAuthorized) throw new Error("not authorised");
order.status = "processing";
```

With Motivo Stateflow the rules live in one declaration, and every transition goes through the same
audited path:

```ts
import { createMachine } from "motivo-stateflow";

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

console.log(orderMachine.state); // "pending"
await orderMachine.send("CONFIRM");
console.log(orderMachine.state); // "confirmed"

// The guard refuses the transition, so nothing changes.
await orderMachine.send("PROCESS").catch((error: Error) => {
  console.log(error.name); // "GuardRejectedError"
});
console.log(orderMachine.state); // "confirmed"
```

Now the rules cannot be bypassed, every attempt is either committed or rejected as a whole, and the
type checker knows the legal event names.

---

## Install

```bash
pnpm add motivo-stateflow
# or: npm install motivo-stateflow
# or: yarn add motivo-stateflow
```

**Requirements:** Node.js 22 or newer (the library uses `structuredClone` when available and falls
back to JSON cloning otherwise), and TypeScript 5.4 or newer to consume the published types.

**Module system:** the package is **ESM-only**. Use `import` from ESM or TypeScript with
`"module": "nodenext"`. From CommonJS, load it with a dynamic import:

```ts
const { createMachine } = await import("motivo-stateflow");
```

---

## Five-minute tutorial

### 1. Declare a machine

A machine needs an `id`, the `initial` state, a `context` object, and a `states` map. Each state
lists the events it accepts; a string value is shorthand for `{ target: "..." }`.

```ts
import { createMachine } from "motivo-stateflow";

type TicketContext = {
  ticketId: string;
  assignee: string | null;
};

const context: TicketContext = {
  ticketId: "T-1",
  assignee: null,
};

const ticketMachine = createMachine({
  id: "ticket",
  initial: "open",
  context,
  states: {
    open: {
      on: {
        ASSIGN: "assigned",
        CLOSE: "closed",
      },
    },
    assigned: {
      on: {
        RESOLVE: "resolved",
      },
    },
    resolved: {
      on: {
        REOPEN: "assigned",
      },
    },
    closed: {},
  },
});

console.log(ticketMachine.state); // "open"
```

Types are inferred: `ticketMachine.state` is `"open" | "assigned" | "resolved" | "closed"` and the
only accepted `send` argument is `"ASSIGN" | "CLOSE" | "RESOLVE" | "REOPEN"`.

### 2. Send events

`send()` returns a promise. It resolves with the committed snapshot, or rejects if the event is not
allowed.

```ts
import { createMachine } from "motivo-stateflow";

const ticketMachine = createMachine({
  id: "ticket",
  initial: "open",
  context: { ticketId: "T-1" },
  states: {
    open: { on: { ASSIGN: "assigned" } },
    assigned: { on: { RESOLVE: "resolved" } },
    resolved: {},
  },
});

const snapshot = await ticketMachine.send("ASSIGN");

console.log(snapshot.state); // "assigned"
console.log(snapshot.previous); // "open"
console.log(snapshot.event); // "ASSIGN"
console.log(snapshot.revision); // 1
```

To ask what the current state accepts before sending anything, use `getNextEvents()` and `can()` (see
[Inspection](#inspection)).

### 3. Add guards, actions and context updates

A guard decides whether a transition may happen; actions run after the decision, and receive a
staged context they may mutate. Changes are committed atomically with the transition.

```ts
import { createMachine } from "motivo-stateflow";

type TicketContext = {
  ticketId: string;
  assignee: string | null;
  attempts: number;
};

const context: TicketContext = {
  ticketId: "T-1",
  assignee: null,
  attempts: 0,
};

const ticketMachine = createMachine({
  id: "ticket",
  initial: "open",
  context,
  states: {
    open: {
      on: {
        ASSIGN: {
          target: "assigned",
          guard: ({ context }) => context.assignee !== null,
          actions: [
            ({ context }) => {
              context.attempts += 1;
            },
          ],
        },
        CLOSE: "closed",
      },
    },
    assigned: { on: { RESOLVE: "resolved" } },
    resolved: { on: { REOPEN: "assigned" } },
    closed: {},
  },
});

await ticketMachine.send("ASSIGN").catch((error) => {
  console.log(error.name); // "GuardRejectedError" - assignee is still null
});
```

### 4. Wait for the queue when it matters

Events are processed one at a time, in submission order. `whenIdle()` resolves once everything that
was submitted has settled - useful in tests and shutdown paths instead of `setTimeout`.

```ts
import { createMachine } from "motivo-stateflow";

const workerMachine = createMachine({
  id: "worker",
  initial: "idle",
  context: { processed: 0 },
  states: {
    idle: {
      on: {
        JOB: {
          target: "idle",
          actions: [
            ({ context }) => {
              context.processed += 1;
            },
          ],
        },
      },
    },
  },
});

void workerMachine.send("JOB");
void workerMachine.send("JOB");
await workerMachine.whenIdle();

console.log(workerMachine.context.processed); // 2
```

### 5. Persist and restore

A snapshot is a plain, serializable value. Define a factory that builds the machine, and call it again
to resume later. `restore()` validates the stored data before applying it.

```ts
import { createMachine } from "motivo-stateflow";

type JobContext = { jobId: string; attempts: number };

const createJobMachine = () =>
  createMachine({
    id: "job",
    initial: "queued",
    context: { jobId: "J-7", attempts: 0 } satisfies JobContext,
    states: {
      queued: { on: { START: "running" } },
      running: { on: { FINISH: "succeeded" } },
      succeeded: {},
    },
  });

const machine = createJobMachine();
await machine.send("START");

const persisted = JSON.stringify(machine); // uses toJSON()

const resumed = createJobMachine();
await resumed.restore(JSON.parse(persisted));

console.log(resumed.state); // "running"
```

That is the whole core surface. Everything below goes deeper into patterns, use cases and semantics.

---

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Definition** | The declarative object passed to `createMachine`: `id`, `initial`, `context`, `states`. Validated eagerly; a malformed definition throws `MachineConfigurationError`. |
| **State** | A named phase of the process (`pending`, `shipped`, ...). Lives in `states`; `initial` selects the starting one. A state that declares `states` is compound and contains child states. |
| **Event** | A named occurrence (`CONFIRM`, `SHIP`, ...). Sent with `send()`; declared per state in that state's `on` map. |
| **Transition** | What an event does in a state: either a target state name, or an object with `target`, `guard` and `actions`. Omitting `target` runs the guard and actions without leaving or entering anything. |
| **Guard** | A predicate that must pass for the transition to be committed. Sync or async. Returning `false` rejects with `GuardRejectedError`. |
| **Action** | A function that runs during a committed transition. Sync or async. Receives the staged context, the state being left and the event. |
| **Entry / exit hooks** | Arrays of actions run when a state is entered or left, in declaration order. |
| **Context** | The typed data attached to the machine. Deep cloned at every public boundary, so it behaves immutably from the outside. |
| **Snapshot** | An immutable view: `id`, `state`, `context`, `event`, `previous`, `revision`, `done`. |
| **Queue** | The per-machine FIFO that serializes events. Guarantees no stale-state commits and no interleaved hooks. Its depth can be capped with the `maxQueueDepth` option. |
| **Inspection** | Read-only views of the machine: `getNextEvents()` lists what the committed state declares, and `can(event)` reports whether a transition would commit without committing it. |
| **Revision** | Monotonic counter of committed transitions on that instance. Failed transitions do not increment it. |

---

## Nested states

A state that declares `states` is compound: it contains child states and starts in the one named by
`initial`. Entering a compound state enters that child, and leaving it leaves whichever child was
active. Nesting groups behaviour that shares a context and a set of transitions.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "order",
  initial: "draft",
  context: {},
  states: {
    draft: {
      initial: "editing",
      states: { editing: {}, reviewing: {} },
      on: { RESET: "published" },
    },
    published: {},
  },
});

console.log(machine.state); // "draft.editing"
console.log(machine.matches("draft")); // true: the compound state is active too
await machine.send("RESET"); // bubbles from editing to draft
console.log(machine.state); // "published"

// @ts-expect-error paths are derived from the states tree
machine.matches("draft.missing");
```

**State paths.** Every state has one: the keys from the top level joined with dots, such as
`"draft.editing"`. `machine.state` reports the active leaf, `matches(path)` answers for that leaf and
every state containing it, and a state name may not contain a dot, because a dot separates path
segments.

**Event bubbling.** An event is offered to the deepest active state first. If that state declares no
transition for it, the search moves to its parent, then to the next parent, and so on. The state
that answers owns the transition: its guard is evaluated, its actions run, and it is the state
reported as `previous`. When two levels declare the same event, only the deeper one is reached while
its state is active.

**Lifecycle ordering across levels.** A transition exits the active states from the leaf up to the
declaring state, deepest first, runs its actions, then enters the states from just below the
boundary that both ends share down to the target, shallowest first. Entering a compound state also
enters its initial children, down to a leaf. A self-transition on a compound state therefore resets
it to its initial child. Sending `RESET` while `draft.editing` is active gives:

```
exit "draft.editing" -> exit "draft" -> actions -> enter "draft" -> enter "draft.editing"
```

**Snapshots.** A snapshot stores the active leaf path and the leaf path before the transition, so a
snapshot taken while `editing` is active reports `state: "draft.editing"`. `restore()` accepts a
declared leaf path and rejects a compound path, because the machine cannot be inside a compound
state without one of its children. `done` is true only when nothing in the active configuration can
handle an event, so a leaf that declares nothing is not done while its parent still does.

**Typing.** `createMachine()` derives all dotted paths recursively from the nested `states` maps.
The resulting union types `state`, `matches()`, snapshots and the state paths returned by
`restore()`. `NestedMachineDefinition` remains available for explicitly annotated definitions, but
ordinary machine declarations do not need a manually maintained path union.

---

## Parallel states

A state declared `type: "parallel"` is active together with **all** of its children. Each child is a
region, and each region handles events on its own.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "editor",
  initial: "open",
  context: { saved: false },
  states: {
    open: {
      type: "parallel",
      states: {
        document: {
          initial: "clean",
          states: { clean: { on: { EDIT: "dirty" } }, dirty: {} },
        },
        toolbar: {
          initial: "plain",
          states: { plain: { on: { ZOOM: "zoomed" } }, zoomed: {} },
        },
      },
    },
  },
});

console.log(machine.state); // "open"
console.log(machine.configuration); // ["open.document.clean", "open.toolbar.plain"]

await machine.send("EDIT"); // only the document region moves
console.log(machine.configuration); // ["open.document.dirty", "open.toolbar.plain"]
```

**One event, several regions.** An event is offered to every region. A region that declares it takes
its own transition, so a single `send()` can advance several regions at once, and they all commit
together as one microstep: one `revision` increment and one notification.

```ts
await machine.send("BOTH"); // both regions declare BOTH, so both transition
```

**Who wins a conflict.** Two regions can pick transitions that would each exit the other's states,
for instance when both target a state outside the parallel state. The deeper declaration wins, and
when neither is an ancestor of the other the region that appears first in document order wins. The
losing transition does not run at all. A handler declared on the parallel state itself is therefore
preempted by any region that declares the same event.

**Guards.** A guard that returns `false` disables only its own region's transition, and the other
regions still commit. When no region's guard accepts, the event rejects with `GuardRejectedError`
and nothing changes, which is what a machine with no parallel state has always done. A guard that
*throws* aborts the whole microstep instead.

**Declare in-region transitions inside the region.** A region is not a proper ancestor of itself, so
a transition declared *on* a region always reaches above the parallel state: it exits and re-enters
the whole parallel state, which resets sibling regions. Declaring the transition on a state inside
the region keeps the change local.

**Nothing is implicitly parallel.** While a parallel state is active, `machine.state` reports that
parallel state, because no deeper state contains every active leaf, and `configuration` carries the
leaf paths. `matches(path)` answers for the parallel state, each region and each active leaf, so a
leaf in one region never matches a sibling region's leaf. `getNextEvents()` lists every event any
active state declares, in document order.

---

## History states

A state declared `type: "history"` remembers the configuration of its parent when that parent is
exited. Targeting the pseudo-state returns to it.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "wizard",
  initial: "steps",
  context: {},
  states: {
    steps: {
      initial: "account",
      on: { SUSPEND: "suspended" },
      states: {
        account: { on: { NEXT: "billing" } },
        billing: {},
        // Remembers every active atomic state below `steps`, not just the direct child.
        remember: { type: "history", history: "deep", target: "account" },
      },
    },
    suspended: { on: { RESUME: "steps.remember" } },
  },
});

await machine.send("NEXT"); // steps.billing
await machine.send("SUSPEND");
await machine.send("RESUME");
console.log(machine.state); // "steps.billing", not the initial "steps.account"
```

- `history: "deep"` records every active atomic descendant of the parent, so a parallel parent
  restores each region exactly.
- `history: "shallow"` records only the parent's active direct children. A remembered compound child
  is then entered through its own default entry, which is why shallow memory of a parallel parent
  resets every region.
- `target` is the state entered on the **first** entry, before any memory exists. Without it, the
  parent is entered through its ordinary default entry.
- Memory is captured when the parent is exited, before that state's `exit` hooks run, and it is part
  of the snapshot, so it survives serialization.
- A history pseudo-state is never active: it never appears in `configuration`, never matches, and
  cannot be the target of an `initial` value.

---

## Targetless transitions

Omitting `target` runs the transition's guard and actions and leaves the machine where it is.
SCXML defines both the exit set and the entry set of such a transition as empty, so nothing is
exited, nothing is entered, no lifecycle hook runs, and the configuration does not change.

```ts
on: {
  // Reacts to the event without moving anything.
  AUDIT: { actions: [({ context }) => { context.audited += 1; }] },
  // Re-enters this state: exit hooks, actions and entry hooks all run.
  REFRESH: { target: "editing" },
}
```

This is the way to react inside one region of a parallel state without disturbing its siblings or its
nested state, because a targetless transition touches nothing. A transition that should re-enter its
own state has to name that state, which is what a self-transition is.

A targetless transition still counts as a commit: `revision` advances by one and subscribers are
notified, with `state` and `previous` both reporting the unchanged configuration.

---

## Typed event payloads

Declare payload shapes in the machine's `events` map. A payload-free event maps to `undefined`;
an event with data maps to its payload object type. The values in this map are only type
declarations, not runtime validators.

```ts
import { createMachine } from "motivo-stateflow";

type CounterEvents = {
  ADD: { amount: number };
  RESET: undefined;
};

const machine = createMachine({
  id: "counter",
  initial: "counting",
  context: { count: 0 },
  events: {} as CounterEvents,
  states: {
    counting: {
      on: {
        ADD: {
          target: "counting",
          guard: ({ event }) => event.amount > 0,
          actions: [({ context, event }) => { context.count += event.amount; }],
        },
        RESET: { actions: [({ context }) => { context.count = 0; }] },
      },
    },
  },
});

await machine.send({ type: "ADD", amount: 2 });
await machine.send("RESET");
```

`send()` and `can()` accept a payload-free event name as a string, or a typed object of the form
`{ type: "EVENT_NAME", ...payload }`. The type checker rejects unknown event names, missing
payload fields and incompatible payload values. Guards, transition actions, entry and exit hooks
receive the full event for the transition; asynchronous work keeps the event payload available
until the transition settles.

Snapshots and subscription notifications retain the event object that committed the transition.
Each snapshot and each listener receives its own clone of the event payload. `getNextEvents()`
returns event names (the `type` discriminators for payload events), not fabricated event objects,
because it cannot know the payload values a caller will send.

Event payloads must be structured-cloneable so the engine can isolate them across queued work and
snapshots. The `events` map declares TypeScript shapes only; untyped runtime callers are checked
for an event name or an object with a string `type`, not validated against a payload schema.

---

## Examples

Every example below is complete and copy-pasteable.

### 1. Guarded transition with async work

Guards may be asynchronous; the engine awaits them and never commits while one is pending. Guards
are the right place for **decisions**, not for side effects.

```ts
import { createMachine } from "motivo-stateflow";

type PaymentContext = { amount: number; authorized: boolean };

const machine = createMachine({
  id: "payment",
  initial: "pending",
  context: { amount: 250, authorized: false } satisfies PaymentContext,
  states: {
    pending: {
      on: {
        CAPTURE: {
          target: "captured",
          guard: async ({ context }) => {
            const response = await Promise.resolve({ ok: context.amount > 0 && context.authorized });
            return response.ok;
          },
        },
      },
    },
    captured: {},
  },
});

const outcome = await machine.send("CAPTURE").then(
  (snapshot) => `committed -> ${snapshot.state}`,
  (error: Error) => `rejected -> ${error.name}`,
);

console.log(outcome); // "rejected -> GuardRejectedError"
console.log(machine.state); // "pending" - nothing was committed
```

### 2. Updating context safely

Mutate the `context` you receive: it is a staged clone that is either committed with the transition or
discarded when anything fails. `machine.context` always returns a fresh clone.

```ts
import { createMachine } from "motivo-stateflow";

type CartContext = {
  items: string[];
  total: number;
};

const context: CartContext = { items: [], total: 0 };

const machine = createMachine({
  id: "cart",
  initial: "shopping",
  context,
  states: {
    shopping: {
      on: {
        ADD_ITEM: {
          target: "shopping",
          actions: [
            ({ context }) => {
              context.items.push("sku-1");
              context.total += 25;
            },
          ],
        },
        CHECKOUT: {
          target: "checked_out",
          guard: ({ context }) => context.items.length > 0,
        },
      },
    },
    checked_out: {},
  },
});

await machine.send("ADD_ITEM");
await machine.send("ADD_ITEM");

const snapshot = machine.snapshot();
snapshot.context.items.push("mutation is discarded");
snapshot.context.total = 0;

console.log(machine.context.items.length); // 2
console.log(machine.context.total); // 50
```

### 3. Entry and exit hooks

Hooks run in a fixed order: **exit** hooks of the current state, then transition **actions**, then
**entry** hooks of the target state - each list in declaration order, each awaited.

```ts
import { createMachine } from "motivo-stateflow";

const log: string[] = [];

const machine = createMachine({
  id: "deploy",
  initial: "idle",
  context: { version: 3 },
  states: {
    idle: {
      exit: [({ context }) => log.push(`exit idle (v${context.version})`)],
      on: {
        DEPLOY: {
          target: "deploying",
          actions: [({ context, state, event }) => log.push(`action ${event} from ${state}`)],
        },
      },
    },
    deploying: {
      entry: [({ state }) => log.push(`entry ${state}`)],
      on: { SUCCEED: "live" },
    },
    live: {},
  },
});

await machine.send("DEPLOY");

console.log(log);
// ["exit idle (v3)", "action DEPLOY from idle", "entry deploying"]
```

### 4. Retry loop with a self-transition

A self-transition names the state it is declared in, so that state is exited and entered again and
its exit, action and entry hooks all run - which makes it a clean way to model an attempt counter.
Omitting `target` instead runs the actions without moving the machine at all, which is how you react
to an event without resetting anything.

```ts
import { createMachine } from "motivo-stateflow";

type UploadContext = { attempts: number; uploaded: boolean };

const context: UploadContext = { attempts: 0, uploaded: false };

const machine = createMachine({
  id: "upload",
  initial: "uploading",
  context,
  states: {
    uploading: {
      on: {
        RETRY: {
          target: "uploading",
          guard: ({ context }) => context.attempts < 3,
          actions: [
            ({ context }) => {
              context.attempts += 1;
            },
          ],
        },
        FAIL: {
          target: "failed",
          guard: ({ context }) => context.attempts >= 3,
        },
        COMPLETE: "done",
      },
    },
    failed: { on: { RETRY: "uploading" } },
    done: {},
  },
});

await machine.send("RETRY");
await machine.send("RETRY");
await machine.send("RETRY");
await machine.send("FAIL");

console.log(machine.state); // "failed"
console.log(machine.context.attempts); // 3
```

### 5. Reacting to state changes

`subscribe()` calls your listener once per **committed** transition, with its own cloned snapshot.
Subscribers are never called for the initial state, for rejected transitions, or for `restore()`.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "order",
  initial: "pending",
  context: { orderId: "order_123" },
  states: {
    pending: { on: { CONFIRM: "confirmed" } },
    confirmed: { on: { SHIP: "shipped" } },
    shipped: {},
  },
});

const unsubscribe = machine.subscribe((snapshot) => {
  console.log(`${snapshot.previous} -> ${snapshot.state} (#${snapshot.revision})`);
});

await machine.send("CONFIRM"); // logs: pending -> confirmed (#1)
await machine.send("SHIP"); // logs: confirmed -> shipped (#2)

unsubscribe();
await machine.send("SHIP").catch(() => undefined); // no log, rejected
```

### 6. Persisting and restoring a machine

Store the snapshot under the id of the business object it belongs to (an order id, a job id, a user
id), and rebuild the machine from the same definition on the next request.

```ts
import { createMachine } from "motivo-stateflow";
import { SnapshotValidationError } from "motivo-stateflow";

type ShipmentContext = { shipmentId: string; carrier: string | null };

// A factory keeps the definition's literal types, so state and event inference stay precise.
const createShipmentMachine = (shipmentId: string) => {
  const context: ShipmentContext = { shipmentId, carrier: null };

  return createMachine({
    id: "shipment",
    initial: "created",
    context,
    states: {
      created: { on: { DISPATCH: "in_transit" } },
      in_transit: { on: { DELIVER: "delivered" } },
      delivered: {},
    },
  });
};

// Persist: store this string under the business id (shipmentId, orderId, ...).
const live = createShipmentMachine("S-9");
await live.send("DISPATCH");
const bytes = JSON.stringify(live.snapshot());

// Later, in another process or request
const resumed = createShipmentMachine("S-9");
try {
  await resumed.restore(JSON.parse(bytes));
  await resumed.send("DELIVER");
  console.log(resumed.state); // "delivered"
} catch (error) {
  if (error instanceof SnapshotValidationError) {
    console.error("stored snapshot is not usable:", error.message);
  }
}
```

`restore()` runs no entry or exit hooks and notifies no subscribers, because restoration is not a
transition. It is also queued behind any pending events, so it can never race one.

### 7. Handling failures

Failures are typed, and they always leave the machine exactly as it was.

```ts
import { createMachine } from "motivo-stateflow";
import {
  GuardRejectedError,
  InvalidEventError,
  InvalidTransitionError,
  StateflowError,
} from "motivo-stateflow";

const machine = createMachine({
  id: "order",
  initial: "pending",
  context: { paymentAuthorized: false },
  states: {
    pending: {
      on: {
        CONFIRM: "confirmed",
        PROCESS: {
          target: "processing",
          guard: ({ context }) => context.paymentAuthorized,
        },
      },
    },
    confirmed: { on: { SHIP: "shipped" } },
    processing: {},
    shipped: {},
  },
});

// A declared event whose guard said no.
await machine.send("PROCESS").catch((error) => {
  console.log(error instanceof GuardRejectedError); // true
});

await machine.send("CONFIRM");

// A declared event that is not accepted in the current state.
await machine.send("PROCESS").catch((error) => {
  console.log(error instanceof InvalidTransitionError); // true
});

// An event that is not declared anywhere.
await machine.send("REFUND" as "CONFIRM").catch((error) => {
  console.log(error instanceof InvalidEventError); // true
});

console.log(machine.state); // "confirmed"
console.log(machine.snapshot().revision); // 1 - every failure committed nothing

// Every library error derives from StateflowError, so one check covers them all.
await machine.send("CANCEL" as "CONFIRM").catch((error) => {
  console.log(error instanceof StateflowError); // true
});
```

If a guard or a hook throws, the original error propagates unchanged - so `try/catch` around your own
code keeps working, and the machine still commits nothing.

### 8. Submitting concurrent events

Events are queued per machine and processed in submission order. Each caller gets the snapshot its own
event produced.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "toggle",
  initial: "off",
  context: { flips: 0 },
  states: {
    off: {
      on: {
        TOGGLE: {
          target: "on",
          actions: [
            ({ context }) => {
              context.flips += 1;
            },
          ],
        },
      },
    },
    on: {
      on: {
        TOGGLE: {
          target: "off",
          actions: [
            ({ context }) => {
              context.flips += 1;
            },
          ],
        },
      },
    },
  },
});

const [first, second, third] = await Promise.all([
  machine.send("TOGGLE"),
  machine.send("TOGGLE"),
  machine.send("TOGGLE"),
]);

console.log([first.state, second.state, third.state]); // ["on", "off", "on"]
console.log(machine.context.flips); // 3
```

A rejected event rejects only its own promise: the queue keeps running, and later events still commit.

### 9. Running several machines

Each machine owns its context and queue. Build one machine per business object - per order, per user,
per job - and they stay independent.

```ts
import { createMachine } from "motivo-stateflow";

// A factory: every call returns a brand-new, fully isolated machine.
const createCounterMachine = () =>
  createMachine({
    id: "counter",
    initial: "counting",
    context: { value: 0 },
    states: {
      counting: {
        on: {
          TICK: {
            target: "counting",
            actions: [
              ({ context }) => {
                context.value += 1;
              },
            ],
          },
        },
      },
    },
  });

const a = createCounterMachine();
const b = createCounterMachine();

await a.send("TICK");

console.log(a.context.value); // 1
console.log(b.context.value); // 0 - independent instances, independent queues

await Promise.all([a.send("TICK"), b.send("TICK"), b.send("TICK")]);
console.log(a.context.value, b.context.value); // 2 2
```

### 10. Testing a machine

Machines are plain objects with no timers and no I/O, so tests are deterministic. Drive them with
events, and use `whenIdle()` instead of sleeps.

```ts
import { describe, expect, it } from "vitest";
import { createMachine, GuardRejectedError } from "motivo-stateflow";

const createOrderMachine = () =>
  createMachine({
    id: "order",
    initial: "pending",
    context: { paymentAuthorized: false },
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

describe("order machine", () => {
  it("blocks processing until payment is authorised", async () => {
    const machine = createOrderMachine();

    await machine.send("CONFIRM");
    await expect(machine.send("PROCESS")).rejects.toBeInstanceOf(GuardRejectedError);
    expect(machine.state).toBe("confirmed");

    await machine.send("SHIP").catch(() => undefined);
    await machine.whenIdle();
    expect(machine.snapshot().revision).toBe(1);
  });
});
```

### 11. Encapsulating a machine in a service

Keep the machine private and expose intention-revealing methods. The service owns persistence and
side effects; the machine owns the rules.

```ts
import { createMachine } from "motivo-stateflow";
import type { Machine } from "motivo-stateflow";

type OrderContext = { orderId: string; paymentAuthorized: boolean };
type OrderState = "pending" | "confirmed" | "processing" | "shipped" | "cancelled";
type OrderEvent = "CONFIRM" | "PROCESS" | "SHIP" | "CANCEL";

export const createOrderMachine = (
  orderId: string,
  paymentAuthorized: boolean,
): Machine<OrderContext, OrderState, OrderEvent> => {
  const context: OrderContext = { orderId, paymentAuthorized };

  return createMachine({
    id: "order",
    initial: "pending",
    context,
    states: {
      pending: { on: { CONFIRM: "confirmed", CANCEL: "cancelled" } },
      confirmed: {
        on: {
          PROCESS: {
            target: "processing",
            guard: ({ context }) => context.paymentAuthorized,
          },
          CANCEL: "cancelled",
        },
      },
      processing: { on: { SHIP: "shipped" } },
      shipped: {},
      cancelled: {},
    },
  });
};

export class OrderService {
  constructor(private readonly machine: Machine<OrderContext, OrderState, OrderEvent>) {}

  get status(): OrderState {
    return this.machine.state;
  }

  /** Resolves with the new status, or rejects with a typed stateflow error. */
  private async advance(event: OrderEvent): Promise<OrderState> {
    await this.machine.send(event);
    return this.machine.state;
  }

  confirm(): Promise<OrderState> {
    return this.advance("CONFIRM");
  }

  process(): Promise<OrderState> {
    return this.advance("PROCESS"); // rejects unless payment was authorised
  }

  ship(): Promise<OrderState> {
    return this.advance("SHIP");
  }
}

const service = new OrderService(createOrderMachine("order_123", true));
await service.confirm();
console.log(await service.process()); // "processing"
console.log(service.status); // "processing"
```

### 12. Gating actions with `can()`

`can()` answers what `send()` would do without doing it, which is what a button, a queue consumer or
a scheduler needs before it offers an action. Nothing is committed, so it is safe to call as often as
you like.

```ts
import { createMachine } from "motivo-stateflow";

const createUploadMachine = (hasQuota: boolean) =>
  createMachine({
    id: "upload",
    initial: "idle",
    context: { hasQuota },
    states: {
      idle: {
        on: { START: { target: "uploading", guard: ({ context }) => context.hasQuota } },
      },
      uploading: { on: { COMPLETE: "done", FAIL: "idle" } },
      done: {},
    },
  });

const machine = createUploadMachine(false);

console.log(machine.getNextEvents()); // ["START"]
console.log(await machine.can("START")); // false: the guard rejects
console.log(machine.state); // "idle", so the machine was never touched

// An event the current state does not declare is false, not an error.
console.log(await machine.can("COMPLETE")); // false

// A machine that can accept the event lets the same gate through.
const ready = createUploadMachine(true);
await ready.send("START");

console.log(ready.getNextEvents()); // ["COMPLETE", "FAIL"]
console.log(await ready.can("COMPLETE")); // true

if (await ready.can("COMPLETE")) {
  await ready.send("COMPLETE");
}
console.log(ready.state); // "done"
```

Drive a UI with the same two calls: `getNextEvents()` for what to render as available, `can()` for
what to enable.

---

## Use cases

### Order fulfillment

The canonical case: a linear process with a validation gate before any work leaves the building.

```ts
import { createMachine } from "motivo-stateflow";

type OrderContext = {
  orderId: string;
  paymentAuthorized: boolean;
  itemsReserved: boolean;
};

const orderContext: OrderContext = {
  orderId: "order_123",
  paymentAuthorized: true,
  itemsReserved: true,
};

export const orderMachine = createMachine({
  id: "order",
  initial: "pending",
  context: orderContext,
  states: {
    pending: {
      on: {
        CONFIRM: {
          target: "confirmed",
          guard: ({ context }) => context.paymentAuthorized,
        },
        CANCEL: "cancelled",
      },
    },
    confirmed: {
      on: {
        RESERVE_STOCK: {
          target: "processing",
          guard: ({ context }) => context.itemsReserved,
        },
        CANCEL: "cancelled",
      },
    },
    processing: { on: { SHIP: "shipped" } },
    shipped: { on: { DELIVER: "delivered" } },
    delivered: {},
    cancelled: {},
  },
});

await orderMachine.send("CONFIRM");
await orderMachine.send("RESERVE_STOCK");
console.log(orderMachine.state); // "processing"
```

**Why it fits:** the fulfillment rules stop being a sequence of `if (order.status ...)` checks spread
across services, and the "cannot ship an unauthorised order" rule is impossible to bypass.

### Payment and subscription lifecycle

Modelling recovery paths (past due, retry, cancel) explicitly is where state machines pay off, because
every recovery edge is named and testable.

```ts
import { createMachine } from "motivo-stateflow";

type SubscriptionContext = {
  subscriptionId: string;
  daysPastDue: number;
  cancelledByUser: boolean;
};

const subscriptionContext: SubscriptionContext = {
  subscriptionId: "sub_42",
  daysPastDue: 0,
  cancelledByUser: false,
};

export const subscriptionMachine = createMachine({
  id: "subscription",
  initial: "trialing",
  context: subscriptionContext,
  states: {
    trialing: { on: { ACTIVATE: "active", EXPIRE: "expired" } },
    active: { on: { PAYMENT_FAILED: "past_due", CANCEL: "cancelled" } },
    past_due: {
      on: {
        RETRY_PAYMENT: {
          target: "past_due",
          guard: ({ context }) => context.daysPastDue < 14,
          actions: [
            ({ context }) => {
              context.daysPastDue += 1;
            },
          ],
        },
        RECOVER: "active",
        CANCEL: "cancelled",
      },
    },
    cancelled: { on: { RESUBSCRIBE: "trialing" } },
    expired: { on: { RESUBSCRIBE: "trialing" } },
  },
});

await subscriptionMachine.send("ACTIVATE");
await subscriptionMachine.send("PAYMENT_FAILED");
await subscriptionMachine.send("RETRY_PAYMENT");
console.log(subscriptionMachine.state, subscriptionMachine.context.daysPastDue); // "past_due" 1
```

**Why it fits:** billing edge cases are the ones teams get wrong. Here "past due" is a state with an
explicit retry counter and an explicit way out, and illegal moves (paying an expired subscription) are
rejected instead of silently corrupting `subscription.status`.

### User onboarding

Multi-step flows need to tolerate steps being skipped or completed out of order, while guaranteeing
that the flow can only finish when everything required is done.

```ts
import { createMachine } from "motivo-stateflow";

type OnboardingContext = {
  userId: string;
  profileComplete: boolean;
  emailVerified: boolean;
  teamInvited: boolean;
};

const onboardingContext: OnboardingContext = {
  userId: "user_7",
  profileComplete: false,
  emailVerified: false,
  teamInvited: false,
};

const allStepsDone = (context: OnboardingContext): boolean =>
  context.profileComplete && context.emailVerified;

export const onboardingMachine = createMachine({
  id: "onboarding",
  initial: "not_started",
  context: onboardingContext,
  states: {
    not_started: { on: { START: "profile" } },
    profile: {
      on: {
        COMPLETE_PROFILE: {
          target: "profile",
          guard: ({ context }) => !context.profileComplete,
          actions: [
            ({ context }) => {
              context.profileComplete = true;
            },
          ],
        },
        NEXT: {
          target: "verify_email",
          guard: ({ context }) => context.profileComplete,
        },
      },
    },
    verify_email: {
      on: {
        VERIFY: {
          target: "verify_email",
          guard: ({ context }) => !context.emailVerified,
          actions: [
            ({ context }) => {
              context.emailVerified = true;
            },
          ],
        },
        NEXT: {
          target: "invite_team",
          guard: ({ context }) => allStepsDone(context),
        },
      },
    },
    invite_team: {
      on: {
        INVITE: {
          target: "invite_team",
          guard: ({ context }) => !context.teamInvited,
          actions: [
            ({ context }) => {
              context.teamInvited = true;
            },
          ],
        },
        FINISH: { target: "completed", guard: ({ context }) => allStepsDone(context) },
      },
    },
    completed: {},
  },
});

await onboardingMachine.send("START");
await onboardingMachine.send("COMPLETE_PROFILE");
await onboardingMachine.send("NEXT");
await onboardingMachine.send("VERIFY");
await onboardingMachine.send("NEXT");
await onboardingMachine.send("FINISH");
console.log(onboardingMachine.state); // "completed"
```

**Why it fits:** "which steps are still missing?" becomes a property of one object instead of a
`completedSteps.includes(...)` convention, and finishing early is impossible by construction.

### Multi-step approval workflow

Sequential human approvals with a rejection that loops back for rework.

```ts
import { createMachine } from "motivo-stateflow";

type ApprovalContext = {
  requestId: string;
  amount: number;
  managerApproved: boolean;
  financeApproved: boolean;
};

const approvalContext: ApprovalContext = {
  requestId: "REQ-3",
  amount: 12_000,
  managerApproved: false,
  financeApproved: false,
};

export const approvalMachine = createMachine({
  id: "approval",
  initial: "draft",
  context: approvalContext,
  states: {
    draft: { on: { SUBMIT: "manager_review" } },
    manager_review: {
      on: {
        APPROVE: {
          target: "finance_review",
          guard: ({ context }) => context.amount > 0,
          actions: [
            ({ context }) => {
              context.managerApproved = true;
            },
          ],
        },
        REQUEST_CHANGES: "draft",
      },
    },
    finance_review: {
      on: {
        APPROVE: {
          target: "approved",
          actions: [
            ({ context }) => {
              context.financeApproved = true;
            },
          ],
        },
        REJECT: "rejected",
      },
    },
    approved: { on: { ARCHIVE: "archived" } },
    rejected: { on: { REOPEN: "draft" } },
    archived: {},
  },
});

await approvalMachine.send("SUBMIT");
await approvalMachine.send("APPROVE"); // manager
await approvalMachine.send("APPROVE"); // finance
console.log(approvalMachine.state); // "approved"
```

**Why it fits:** approvals are the textbook case for "who may do what, in which order". Each role's
allowed action is a transition, the audit trail is the event sequence, and `rejected -> draft` makes
rework a first-class path instead of an exception.

### Background job lifecycle

Long-running jobs need retrying, terminal success, terminal failure and a way to inspect how far they
got.

```ts
import { createMachine } from "motivo-stateflow";

type JobContext = {
  jobId: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
};

const jobContext: JobContext = {
  jobId: "job_88",
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
};

export const jobMachine = createMachine({
  id: "job",
  initial: "queued",
  context: jobContext,
  states: {
    queued: { on: { START: "running", CANCEL: "cancelled" } },
    running: {
      on: {
        SUCCEED: "succeeded",
        FAIL: {
          target: "retrying",
          guard: ({ context }) => context.attempts < context.maxAttempts,
          actions: [
            ({ context }) => {
              context.attempts += 1;
              context.lastError = "transient failure";
            },
          ],
        },
        EXHAUST: {
          target: "failed",
          guard: ({ context }) => context.attempts >= context.maxAttempts,
        },
        CANCEL: "cancelled",
      },
    },
    retrying: { on: { START: "running", CANCEL: "cancelled" } },
    succeeded: {},
    failed: { on: { RETRY: "queued" } },
    cancelled: {},
  },
});

await jobMachine.send("START");
await jobMachine.send("FAIL");
console.log(jobMachine.state, jobMachine.context.attempts); // "retrying" 1
```

**Why it fits:** a job's lifecycle is a graph, not a boolean. Persisting the snapshot between attempts
also gives you resumable jobs without a bespoke progress column.

### Document review loop

Where the same state is revisited repeatedly with different outcomes - the classic "request changes
and come back" cycle.

```ts
import { createMachine } from "motivo-stateflow";

type DocumentContext = {
  documentId: string;
  reviewer: string | null;
  revisions: number;
};

const documentContext: DocumentContext = {
  documentId: "DOC-11",
  reviewer: null,
  revisions: 0,
};

export const documentMachine = createMachine({
  id: "document",
  initial: "draft",
  context: documentContext,
  states: {
    draft: { on: { SUBMIT: "in_review" } },
    in_review: {
      on: {
        REQUEST_CHANGES: {
          target: "changes_requested",
          actions: [
            ({ context }) => {
              context.revisions += 1;
            },
          ],
        },
        APPROVE: "approved",
      },
    },
    changes_requested: { on: { RESUBMIT: "in_review" } },
    approved: { on: { PUBLISH: "published" } },
    published: {},
  },
});

await documentMachine.send("SUBMIT");
await documentMachine.send("REQUEST_CHANGES");
await documentMachine.send("RESUBMIT");
console.log(documentMachine.state, documentMachine.context.revisions); // "in_review" 1
```

**Why it fits:** the loop is explicit, so "how many revision cycles did this take?" is a number in the
context rather than something you reconstruct from an audit log.

### Resumable multi-step application

Long forms often span sessions. Persist the snapshot after every step and resume from the stored
state - the definition guarantees a half-finished application can only continue from where it stopped.

```ts
import { createMachine } from "motivo-stateflow";

type ApplicationContext = {
  applicationId: string;
  personalDetails: boolean;
  documents: boolean;
  employment: boolean;
};

const applicationContext: ApplicationContext = {
  applicationId: "APP-5",
  personalDetails: false,
  documents: false,
  employment: false,
};

export const applicationMachine = createMachine({
  id: "application",
  initial: "personal_details",
  context: applicationContext,
  states: {
    personal_details: {
      on: {
        SAVE: {
          target: "documents",
          actions: [
            ({ context }) => {
              context.personalDetails = true;
            },
          ],
        },
      },
    },
    documents: {
      on: {
        SAVE: {
          target: "employment",
          actions: [
            ({ context }) => {
              context.documents = true;
            },
          ],
        },
        BACK: "personal_details",
      },
    },
    employment: {
      on: {
        SAVE: {
          target: "review",
          actions: [
            ({ context }) => {
              context.employment = true;
            },
          ],
        },
        BACK: "documents",
      },
    },
    review: { on: { SUBMIT: "submitted", BACK: "employment" } },
    submitted: {},
  },
});

// Session 1
await applicationMachine.send("SAVE");
const draft = JSON.stringify(applicationMachine.snapshot());

// Session 2, new runtime
const resumed = createMachine({
  id: "application",
  initial: "personal_details",
  context: { applicationId: "", personalDetails: false, documents: false, employment: false },
  states: {
    personal_details: { on: { SAVE: "documents" } },
    documents: { on: { SAVE: "employment", BACK: "personal_details" } },
    employment: { on: { SAVE: "review", BACK: "documents" } },
    review: { on: { SUBMIT: "submitted", BACK: "employment" } },
    submitted: {},
  },
});

await resumed.restore(JSON.parse(draft));
console.log(resumed.state); // "documents"
```

**Why it fits:** resumption logic is usually written as a chain of `if (form.step === 3)` checks; here
the step *is* the state and it round-trips through storage.

### When not to use a state machine

- **Pure data transformation** with no phases: a function is simpler.
- **A single boolean** that never has transitions: a flag is enough.
- **Long-running orchestration across services with retries, compensation and durability**: the core
  library handles a single in-memory machine. Durable workflow orchestration (checkpointing, saga
  compensation, actor trees, timers) is planned for later releases - see
  [Known limitations and roadmap](#known-limitations-and-roadmap). Today you can layer those concerns
  yourself by persisting snapshots and re-sending events on the next request.

---

## API reference

### `createMachine(definition, options?)`

Returns a machine. The definition is validated eagerly: a malformed definition throws
`MachineConfigurationError` immediately instead of failing during an event.

| Field     | Required | Description                                                                               |
| --------- | -------- | ----------------------------------------------------------------------------------------- |
| `id`      | yes      | Non-empty identifier. Echoed in snapshots and error messages.                              |
| `initial` | yes      | A declared state. The machine starts here.                                                 |
| `context` | yes      | Plain object; must be structured-cloneable. Deep cloned per machine instance.              |
| `events`  | no       | Optional type-only map from event names to payload shapes; use `undefined` for payload-free events. |
| `states`  | yes      | Map of state name to state definition. Every transition target must be a declared state.    |

A top-level `on` map is rejected with `UnsupportedDefinitionKeyError` (`code`:
`ERR_UNSUPPORTED_DEFINITION_KEY`) rather than ignored, because a machine has no state of its own to
transition from: transitions belong to the state that reacts to them. This is a compile error as
well, since the definition type declares `on` as `never`.

#### Machine options

| Option | Type | Description |
| --- | --- | --- |
| `schemaVersion` | `number` (default `2`) | Stamped into every snapshot and checked by `restore()`. Bump it when the context shape or transition graph changes, and old snapshots are rejected instead of applied silently. A stored version of `1`, or none at all, is a 0.1.0 snapshot and is migrated; any other version is refused. |
| `parseContext` | `(input: unknown) => TContext` | Validates and rehydrates a restored context. Must return a valid context or throw; a throw rejects the snapshot with the original error on `cause`. |
| `maxQueueDepth` | `number` (default `Infinity`) | Caps how many submissions may be queued at once. Must be a positive integer. Every submission that queues work counts, including the one currently running; a submission that arrives at the cap is refused with `QueueOverflowError` instead of being queued. |

```ts
import { createMachine } from "motivo-stateflow";

type ReportContext = { generatedAt: Date; label: string };

const context: ReportContext = { generatedAt: new Date(), label: "daily" };

const machine = createMachine(
  {
    id: "report",
    initial: "open",
    context,
    states: { open: { on: { CLOSE: "closed" } }, closed: {} },
  },
  {
    schemaVersion: 2,
    // JSON turns a Date into a string, so put it back before the machine uses the context.
    parseContext: (input) => {
      const raw = input as { generatedAt: string; label: string };
      if (typeof raw.generatedAt !== "string" || typeof raw.label !== "string") {
        throw new Error("stored report context is not the expected shape");
      }
      return { generatedAt: new Date(raw.generatedAt), label: raw.label };
    },
  },
);

console.log(machine.snapshot().schemaVersion); // 2
```

#### State definition

| Field   | Type                                      | Description                                                        |
| ------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `entry` | `ActionFn[]` or `readonly ActionFn[]`     | Actions run when the state is entered (after transition actions).   |
| `exit`  | `ActionFn[]` or `readonly ActionFn[]`     | Actions run when the state is left (before transition actions).     |
| `on`    | `Partial<Record<EventName, Transition>>`  | Events accepted in this state and what they do. Payload events use their `type` name as the key. |
| `initial` | `string`                                | Key of the child entered when this compound state is entered. Required with `states`, rejected without it. |
| `states` | `Record<StateName, StateDefinition>`     | Nested states. Present only on a compound state.                    |

#### Transition forms

| Form | Example | Meaning |
| --- | --- | --- |
| Shorthand | `CONFIRM: "confirmed"` | Unconditional transition to `confirmed`. |
| Object | `PROCESS: { target: "processing", guard, actions }` | Conditional transition with side effects. |
| Targetless | `AUDIT: {}` or `AUDIT: { guard, actions }` | Runs the guard and actions while the configuration stays as it is: nothing is exited and nothing is entered. |
| Self-transition | `RETRY: { target: "counting" }` | Re-enters the named state, so `exit` hooks, actions and `entry` hooks run and a compound state resets to its initial child. |

A target is written in one of three forms:

| Form | Example | Resolves to |
| --- | --- | --- |
| Full path | `"draft.reviewing"` | The named state, read from the top level, wherever it is written. |
| Bare name | `"reviewing"` | The declaring state's own children first, then each enclosing state's children in turn. |
| Relative | `".reviewing"` | A child of the declaring state. Only valid where the state has children. |

Targets are resolved when the machine is created, so an unresolvable one throws
`MachineConfigurationError` immediately rather than failing on an event.

#### Guards, actions and hooks

```ts
import type { ActionFn, GuardContext, GuardFn } from "motivo-stateflow";

type OrderContext = { paymentAuthorized: boolean };

// The value passed to every guard, action and hook:
type OrderArgs = GuardContext<
  OrderContext, // context
  "pending" | "confirmed", // state being left (or entered, for entry hooks)
  "CONFIRM" | "PROCESS" // event
>;

const guard: GuardFn<OrderContext, "pending" | "confirmed", "CONFIRM" | "PROCESS"> = ({ context }) =>
  context.paymentAuthorized;

const action: ActionFn<OrderContext, "pending" | "confirmed", "CONFIRM" | "PROCESS"> = ({
  context,
  state,
  event,
}) => {
  console.log(`${typeof event === "string" ? event : event.type} while leaving ${state}, authorised=${context.paymentAuthorized}`);
};

export const useArgs = (args: OrderArgs): boolean => guard(args) === true || (action(args), true);
```

- A guard that returns `false` rejects the transition with `GuardRejectedError`.
- A guard or action that throws (or rejects) aborts the transition and propagates the original error.
- Actions and hooks may be synchronous or asynchronous; they are awaited in declaration order.
- Inside a definition, `state` and `event` are narrowed to where they are written
  ([Per-state narrowing](#per-state-narrowing)). The signatures above spell out the machine-wide
  unions, which is what you write when a guard is declared on its own.
- **Treat guards as read-only.** The context they receive is mutable and mutations are committed, so
  mutate only in actions and hooks.

#### `Machine`

| Member | Signature | Description |
| --- | --- | --- |
| `id` | `string` | Machine identifier. |
| `state` | `TState` | The committed state, as a full path for a nested machine (`"draft.editing"`). |
| `context` | `TContext` | A fresh clone of the committed context. |
| `send` | `(event: TEvent) => Promise<MachineSnapshot>` | Queues an event. Resolves with the committed snapshot, or rejects with the failure. |
| `can` | `(event: TEvent) => Promise<boolean>` | Queued check of whether the event would commit. Runs the guard, commits nothing. |
| `getNextEvents` | `() => EventNameOf<TEvent>[]` | Event names the active configuration declares, shallowest state first. Synchronous, never runs a guard. |
| `matches` | `(path: TState) => boolean` | True for the active leaf and every state above it; false for an undeclared path. |
| `subscribe` | `(listener: (snapshot) => void) => () => void` | Called once per committed transition. Returns an unsubscribe function. |
| `snapshot` | `() => MachineSnapshot` | Immutable snapshot of the committed state, with a cloned context. |
| `restore` | `(snapshot: unknown) => Promise<MachineSnapshot>` | Validates and applies a serialized snapshot, queued behind pending events. |
| `whenIdle` | `() => Promise<void>` | Resolves when the queue is empty and every submitted event has settled. |
| `toJSON` | `() => MachineSnapshot` | Used by `JSON.stringify(machine)`. |

#### Inspection

Two read-only helpers answer "what can happen next" without changing anything.

`getNextEvents()` is synchronous and structural: the events the committed state declares, in
declaration order, with no guard evaluation. Like `snapshot()`, it reads the committed state without
waiting for queued events. A state with no outgoing transitions returns `[]`.

`can(event)` is asynchronous and guard-aware: it answers what `send()` would do, without performing
the transition. The event has to be declared in the committed state and its guard - synchronous or
asynchronous - has to accept the pending context. No hooks run, no subscriber is notified, the
revision does not move, and the machine stays on its current snapshot. Guards see a staging clone of
the context, so a guard that writes to it cannot reach the machine from here.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "order",
  initial: "pending",
  context: { paymentAuthorized: false },
  states: {
    pending: { on: { CONFIRM: "confirmed" } },
    confirmed: {
      on: { SHIP: { target: "shipped", guard: ({ context }) => context.paymentAuthorized } },
    },
    shipped: {},
  },
});

console.log(machine.getNextEvents()); // ["CONFIRM"]
console.log(await machine.can("SHIP")); // false: "pending" does not declare SHIP

await machine.send("CONFIRM");
console.log(machine.getNextEvents()); // ["SHIP"]
console.log(await machine.can("SHIP")); // false: the guard rejects

// Gating a call has no stale-answer risk:
if (await machine.can("SHIP")) {
  await machine.send("SHIP");
}
```

The check is queued behind pending events, so it evaluates the transition as it would run once
everything already submitted has settled. That is what makes the answer match what `send()` would do
at the same point:

```ts
machine.send("CONFIRM");
// Queued behind the send above, so this asks about "confirmed", not "pending".
const answer = await machine.can("SHIP");
```

Two behaviours are worth knowing before leaning on it:

- An event the committed state does not declare resolves to `false` instead of rejecting, so a
  dynamic caller can ask about anything. A malformed event value still rejects with
  `InvalidEventError`, and a guard that throws rejects with the original error, exactly as `send()` does.
- `can()` runs guards, so a guard with side effects of its own is observable here too. The machine is
  untouched: only the guard runs, and only against a clone.

Because a running check is pending work, `whenIdle()` waits for it.

#### `MachineSnapshot`

| Field      | Type                | Description                                                                     |
| ---------- | ------------------- | ------------------------------------------------------------------------------- |
| `id`       | `string`            | Machine identifier.                                                             |
| `state`    | `TState`            | Committed state path, such as `"draft.editing"` for a nested machine.            |
| `context`  | `TContext`          | Cloned context.                                                                 |
| `event`    | `TEvent \| null`    | The full event value that produced this snapshot, or `null` when none did.      |
| `previous` | `TState \| null`    | The state path before the transition that produced this snapshot, or `null` when no transition did. |
| `revision` | `number`            | Committed transitions on this instance. Never restored from storage.             |
| `done`     | `boolean`           | `true` when no state in the active configuration, in any region, declares an outgoing transition. |
| `schemaVersion` | `number`       | Version stamped by the machine, checked by `restore()`.                          |
| `configuration` | `readonly TState[]` | Active atomic state paths, in document order. The authoritative view of the configuration, and the only field that expresses a parallel state. |
| `history`  | `Readonly<Record<string, readonly TState[]>>` | Configuration remembered per history pseudo-state path, empty for a machine with no history. |

The snapshots returned by `send()` and delivered to subscribers describe the transition that produced
them, so `event` and `previous` are filled in. Snapshots from `machine.snapshot()`, `toJSON()` and
`restore()` are reads of a committed state rather than the result of a transition, so both fields are
`null` there.

#### Exported errors

| Error | `code` | Raised when |
| --- | --- | --- |
| `StateflowError` | - | Base class for every library error. |
| `MachineConfigurationError` | - | The definition is malformed, or the context/event payload cannot be cloned. |
| `UnsupportedDefinitionKeyError` | `ERR_UNSUPPORTED_DEFINITION_KEY` | The definition declares a top-level `on`; its `key` reports the field. |
| `UnsupportedTransitionTypeError` | `ERR_UNSUPPORTED_TRANSITION_TYPE` | A transition declares `type`; internal transitions are not implemented. |
| `InvalidEventError` | - | The event is malformed or declared nowhere in the machine. |
| `InvalidTransitionError` | - | The event is declared but not accepted in the current state. |
| `GuardRejectedError` | - | A guard returned `false`. |
| `QueueOverflowError` | - | A submission arrived while the queue was already at `maxQueueDepth`. |
| `SnapshotValidationError` | - | `restore()` received a malformed snapshot. |
| `UnsupportedSnapshotVersionError` | `ERR_UNSUPPORTED_SNAPSHOT_VERSION` | `restore()` received a snapshot format version it does not know; `receivedVersion` reports it. |

Every error extends `StateflowError`, and the errors raised while reading a definition or a snapshot
extend `MachineConfigurationError` and `SnapshotValidationError` respectively, so handling by class
keeps working when a new specific error is added. Switch on `code` when the wording of a message
must not matter.

---

## Semantics

### Event processing order

For each accepted event, the engine runs exactly these steps:

1. Event validation (unknown event vs. event not accepted in the current state).
2. Guard evaluation (awaited; sync and async guards behave identically).
3. Exit hooks of the current state, in declaration order.
4. Transition actions, in declaration order.
5. Entry hooks of the target state, in declaration order.
6. Snapshot commitment (state, context and revision).
7. Subscriber notification, in subscription order.

Steps 1-5 run against staged values. Nothing is committed and nobody is notified until step 6, so a
failure in any earlier step leaves the machine exactly as it was, and failed operations can never
produce a partially committed snapshot or a duplicate notification.

Two consequences worth knowing:

- Inside a guard, action or hook, `args.state` is the authoritative view. `machine.state` and
  `machine.snapshot()` still report the **previous** committed state until the commit in step 6.
- External side effects performed in hooks are **not** rolled back. The library guarantees the
  machine's own state, context and notifications stay consistent; design hooks to be idempotent when
  they call out to other systems.

### Failure behaviour

| Situation | Outcome |
| --- | --- |
| Event declared nowhere | `InvalidEventError`; nothing committed. |
| Event declared, not accepted in this state | `InvalidTransitionError`; nothing committed. |
| Guard returns `false` | `GuardRejectedError`; nothing committed. |
| Guard throws or rejects | The original error propagates; nothing committed. |
| Exit hook, action or entry hook throws or rejects | The original error propagates; nothing committed. |
| An action makes the context unclonable | `MachineConfigurationError`; nothing committed. |
| Malformed snapshot passed to `restore()` | `SnapshotValidationError`; the machine is untouched. |

### Deterministic event processing

- Events are processed **FIFO**, in submission order, per machine instance.
- Events submitted while another event is processing are **queued**, not rejected or dropped.
- The queue is unbounded unless `maxQueueDepth` is set, and `whenIdle()` waits for it to drain (see
  [Queue depth and backpressure](#queue-depth-and-backpressure)).
- A rejected event rejects **only its own caller's promise**. The queue is never poisoned, and later
  events - including the same event submitted again - still run.
- Each transition commits before the next queued event runs, so guards and hooks always observe the
  state committed by the previous event, never a stale snapshot.
- Notification happens inside the same queue slot as the commit, so notification order always matches
  commit order.

A `send()` whose promise nobody awaits is safe (it will not crash the process), but its failure is
then silent. Await it, or subscribe/inspect to observe outcomes.

### Queue depth and backpressure

The queue is unbounded by default, so a burst of submissions is accepted and processed in order. A
machine that must not accumulate work can cap it:

```ts
import { QueueOverflowError, createMachine } from "motivo-stateflow";

const machine = createMachine(
  {
    id: "ingest",
    initial: "open",
    context: { accepted: 0 },
    states: {
      open: {
        on: {
          PUSH: {
            actions: [
              ({ context }) => {
                context.accepted += 1;
              },
            ],
          },
        },
      },
    },
  },
  { maxQueueDepth: 2 },
);

machine.send("PUSH"); // queued
machine.send("PUSH"); // queued

try {
  await machine.send("PUSH"); // refused: two submissions are already queued
} catch (error) {
  if (error instanceof QueueOverflowError) {
    await machine.whenIdle(); // drained, so there is room again
    await machine.send("PUSH");
  }
}

console.log(machine.context.accepted); // 3
```

The cap counts every submission that queues work - `send()`, `can()` and `restore()` - including the
one currently running, so `maxQueueDepth: 1` means one submission in flight.

A refused submission fails fast. It is not queued, so it takes no turn, reaches no guard and no hook,
and changes nothing; the submissions already queued still run, in order. Waiting for room is the
caller's job: `whenIdle()` resolves once the queue has drained, which is exactly when a slot is free.

### Context

- The initial context is deep cloned at creation, so machines never share mutable state - even when
  created from the same definition object.
- Each transition receives a staged clone in `args.context`. Mutating it stages an update that is
  committed atomically with the transition, or discarded if anything fails.
- `machine.context`, `machine.snapshot()` and every notification hand out separate clones, so callers
  cannot corrupt internal state.
- Context must be a plain object and structured-cloneable.

**Typing the context.** Annotating the context value keeps the machine's context type exactly as
declared and stays mutable inside hooks:

```ts
import { createMachine } from "motivo-stateflow";

type OrderContext = { orderId: string; paymentAuthorized: boolean };

const context: OrderContext = { orderId: "order_123", paymentAuthorized: false };
const machine = createMachine({
  id: "order",
  initial: "pending",
  context,
  states: { pending: { on: { CONFIRM: "confirmed" } }, confirmed: {} },
});

console.log(machine.state); // "pending"
```

An inline literal without `satisfies` is widened (`false` becomes `boolean`), which also works. Note
that `satisfies` **preserves literal types**, so `{ paymentAuthorized: false } satisfies OrderContext`
infers `paymentAuthorized: false` and assigning `true` inside a hook becomes a type error. Use the
annotated form when hooks reassign boolean or numeric fields.

### Subscriptions

- `subscribe(listener)` returns an unsubscribe function that removes exactly that subscription.
- Subscribing the same function twice creates two independent subscriptions: the listener runs twice
  per commit, and unsubscribing once leaves the other active.
- Subscribers receive committed transitions only - never the initial state, rejected transitions or
  `restore()`.
- Each notification carries its own cloned snapshot.
- A throwing subscriber is isolated: it cannot corrupt machine state, suppress other subscribers or
  stall the queue.
- Unsubscribing during a notification is safe.

### Snapshots and restoration

- `restore()` validates the snapshot: unknown fields are ignored, while a non-object input, a
  mismatched `id`, an undeclared state (including prototype names such as `toString`), a missing or
  non-plain-object context, an unclonable context, and a `schemaVersion` that does not match the
  machine all reject with `SnapshotValidationError`. A snapshot with no `schemaVersion` was written
  before versioning existed and is still accepted.
- `restore()` is queued behind pending events, so it can never race an in-flight transition.
- `restore()` runs no lifecycle hooks and notifies no subscribers, because restoration is not a
  transition.
- `revision` is machine-local and is never taken from the stored snapshot.
- Only the snapshot is serialized. Functions (guards, actions, hooks) belong to the definition, which
  must be identical when you restore.
- The stored context is validated by shape only, unless the machine was created with a
  `parseContext` option. That validator receives the raw stored value and must return a valid
  context or throw; a throw rejects the snapshot with the original error on `cause`. It is the place
  to rebuild values that JSON cannot carry, such as `Date` or `Map`:

```ts
import { createMachine } from "motivo-stateflow";

type OrderContext = { orderId: string; placedAt: Date };

const context: OrderContext = { orderId: "order_123", placedAt: new Date() };

const machine = createMachine(
  {
    id: "order",
    initial: "pending",
    context,
    states: { pending: { on: { CONFIRM: "confirmed" } }, confirmed: {} },
  },
  {
    schemaVersion: 2,
    // JSON stores a Date as a string, so rebuild it before the machine uses the context.
    parseContext: (input) => {
      const raw = input as { orderId: string; placedAt: string };
      return { orderId: raw.orderId, placedAt: new Date(raw.placedAt) };
    },
  },
);

console.log(machine.snapshot().schemaVersion); // 2
```

Restoring a snapshot is not event sourcing; an event log and replay are out of scope.

### Prototype safety

Transitions live in `Map`s and all definition lookups use own-property checks. Events such as
`toString`, `constructor`, `valueOf` or `__proto__` are **not** resolved as transitions unless you
declare them explicitly, and state or target names that collide with `Object.prototype` members work
correctly.

---

## Type safety

State names, event names and the context shape are inferred from the definition:

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
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

// Inferred: "pending" | "confirmed" | "processing" | "shipped"
const state: "pending" | "confirmed" | "processing" | "shipped" = machine.state;

// Inferred: "CONFIRM" | "PROCESS" | "SHIP"
const event: "CONFIRM" | "PROCESS" | "SHIP" = "CONFIRM";
await machine.send(event);

// @ts-expect-error "UNKNOWN" is not an event of this machine
await machine.send("UNKNOWN").catch(() => undefined);

// @ts-expect-error "ghost" is not a declared state
const buildInvalid = () => createMachine({ id: "x", initial: "pending", context: {}, states: { pending: { on: { GO: "ghost" } } } });
void buildInvalid;

console.log(state); // "pending"
```

What the compiler enforces:

- The **state union is the complete `states` tree**: every declared path is valid, including a
  state that no transition targets (an entry-only, planned or unreachable state).
- Unknown event names are rejected at the call site.
- The `events` map declares payload shapes. Payload-free events accept string shorthand; payload
  events require `{ type, ...payload }` with the declared fields.
- `initial` and every transition target (shorthand and object form) must be a declared state.
- Guards, actions and hooks receive the typed context, plus the state and event they are narrowed
  to (see [Per-state narrowing](#per-state-narrowing)). For a nested machine the narrowed state is
  the full path, such as `"draft.editing"`.
- The state union is the declared state paths, so `machine.state`, `matches(path)`, snapshots and
  `restore()` results use paths derived recursively from the definition.
- The context type flows into guards, actions, hooks, snapshots and subscribers.

### Per-state narrowing

Everything you declare inside a state is narrowed to that state, so the compiler rejects a reach
that the runtime could never take:

- `state` is the state that declares the hook, guard or action. A guard written in `confirmed` sees
  `"confirmed"`, so comparing it against `"pending"` is a compile error.
- `event` is the full event value for the transition. A guard under `CONFIRM` sees `"CONFIRM"` for
  a payload-free event, or the typed `{ type: "CONFIRM", ...payload }` object when it has payloads.
- Entry and exit hooks receive the machine-wide event union, because more than one transition can
  lead into a state, while their `state` is still the state that declares them.

```ts
import { createMachine } from "motivo-stateflow";

const machine = createMachine({
  id: "order",
  initial: "pending",
  context: { paymentAuthorized: false },
  states: {
    pending: {
      on: {
        CONFIRM: {
          target: "confirmed",
          guard: ({ state, event }) => {
            // state is "pending", event is "CONFIRM"
            return state === "pending" && event === "CONFIRM";
          },
        },
      },
    },
    confirmed: {
      entry: [
        ({ state }) => {
          // state is "confirmed"
          console.log(`entered ${state}`);
        },
      ],
      on: {
        SHIP: {
          target: "shipped",
          guard: ({ state }) => {
            // @ts-expect-error a guard declared in "confirmed" only ever runs in "confirmed"
            return state === "pending";
          },
        },
      },
    },
    shipped: {},
  },
});

console.log(machine.state); // "pending"
```

Nothing about this changes the runtime behaviour: it is the same transition engine, with the types
tightened to say exactly what it does.

### Keeping the union precise

The state and event unions are built from the keys of your definition, so the definition has to keep
its literal types. An inline object literal does this automatically. A definition held in a mutable
variable widens (`initial` and every target become `string`), which leaves the compiler nothing to
check against the union, so hold it in one of these forms instead:

- `satisfies MachineDefinition<...>`, which validates the shape and keeps the literals.
- An annotation, `const definition: MachineDefinition<...> = { ... }`, where the type arguments
  supply the unions.
- `as const`, which is accepted because hook and action lists may be readonly arrays.
- A factory function, because a returned object literal keeps its literals.

```ts
import { createMachine } from "motivo-stateflow";
import type { MachineDefinition } from "motivo-stateflow";

type OrderContext = Record<string, never>;
type OrderState = "pending" | "confirmed";
type OrderEvent = "CONFIRM";

const definition = {
  id: "order",
  initial: "pending",
  context: {},
  states: {
    pending: { on: { CONFIRM: "confirmed" } },
    confirmed: {},
  },
} satisfies MachineDefinition<OrderContext, OrderState, OrderEvent>;

const machine = createMachine(definition);
const state: OrderState = machine.state;

console.log(state); // "pending"
```

A factory function works too, because a returned object literal keeps its literals:

```ts
import { createMachine } from "motivo-stateflow";

const createOrderMachine = () =>
  createMachine({
    id: "order",
    initial: "pending",
    context: {},
    states: { pending: { on: { CONFIRM: "confirmed" } }, confirmed: {} },
  });

const machine = createOrderMachine();
const state: "pending" | "confirmed" = machine.state;

console.log(state); // "pending"
```

Annotating the definition in a variable requires the published types to reference `NoInfer`, so
consumers need **TypeScript 5.4 or newer**. The published declarations are verified against the
floor, the development version and the latest release by `pnpm test:consumer`, which installs the
packed tarball into a throwaway project and type checks it with `skipLibCheck` disabled.

What stays a runtime concern (and is covered by validation + tests):

- Which events are accepted in *which* state for callers the compiler cannot see, such as plain
  JavaScript, or data arriving from the network. Typed callers are covered by the compiler, and
  everyone else by `can()` and `getNextEvents()` (see [Inspection](#inspection)).
- State-dependent context rules (`can only ship after payment`).
- Anything arriving from the network, storage or plain JavaScript.

---

## Known limitations and roadmap

Current release: **0.1.0**. Known constraints, stated plainly:

| Constraint | Detail |
| --- | --- |
| Parallel regions and history | Flat, compound and parallel states are supported, with shallow and deep history pseudo-states. Internal transitions, raised events and delayed events are not. |
| No internal transitions | Every transition is external: a state that declares a transition is exited and re-entered, even when the target is inside it. A transition declaration that carries `type` is rejected, so the field stays reserved. To reset one region of a parallel state without disturbing its siblings, declare the transition on a state inside that region and target a state inside that region as well. |
| No delayed transitions or timers | There is no `after`/`delay` support and no clock injection. Schedule externally and `send()` when the time comes. |
| No actor composition | One machine per process object; invoking child machines is on the roadmap. |
| No durable execution | Snapshots can be persisted and restored, but there is no checkpointing, lease/ownership, or recovery loop. |
| Unbounded queue by default | The queue grows without limit unless `maxQueueDepth` is set. There is no signal when the queue is getting deep; `whenIdle()` is the only queue control. |
| Guards run in `can()` | `can()` evaluates the guard to answer, so side effects inside a guard are observable during a check. The machine itself is never modified. |
| Context must be plain and cloneable | `Date`, `Map` and `Set` survive cloning, but class instances lose their prototype and accessor properties are evaluated once at creation. Keep domain behaviour outside the context. |
| Serialization is JSON-shaped | Non-JSON values (`bigint`, cyclic structures) make `JSON.stringify` throw, and `restore()` validates shape rather than your context's TypeScript type. Pass a `parseContext` option to validate and rehydrate the stored context; without it, a value of the wrong type can still be restored. `schemaVersion` rejects snapshots written by a different version of the machine. |
| ESM-only | CommonJS must use `require`-of-ESM support or a dynamic `import()`. |
| Minified class names | The published bundle mangles class identifiers, so the static `SomeError.name` is unreliable. Use `instanceof` and the instance's `error.name` - the constructors always set it correctly. |
| Type inference | The state union follows the `states` map keys, so a state that nothing targets is still a valid declared state. The union therefore depends on literal types: a definition stored in a mutable variable needs `satisfies`, an annotation, `as const` or a factory (see [Keeping the union precise](#keeping-the-union-precise)). |

Planned evolution (subject to change), aiming to keep the 0.1.0 API and semantics intact:

1. **Internal transitions** - `type: "internal" | "external"` on a transition, so a state can react
   without being exited and re-entered. The field is reserved and currently rejected.
2. **Extensibility groundwork** - compiled machine IR, injectable clock/randomness, richer error
   taxonomy, inspection records.
3. **Advanced states** - raised and delayed events, final states and completion events.
4. **Actors and composition** - spawned child machines, message routing, supervision.
5. **Workflow layer** - multi-machine sagas with compensation and human tasks.
6. **Durable execution** - stores, checkpointing, recovery, migrations.
7. **Tooling** - CLI, graph analysis, visualization, model-based testing, framework adapters.

---

## Development

```bash
pnpm install
pnpm test          # unit tests (Vitest) + compile-time tests + tsc --noEmit
pnpm test:coverage # the same suite with the coverage thresholds enforced
pnpm test:consumer # packs the package and type checks a consumer per TypeScript version
pnpm lint          # ESLint
pnpm build         # tsup ESM bundle with declarations and source maps
pnpm smoke         # imports the built package as a consumer would
pnpm check         # lint + test + coverage + build + smoke + consumer verification
```

The suite is organised into focused files:

| Suite                         | Covers                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| `tests/creation.test.ts`      | Machine creation, definition validation, snapshot shape.                   |
| `tests/transitions.test.ts`   | Transitions, event resolution, terminal states, self-transitions.          |
| `tests/nested.test.ts`        | Compound states: paths, target forms, bubbling, ordering across levels, `matches()`. |
| `tests/parallel.test.ts`      | Parallel regions: configuration reporting, per-region selection, conflict resolution, exit sets, microstep atomicity. |
| `tests/history.test.ts`       | History pseudo-states: shallow and deep memory, default targets, capture on exit, serialization. |
| `tests/ordering.test.ts`      | Exit, action and entry ordering across the source-to-target path, including the least common ancestor. |
| `tests/guards.test.ts`        | Sync/async guards, argument shape, rejection, stale-state protection.      |
| `tests/actions.test.ts`       | Hook ordering, async hooks, failure atomicity, context updates.            |
| `tests/inspection.test.ts`    | `can()` and `getNextEvents()`: guard evaluation, queue ordering, read-only guarantees. |
| `tests/concurrency.test.ts`   | FIFO ordering, queue recovery, `whenIdle()`, queue depth, notification ordering. |
| `tests/subscriptions.test.ts` | Notification timing, unsubscription, subscriber isolation.                |
| `tests/snapshots.test.ts`     | Serialization, restoration validation, immutability, queued restoration.   |
| `tests/isolation.test.ts`     | Instance isolation, nested context, unusual identifiers, resilience.       |
| `tests/regressions.test.ts`   | Defects reported against earlier revisions.                               |
| `tests/runtime-fallbacks.test.ts` | The JSON clone fallback and error rendering when value conversion throws. |
| `tests/events.test.ts`       | Typed payload propagation through guards, actions, hooks, async work and snapshots. |
| `tests/properties.test.ts`    | fast-check invariants over generated event sequences.                      |
| `tests/types.test-d.ts`       | Compile-time inference, payload validation and nested path rejection tests. |

Property tests assert invariants such as "the state is always declared", "rejected transitions never
commit", "the same sequence produces the same result", "instances stay isolated", "failed events do
not corrupt later processing" and "restoration preserves invariants". Failures print a reproducible
seed and a shrunk counterexample.

## Project structure

```
src/
  index.ts     public entry point
  machine.ts   engine: validation, queue, transitions, snapshots
  types.ts     public types (Machine, MachineSnapshot, hooks)
  errors.ts    error hierarchy
scripts/
  smoke-test.mjs  verifies the built package can be imported and used
tests/         focused Vitest suites, type tests and property tests
examples/      (planned) runnable end-to-end examples
.github/       CI workflow
```

Hooks run sequentially and are awaited, so tests need no timing assumptions: use `whenIdle()` and
explicit promises rather than sleeps.

## Publishing

1. `pnpm check` must pass.
2. `pnpm build`, then publish with the `files` allow-list already configured:
   `npm publish --access public`.
3. Tag the release in the `motivo-stateflow` repository and add release notes.

## License

MIT
