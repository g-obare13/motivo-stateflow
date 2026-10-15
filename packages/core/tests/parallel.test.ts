/**
 * Parallel states: independent regions, per-region transition selection, conflict resolution,
 * configuration reporting and microstep atomicity.
 *
 * Every test names the rule IDs it proves, which refer to `packages/core/SEMANTICS.md`.
 */

import { describe, expect, it } from "vitest";
import {
  createMachine,
  GuardRejectedError,
  InvalidEventError,
  InvalidTransitionError,
  MachineConfigurationError,
  UnsupportedTransitionTypeError,
} from "../src/index.js";

/**
 * Two regions, each a compound state that handles `INC` on itself, plus a `PAUSE` handler on the
 * parallel state itself so bubbling to the parallel state can be observed.
 */
const parallelMachine = (log: string[] = []) =>
  createMachine({
    id: "parallel",
    initial: "p",
    context: { log },
    states: {
      p: {
        type: "parallel",
        entry: [() => log.push("enter p")],
        exit: [() => log.push("exit p")],
        on: { PAUSE: { target: "paused" } },
        states: {
          r1: {
            initial: "r1a",
            entry: [() => log.push("enter r1")],
            exit: [() => log.push("exit r1")],
            states: {
              r1a: {
                entry: [() => log.push("enter r1a")],
                exit: [() => log.push("exit r1a")],
                on: { INC: { target: "r1b", actions: [() => log.push("inc r1")] } },
              },
              r1b: { entry: [() => log.push("enter r1b")], exit: [() => log.push("exit r1b")] },
            },
          },
          r2: {
            initial: "r2a",
            entry: [() => log.push("enter r2")],
            exit: [() => log.push("exit r2")],
            states: {
              r2a: {
                entry: [() => log.push("enter r2a")],
                exit: [() => log.push("exit r2a")],
                on: { INC: { target: "r2b", actions: [() => log.push("inc r2")] } },
              },
              r2b: { entry: [() => log.push("enter r2b")], exit: [() => log.push("exit r2b")] },
            },
          },
        },
      },
      paused: { entry: [() => log.push("enter paused")], on: { RESUME: "p" } },
    },
  });

describe("parallel configuration", () => {
  it("ST1, ST3, CF1, CF2, CF4: enters every region and reports active leaves in document order", () => {
    const machine = parallelMachine();

    expect(machine.state).toBe("p");
    expect(machine.configuration).toEqual(["p.r1.r1a", "p.r2.r2a"]);
    expect(machine.snapshot().configuration).toEqual(["p.r1.r1a", "p.r2.r2a"]);
  });

  it("CF3: rejects a configuration that leaves a region of an active parallel state out", async () => {
    const machine = parallelMachine();

    await expect(
      machine.restore({
        id: "parallel",
        state: "p",
        context: { log: [] },
        configuration: ["p.r1.r1a"],
        history: {},
      }),
    ).rejects.toThrow(/activates 1 of the 2 regions/);
  });

  it("CF5, CF6: reports the deepest state containing the whole configuration as state", async () => {
    const machine = parallelMachine();

    expect(machine.state).toBe("p");

    const committed = await machine.send("INC");

    expect(committed.state).toBe("p");
    expect(committed.previous).toBe("p");
    expect(committed.configuration).toEqual(["p.r1.r1b", "p.r2.r2b"]);
  });

  it("CF7: matches the parallel state and every region, but not a sibling region's leaf", () => {
    const machine = parallelMachine();

    expect(machine.matches("p")).toBe(true);
    expect(machine.matches("p.r1")).toBe(true);
    expect(machine.matches("p.r2")).toBe(true);
    expect(machine.matches("p.r1.r1a")).toBe(true);
    expect(machine.matches("p.r2.r2a")).toBe(true);
    expect(machine.matches("p.r1.r1b")).toBe(false);
    expect(machine.matches("paused")).toBe(false);
  });

  it("CF8: lists the events of the whole configuration in document order", () => {
    const machine = parallelMachine();

    // "PAUSE" is declared on the parallel state, which precedes both regions, and the INC that
    // both regions declare appears once.
    expect(machine.getNextEvents()).toEqual(["PAUSE", "INC"]);
  });

  it("CF9: done only when no region can handle an event", async () => {
    const silent = createMachine({
      id: "silent",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: { r1: { initial: "a", states: { a: {} } }, r2: { initial: "b", states: { b: {} } } },
        },
      },
    });

    expect(silent.snapshot().done).toBe(true);

    const machine = parallelMachine();
    expect(machine.snapshot().done).toBe(false);

    // One region still able to handle an event keeps the whole configuration unfinished.
    await machine.send("INC");
    expect(machine.snapshot().done).toBe(false);
  });

  it("CF8: describes the whole configuration when an event is not allowed", async () => {
    const machine = parallelMachine();

    await expect(machine.send("RESUME")).rejects.toThrow(
      'Event "RESUME" is not allowed in configuration ["p.r1.r1a", "p.r2.r2a"] of machine "parallel".',
    );

    // A machine with one active leaf keeps the 0.1.0 wording.
    const sequential = createMachine({
      id: "sequential",
      initial: "idle",
      context: {},
      states: { idle: {}, done: { on: { RESTART: "idle" } } },
    });

    await expect(sequential.send("RESTART")).rejects.toThrow(
      'Event "RESTART" is not allowed in state "idle" of machine "sequential".',
    );
  });

  it("TS9: describes the whole configuration when every region rejects the guard", async () => {
    const machine = createMachine({
      id: "no-guards-pass-message",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: {
            r1: { initial: "a", on: { GO: { target: "b", guard: () => false } }, states: { a: {}, b: {} } },
            r2: { initial: "c", on: { GO: { target: "d", guard: () => false } }, states: { c: {}, d: {} } },
          },
        },
      },
    });

    await expect(machine.send("GO")).rejects.toThrow(
      'Guard rejected event "GO" in configuration ["p.r1.a", "p.r2.c"] of machine "no-guards-pass-message".',
    );
  });

  it("ST3: a parallel state reaches its own initial state, and regions nest further parallel states", async () => {
    const nested = createMachine({
      id: "nested",
      initial: "idle",
      context: {},
      states: {
        idle: { on: { START: "p" } },
        p: {
          type: "parallel",
          states: {
            r1: {
              type: "parallel",
              states: { deep: { initial: "x", states: { x: {} } } },
            },
            r2: { initial: "y", states: { y: {} } },
          },
        },
      },
    });

    await nested.send("START");

    expect(nested.configuration).toEqual(["p.r1.deep.x", "p.r2.y"]);
    expect(nested.state).toBe("p");
  });
});

describe("per-region transition selection", () => {
  it("BB3, TS8, AT6: one event advances every region in a single microstep", async () => {
    const log: string[] = [];
    const machine = parallelMachine(log);
    let notifications = 0;
    machine.subscribe(() => {
      notifications += 1;
    });

    const committed = await machine.send("INC");

    expect(committed.configuration).toEqual(["p.r1.r1b", "p.r2.r2b"]);
    expect(committed.revision).toBe(1);
    expect(notifications).toBe(1);
    // Actions run in document order of the declaring states, after the whole exit set, which is
    // itself in reverse document order.
    expect(log).toEqual([
      "exit r2a",
      "exit r1a",
      "inc r1",
      "inc r2",
      "enter r1b",
      "enter r2b",
    ]);
  });

  it("TS2, TS3, BB2: an event declared on the parallel state fires once for the whole machine", async () => {
    const log: string[] = [];
    const machine = parallelMachine(log);

    await machine.send("PAUSE");

    expect(machine.state).toBe("paused");
    expect(machine.configuration).toEqual(["paused"]);
    // Both regions selected the same declaration, so it fired once and exited the whole subtree in
    // reverse document order.
    expect(log).toEqual([
      "exit r2a",
      "exit r2",
      "exit r1a",
      "exit r1",
      "exit p",
      "enter paused",
    ]);
  });

  it("BB4: a guard returning false in one region does not stop another region", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "mixed-guards",
      initial: "p",
      context: { log },
      states: {
        p: {
          type: "parallel",
          states: {
            r1: {
              initial: "r1a",
              on: { INC: { target: "r1b", guard: () => false } },
              states: { r1a: {}, r1b: { entry: [() => log.push("enter r1b")] } },
            },
            r2: {
              initial: "r2a",
              on: { INC: { target: "r2b" } },
              states: { r2a: {}, r2b: { entry: [() => log.push("enter r2b")] } },
            },
          },
        },
      },
    });

    await expect(machine.send("INC")).resolves.toBeDefined();

    // The disabled region is simply unchanged, with no error raised.
    expect(machine.configuration).toEqual(["p.r1.r1a", "p.r2.r2b"]);
    expect(log).toEqual(["enter r2b"]);
  });

  it("TS9: rejects with GuardRejectedError when every region's guard returns false", async () => {
    const machine = createMachine({
      id: "no-guards-pass",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: {
            r1: {
              initial: "a",
              on: { GO: { target: "b", guard: () => false } },
              states: { a: {}, b: {} },
            },
            r2: {
              initial: "c",
              on: { GO: { target: "d", guard: () => false } },
              states: { c: {}, d: {} },
            },
          },
        },
      },
    });

    await expect(machine.send("GO")).rejects.toBeInstanceOf(GuardRejectedError);
    expect(machine.configuration).toEqual(["p.r1.a", "p.r2.c"]);
    expect(machine.snapshot().revision).toBe(0);
  });

  it("TS5a, BB5, BB6: a region preempts the parallel state's handler for the same event", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "preemption",
      initial: "p",
      context: { log },
      states: {
        p: {
          type: "parallel",
          exit: [() => log.push("exit p")],
          on: { STOP: { target: "stopped" } },
          states: {
            r1: {
              initial: "r1a",
              states: {
                r1a: { on: { STOP: { target: "r1b" } } },
                r1b: { entry: [() => log.push("enter r1b")] },
              },
            },
            r2: {
              initial: "r2a",
              states: { r2a: {}, r2b: {} },
            },
          },
        },
        stopped: {},
      },
    });

    await machine.send("STOP");

    // Region r1 outranks the parallel state, and r2's only candidate was the preempted one.
    expect(machine.state).toBe("p");
    expect(machine.configuration).toEqual(["p.r1.r1b", "p.r2.r2a"]);
    expect(log).toEqual(["enter r1b"]);
  });

  it("TS5b: sibling regions that both reach outside the parallel state resolve by document order", async () => {
    const machine = createMachine({
      id: "tie-break",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: {
            r1: { initial: "a", on: { FINISH: "endA" }, states: { a: {} } },
            r2: { initial: "b", on: { FINISH: "endB" }, states: { b: {} } },
          },
        },
        endA: {},
        endB: {},
      },
    });

    await machine.send("FINISH");

    // Neither region is an ancestor of the other, so the earlier leaf wins and the later is
    // preempted rather than both firing.
    expect(machine.state).toBe("endA");
    expect(machine.configuration).toEqual(["endA"]);
  });

  it("TS10: keeps the undeclared-event and not-accepted-in-this-configuration errors apart", async () => {
    const machine = parallelMachine();

    // Typed so the test can ask about an event the machine does not declare.
    await expect(machine.send("NOPE" as never)).rejects.toBeInstanceOf(InvalidEventError);
    await expect(machine.send("RESUME")).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe("exit and entry sets", () => {
  it("TD7: targeting a parallel state from outside enters every region", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "enter-parallel",
      initial: "idle",
      context: { log },
      states: {
        idle: { on: { OPEN: "p" } },
        p: {
          entry: [() => log.push("enter p")],
          type: "parallel",
          states: {
            r1: {
              initial: "r1a",
              entry: [() => log.push("enter r1")],
              states: { r1a: { entry: [() => log.push("enter r1a")] } },
            },
            r2: {
              initial: "r2a",
              entry: [() => log.push("enter r2")],
              states: { r2a: { entry: [() => log.push("enter r2a")] } },
            },
          },
        },
      },
    });

    await machine.send("OPEN");

    expect(machine.configuration).toEqual(["p.r1.r1a", "p.r2.r2a"]);
    expect(log).toEqual(["enter p", "enter r1", "enter r1a", "enter r2", "enter r2a"]);
  });

  it("TD1, TD8: a cross-region target exits the parallel state and resets the region it did not name", async () => {
    const machine = createMachine({
      id: "cross-region",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: {
            r1: {
              initial: "r1a",
              states: {
                r1a: { on: { INC: "r1b" } },
                r1b: { on: { CROSS: "p.r2.r2b" } },
              },
            },
            r2: {
              initial: "r2a",
              states: { r2a: {}, r2b: {} },
            },
          },
        },
      },
    });

    await machine.send("INC");
    expect(machine.configuration).toEqual(["p.r1.r1b", "p.r2.r2a"]);

    await machine.send("CROSS");

    // The parallel state is a proper descendant of the domain, so it exits and re-enters: r1 is
    // back at its initial child while r2 is where the target named.
    expect(machine.configuration).toEqual(["p.r1.r1a", "p.r2.r2b"]);
  });
});

describe("microstep atomicity", () => {
  it("AT1, AT2, AT3, AT5: one region's failing action rolls the whole microstep back", async () => {
    const machine = createMachine({
      id: "atomic",
      initial: "p",
      context: { count: 0 },
      states: {
        p: {
          type: "parallel",
          states: {
            r1: {
              initial: "r1a",
              states: {
                r1a: {
                  on: {
                    GO: {
                      target: "r1b",
                      actions: [
                        ({ context }) => {
                          context.count += 1;
                        },
                      ],
                    },
                  },
                },
                r1b: {},
              },
            },
            r2: {
              initial: "r2a",
              states: {
                r2a: {
                  on: {
                    GO: {
                      target: "r2b",
                      actions: [
                        ({ context }) => {
                          context.count += 1;
                          throw new Error("region two failed");
                        },
                      ],
                    },
                  },
                },
                r2b: {},
              },
            },
          },
        },
      },
    });

    let notifications = 0;
    machine.subscribe(() => {
      notifications += 1;
    });

    await expect(machine.send("GO")).rejects.toThrow("region two failed");

    // r1's action had already run and r1 had already exited, yet nothing is committed anywhere.
    expect(machine.configuration).toEqual(["p.r1.r1a", "p.r2.r2a"]);
    expect(machine.context).toEqual({ count: 0 });
    expect(machine.snapshot().revision).toBe(0);
    expect(notifications).toBe(0);
  });

  it("AT4: documents that hook side effects outside the machine are not rolled back", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "side-effects",
      initial: "p",
      context: { log },
      states: {
        p: {
          type: "parallel",
          states: {
            r1: {
              initial: "a",
              states: {
                a: { exit: [() => log.push("exit r1a")], on: { GO: "b" } },
                b: {},
              },
            },
            r2: {
              initial: "c",
              states: {
                c: {
                  on: {
                    GO: {
                      target: "d",
                      actions: [
                        () => {
                          throw new Error("nope");
                        },
                      ],
                    },
                  },
                },
                d: {},
              },
            },
          },
        },
      },
    });

    await expect(machine.send("GO")).rejects.toThrow("nope");

    // The exit hook already ran, so its external effect stands even though the machine is untouched.
    expect(log).toEqual(["exit r1a"]);
    expect(machine.configuration).toEqual(["p.r1.a", "p.r2.c"]);
  });
});

describe("region self-transitions", () => {
  it("EO5: a self-transition on a region resets the whole parallel subtree", async () => {
    const log: string[] = [];
    const machine = createMachine({
      id: "region-self",
      initial: "p",
      context: { log },
      states: {
        p: {
          type: "parallel",
          states: {
            r1: {
              initial: "r1a",
              entry: [() => log.push("enter r1")],
              exit: [() => log.push("exit r1")],
              on: { RESET: "r1" },
              states: {
                r1a: {
                  entry: [() => log.push("enter r1a")],
                  exit: [() => log.push("exit r1a")],
                  on: { INC: "r1b" },
                },
                r1b: {},
              },
            },
            r2: {
              initial: "r2a",
              states: { r2a: { entry: [() => log.push("enter r2a")], on: { INC: "r2b" } }, r2b: {} },
            },
          },
        },
      },
    });

    await machine.send("INC");
    expect(machine.configuration).toEqual(["p.r1.r1b", "p.r2.r2b"]);

    log.length = 0;
    await machine.send("RESET");

    // Parallel states are never the least common compound ancestor, so the domain is above the
    // parallel state and the self-transition resets the sibling region as well.
    expect(machine.configuration).toEqual(["p.r1.r1a", "p.r2.r2a"]);
    // Only the states that were active when the region was left run exit hooks, so r1b exits but
    // r1a, which is entered again, does not.
    expect(log).toEqual(["exit r1", "enter r1", "enter r1a", "enter r2a"]);
  });

  it("TD1, TS4, TS5b: a transition declared on the region itself reaches above the parallel state", async () => {
    const machine = createMachine({
      id: "region-declared",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          states: {
            r1: { initial: "a", on: { INC: "b" }, states: { a: {}, b: {} } },
            r2: { initial: "c", on: { INC: "d" }, states: { c: {}, d: {} } },
          },
        },
      },
    });

    await machine.send("INC");

    // The declaring state is the region, which is not a proper ancestor of itself, so the domain
    // is the root and the two regions conflict. Document order picks r1 and r2 never transitions,
    // which is why in-region transitions belong on a state inside the region.
    expect(machine.configuration).toEqual(["p.r1.b", "p.r2.c"]);
  });
});

describe("definition validation", () => {
  /**
   * Compiles a definition that the compiler already rejects, so the runtime check can be exercised
   * on its own. The compile-time rejection of the same definitions is asserted in
   * `types.test-d.ts`.
   */
  const compile = (definition: unknown) => () => createMachine(definition as never);

  it("ST4, ST5: rejects malformed parallel and history declarations at creation", () => {
    expect(
      compile({
        id: "bad",
        initial: "p",
        context: {},
        states: { p: { type: "parallel", initial: "a", states: { r1: { states: { a: {} } } } } },
      }),
    ).toThrow(/cannot declare "initial"/);

    expect(
      compile({
        id: "bad",
        initial: "p",
        context: {},
        states: { p: { type: "parallel" } },
      }),
    ).toThrow(/declares no "states"/);

    expect(
      compile({
        id: "bad",
        initial: "a",
        context: {},
        states: { a: { initial: "h", states: { h: { type: "history", history: "deep" } } } },
      }),
    ).toThrow(/history pseudo-state is never active/);

    expect(
      compile({
        id: "bad",
        initial: "a",
        context: {},
        states: { a: { initial: "b", states: { b: {}, h: { type: "history", on: { GO: "b" } } } } },
      }),
    ).toThrow(/cannot declare "on"/);

    expect(
      compile({
        id: "bad",
        initial: "h",
        context: {},
        states: { h: { type: "history" } },
      }),
    ).toThrow(/declared at the top level/);

    expect(
      compile({
        id: "bad",
        initial: "a",
        context: {},
        states: { a: { type: "compoundish" } },
      }),
    ).toThrow(/invalid "type"/);

    expect(
      compile({
        id: "bad",
        initial: "a",
        context: {},
        states: { a: { type: "atomic", states: { b: {} } } },
      }),
    ).toThrow(/declared "atomic" but declares "states"/);
  });

  it("reserves the transition type field and explains why it is refused", () => {
    const internal = {
      id: "internal",
      initial: "a",
      context: {},
      states: { a: { on: { GO: { target: "b", type: "internal" } } }, b: {} },
    };

    const caught = (definition: unknown): UnsupportedTransitionTypeError => {
      try {
        compile(definition)();
      } catch (error) {
        return error as UnsupportedTransitionTypeError;
      }
      throw new Error("expected the definition to be refused");
    };

    const failure = caught(internal);

    expect(failure).toBeInstanceOf(UnsupportedTransitionTypeError);
    expect(failure).toBeInstanceOf(MachineConfigurationError);
    expect(failure.message).toMatch(/internal transitions are not supported in this version/);
    // The rejected value is reported, so a caller can tell which field to remove.
    expect(failure.receivedType).toBe("internal");

    // A non-string `type` is still refused, and reports no name rather than a coerced one.
    expect(
      caught({
        ...internal,
        states: { a: { on: { GO: { target: "b", type: 42 } } }, b: {} },
      }).receivedType,
    ).toBeUndefined();
  });
});

describe("conflict resolution across regions", () => {
  it("TS5, TS6: a deeper region handler preempts an already selected ancestor handler", async () => {
    const machine = createMachine({
      id: "later-deeper",
      initial: "p",
      context: {},
      states: {
        p: {
          type: "parallel",
          on: { STOP: "stopped" },
          states: {
            r1: { initial: "s1", states: { s1: {} } },
            // The eligible leaf of this region comes after the leaf that selected the ancestor
            // handler, so the deeper handler is considered second and has to displace it.
            r2: { initial: "t1", on: { STOP: "t2" }, states: { t1: {}, t2: {} } },
          },
        },
        stopped: {},
      },
    });

    await machine.send("STOP");

    // The region outranks the parallel state, so `stopped` is not entered and r1 is untouched.
    expect(machine.state).toBe("p");
    expect(machine.configuration).toEqual(["p.r1.s1", "p.r2.t2"]);
  });
});