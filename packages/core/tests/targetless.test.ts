/**
 * Targetless transitions.
 *
 * SCXML gives a transition with no `target` an empty exit set and an empty entry set, so it runs
 * its guard and its actions while the configuration stays exactly as it was: nothing is exited and
 * nothing is re-entered.
 *
 * Rule IDs refer to `packages/core/SEMANTICS.md`.
 */

import { describe, expect, it } from "vitest";
import { createMachine } from "../src/index.js";

describe("targetless transitions", () => {
  it("TL1, TL2: runs the guard and actions of a leaf without leaving or re-entering it", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "leaf",
      initial: "idle",
      context: { hits: 0 },
      states: {
        idle: {
          entry: [() => log.push("enter idle")],
          exit: [() => log.push("exit idle")],
          on: {
            TICK: {
              guard: ({ context }) => {
                log.push(`guard ${context.hits}`);
                return true;
              },
              actions: [
                ({ context }) => {
                  context.hits += 1;
                  log.push("action");
                },
              ],
            },
          },
        },
      },
    });

    let notifications = 0;
    machine.subscribe(() => {
      notifications += 1;
    });

    const committed = await machine.send("TICK");

    // The actions ran, and no lifecycle hook did.
    expect(log).toEqual(["guard 0", "action"]);
    expect(machine.state).toBe("idle");
    expect(machine.configuration).toEqual(["idle"]);
    expect(machine.context).toEqual({ hits: 1 });

    // The transition was taken, so it still reports a commit with no change of state.
    expect(committed.state).toBe("idle");
    expect(committed.previous).toBe("idle");
    expect(committed.configuration).toEqual(["idle"]);
    expect(committed.revision).toBe(1);
    expect(notifications).toBe(1);
  });

  it("TL1, TL3: leaves a compound state and its active child active", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "compound",
      initial: "parent",
      context: {},
      states: {
        parent: {
          initial: "child",
          entry: [() => log.push("enter parent")],
          exit: [() => log.push("exit parent")],
          on: { NOTE: { actions: [() => log.push("note")] } },
          states: {
            child: {
              entry: [() => log.push("enter child")],
              exit: [() => log.push("exit child")],
              on: { DEEP: { actions: [() => log.push("deep")] } },
            },
          },
        },
      },
    });

    await machine.send("NOTE");

    // The declaring state would be exited by a self-transition; a targetless transition is not one.
    expect(machine.state).toBe("parent.child");
    expect(machine.configuration).toEqual(["parent.child"]);
    expect(log).toEqual(["note"]);

    // The same holds for a declaration on the active leaf's own state.
    log.length = 0;
    await machine.send("DEEP");
    expect(machine.configuration).toEqual(["parent.child"]);
    expect(log).toEqual(["deep"]);
  });

  it("TL4: inside one region it leaves siblings and nested state untouched", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "regions",
      initial: "p",
      context: { noted: 0 },
      states: {
        p: {
          type: "parallel",
          exit: [() => log.push("exit p")],
          states: {
            r1: {
              initial: "inner",
              exit: [() => log.push("exit r1")],
              states: {
                inner: {
                  initial: "leaf",
                  exit: [() => log.push("exit inner")],
                  states: {
                    leaf: {
                      exit: [() => log.push("exit leaf")],
                      on: {
                        NOTE: {
                          actions: [
                            ({ context }) => {
                              context.noted += 1;
                              log.push("note");
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            r2: {
              initial: "b",
              exit: [() => log.push("exit r2")],
              states: { b: { exit: [() => log.push("exit b")], on: { NEXT: "c" } }, c: {} },
            },
          },
        },
      },
    });

    // Move the sibling region off its initial child, so a reset would be visible.
    await machine.send("NEXT");
    expect(machine.configuration).toEqual(["p.r1.inner.leaf", "p.r2.c"]);

    log.length = 0;
    await machine.send("NOTE");

    expect(machine.configuration).toEqual(["p.r1.inner.leaf", "p.r2.c"]);
    expect(log).toEqual(["note"]);
    expect(machine.context).toEqual({ noted: 1 });
  });

  it("TL5: records no history, because nothing is exited", async () => {
    const machine = createMachine({
      id: "history",
      initial: "editing",
      context: { notes: 0 },
      states: {
        editing: {
          initial: "idle",
          on: {
            PAUSE: "away",
            NOTE: {
              actions: [
                ({ context }) => {
                  context.notes += 1;
                },
              ],
            },
          },
          states: {
            idle: { on: { EDIT: "dirty" } },
            dirty: {},
            hist: { type: "history", history: "deep" },
          },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });

    await machine.send("EDIT");
    await machine.send("NOTE");

    // The parent was never left, so there is nothing to remember.
    expect(machine.snapshot().history).toEqual({});
    expect(machine.state).toBe("editing.dirty");
    expect(machine.context).toEqual({ notes: 1 });

    // Memory is recorded only once the parent really is exited.
    await machine.send("PAUSE");
    expect(machine.snapshot().history).toEqual({ "editing.hist": ["editing.dirty"] });
  });

  it("TL6: never conflicts, so two regions can each run their own targetless handler", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "two-regions",
      initial: "p",
      context: { total: 0 },
      states: {
        p: {
          type: "parallel",
          on: { PING: { actions: [() => log.push("p")] } },
          states: {
            r1: {
              initial: "a",
              on: { PING: { actions: [() => log.push("r1")] } },
              states: { a: {} },
            },
            r2: {
              initial: "b",
              states: {
                b: {
                  on: {
                    PING: {
                      actions: [
                        ({ context }) => {
                          context.total += 1;
                          log.push("r2");
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    await machine.send("PING");

    // Both regions run their own handler: with empty exit sets they conflict with nothing, and each
    // region's nearest declarer is its own state, so the parallel state's handler is not reached.
    expect(log).toEqual(["r1", "r2"]);
    expect(machine.configuration).toEqual(["p.r1.a", "p.r2.b"]);
    expect(machine.context).toEqual({ total: 1 });
  });

  it("TL6, TS3: an ancestor's targetless handler runs once for every region that needs it", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "fallback-regions",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          on: { PING: { actions: [() => log.push("p")] } },
          states: {
            r1: { initial: "a", on: { PING: { actions: [() => log.push("r1")] } }, states: { a: {} } },
            r2: { initial: "b", states: { b: {} } },
            r3: { initial: "c", states: { c: {} } },
          },
        },
      },
    });

    await machine.send("PING");

    // The two regions that declare nothing select the same declaration on the parallel state, which
    // therefore runs once, and actions run in document order of the declaring states.
    expect(log).toEqual(["p", "r1"]);
    expect(machine.configuration).toEqual(["p.r1.a", "p.r2.b", "p.r3.c"]);
  });
});
