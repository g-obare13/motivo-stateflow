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

describe("parallel configurations and restoration", () => {
  /**
   * Two regions, one of them parallel itself, plus a deep history pseudo-state, so a generated
   * sequence exercises selection, conflict resolution, nested configurations and memory.
   */
  const buildParallelMachine = () =>
    createMachine({
      id: "parallel-props",
      initial: "work",
      context: { touched: 0 },
      states: {
        work: {
          type: "parallel",
          on: { STOP: "stopped" },
          states: {
            alpha: {
              initial: "a1",
              states: { a1: { on: { NEXT_A: "a2" } }, a2: { on: { NEXT_A: "a1" } } },
            },
            beta: {
              type: "parallel",
              states: {
                inner: { initial: "b1", states: { b1: { on: { NEXT_B: "b2" } }, b2: {} } },
                other: { initial: "c1", states: { c1: { on: { NEXT_C: "c2" } }, c2: {} } },
              },
            },
            memory: { type: "history", history: "deep" },
          },
        },
        stopped: { on: { RESUME: "work.memory", RESTART: "work" } },
      },
    });

  const PARALLEL_EVENTS = [
    "NEXT_A",
    "NEXT_B",
    "NEXT_C",
    "STOP",
    "RESUME",
    "RESTART",
    "ABSENT",
  ] as const;

  type ParallelEvent = (typeof PARALLEL_EVENTS)[number];

  /** The events every generated sequence is drawn from, including one the machine never declares. */
  const isDeclared = (event: string): boolean => event !== "ABSENT";

  const parallelSequence = () => fc.array(fc.constantFrom(...PARALLEL_EVENTS), { maxLength: 18 });

  /** Applies a sequence, swallowing rejections, which are part of the generated input space. */
  const applyParallelSequence = async (
    machine: ReturnType<typeof buildParallelMachine>,
    events: readonly string[],
  ): Promise<void> => {
    for (const event of events) {
      if (!isDeclared(event)) {
        // Deliberately undeclared, so it can only be submitted through the untyped entry point.
        await machine.send(asEvent<never>(event)).catch(() => undefined);
        continue;
      }
      try {
        await machine.send(asEvent<DeclaredEvent>(event));
      } catch {
        // Rejected events are expected.
      }
    }
  };

  /** The events the machine actually declares, used where a real submission must type-check. */
  type DeclaredEvent = Exclude<ParallelEvent, "ABSENT">;

  /** Runs one event and reports the outcome, so two machines can be compared. */
  const settle = async (
    machine: ReturnType<typeof buildParallelMachine>,
    event: DeclaredEvent,
  ): Promise<unknown> => {
    try {
      const snapshot = await machine.send(asEvent<DeclaredEvent>(event));
      return {
        state: snapshot.state,
        configuration: [...snapshot.configuration],
        context: snapshot.context,
      };
    } catch (error) {
      return { rejected: (error as Error).name };
    }
  };

  it("always keeps the active configuration legal and consistently reported", async () => {
    await fc.assert(
      fc.asyncProperty(parallelSequence(), async (events) => {
        const machine = buildParallelMachine();
        await applyParallelSequence(machine, events);

        const configuration = [...machine.configuration];

        // Exactly one top-level state is active, and no leaf is reported twice.
        expect(configuration.length).toBeGreaterThan(0);
        expect(new Set(configuration).size).toBe(configuration.length);

        // Every reported leaf is an atomic state of the machine, and every active parallel state
        // has all of its regions active.
        for (const path of configuration) {
          expect(machine.matches(path)).toBe(true);
        }
        if (machine.matches("work")) {
          expect(configuration).toHaveLength(3);
          expect(configuration.every((path) => path.startsWith("work."))).toBe(true);
        } else {
          expect(configuration).toEqual(["stopped"]);
        }

        // `state` is the deepest active state containing the whole configuration.
        expect(machine.state).toBe(configuration.length === 1 ? configuration[0] : "work");

        // The snapshot agrees with the machine, and the reachable events follow the configuration:
        // `STOP` is declared on the parallel state, which is active whenever `work` is.
        const snapshot = machine.snapshot();
        expect(snapshot.configuration).toEqual(configuration);
        for (const path of configuration) {
          expect(machine.matches(path)).toBe(true);
        }

        if (machine.matches("work")) {
          expect(machine.getNextEvents()).toContain("STOP");
          expect(machine.getNextEvents()).not.toContain("ABSENT");
          expect(new Set(machine.getNextEvents()).size).toBe(machine.getNextEvents().length);
          await expect(machine.can("STOP")).resolves.toBe(true);
        } else {
          expect(machine.getNextEvents()).toEqual(["RESUME", "RESTART"]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("restores a serialized snapshot into an indistinguishable machine", async () => {
    await fc.assert(
      fc.asyncProperty(parallelSequence(), async (events) => {
        const original = buildParallelMachine();
        await applyParallelSequence(original, events);

        const resumed = buildParallelMachine();
        await resumed.restore(JSON.parse(JSON.stringify(original)));

        expect([...resumed.configuration]).toEqual([...original.configuration]);
        expect(resumed.context).toEqual(original.context);
        expect(resumed.snapshot().done).toBe(original.snapshot().done);
        expect(resumed.snapshot().history).toEqual(original.snapshot().history);
        expect(resumed.getNextEvents()).toEqual(original.getNextEvents());
        expect(resumed.snapshot().configuration).toEqual(original.snapshot().configuration);

        // The restored machine answers the next event exactly as the original does.
        for (const probe of ["NEXT_A", "NEXT_B", "NEXT_C", "STOP", "RESUME"] as const) {
          const left = buildParallelMachine();
          const right = buildParallelMachine();
          await left.restore(JSON.parse(JSON.stringify(original)));
          await right.restore(JSON.parse(JSON.stringify(original)));
          expect(await settle(right, probe)).toEqual(await settle(left, probe));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});