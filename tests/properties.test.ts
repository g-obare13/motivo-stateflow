/**
 * Property-based tests.
 *
 * Invariants are checked over generated event sequences so that whole classes of ordering and
 * atomicity bugs are covered without hand-written cases. fast-check prints a reproducible seed
 * and a shrunk counterexample whenever an invariant fails.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMachine } from "../src/index.js";
import { asEvent } from "./helpers.js";

/** Simulated background job lifecycle with a self-transition that counts executions. */
const buildJobMachine = () =>
  createMachine({
    id: "job",
    initial: "idle",
    context: { executions: 0 },
    states: {
      idle: { on: { START: "running", RESET: "idle", FORCE: { target: "idle", guard: () => false } } },
      running: {
        on: {
          PAUSE: "paused",
          STOP: "done",
          FORCE: {
            target: "idle",
            guard: () => false,
          },
          START: {
            target: "running",
            actions: [({ context }) => {
              context.executions += 1;
            }],
          },
        },
      },
      paused: { on: { START: "running", RESET: "idle", FORCE: { target: "idle", guard: () => false } } },
      done: { on: { RESET: "idle", FORCE: { target: "idle", guard: () => false } } },
    },
  });

const EVENTS = ["START", "PAUSE", "STOP", "RESET"] as const;

/** Every event name declared by the job machine, including the always-rejecting `FORCE`. */
type Event = (typeof EVENTS)[number] | "FORCE";

const DECLARED_STATES = ["idle", "running", "paused", "done"];

const eventSequence = () => fc.array(fc.constantFrom(...EVENTS), { maxLength: 20 });

/** Applies a sequence, swallowing rejections, and reports how many events were committed. */
const applySequence = async (
  machine: ReturnType<typeof buildJobMachine>,
  events: readonly string[],
): Promise<number> => {
  let committed = 0;
  for (const event of events) {
    try {
      await machine.send(asEvent<Event>(event));
      committed += 1;
    } catch {
      // Rejected events are part of the generated input space.
    }
  }
  return committed;
};

const NUM_RUNS = 40;

describe("invariants", () => {
  it("always keeps the machine in a declared state", async () => {
    await fc.assert(
      fc.asyncProperty(eventSequence(), async (events) => {
        const machine = buildJobMachine();
        const committed = await applySequence(machine, events);

        expect(DECLARED_STATES).toContain(machine.state);
        expect(machine.snapshot().revision).toBe(committed);
        expect(machine.snapshot().state).toBe(machine.state);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("never commits a rejected transition", async () => {
    const undeclaredEvents = ["NOPE", "toString", "constructor", "hasOwnProperty", ""];

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...undeclaredEvents), async (event) => {
        const machine = buildJobMachine();
        const before = machine.snapshot();

        await expect(machine.send(asEvent<Event>(event))).rejects.toThrow();

        expect(machine.snapshot()).toEqual(before);
        expect(machine.state).toBe("idle");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("never commits an event that the current state does not accept", async () => {
    await fc.assert(
      fc.asyncProperty(eventSequence(), async (events) => {
        const machine = buildJobMachine();

        for (const event of events) {
          const before = machine.snapshot();
          try {
            await machine.send(asEvent<Event>(event));
          } catch {
            expect(machine.snapshot()).toEqual(before);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("processes the same sequence deterministically", async () => {
    await fc.assert(
      fc.asyncProperty(eventSequence(), async (events) => {
        const first = buildJobMachine();
        const second = buildJobMachine();

        await applySequence(first, events);
        await applySequence(second, events);

        expect(first.state).toBe(second.state);
        expect(first.context).toEqual(second.context);
        expect(first.snapshot().revision).toBe(second.snapshot().revision);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("keeps independent machines isolated", async () => {
    await fc.assert(
      fc.asyncProperty(eventSequence(), eventSequence(), async (firstEvents, secondEvents) => {
        const first = buildJobMachine();
        const second = buildJobMachine();

        await applySequence(first, firstEvents);
        const firstSnapshot = first.snapshot();

        await applySequence(second, secondEvents);

        expect(first.snapshot()).toEqual(firstSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("does not let failed events corrupt later processing", async () => {
    // The failure set covers all four documented failure modes: unrecognised events,
    // prototype-named events, events not allowed in the current state, and guard rejection.
    const failures = ["NOPE", "toString", "notAnEvent", "FORCE", "PAUSE", "STOP"];

    await fc.assert(
      fc.asyncProperty(
        eventSequence(),
        fc.array(fc.constantFrom(...failures), { maxLength: 5 }),
        async (events, rejected) => {
          const interrupted = buildJobMachine();
          const control = buildJobMachine();

          for (const event of rejected) {
            await expect(interrupted.send(asEvent<Event>(event))).rejects.toThrow();
          }

          const interruptedCommitted = await applySequence(interrupted, events);
          const controlCommitted = await applySequence(control, events);

          expect(interruptedCommitted).toBe(controlCommitted);
          expect(interrupted.state).toBe(control.state);
          expect(interrupted.context).toEqual(control.context);
          expect(interrupted.snapshot().revision).toBe(control.snapshot().revision);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("preserves invariants across serialization and restoration", async () => {
    const continueAfter: Record<string, { event: Event; next: string }> = {
      idle: { event: "RESET", next: "idle" },
      running: { event: "STOP", next: "done" },
      paused: { event: "RESET", next: "idle" },
      done: { event: "RESET", next: "idle" },
    };

    await fc.assert(
      fc.asyncProperty(eventSequence(), async (events) => {
        const source = buildJobMachine();
        await applySequence(source, events);

        const serialized = JSON.parse(JSON.stringify(source.snapshot())) as unknown;
        const restored = buildJobMachine();
        await restored.restore(serialized);

        expect(DECLARED_STATES).toContain(restored.state);
        expect(restored.state).toBe(source.state);
        expect(restored.context).toEqual(source.context);

        const continuation = continueAfter[restored.state]!;
        const snapshot = await restored.send(continuation.event);

        expect(snapshot.previous).toBe(source.state);
        expect(restored.state).toBe(continuation.next);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
