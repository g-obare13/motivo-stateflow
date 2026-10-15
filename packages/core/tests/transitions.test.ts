/**
 * Transition semantics: resolution of events against the current state, the distinction between
 * unknown events and events that are merely not allowed, and terminal states.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createMachine,
  InvalidEventError,
  InvalidTransitionError,
  MachineConfigurationError,
} from "../src/index.js";
import type { MachineDefinition } from "../src/index.js";
import { asEvent, createLooseMachine } from "./helpers.js";

const trafficMachine = () =>
  createMachine({
    id: "traffic",
    initial: "green",
    context: { changes: 0 },
    states: {
      green: { on: { TIMER: "yellow" } },
      yellow: { on: { TIMER: "red" } },
      red: { on: { TIMER: "green" } },
    },
  });

describe("transitions", () => {
  it("commits a valid transition and resolves with the new snapshot", async () => {
    const machine = trafficMachine();
    const snapshot = await machine.send("TIMER");

    expect(machine.state).toBe("yellow");
    expect(snapshot).toMatchObject({
      id: "traffic",
      state: "yellow",
      previous: "green",
      event: "TIMER",
      revision: 1,
      done: false,
    });
  });

  it("supports multiple sequential transitions", async () => {
    const machine = trafficMachine();

    await machine.send("TIMER");
    await machine.send("TIMER");
    await machine.send("TIMER");

    expect(machine.state).toBe("green");
    expect(machine.snapshot().revision).toBe(3);
  });

  it("leaves the machine untouched when the transition fails", async () => {
    const machine = trafficMachine();
    await machine.send("TIMER");
    const before = machine.snapshot();

    await expect(machine.send(asEvent<"TIMER">("JUMP"))).rejects.toBeInstanceOf(InvalidEventError);

    expect(machine.state).toBe(before.state);
    expect(machine.context).toEqual(before.context);
    expect(machine.snapshot().revision).toBe(before.revision);
  });
});

describe("event resolution", () => {
  it("reports an event that is declared nowhere as InvalidEventError", async () => {
    const machine = trafficMachine();
    await expect(machine.send(asEvent<"TIMER">("LAUNCH"))).rejects.toBeInstanceOf(InvalidEventError);
  });

  it("reports a declared event that the current state does not accept as InvalidTransitionError", async () => {
    const machine = createMachine({
      id: "order",
      initial: "pending",
      context: {},
      states: {
        pending: { on: { CONFIRM: "confirmed" } },
        confirmed: { on: { SHIP: "shipped" } },
        shipped: {},
      },
    });

    await expect(machine.send("CONFIRM")).resolves.toBeDefined();
    await expect(machine.send("CONFIRM")).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("never resolves prototype members as events", async () => {
    const machine = trafficMachine();

    for (const event of [
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
      "isPrototypeOf",
    ]) {
      await expect(machine.send(asEvent<"TIMER">(event))).rejects.toBeInstanceOf(InvalidEventError);
    }
    expect(machine.state).toBe("green");
  });

  it("resolves prototype-named events when they are declared explicitly", async () => {
    const machine = createMachine({
      id: "prototype-events",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { toString: "done" } },
        done: {},
      },
    });

    await machine.send("toString");
    expect(machine.state).toBe("done");
  });

  it("rejects non-string events", async () => {
    const machine = trafficMachine();
    await expect(machine.send(asEvent<"TIMER">(undefined as never))).rejects.toBeInstanceOf(
      InvalidEventError,
    );
  });

  it("treats a state with no outgoing transitions as terminal", async () => {
    const machine = createMachine({
      id: "job",
      initial: "queued",
      context: {},
      states: {
        queued: { on: { RUN: "finished" } },
        finished: {},
      },
    });

    expect(machine.snapshot().done).toBe(false);
    await machine.send("RUN");
    const snapshot = machine.snapshot();

    expect(snapshot.done).toBe(true);
  });
});

describe("self transitions", () => {
  it("runs exit, action and entry hooks when the target is the current state", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "counter",
      initial: "counting",
      context: { value: 0 },
      states: {
        counting: {
          exit: [({ context }) => log.push(`exit:${context.value}`)],
          entry: [({ context }) => log.push(`entry:${context.value}`)],
          on: {
            TICK: {
              target: "counting",
              actions: [({ context }) => {
                context.value += 1;
                log.push(`tick:${context.value}`);
              }],
            },
          },
        },
      },
    });

    await machine.send("TICK");
    await machine.send("TICK");

    expect(machine.state).toBe("counting");
    expect(machine.context).toEqual({ value: 2 });
    expect(log).toEqual([
      "exit:0",
      "tick:1",
      "entry:1",
      "exit:1",
      "tick:2",
      "entry:2",
    ]);
  });

  it("runs the actions of a transition without a target without leaving the state", async () => {
    const action = vi.fn();
    const entered = vi.fn();
    const exited = vi.fn();
    const machine = createMachine({
      id: "counter",
      initial: "counting",
      context: {},
      states: {
        counting: {
          entry: [entered],
          exit: [exited],
          on: { TICK: { actions: [action] } },
        },
      },
    });

    await machine.send("TICK");

    expect(action).toHaveBeenCalledTimes(1);
    expect(machine.state).toBe("counting");
    expect(machine.snapshot().revision).toBe(1);
    // SCXML gives a targetless transition an empty exit set and an empty entry set, so no lifecycle
    // hook runs. A transition that should re-enter its declaring state declares `target` explicitly.
    expect(entered).not.toHaveBeenCalled();
    expect(exited).not.toHaveBeenCalled();
  });
});

describe("attempts to reach undeclared states", () => {
  it("cannot be declared at creation time", () => {
    expect(() =>
      createLooseMachine({
        id: "order",
        initial: "pending",
        context: {},
        states: {
          pending: { on: { CONFIRM: "confirmed" } },
        },
      }),
    ).toThrow(MachineConfigurationError);
  });

  it("cannot be introduced by mutating the definition after creation", async () => {
    // Literal types matter here: a definition kept in a variable must be annotated (or use
    // `as const` on the literals) so the state union follows the `states` keys.
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

    (definition.states.pending.on as Record<string, string>).CONFIRM = "ghost";
    (definition.states as unknown as Record<string, unknown>).ghost = {};

    await expect(machine.send("CONFIRM")).resolves.toMatchObject({ state: "confirmed" });
  });
});
