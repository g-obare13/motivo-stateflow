/**
 * Typed event object runtime behavior: guards, actions, lifecycle hooks, inspection, snapshots
 * and preservation of submitted payloads across queued asynchronous work.
 */

import { describe, expect, it } from "vitest";
import { createMachine } from "../src/index.js";
import { deferred } from "./helpers.js";

describe("event payloads", () => {
  it("passes the complete event through guards, hooks, actions and snapshots", async () => {
    const exitStarted = deferred<void>();
    const continueExit = deferred<void>();
    const actionStarted = deferred<void>();
    const continueAction = deferred<void>();
    const observed: string[] = [];

    const machine = createMachine({
      id: "event-payloads",
      initial: "waiting",
      context: { amount: 0 },
      events: {} as { ADD: { amount: number }; RESET: undefined },
      states: {
        waiting: {
          exit: [
            async ({ event }) => {
              if (typeof event !== "string") {
                exitStarted.resolve();
                await continueExit.promise;
                observed.push(`exit:${event.amount}`);
              }
            },
          ],
          on: {
            ADD: {
              target: "complete",
              guard: ({ event }) => {
                observed.push(`guard:${event.amount}`);
                return event.amount > 0;
              },
              actions: [
                async ({ context, event }) => {
                  actionStarted.resolve();
                  await continueAction.promise;
                  context.amount = event.amount;
                  observed.push(`action:${event.amount}`);
                },
              ],
            },
            RESET: "waiting",
          },
        },
        complete: {
          entry: [
            ({ event }) => {
              if (typeof event !== "string") {
                observed.push(`entry:${event.amount}`);
              }
            },
          ],
        },
      },
    });

    expect(machine.getNextEvents()).toEqual(["ADD", "RESET"]);
    await expect(machine.can({ type: "ADD", amount: 2 })).resolves.toBe(true);

    const submitted = { type: "ADD" as const, amount: 7 };
    const transition = machine.send(submitted);
    submitted.amount = 100;

    await exitStarted.promise;
    continueExit.resolve();
    await actionStarted.promise;
    continueAction.resolve();

    const committed = await transition;
    expect(observed).toEqual([
      "guard:2",
      "guard:7",
      "exit:7",
      "action:7",
      "entry:7",
    ]);
    expect(committed).toMatchObject({
      state: "complete",
      context: { amount: 7 },
      event: { type: "ADD", amount: 7 },
    });
  });

  it("isolates payload objects across the returned snapshot and subscribers", async () => {
    const machine = createMachine({
      id: "event-snapshot",
      initial: "idle",
      context: {},
      events: {} as { SAVE: { id: string } },
      states: {
        idle: { on: { SAVE: "saved" } },
        saved: {},
      },
    });
    let subscriberPayload: string | undefined;

    machine.subscribe((snapshot) => {
      if (snapshot.event !== null && typeof snapshot.event !== "string") {
        subscriberPayload = snapshot.event.id;
        snapshot.event.id = "subscriber-change";
      }
    });

    const committed = await machine.send({ type: "SAVE", id: "original" });

    expect(subscriberPayload).toBe("original");
    expect(committed.event).toEqual({ type: "SAVE", id: "original" });
    expect(machine.snapshot().event).toBeNull();
  });

  it("rejects malformed object events at runtime", async () => {
    const machine = createMachine({
      id: "malformed-event",
      initial: "idle",
      context: {},
      states: { idle: { on: { GO: "done" } }, done: {} },
    });

    await expect(machine.send({ type: 1 } as never)).rejects.toThrow(
      'string "type"',
    );
    await expect(machine.can({ type: 1 } as never)).rejects.toThrow(
      'string "type"',
    );
  });
});

describe("unclonable event payloads", () => {
  it("rejects an event that cannot be cloned, without changing the machine", async () => {
    const machine = createMachine({
      id: "unclonable-event",
      initial: "idle",
      context: {},
      states: { idle: { on: { GO: "done" } }, done: {} },
    });

    await expect(
      machine.send({ type: "GO", handler: () => undefined } as never),
    ).rejects.toThrow(/not structured-cloneable/);
    expect(machine.state).toBe("idle");

    await expect(machine.can({ type: "GO", handler: () => undefined } as never)).rejects.toThrow(
      /not structured-cloneable/,
    );
  });
});