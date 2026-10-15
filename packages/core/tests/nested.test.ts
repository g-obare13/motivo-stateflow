/**
 * Nested (compound) states: state paths, target resolution, event bubbling, lifecycle ordering
 * across levels, `matches()`, and the snapshot and restore rules for paths.
 *
 * Machines here pass the full path union as explicit type arguments, because TypeScript cannot
 * infer a recursive structure from a definition literal.
 */

import { describe, expect, it } from "vitest";
import {
  GuardRejectedError,
  MachineConfigurationError,
  SnapshotValidationError,
  createMachine,
} from "../src/index.js";
import { createLooseMachine } from "./helpers.js";

type DocTop = "draft" | "published";
type DocPath = "draft" | "draft.editing" | "draft.reviewing" | "published";
type DocEvent = "SUBMIT" | "BACK" | "PUBLISH" | "RESET" | "ESCALATE" | "FLAG";
type DocContext = { reviews: number; escalate: boolean };

/**
 * A document workflow with one compound state.
 *
 * - `draft` contains `editing` and `reviewing`, and starts in `editing`.
 * - `RESET`, `ESCALATE` and `FLAG` are declared on `draft`, so they are handled whichever child is
 *   active; `SUBMIT`, `BACK` and `PUBLISH` belong to the states that own them.
 */
const docMachine = () => {
  const log: string[] = [];
  const machine = createMachine<DocContext, DocTop, DocEvent, DocPath>({
    id: "doc",
    initial: "draft",
    context: { reviews: 0, escalate: false },
    states: {
      draft: {
        initial: "editing",
        entry: [() => log.push("enter draft")],
        exit: [() => log.push("exit draft")],
        on: {
          RESET: {
            actions: [() => log.push("reset")],
          },
          ESCALATE: {
            target: ".reviewing",
            guard: ({ context }) => context.escalate,
          },
          FLAG: {
            actions: [
              ({ context }) => {
                context.escalate = true;
              },
            ],
          },
        },
        states: {
          editing: {
            entry: [() => log.push("enter editing")],
            exit: [() => log.push("exit editing")],
            on: {
              SUBMIT: {
                target: "draft.reviewing",
                actions: [
                  ({ context }) => {
                    context.reviews += 1;
                    log.push("submit");
                  },
                ],
              },
            },
          },
          reviewing: {
            entry: [() => log.push("enter reviewing")],
            exit: [() => log.push("exit reviewing")],
            on: {
              BACK: "editing",
              PUBLISH: "published",
            },
          },
        },
      },
      published: {
        entry: [() => log.push("enter published")],
      },
    },
  });

  return { machine, log };
};

/** A machine whose compound state is entered from the outside, for entry-path tests. */
const reopenMachine = (target: DocPath, log: string[] = []) =>
  createMachine<Record<string, never>, DocTop, "OPEN", DocPath>({
    id: "reopen",
    initial: "published",
    context: {},
    states: {
      draft: {
        initial: "editing",
        entry: [() => log.push("enter draft")],
        states: {
          editing: { entry: [() => log.push("enter editing")] },
          reviewing: { entry: [() => log.push("enter reviewing")] },
        },
      },
      published: { on: { OPEN: target } },
    },
  });

describe("creating nested machines", () => {
  it("starts in the initial leaf of the initial compound state", () => {
    const { machine, log } = docMachine();

    expect(machine.state).toBe("draft.editing");
    expect(machine.snapshot().state).toBe("draft.editing");
    expect(machine.snapshot().done).toBe(false);
    // Starting in a state is not entering it, so no hook runs at creation.
    expect(log).toEqual([]);
  });

  it("requires an initial child on a compound state", () => {
    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { states: { b: {} } } },
      }),
    ).toThrow(MachineConfigurationError);
    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { states: { b: {} } } },
      }),
    ).toThrow(/must declare an "initial" child state/);
  });

  it("rejects an initial child that is not declared", () => {
    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "ghost", states: { b: {} } } },
      }),
    ).toThrow(/must declare an "initial" child state/);
  });

  it("rejects initial without nested states, and an empty nested states map", () => {
    expect(() =>
      createLooseMachine({ id: "x", initial: "a", context: {}, states: { a: { initial: "b" } } }),
    ).toThrow(/declares "initial" without nested "states"/);

    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: {} } },
      }),
    ).toThrow(/empty "states" map/);
  });

  it("rejects a state name containing a dot, which paths would make ambiguous", () => {
    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a.b",
        context: {},
        states: { "a.b": {} },
      }),
    ).toThrow(/cannot contain a dot/);
  });

  it("rejects targets that do not resolve, in every form", () => {
    const machine = (target: string) =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: { on: { GO: target } } } } },
      });

    expect(() => machine("ghost")).toThrow(MachineConfigurationError);
    expect(() => machine("ghost")).toThrow(/targets undeclared state "ghost"/);
    expect(() => machine("a.ghost")).toThrow(/targets undeclared state "a.ghost"/);
    expect(() => machine(".ghost")).toThrow(/targets undeclared state ".ghost"/);
    expect(() => machine(7 as unknown as string)).toThrow(
      /must be a state name or a transition object/,
    );

    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: { on: { GO: { target: 7 } } } } } },
      }),
    ).toThrow(/targets 7, which is not a state name/);
  });

  it("validates nested hook lists and event maps like top-level ones", () => {
    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: { entry: "nope" } } } },
      }),
    ).toThrow(/State "a.b" of machine "x" has an invalid "entry" hook/);

    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: { on: "nope" } } } },
      }),
    ).toThrow(/State "a.b" of machine "x" has an invalid "on" map/);

    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: { on: { GO: 7 } } } } },
      }),
    ).toThrow(/must be a state name or a transition object/);
  });

  it("names a state by its full path in error messages", () => {
    expect(() =>
      createLooseMachine({
        id: "x",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: { on: { GO: "a.ghost" } } } } },
      }),
    ).toThrow(
      /Transition for event "GO" in state "a\.b" of machine "x" targets undeclared state "a\.ghost"/,
    );
  });
});

describe("target resolution", () => {
  it("resolves a bare name to a sibling and to a top-level state from any depth", async () => {
    const { machine } = docMachine();

    await machine.send("SUBMIT");
    await machine.send("BACK");
    expect(machine.state).toBe("draft.editing");

    await machine.send("SUBMIT");
    await machine.send("PUBLISH");
    expect(machine.state).toBe("published");
  });

  it("resolves a bare name to the declaring state's own child", async () => {
    const machine = createMachine<Record<string, never>, "a", "PICK", "a" | "a.x" | "a.y">({
      id: "pick",
      initial: "a",
      context: {},
      states: {
        a: {
          initial: "x",
          states: { x: {}, y: {} },
          // "y" is a child of the state that declares the transition.
          on: { PICK: "y" },
        },
      },
    });

    await machine.send("PICK");
    expect(machine.state).toBe("a.y");
  });

  it("resolves an absolute dotted path and a relative leading dot", async () => {
    const { machine } = docMachine();

    // SUBMIT uses the absolute form "draft.reviewing".
    await machine.send("SUBMIT");
    expect(machine.state).toBe("draft.reviewing");

    await machine.send("BACK");
    // ESCALATE uses the relative form ".reviewing" from inside draft.
    await machine.send("FLAG");
    await machine.send("ESCALATE");
    expect(machine.state).toBe("draft.reviewing");
  });

  it("enters the initial child when the target is a compound state", async () => {
    const log: string[] = [];
    const machine = reopenMachine("draft", log);

    await machine.send("OPEN");

    expect(machine.state).toBe("draft.editing");
    expect(log).toEqual(["enter draft", "enter editing"]);
  });

  it("enters a named descendant without entering the initial sibling", async () => {
    const log: string[] = [];
    const machine = reopenMachine("draft.reviewing", log);

    await machine.send("OPEN");

    expect(machine.state).toBe("draft.reviewing");
    expect(log).toEqual(["enter draft", "enter reviewing"]);
  });
});

describe("event bubbling", () => {
  it("handles an event on the nearest state that declares it", async () => {
    const { machine, log } = docMachine();

    await machine.send("RESET");

    // RESET is declared on draft, so the active child and draft both exit, deepest first, the
    // action runs, and both are entered again shallowest first.
    expect(log).toEqual([
      "exit editing",
      "exit draft",
      "reset",
      "enter draft",
      "enter editing",
    ]);
    expect(machine.state).toBe("draft.editing");
  });

  it("prefers the deepest declaration when two levels declare the same event", async () => {
    const log: string[] = [];
    const machine = createMachine<Record<string, never>, "a" | "b", "TICK", "a" | "a.x" | "b">({
      id: "shadow",
      initial: "a",
      context: {},
      states: {
        a: {
          initial: "x",
          states: {
            x: {
              on: {
                TICK: {
                  actions: [() => log.push("child")],
                },
              },
            },
          },
          on: {
            TICK: {
              actions: [() => log.push("parent")],
            },
          },
        },
        b: {},
      },
    });

    await machine.send("TICK");
    expect(log).toEqual(["child"]);
  });

  it("evaluates the guard of the state that handles a bubbled event", async () => {
    const { machine } = docMachine();

    await expect(machine.can("ESCALATE")).resolves.toBe(false);
    await expect(machine.send("ESCALATE")).rejects.toBeInstanceOf(GuardRejectedError);

    await machine.send("FLAG");
    await expect(machine.can("ESCALATE")).resolves.toBe(true);

    await machine.send("ESCALATE");
    expect(machine.state).toBe("draft.reviewing");
  });

  it("reports an event the active configuration cannot handle as not allowed", async () => {
    const { machine } = docMachine();

    await expect(machine.send("PUBLISH")).rejects.toThrow(
      /is not allowed in state "draft\.editing"/,
    );
    await expect(machine.can("PUBLISH")).resolves.toBe(false);
  });
});

describe("inspecting a nested machine", () => {
  it("matches the active leaf and every state above it", async () => {
    const { machine } = docMachine();

    expect(machine.matches("draft.editing")).toBe(true);
    expect(machine.matches("draft")).toBe(true);
    expect(machine.matches("published")).toBe(false);
    // Typed so the test can ask about a path the machine does not declare.
    expect(machine.matches("draft.ghost" as DocPath)).toBe(false);

    await machine.send("SUBMIT");
    expect(machine.matches("draft.editing")).toBe(false);
    expect(machine.matches("draft.reviewing")).toBe(true);

    await machine.send("PUBLISH");
    expect(machine.matches("draft")).toBe(false);
    expect(machine.matches("published")).toBe(true);
  });

  it("lists the events of the whole configuration, shallowest state first", async () => {
    const { machine } = docMachine();

    expect(machine.getNextEvents()).toEqual(["RESET", "ESCALATE", "FLAG", "SUBMIT"]);

    await machine.send("SUBMIT");
    expect(machine.getNextEvents()).toEqual(["RESET", "ESCALATE", "FLAG", "BACK", "PUBLISH"]);
  });

  it("lists an event declared at two levels once", () => {
    const machine = createMachine<Record<string, never>, "a", "TICK" | "STOP", "a" | "a.x">({
      id: "dup",
      initial: "a",
      context: {},
      states: {
        a: {
          initial: "x",
          states: { x: { on: { TICK: {} } } },
          on: { TICK: {}, STOP: {} },
        },
      },
    });

    expect(machine.getNextEvents()).toEqual(["TICK", "STOP"]);
  });

  it("computes done from the whole configuration, not just the leaf", async () => {
    const held = createMachine<Record<string, never>, "a" | "b", "GO", "a" | "a.x" | "b">({
      id: "held",
      initial: "a",
      context: {},
      states: {
        a: { initial: "x", states: { x: {} }, on: { GO: "b" } },
        b: {},
      },
    });

    // The leaf declares nothing, but its parent still handles an event.
    expect(held.snapshot().done).toBe(false);

    await held.send("GO");
    expect(held.snapshot().done).toBe(true);
  });
});

describe("snapshots and restoration for nested machines", () => {
  it("stores the active leaf path and the previous leaf path", async () => {
    const { machine } = docMachine();

    expect(machine.snapshot().previous).toBeNull();

    const snapshot = await machine.send("SUBMIT");
    expect(snapshot.state).toBe("draft.reviewing");
    expect(snapshot.previous).toBe("draft.editing");
    expect(snapshot.event).toBe("SUBMIT");
  });

  it("round-trips a nested state through JSON", async () => {
    const { machine } = docMachine();
    await machine.send("SUBMIT");

    const restored = docMachine().machine;
    await restored.restore(JSON.parse(JSON.stringify(machine)));

    expect(restored.state).toBe("draft.reviewing");
    expect(restored.context).toEqual({ reviews: 1, escalate: false });
  });

  it("rejects a snapshot that names a compound state", async () => {
    const { machine } = docMachine();
    const snapshot = { id: "doc", state: "draft", context: { reviews: 0, escalate: false } };

    await expect(machine.restore(snapshot)).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(machine.restore(snapshot)).rejects.toThrow(/is a compound state/);
  });

  it("rejects a snapshot whose state is not a declared path", async () => {
    const { machine } = docMachine();

    await expect(
      machine.restore({ id: "doc", state: "draft.ghost", context: {} }),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(machine.restore({ id: "doc", state: "ghost", context: {} })).rejects.toThrow(
      /is not declared by machine "doc"/,
    );
  });
});

describe("deeper trees", () => {
  const deepMachine = (log: string[]) =>
    createMachine<
      Record<string, never>,
      "a" | "b",
      "TOP" | "SELF",
      "a" | "a.mid" | "a.mid.leaf" | "b"
    >({
      id: "deep",
      initial: "a",
      context: {},
      states: {
        a: {
          initial: "mid",
          entry: [() => log.push("enter a")],
          exit: [() => log.push("exit a")],
          on: { TOP: "b" },
          states: {
            mid: {
              initial: "leaf",
              entry: [() => log.push("enter mid")],
              exit: [() => log.push("exit mid")],
              states: {
                leaf: {
                  entry: [() => log.push("enter leaf")],
                  exit: [() => log.push("exit leaf")],
                  on: { SELF: "a.mid.leaf" },
                },
              },
            },
          },
        },
        b: {},
      },
    });

  it("enters the full initial chain and exposes every level", () => {
    const machine = deepMachine([]);

    expect(machine.state).toBe("a.mid.leaf");
    expect(machine.matches("a")).toBe(true);
    expect(machine.matches("a.mid")).toBe(true);
    expect(machine.getNextEvents()).toEqual(["TOP", "SELF"]);
  });

  it("exits every level up to the state that handles the event, deepest first", async () => {
    const log: string[] = [];
    const machine = deepMachine(log);

    await machine.send("TOP");

    expect(machine.state).toBe("b");
    expect(log).toEqual(["exit leaf", "exit mid", "exit a"]);
  });

  it("re-enters only the leaf for a self-target written as an absolute path", async () => {
    const log: string[] = [];
    const machine = deepMachine(log);

    await machine.send("SELF");

    expect(machine.state).toBe("a.mid.leaf");
    expect(log).toEqual(["exit leaf", "enter leaf"]);
  });
});
