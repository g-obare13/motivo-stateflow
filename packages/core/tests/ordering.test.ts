/**
 * Exit, action and entry ordering.
 *
 * The orderings follow SCXML's external transition semantics: the exit set is left in reverse
 * document order (innermost first), the selected transitions' actions run in document order of
 * their declaring states, and the entry set is entered in document order (outermost first). Each
 * test names the rule IDs it proves, which refer to `packages/core/SEMANTICS.md`.
 */

import { describe, expect, it } from "vitest";
import { createMachine } from "../src/index.js";

/**
 * The nesting from the `EO` worked example: `e` is a sibling of `b` inside `a`, so moving to `e`
 * stays within `a`'s subtree while still crossing the domain boundary.
 */
const nestedMachine = (log: string[] = []) =>
  createMachine({
    id: "nested",
    initial: "a",
    context: { log },
    states: {
      a: {
        initial: "b",
        entry: [() => log.push("enter a")],
        exit: [() => log.push("exit a")],
        on: { GO: { target: "e", actions: [() => log.push("action")] } },
        states: {
          b: {
            initial: "c",
            entry: [() => log.push("enter b")],
            exit: [() => log.push("exit b")],
            on: { DOWN: { target: "d", actions: [() => log.push("down")] } },
            states: {
              c: { entry: [() => log.push("enter c")], exit: [() => log.push("exit c")] },
              d: { entry: [() => log.push("enter d")], exit: [() => log.push("exit d")] },
            },
          },
          e: {
            initial: "f",
            entry: [() => log.push("enter e")],
            exit: [() => log.push("exit e")],
            states: { f: { entry: [() => log.push("enter f")], exit: [() => log.push("exit f")] } },
          },
        },
      },
    },
  });

describe("exit and entry ordering", () => {
  it("EO1, EO2, EO3: leaves deepest first and enters outermost first across the whole path", async () => {
    const log: string[] = [];
    const machine = nestedMachine(log);
    log.length = 0;

    await machine.send("GO");

    // The domain is the root, so every active state is exited and the target's default entry is
    // entered after the transition's actions.
    expect(log).toEqual(["exit c", "exit b", "exit a", "action", "enter a", "enter e", "enter f"]);
    expect(machine.state).toBe("a.e.f");
  });

  it("EO1, EO2: a target outside the subtree leaves it without re-entering it", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "sibling",
      initial: "a",
      context: { log },
      states: {
        a: {
          initial: "b",
          entry: [() => log.push("enter a")],
          exit: [() => log.push("exit a")],
          on: { GO: "other" },
          states: { b: { entry: [() => log.push("enter b")], exit: [() => log.push("exit b")] } },
        },
        other: { entry: [() => log.push("enter other")] },
      },
    });

    log.length = 0;
    await machine.send("GO");

    // The whole of `a` is a proper descendant of the domain and the target is not inside it, so `a`
    // is exited and never entered again.
    expect(log).toEqual(["exit b", "exit a", "enter other"]);
    expect(machine.configuration).toEqual(["other"]);
  });

  it("EO1, EO2: re-enters only the span between the target and the shared ancestor", async () => {
    const log: string[] = [];
    const machine = nestedMachine(log);
    log.length = 0;

    await machine.send("DOWN");

    // The domain is `a`, which the transition does not leave, so only the states below it move, and
    // only the active ones run exit hooks.
    expect(log).toEqual(["exit c", "exit b", "down", "enter b", "enter d"]);
    expect(machine.state).toBe("a.b.d");
  });

  it("EO4: a self-transition on a compound state resets it to its initial child", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "self",
      initial: "a",
      context: { log },
      states: {
        a: {
          initial: "b",
          entry: [() => log.push("enter a")],
          exit: [() => log.push("exit a")],
          on: { RESET: "a" },
          states: {
            b: { entry: [() => log.push("enter b")], exit: [() => log.push("exit b")], on: { NEXT: "c" } },
            c: { entry: [() => log.push("enter c")], exit: [() => log.push("exit c")] },
          },
        },
      },
    });

    await machine.send("NEXT");
    expect(machine.state).toBe("a.c");

    log.length = 0;
    await machine.send("RESET");

    expect(machine.state).toBe("a.b");
    expect(log).toEqual(["exit c", "exit a", "enter a", "enter b"]);
  });

  it("EO1, EO3: runs hook lists in declaration order and actions after every exit", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "lists",
      initial: "a",
      context: { log },
      states: {
        a: {
          exit: [() => log.push("exit a1"), () => log.push("exit a2")],
          on: {
            GO: {
              target: "b",
              actions: [() => log.push("action 1"), () => log.push("action 2")],
            },
          },
        },
        b: { entry: [() => log.push("enter b1"), () => log.push("enter b2")] },
      },
    });

    log.length = 0;
    await machine.send("GO");

    expect(log).toEqual(["exit a1", "exit a2", "action 1", "action 2", "enter b1", "enter b2"]);
  });

  it("EO1: exits sibling regions in reverse document order and enters them in document order", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "regions",
      initial: "p",
      context: { log },
      states: {
        p: {
          type: "parallel",
          states: {
            first: {
              initial: "f1",
              states: { f1: { exit: [() => log.push("exit f1")], on: { END: "f2" } }, f2: { entry: [() => log.push("enter f2")] } },
            },
            second: {
              initial: "s1",
              states: { s1: { exit: [() => log.push("exit s1")], on: { END: "s2" } }, s2: { entry: [() => log.push("enter s2")] } },
            },
            third: {
              initial: "t1",
              states: { t1: { exit: [() => log.push("exit t1")], on: { END: "t2" } }, t2: { entry: [() => log.push("enter t2")] } },
            },
          },
        },
      },
    });

    await machine.send("END");

    expect(log).toEqual([
      "exit t1",
      "exit s1",
      "exit f1",
      "enter f2",
      "enter s2",
      "enter t2",
    ]);
    expect(machine.configuration).toEqual(["p.first.f2", "p.second.s2", "p.third.t2"]);
  });

  it("TD1: an ancestor's handler exits every level below it and re-enters them", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "bubbled",
      initial: "outer",
      context: { log },
      states: {
        outer: {
          initial: "middle",
          exit: [() => log.push("exit outer")],
          on: { RESET: { target: "outer", actions: [() => log.push("reset")] } },
          states: {
            middle: {
              initial: "leaf",
              exit: [() => log.push("exit middle")],
              states: {
                leaf: { exit: [() => log.push("exit leaf")], on: { NEXT: "other" } },
                other: { entry: [() => log.push("enter other")] },
              },
            },
          },
        },
      },
    });

    await machine.send("NEXT");
    log.length = 0;

    await machine.send("RESET");

    // `other` is exited but not re-entered, because entering `outer` again descends its default
    // entry, which is the `middle.leaf` chain rather than the state it was in.
    expect(log).toEqual(["exit middle", "exit outer", "reset"]);
    expect(machine.state).toBe("outer.middle.leaf");
  });
});
