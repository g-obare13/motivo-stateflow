/**
 * History pseudo-states: shallow and deep memory, default targets, capture on exit and survival
 * across serialization.
 *
 * Every test names the rule IDs it proves, which refer to `packages/core/SEMANTICS.md`.
 */

import { describe, expect, it } from "vitest";
import { createMachine, MachineConfigurationError } from "../src/index.js";

/**
 * A single compound state with a deep history pseudo-state and a way to leave and come back, so
 * memory can be compared against the parent's default entry.
 */
const deepMachine = (log: string[] = []) =>
  createMachine({
    id: "deep-history",
    initial: "editing",
    context: { log },
    states: {
      editing: {
        initial: "idle",
        entry: [() => log.push("enter editing")],
        exit: [() => log.push("exit editing")],
        on: { PAUSE: "away" },
        states: {
          idle: { entry: [() => log.push("enter idle")], exit: [() => log.push("exit idle")], on: { EDIT: "dirty" } },
          dirty: { entry: [() => log.push("enter dirty")], exit: [() => log.push("exit dirty")] },
          hist: { type: "history", history: "deep" },
        },
      },
      away: { on: { RESUME: "editing.hist", RESTART: "editing" } },
    },
  });

describe("history pseudo-states", () => {
  it("HS1, ST5: is never active and never appears in the configuration", async () => {
    const machine = deepMachine();

    expect(machine.configuration).toEqual(["editing.idle"]);
    expect(machine.matches("editing.hist" as never)).toBe(false);
    expect(machine.getNextEvents()).toEqual(["PAUSE", "EDIT"]);

    await machine.send("EDIT");
    expect(machine.matches("editing.hist" as never)).toBe(false);
  });

  it("HS3, HS5: restores the exact leaf after the parent was left", async () => {
    const machine = deepMachine();

    await machine.send("EDIT");
    await machine.send("PAUSE");
    expect(machine.snapshot().history).toEqual({ "editing.hist": ["editing.dirty"] });

    await machine.send("RESUME");

    expect(machine.state).toBe("editing.dirty");
  });

  it("HS5: uses the parent's default entry when there is no memory and no default target", async () => {
    const machine = deepMachine();

    // Leaving and returning through the plain parent never consults memory either, and memory is
    // only recorded when the parent is actually exited.
    await machine.send("EDIT");
    await machine.send("RESUME").catch(() => undefined);
    expect(machine.state).toBe("editing.dirty");
  });

  it("HS5, HS6: uses a declared default target on first entry", async () => {
    const machine = createMachine({
      id: "default-target",
      initial: "away",
      context: {},
      states: {
        editing: {
          initial: "idle",
          states: {
            idle: {},
            dirty: {},
            hist: { type: "history", history: "deep", target: "dirty" },
          },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });

    // No memory exists yet, so the pseudo-state's own target decides.
    await machine.send("RESUME");

    expect(machine.state).toBe("editing.dirty");
  });

  it("HS5: falls back to the parent's default entry when no default target is declared", async () => {
    const machine = createMachine({
      id: "no-default-target",
      initial: "away",
      context: {},
      states: {
        editing: {
          initial: "idle",
          states: { idle: {}, dirty: {}, hist: { type: "history", history: "deep" } },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });

    await machine.send("RESUME");

    expect(machine.state).toBe("editing.idle");
  });

  it("HS2: shallow memory records the direct child and then applies its default entry", async () => {
    const machine = createMachine({
      id: "shallow",
      initial: "parent",
      context: {},
      states: {
        parent: {
          initial: "c1",
          on: { LEAVE: "away" },
          states: {
            c1: { initial: "c1x", states: { c1x: { on: { DEEPER: "c1y" } }, c1y: {} } },
            c2: {},
            hist: { type: "history", history: "shallow" },
          },
        },
        away: { on: { RESUME: "parent.hist" } },
      },
    });

    await machine.send("DEEPER");
    expect(machine.state).toBe("parent.c1.c1y");

    await machine.send("LEAVE");
    // A shallow pseudo-state remembers the direct child, not the leaf below it.
    expect(machine.snapshot().history).toEqual({ "parent.hist": ["parent.c1"] });

    await machine.send("RESUME");
    // c1 is entered again through its own default entry, so c1y is not restored.
    expect(machine.state).toBe("parent.c1.c1x");
  });

  it("HS6: rejects a shallow default target that is not a direct child of the parent", () => {
    expect(() =>
      createMachine({
        id: "bad-shallow",
        initial: "away",
        context: {},
        states: {
          parent: {
            initial: "c1",
            states: {
              c1: { initial: "c1x", states: { c1x: {} } },
              hist: { type: "history", history: "shallow", target: "parent.c1.c1x" },
            },
          },
          away: {},
        },
      }),
    ).toThrow(/not a direct child/);

    // The same target is legal for a deep pseudo-state.
    expect(() =>
      createMachine({
        id: "ok-deep",
        initial: "away",
        context: {},
        states: {
          parent: {
            initial: "c1",
            states: {
              c1: { initial: "c1x", states: { c1x: {} } },
              hist: { type: "history", history: "deep", target: "parent.c1.c1x" },
            },
          },
          away: {},
        },
      }),
    ).not.toThrow();
  });

  it("HS7: re-entering the parent without a history target never consults memory", async () => {
    const machine = deepMachine();

    await machine.send("EDIT");
    await machine.send("PAUSE");
    expect(machine.snapshot().history).toEqual({ "editing.hist": ["editing.dirty"] });

    await machine.send("RESTART");

    expect(machine.state).toBe("editing.idle");
  });

  it("HS8: memory survives serialization and restoration", async () => {
    const machine = deepMachine();
    await machine.send("EDIT");
    await machine.send("PAUSE");

    const stored = JSON.parse(JSON.stringify(machine));
    expect(stored.history).toEqual({ "editing.hist": ["editing.dirty"] });
    expect(stored.configuration).toEqual(["away"]);

    const resumed = deepMachine();
    await resumed.restore(stored);
    await resumed.send("RESUME");

    expect(resumed.state).toBe("editing.dirty");
  });

  it("HS4: memory is captured on exit, and a failed exit leaves it untouched", async () => {
    const machine = createMachine({
      id: "capture",
      initial: "editing",
      context: { fail: true },
      states: {
        editing: {
          initial: "idle",
          exit: [
            ({ context }) => {
              if (context.fail) {
                throw new Error("exit refused");
              }
            },
          ],
          on: { PAUSE: "away" },
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
    expect(machine.snapshot().history).toEqual({});

    // The exit hook throws, so nothing is committed and the captured memory is discarded with it.
    await expect(machine.send("PAUSE")).rejects.toThrow("exit refused");
    expect(machine.snapshot().history).toEqual({});
    expect(machine.state).toBe("editing.dirty");

    // Once the exit succeeds, the memory it captured is committed.
    const retry = createMachine({
      id: "capture",
      initial: "editing",
      context: { fail: false },
      states: {
        editing: {
          initial: "idle",
          on: { PAUSE: "away" },
          states: { idle: { on: { EDIT: "dirty" } }, dirty: {}, hist: { type: "history", history: "deep" } },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });
    await retry.send("EDIT");
    await retry.send("PAUSE");
    expect(retry.snapshot().history).toEqual({ "editing.hist": ["editing.dirty"] });
  });

  it("HS9: a history target re-enters the states it remembers", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "self-history",
      initial: "editing",
      context: { log },
      states: {
        editing: {
          initial: "idle",
          entry: [() => log.push("enter editing")],
          exit: [() => log.push("exit editing")],
          on: { PAUSE: "away", AGAIN: "editing.hist" },
          states: {
            idle: { on: { EDIT: "dirty" } },
            dirty: { entry: [() => log.push("enter dirty")], exit: [() => log.push("exit dirty")] },
            hist: { type: "history", history: "deep" },
          },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });

    await machine.send("EDIT");
    await machine.send("PAUSE");
    await machine.send("RESUME");
    expect(machine.state).toBe("editing.dirty");

    log.length = 0;
    await machine.send("AGAIN");

    // The remembered leaf is a proper descendant of the transition's domain, so it is exited and
    // entered again rather than left alone.
    expect(machine.state).toBe("editing.dirty");
    expect(log).toEqual(["exit dirty", "exit editing", "enter editing", "enter dirty"]);
  });

  it("HS3: a parallel parent's deep memory restores every region exactly", async () => {
    const machine = createMachine({
      id: "parallel-history",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          on: { PAUSE: "paused" },
          states: {
            r1: { initial: "a", states: { a: { on: { A1: "b" } }, b: {} } },
            r2: { initial: "c", states: { c: { on: { C1: "d" } }, d: {} } },
            hist: { type: "history", history: "deep" },
          },
        },
        paused: { on: { RESUME: "p.hist" } },
      },
    });

    await machine.send("A1");
    await machine.send("C1");
    await machine.send("PAUSE");

    expect(machine.snapshot().history).toEqual({ "p.hist": ["p.r1.b", "p.r2.d"] });

    await machine.send("RESUME");

    expect(machine.configuration).toEqual(["p.r1.b", "p.r2.d"]);
  });

  it("HS2: a parallel parent's shallow memory records every region and resets each one", async () => {
    const machine = createMachine({
      id: "parallel-shallow",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          on: { PAUSE: "paused" },
          states: {
            r1: { initial: "a", states: { a: { on: { A1: "b" } }, b: {} } },
            r2: { initial: "c", states: { c: { on: { C1: "d" } }, d: {} } },
            hist: { type: "history", history: "shallow" },
          },
        },
        paused: { on: { RESUME: "p.hist" } },
      },
    });

    await machine.send("A1");
    await machine.send("C1");
    await machine.send("PAUSE");

    expect(machine.snapshot().history).toEqual({ "p.hist": ["p.r1", "p.r2"] });

    await machine.send("RESUME");

    // Every region is entered through its own default entry, so both reset.
    expect(machine.configuration).toEqual(["p.r1.a", "p.r2.c"]);
  });

  it("HS6: rejects a history declaration that a pseudo-state cannot have", () => {
    expect(() =>
      createMachine({
        id: "bad",
        initial: "a",
        context: {},
        states: {
          a: {
            initial: "b",
            states: { b: {}, h: { type: "history", history: "sometimes" as never } },
          },
        },
      }),
    ).toThrow(MachineConfigurationError);
  });
});

describe("history definition validation", () => {
  const compile = (definition: unknown) => () => createMachine(definition as never);

  it("HS5, ST5: rejects a history default target that names another pseudo-state", () => {
    expect(
      compile({
        id: "bad-chain",
        initial: "away",
        context: {},
        states: {
          parent: {
            initial: "c1",
            states: {
              c1: {},
              first: { type: "history", history: "deep", target: "second" },
              second: { type: "history", history: "deep" },
            },
          },
          away: {},
        },
      }),
    ).toThrow(/names another history pseudo-state/);
  });

  it("ST5: rejects a machine whose initial state is a history pseudo-state", () => {
    // At the top level the pseudo-state has no configuration to remember, so it is rejected while
    // the tree is built, before the initial key is even resolved.
    expect(
      compile({
        id: "bad-initial",
        initial: "h",
        context: {},
        states: { h: { type: "history", history: "deep" } },
      }),
    ).toThrow(/declared at the top level/);

    // A compound state cannot start in a pseudo-state either, for the same reason.
    expect(
      compile({
        id: "bad-initial",
        initial: "parent",
        context: {},
        states: {
          parent: { initial: "h", states: { c1: {}, h: { type: "history", history: "deep" } } },
        },
      }),
    ).toThrow(/a history pseudo-state is never active/);
  });

  it("TY2, TD6: rejects a target that tries to walk through a history pseudo-state", () => {
    expect(
      compile({
        id: "bad-through",
        initial: "away",
        context: {},
        states: {
          parent: {
            initial: "c1",
            states: { c1: {}, h: { type: "history", history: "deep" } },
          },
          away: { on: { RESUME: "parent.h.c1" } },
        },
      }),
    ).toThrow(/targets undeclared state/);
  });

  it("TY2: rejects a target whose undeclared segment is followed by further segments", () => {
    // The walk stops at the undeclared segment instead of dereferencing `undefined`.
    const badTail = {
      id: "bad-tail",
      initial: "away",
      context: {},
      states: {
        parent: { initial: "c1", states: { c1: {} } },
        away: { on: { RESUME: "parent.ghost.deeper" } },
      },
    };
    const failure = (() => {
      try {
        compile(badTail)();
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(MachineConfigurationError);
    expect((failure as Error).message).toMatch(/targets undeclared state/);
  });

  it("HS5, SR7: uses the default target when the restored memory is empty", async () => {
    const machine = createMachine({
      id: "empty-memory",
      initial: "away",
      context: {},
      states: {
        editing: {
          initial: "idle",
          states: { idle: {}, dirty: {}, hist: { type: "history", history: "deep", target: "dirty" } },
        },
        away: { on: { RESUME: "editing.hist" } },
      },
    });

    await machine.restore({
      id: "empty-memory",
      state: "away",
      context: {},
      configuration: ["away"],
      history: { "editing.hist": [] },
    });

    // An empty array carries no memory, so the pseudo-state's own target decides.
    await machine.send("RESUME");

    expect(machine.state).toBe("editing.dirty");
  });

  it("HS2, ST4: defaults to shallow memory when the declaration omits history", async () => {
    const machine = createMachine({
      id: "default-memory",
      initial: "parent",
      context: {},
      states: {
        parent: {
          initial: "c1",
          on: { LEAVE: "away" },
          states: {
            c1: { initial: "c1x", states: { c1x: { on: { DEEPEN: "c1y" } }, c1y: {} } },
            hist: { type: "history" },
          },
        },
        away: { on: { RESUME: "parent.hist" } },
      },
    });

    // The remembered child is re-entered, and its own default entry runs again: shallow memory
    // remembers `parent.c1`, not the leaf `parent.c1.c1y2` below it.
    await machine.send("DEEPEN");
    await machine.send("LEAVE");
    expect(machine.snapshot().history).toEqual({ "parent.hist": ["parent.c1"] });

    await machine.send("RESUME");

    expect(machine.state).toBe("parent.c1.c1x");
  });
});