/**
 * Motivo Stateflow machine engine.
 *
 * Implements {@link createMachine}, the single entry point of the library. The engine is
 * framework-independent, has no runtime dependencies, and processes events through a strict FIFO
 * queue so concurrent `send()` calls can never commit against stale state.
 *
 * @packageDocumentation
 */

import {
  GuardRejectedError,
  InvalidEventError,
  InvalidTransitionError,
  MachineConfigurationError,
  QueueOverflowError,
  SnapshotValidationError,
  SUPPORTED_SNAPSHOT_VERSIONS,
  UnsupportedDefinitionKeyError,
  UnsupportedSnapshotVersionError,
  UnsupportedTransitionTypeError,
} from "./errors.js";
import { intersects, isDescendantOf, leastCommonCompoundAncestor } from "./graph.js";
import type {
  ActionFn,
  EventFromName,
  EventNameOf,
  EventPayloadMap,
  EventPayloadNames,
  GuardContext,
  GuardFn,
  Machine,
  MachineDefinition,
  MachineOptions,
  MachineSnapshot,
  Subscription,
  TransitionDefinition,
  Unsubscribe,
} from "./types.js";

/**
 * Snapshot format version this build writes and validates.
 *
 * Version 1 is the 0.1.0 shape, which stored a single `state` and no configuration or history
 * memory. Version 2 adds `configuration` and `history`, so a parallel machine can report every
 * active leaf and a history pseudo-state can survive serialization. A version 1 snapshot is
 * migrated by {@link migrateSnapshotV1ToV2}; anything else is refused rather than guessed at.
 */
const SNAPSHOT_FORMAT_VERSION = 2;

type StatePathUnion<TStates, TPrefix extends string = ""> = {
  [TKey in keyof TStates & string]:
    | `${TPrefix}${TKey}`
    | (TStates[TKey] extends { states: infer TChildren }
        ? StatePathUnion<TChildren, `${TPrefix}${TKey}.`>
        : never);
}[keyof TStates & string];

type BareTargetNames<TPath extends string> = TPath extends `${string}.${infer TRest}`
  ? BareTargetNames<TRest>
  : TPath;

type AllowedTargetNames<TPath extends string> =
  | TPath
  | BareTargetNames<TPath>
  | (TPath extends `${string}.${string}` ? `.${string}` : never);

type DeclaredTargets<TState> = TState extends { type: "history" }
  ? TState extends { target: infer THistoryTarget }
    ? THistoryTarget
    : never
  : TState extends { on: infer TOn }
    ? {
        [TEvent in keyof TOn]: TOn[TEvent] extends string
          ? TOn[TEvent]
          : TOn[TEvent] extends { target: infer TTarget }
            ? TTarget
            : never;
      }[keyof TOn]
    : never;

type StateEventNames<TStates> = {
  [TKey in keyof TStates]: TStates[TKey] extends { on: infer TOn }
    ? keyof TOn & string
    : never;
}[keyof TStates] | {
  [TKey in keyof TStates]: TStates[TKey] extends {
    states: infer TChildren extends Record<string, unknown>;
  }
    ? StateEventNames<TChildren>
    : never;
}[keyof TStates];

type InvalidTargets<TStates, TPath extends string> = {
  [TKey in keyof TStates]: TStates[TKey] extends { states: infer TChildren }
    ? InvalidTargets<TChildren, TPath>
    : never;
}[keyof TStates] | {
  [TKey in keyof TStates]: DeclaredTargets<TStates[TKey]> extends infer TTarget
    ? TTarget extends string
      ? TTarget extends AllowedTargetNames<TPath>
        ? never
        : TTarget
      : never
    : never;
}[keyof TStates];

type ValidateTargets<TStates, TPath extends string> =
  [InvalidTargets<TStates, TPath>] extends [never]
    ? unknown
    : { __invalid_transition_target__: InvalidTargets<TStates, TPath> };

type NestedStateMap<TState> = TState extends {
  states: infer TChildren extends Record<string, unknown>;
}
  ? TChildren
: Record<never, never>;

/**
 * Paths of history pseudo-states, which are valid transition targets but are never active and so
 * are excluded from the machine's state union.
 */
type HistoryPathUnion<TStates, TPrefix extends string = ""> = {
  [TKey in keyof TStates & string]:
    | (TStates[TKey] extends { type: "history" } ? `${TPrefix}${TKey}` : never)
    | (TStates[TKey] extends { states: infer TChildren extends Record<string, unknown> }
        ? HistoryPathUnion<TChildren, `${TPrefix}${TKey}.`>
        : never);
}[keyof TStates & string];

/**
 * Every path a machine can be *in*: the declared paths without the history pseudo-states. This is
 * the machine's state union, and therefore the type of `configuration`, `state`, `matches()`,
 * `restore()` results and a history default target.
 */
type EnterablePathUnion<TStates> = Exclude<StatePathUnion<TStates>, HistoryPathUnion<TStates>>;

/**
 * State-kind declarations that cannot work, as a property name that becomes the compiler's error
 * message. Covers a parallel state that also declares `initial`, a parallel state with nothing to
 * run in parallel, a history pseudo-state that declares anything only an active state may declare,
 * and a history pseudo-state at the top level, where it has no configuration to remember.
 */
type InvalidStateTree<TStates, TTopLevel extends boolean = false> = {
  [TKey in keyof TStates & string]: TStates[TKey] extends { type: "history" }
    ? TStates[TKey] extends
        | { states: unknown }
        | { initial: unknown }
        | { on: unknown }
        | { entry: unknown }
        | { exit: unknown }
      ? `${TKey}.history-pseudo-state-must-not-declare-states-hooks-or-transitions`
      : TTopLevel extends true
        ? `${TKey}.history-pseudo-state-needs-a-parent-state`
        : never
    : TStates[TKey] extends { type: "parallel" }
      ? TStates[TKey] extends { initial: unknown }
        ? `${TKey}.parallel-state-must-not-declare-initial`
        : TStates[TKey] extends { states: infer TChildren extends Record<string, unknown> }
          ? InvalidStateTree<TChildren>
          : `${TKey}.parallel-state-needs-at-least-one-region`
      : TStates[TKey] extends { states: infer TChildren extends Record<string, unknown> }
        ? TStates[TKey] extends { initial: infer TInitial extends string }
          ? TInitial extends keyof TChildren
            ? InvalidStateTree<TChildren>
            : `${TKey}.compound-state-needs-an-initial-child`
          : `${TKey}.compound-state-needs-an-initial-child`
        : TStates[TKey] extends { initial: unknown }
          ? `${TKey}.initial-without-states`
          : never;
}[keyof TStates & string];

type ValidateStateTree<TStates> = [InvalidStateTree<TStates, true>] extends [never]
  ? unknown
  : { __invalid_state_kind__: InvalidStateTree<TStates, true> };

type InferredMachineDefinition<
  TContext,
  TState extends string,
  TEvent extends string,
  TStates extends Record<string, unknown>,
  TPayloads extends EventPayloadMap,
> = {
  id: string;
  initial: NoInfer<TState>;
  context: TContext;
  events?: TPayloads;
  states: TStates & {
    [TKey in TState]: FlexibleStateDefinition<
      TContext,
      TEvent | EventPayloadNames<TPayloads>,
      TPayloads,
      TKey,
      NestedStateMap<TStates[TKey]>
    >;
  };
};

type FlexibleStateDefinition<
  TContext,
  TEvent extends string,
  TPayloads extends EventPayloadMap,
  TKey extends string,
  TChildren extends Record<string, unknown> = Record<never, never>,
> = {
  /** State kind. Omitting it infers `compound` from `states` and `atomic` otherwise. */
  type?: "atomic" | "compound" | "parallel" | "history";
  /** Depth of a history pseudo-state's memory. Defaults to `"shallow"`. */
  history?: "shallow" | "deep";
  /**
   * State a history pseudo-state enters on first entry, before any memory exists.
   *
   * Typed as a string because the definition is still being inferred here: the declared value is
   * checked against the state tree by `ValidateTargets`, which sees the whole tree.
   */
  target?: string;
  entry?: ReadonlyArray<ActionFn<TContext, TKey, EventFromName<TEvent, TPayloads>>>;
  exit?: ReadonlyArray<ActionFn<TContext, TKey, EventFromName<TEvent, TPayloads>>>;
  on?: {
    [TEventKey in NoInfer<TEvent>]?: TransitionDefinition<
      TContext,
      string,
      TEvent,
      TKey,
      TEventKey,
      TPayloads
    > | string;
  };
  initial?: string;
  states?: TChildren & {
    [TChild in keyof TChildren & string]: FlexibleStateDefinition<
      TContext,
      TEvent,
      TPayloads,
      `${TKey}.${TChild}`,
      NestedStateMap<TChildren[TChild]>
    >;
  };
};

/**
 * A transition after normalization: the target is resolved eagerly, `null` when the declaration
 * omitted it, and every hook list is copied into a local array, so later mutation of the caller's
 * definition cannot change the behaviour of a running machine.
 *
 * A targetless transition has an empty exit set and an empty entry set, so it runs its guard and
 * its actions while the configuration stays as it was.
 */
type CompiledTransition<TContext> = {
  /** Declared target, or `null` for a targetless transition, which neither exits nor enters. */
  target: CompiledNode<TContext> | null;
  /** Guard returning `false` leaves this transition out of the microstep. */
  guard?: GuardFn<TContext, string, unknown>;
  actions?: Array<ActionFn<TContext, string, unknown>>;
};

/**
 * Kind of a real state. A history pseudo-state is a separate node type because it is never active
 * and holds no hooks or transitions.
 */
type CompiledStateKind = "atomic" | "compound" | "parallel";

/**
 * A state after compilation. States form a tree: a compound state holds its children by key and
 * remembers the child to enter, a parallel state holds its regions and enters all of them.
 * Transitions live in a `Map`, which removes every prototype-chain hazard: events such as
 * `toString`, `constructor` or `hasOwnProperty` resolve only when they are declared explicitly.
 *
 * The machine's top level hangs off a virtual root, whose own key and path are empty and which
 * declares no hooks. That gives resolution and the least common ancestor arithmetic one uniform
 * shape: every top-level state is simply a child of the root.
 */
type CompiledState<TContext> = {
  /** Distinguishes the three enterable kinds. */
  kind: CompiledStateKind;
  /** Dot-joined path from the top level, for example `"draft.editing"`. Empty for the root. */
  path: string;
  /** This state's own key, as the definition writes it. Empty for the root. */
  key: string;
  /** Enclosing state, or the root itself for the root. */
  parent: CompiledState<TContext>;
  /** Position in document order: depth-first, pre-order, declaration order. */
  order: number;
  /** Nested states by key, in declaration order. Empty for an atomic state. */
  children: Map<string, CompiledState<TContext>>;
  /** History pseudo-states declared by this state, by key. */
  history: Map<string, CompiledHistory<TContext>>;
  /** Child entered when this state is entered. Absent for an atomic or parallel state. */
  initialChild?: CompiledState<TContext>;
  entry: Array<ActionFn<TContext, string, unknown>>;
  exit: Array<ActionFn<TContext, string, unknown>>;
  transitions: Map<string, CompiledTransition<TContext>>;
};

/**
 * A history pseudo-state: `type: "history"` on a child of the state whose configuration it
 * remembers. It is never active, so it declares no hooks and no transitions, and it is excluded
 * from the machine's state union while remaining a valid transition target.
 */
type CompiledHistory<TContext> = {
  kind: "history";
  /** Dot-joined path, for example `"draft.remember"`. */
  path: string;
  /** This pseudo-state's own key. */
  key: string;
  /** The state whose configuration is remembered. */
  parent: CompiledState<TContext>;
  /** Position in document order, so a history node sorts next to its declared siblings. */
  order: number;
  /** `"shallow"` records the parent's active children, `"deep"` every active atomic descendant. */
  memory: "shallow" | "deep";
  /** State entered on first entry, before any memory has been recorded. */
  defaultTarget?: CompiledState<TContext>;
};

/** A transition target: either a real state or a history pseudo-state. */
type CompiledNode<TContext> = CompiledState<TContext> | CompiledHistory<TContext>;

/**
 * One region's contribution to a microstep: the transition that region selected, its declaring
 * state, the active leaf that selected it and the exit set that decision implies.
 */
type Candidate<TContext> = {
  /** State that declares the transition. */
  source: CompiledState<TContext>;
  /** The transition itself. */
  transition: CompiledTransition<TContext>;
  /** Document order of the first active leaf that selected this candidate. */
  leafOrder: number;
  /** Effective targets, with any history pseudo-state already dereferenced. */
  targets: Array<CompiledState<TContext>>;
  /** Active states this candidate exits, which is what decides conflicts. */
  exit: Set<CompiledState<TContext>>;
};

/**
 * A single `subscribe()` call. Subscriptions are tracked per call instead of per function, so
 * subscribing the same function twice can be undone one subscription at a time.
 */
type ListenerRecord<TContext, TState extends string, TEvent> = {
  listener: Subscription<TContext, TState, TEvent>;
};

/**
 * Creates a machine runtime from a declarative definition.
 *
 * The definition is validated eagerly, so malformed definitions - undeclared initial states,
 * transition targets that are not declared, hooks that are not arrays of functions - fail at
 * creation time with a {@link MachineConfigurationError} instead of failing later on an event.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 * @param definition - Declarative machine definition.
 * @returns A runtime machine exposing `id`, `state`, `context`, `send`, `can`, `getNextEvents`,
 * `matches`, `subscribe`, `snapshot`, `restore`, `whenIdle` and `toJSON`.
 * @throws {MachineConfigurationError} When the definition is malformed.
 *
 * @example
 * ```ts
 * const machine = createMachine({
 *   id: "order",
 *   initial: "pending",
 *   context: { paymentAuthorized: false },
 *   states: {
 *     pending: { on: { CONFIRM: "confirmed" } },
 *     confirmed: {},
 *   },
 * });
 *
 * console.log(machine.state); // "pending"
 * await machine.send("CONFIRM");
 * console.log(machine.state); // "confirmed"
 * ```
 */
export function createMachine<
  TContext extends object,
  TState extends string,
  TEvent extends string,
  TPayloads extends EventPayloadMap = Record<never, never>,
>(
  definition: MachineDefinition<TContext, TState, TEvent, TState, TPayloads>,
  options?: MachineOptions<TContext>,
): Machine<
  TContext,
  TState,
  EventFromName<TEvent | EventPayloadNames<TPayloads>, TPayloads>
>;
// eslint-disable-next-line no-redeclare
export function createMachine<
  TContext extends object,
  TState extends string,
  const TStates extends Record<string, unknown>,
  TPayloads extends EventPayloadMap = Record<never, never>,
  TEvent extends string = StateEventNames<TStates>,
>(
  definition: InferredMachineDefinition<
    TContext,
    TState,
    TEvent,
    TStates,
    TPayloads
  > &
    ValidateTargets<NoInfer<TStates>, StatePathUnion<NoInfer<TStates>>> &
    ValidateStateTree<NoInfer<TStates>>,
  options?: MachineOptions<TContext>,
): Machine<
  TContext,
  EnterablePathUnion<TStates>,
  EventFromName<
    StateEventNames<TStates> | TEvent | EventPayloadNames<TPayloads>,
    TPayloads
  >
>;
/**
 * Compatibility overload for explicitly annotated machine definitions.
 */
// eslint-disable-next-line no-redeclare
export function createMachine<
  TContext extends object,
  TState extends string,
  TEvent extends string,
  TPath extends string = TState,
  TPayloads extends EventPayloadMap = Record<never, never>,
>(
  definition: MachineDefinition<TContext, TState, TEvent, TPath, TPayloads>,
  options?: MachineOptions<TContext>,
): Machine<TContext, TPath, EventFromName<TEvent | EventPayloadNames<TPayloads>, TPayloads>>;
// eslint-disable-next-line no-redeclare
export function createMachine<TContext extends object>(
  definition: unknown,
  options: MachineOptions<TContext> = {},
): unknown {
  const raw = definition as unknown as {
    id?: unknown;
    on?: unknown;
    initial?: unknown;
    context?: unknown;
    states?: unknown;
  };
  const machineId = typeof raw.id === "string" ? raw.id : "";

  if (machineId.trim() === "") {
    throw new MachineConfigurationError('Machine definitions require a non-empty string "id".');
  }

  // Transitions belong to states, so a machine-level map is a misplaced handler rather than a
  // feature. It is rejected instead of ignored: a definition that reads as if it reacts would
  // otherwise produce a machine that never does.
  if (raw.on !== undefined) {
    throw new UnsupportedDefinitionKeyError(
      `Machine "${machineId}" declares a top-level "on" map, but transitions belong to states: declare them on the state that should react. A machine has no state of its own to transition from.`,
      "on",
    );
  }

  const rawStates = assertPlainObject(
    raw.states,
    `Machine "${machineId}" must declare a "states" object.`,
  );
  if (Object.keys(rawStates).length === 0) {
    throw new MachineConfigurationError(`Machine "${machineId}" must declare at least one state.`);
  }
  assertPlainObject(
    raw.context,
    `Machine "${machineId}" context must be a plain object so it can be cloned safely.`,
  );
  if (typeof raw.initial !== "string" || !hasOwn(rawStates, raw.initial)) {
    throw new MachineConfigurationError(
      `Machine "${machineId}" initial state ${describe(raw.initial)} is not declared.`,
    );
  }

  const { root, initialConfiguration, pathIndex, historyIndex, recognizedEvents } =
    compileTree<TContext>(machineId, rawStates, raw.initial);

  const rawOptions = options as unknown as {
    schemaVersion?: unknown;
    parseContext?: unknown;
    maxQueueDepth?: unknown;
  };
  if (
    rawOptions.schemaVersion !== undefined &&
    (typeof rawOptions.schemaVersion !== "number" ||
      !Number.isSafeInteger(rawOptions.schemaVersion) ||
      rawOptions.schemaVersion < 0)
  ) {
    throw new MachineConfigurationError(
      `Machine "${machineId}" option "schemaVersion" must be a non-negative integer.`,
    );
  }
  if (rawOptions.parseContext !== undefined && typeof rawOptions.parseContext !== "function") {
    throw new MachineConfigurationError(
      `Machine "${machineId}" option "parseContext" must be a function.`,
    );
  }
  if (
    rawOptions.maxQueueDepth !== undefined &&
    (typeof rawOptions.maxQueueDepth !== "number" ||
      !Number.isSafeInteger(rawOptions.maxQueueDepth) ||
      rawOptions.maxQueueDepth < 1)
  ) {
    throw new MachineConfigurationError(
      `Machine "${machineId}" option "maxQueueDepth" must be a positive integer.`,
    );
  }
  const schemaVersion = (rawOptions.schemaVersion as number | undefined) ?? SNAPSHOT_FORMAT_VERSION;
  const parseContext = rawOptions.parseContext as ((input: unknown) => TContext) | undefined;
  const maxQueueDepth =
    (rawOptions.maxQueueDepth as number | undefined) ?? Number.POSITIVE_INFINITY;

  let activeLeaves: Array<CompiledState<TContext>> = initialConfiguration;
  let activeStates: Set<CompiledState<TContext>> = new Set<CompiledState<TContext>>();
  /** Paths of every active state, so `matches()` answers without walking the tree. */
  let activePaths: Set<string> = new Set<string>();
  let historyMemory = new Map<string, Array<CompiledState<TContext>>>();
  let currentContext: TContext = cloneContext(raw.context as TContext, () => {
    throw new MachineConfigurationError(
      `Machine "${machineId}" context must be structured-cloneable: it cannot contain functions or other non-cloneable values.`,
    );
  });
  let revision = 0;
  let queueTail: Promise<void> = Promise.resolve();
  let pending = 0;
  const idleWaiters = new Set<() => void>();
  type TMachineEvent = unknown;
  type TMachinePath = string;
  const listeners = new Set<ListenerRecord<TContext, TMachinePath, TMachineEvent>>();

  const finishQueuedTask = (): void => {
    pending -= 1;
    if (pending > 0) {
      return;
    }
    for (const resolve of [...idleWaiters]) {
      resolve();
    }
    idleWaiters.clear();
  };

  /**
   * Appends a task to the FIFO queue. The task starts only after every previously submitted task
   * has settled, and a failing task never poisons the queue: the tail promise always resolves so
   * later tasks still run, while the caller still receives the original failure.
   *
   * This is the single entry point for everything that queues work, which is what makes the
   * `maxQueueDepth` cap cover `send()`, `can()` and `restore()` alike. A task that arrives at the
   * cap is refused outright: it is not queued, so it takes no turn and holds no slot.
   */
  const enqueue = <T>(task: () => T | Promise<T>): Promise<T> => {
    if (pending >= maxQueueDepth) {
      return Promise.reject(
        new QueueOverflowError(
          `Machine "${machineId}" refused a submission: ${pending} submissions are already queued, which is its maxQueueDepth of ${maxQueueDepth}. Await the queued work, or whenIdle(), before submitting more.`,
        ),
      );
    }
    pending += 1;
    const result = queueTail.then(task);
    queueTail = result.then(finishQueuedTask, finishQueuedTask);
    return result;
  };

  /**
   * Active states reachable from one active leaf up to the top level, deepest first. The root is
   * not included.
   */
  const chainOf = (leaf: CompiledState<TContext>): Array<CompiledState<TContext>> => {
    const chain: Array<CompiledState<TContext>> = [];
    for (let node = leaf; node !== root; node = node.parent) {
      chain.push(node);
    }
    return chain;
  };

  /**
   * The set of active states implied by a configuration: every active leaf and all of its
   * ancestors. A configuration is stored as its leaves because any active non-atomic state is an
   * ancestor of at least one leaf, so storing leaves loses nothing and cannot become inconsistent.
   */
  const activeSetOf = (
    leaves: Array<CompiledState<TContext>>,
  ): Set<CompiledState<TContext>> => {
    const active = new Set<CompiledState<TContext>>();
    for (const leaf of leaves) {
      for (const state of chainOf(leaf)) {
        active.add(state);
      }
    }
    return active;
  };

  /** Replaces the configuration and everything derived from it, in one place. */
  const applyConfiguration = (leaves: Array<CompiledState<TContext>>): void => {
    const states = activeSetOf(leaves);
    activeLeaves = leaves;
    activeStates = states;
    activePaths = new Set([...states].map((state) => state.path));
  };

  applyConfiguration(activeLeaves);

  /**
   * The active states one candidate exits: the proper descendants of its domain, or nothing at all
   * for a targetless transition, which has no domain to compute because it has no target.
   */
  const exitSetFor = (
    source: CompiledState<TContext>,
    targets: Array<CompiledState<TContext>>,
  ): Set<CompiledState<TContext>> => {
    const exiting = new Set<CompiledState<TContext>>();
    if (targets.length === 0) {
      return exiting;
    }
    const domain = leastCommonCompoundAncestor([source, ...targets], root);
    for (const state of activeStates) {
      if (isDescendantOf(state, domain)) {
        exiting.add(state);
      }
    }
    return exiting;
  };

  /**
   * The complete target set: the effective targets, all of their ancestors, and the closure that
   * adds every region of an entered parallel state and the default entry of a compound state that
   * nothing inside it targets.
   *
   * `survivors` is the active configuration minus the exit set, and it is what stops the closure
   * from resetting a parallel sibling region: a region that keeps an active child is already where
   * it should be, so its own default entry must not be added alongside that child.
   */
  const completeTargetSet = (
    targets: Array<CompiledState<TContext>>,
    survivors: Set<CompiledState<TContext>>,
  ): Set<CompiledState<TContext>> => {
    const targetSet = new Set<CompiledState<TContext>>();
    const addWithAncestors = (state: CompiledState<TContext>): void => {
      for (let node = state; node !== root; node = node.parent) {
        targetSet.add(node);
      }
    };
    for (const target of targets) {
      addWithAncestors(target);
    }

    const hasChildInSet = (state: CompiledState<TContext>): boolean =>
      [...state.children.values()].some((child) => targetSet.has(child));
    const keepsActiveChild = (state: CompiledState<TContext>): boolean =>
      [...state.children.values()].some((child) => survivors.has(child));

    for (let changed = true; changed; ) {
      changed = false;
      for (const state of [...targetSet]) {
        if (state.kind === "parallel") {
          for (const child of state.children.values()) {
            if (!targetSet.has(child)) {
              addWithAncestors(child);
              changed = true;
            }
          }
        } else if (
          state.kind === "compound" &&
          state.initialChild &&
          !hasChildInSet(state) &&
          !keepsActiveChild(state)
        ) {
          addWithAncestors(state.initialChild);
          changed = true;
        }
      }
    }
    return targetSet;
  };

  /**
   * The deepest active state that contains the whole configuration, which is what `state` reports.
   * For a sequential configuration that is the single active leaf; for a parallel configuration it
   * is the parallel state, because no deeper state contains every active leaf.
   */
  const configurationRoot = (
    leaves: Array<CompiledState<TContext>>,
  ): CompiledState<TContext> => {
    let deepest: CompiledState<TContext> | undefined;
    for (const leaf of leaves) {
      if (deepest === undefined) {
        deepest = leaf;
        continue;
      }
      while (deepest !== root && deepest !== leaf && !isDescendantOf(leaf, deepest)) {
        deepest = deepest.parent;
      }
    }
    return deepest ?? root;
  };

  /** A configuration is done when no active state in any region can handle an event. */
  const isDone = (leaves: Array<CompiledState<TContext>>): boolean => {
    for (const state of activeSetOf(leaves)) {
      if (state.transitions.size > 0) {
        return false;
      }
    }
    return true;
  };

  /** Serializes history memory, which is held as compiled states while the machine is running. */
  const historyToPaths = (): Record<string, Array<string>> => {
    const serialized: Record<string, Array<string>> = {};
    for (const [path, states] of historyMemory) {
      serialized[path] = states.map((state) => state.path);
    }
    return serialized;
  };

  const buildSnapshot = (
    leaves: Array<CompiledState<TContext>>,
    context: TContext,
    event: TMachineEvent | null,
    previous: Array<CompiledState<TContext>> | null,
  ): MachineSnapshot<TContext, TMachinePath, TMachineEvent> => ({
    id: machineId,
    state: configurationRoot(leaves).path as TMachinePath,
    context,
    event: event === null ? null : cloneEvent(event, machineId),
    previous: previous === null ? null : (configurationRoot(previous).path as TMachinePath),
    revision,
    done: isDone(leaves),
    schemaVersion,
    configuration: leaves.map((leaf) => leaf.path as TMachinePath),
    history: historyToPaths() as Record<string, Array<TMachinePath>>,
  });

  const snapshot = (): MachineSnapshot<TContext, TMachinePath, TMachineEvent> =>
    buildSnapshot(activeLeaves, cloneContext(currentContext), null, null);

  const notify = (
    committedContext: TContext,
    committed: MachineSnapshot<TContext, TMachinePath, TMachineEvent>,
  ): void => {
    for (const record of [...listeners]) {
      try {
        record.listener({
          ...committed,
          context: cloneContext(committedContext),
          event: committed.event === null ? null : cloneEvent(committed.event, machineId),
        });
      } catch {
        // A misbehaving subscriber must never corrupt machine state or stall the queue.
      }
    }
  };

  const normaliseEvent = (event: TMachineEvent): string => {
    if (typeof event === "string") {
      return event;
    }
    if (!isPlainObject(event) || typeof event.type !== "string") {
      throw new InvalidEventError(
        `Machine "${machineId}" can only process event names or event objects with a string "type", received ${describe(event)}.`,
      );
    }
    return event.type;
  };

  const prepareEvent = (event: TMachineEvent): TMachineEvent => {
    normaliseEvent(event);
    return cloneEvent(event, machineId);
  };

  /**
   * Every region's candidate for an event: at most one per active leaf, taken from that leaf's
   * nearest declaring ancestor. A declaration on an ancestor shared by several regions is found
   * from each of them but is one transition, so candidates are keyed by declaring state and
   * remember the first leaf that selected them. That leaf is what document order uses to break a
   * priority tie, and it is why the order of `activeLeaves` matters here.
   */
  const candidatesFor = (event: string): Array<Candidate<TContext>> => {
    const bySource = new Map<CompiledState<TContext>, Candidate<TContext>>();
    for (const leaf of activeLeaves) {
      for (const state of chainOf(leaf)) {
        const transition = state.transitions.get(event);
        if (!transition) {
          continue;
        }
        if (!bySource.has(state)) {
          bySource.set(state, {
            source: state,
            transition,
            leafOrder: leaf.order,
            targets: [],
            exit: new Set<CompiledState<TContext>>(),
          });
        }
        break;
      }
    }
    return [...bySource.values()];
  };

  /**
   * The event's candidates, or the error that explains why the event cannot be processed at all.
   * Shared by `send()` and `can()` so both agree on what is accepted where.
   */
  const resolveCandidates = (event: string): Array<Candidate<TContext>> => {
    const candidates = candidatesFor(event);
    if (candidates.length > 0) {
      return candidates;
    }
    if (!recognizedEvents.has(event)) {
      throw new InvalidEventError(`Event "${event}" is not recognised by machine "${machineId}".`);
    }
    throw new InvalidTransitionError(
      `Event "${event}" is not allowed in ${describeConfiguration(activeLeaves)} of machine "${machineId}".`,
    );
  };

  /**
   * Effective targets of a transition, dereferencing a history pseudo-state: the remembered
   * configuration when there is one, otherwise the declared default target, otherwise the ordinary
   * default entry of the parent state. Dereferencing happens before the domain and the exit and
   * entry sets are computed, so everything after it is ordinary transition semantics.
   *
   * A targetless transition has no targets, so nothing is exited and nothing is entered.
   */
  const effectiveTargets = (
    transition: CompiledTransition<TContext>,
    memory: Map<string, Array<CompiledState<TContext>>>,
  ): Array<CompiledState<TContext>> => {
    const target = transition.target;
    if (target === null) {
      return [];
    }
    if (target.kind !== "history") {
      return [target];
    }
    const remembered = memory.get(target.path);
    if (remembered && remembered.length > 0) {
      return [...remembered];
    }
    return target.defaultTarget ? [target.defaultTarget] : [target.parent];
  };

  /**
   * True when `candidate` has higher priority than `other`, which are known to conflict. A
   * transition declared deeper wins, which is how a region preempts the parallel state that
   * contains it. When neither declaration is an ancestor of the other, the leaf that selected the
   * candidate earlier in document order wins.
   */
  const outranks = (candidate: Candidate<TContext>, other: Candidate<TContext>): boolean => {
    if (isDescendantOf(candidate.source, other.source)) {
      return true;
    }
    if (isDescendantOf(other.source, candidate.source)) {
      return false;
    }
    return candidate.leafOrder < other.leafOrder;
  };

  /**
   * The selected set for a microstep: the largest conflict-free set of enabled candidates in which
   * no excluded candidate outranks a member.
   *
   * Two candidates conflict when their exit sets intersect, which can only happen when their
   * declaring states are related by ancestry, or when both reach above the parallel state that
   * contains them. Candidates are considered in document order of the leaves that selected them,
   * and one that outranks a conflicting member replaces it.
   */
  const selectCandidates = (
    candidates: Array<Candidate<TContext>>,
    memory: Map<string, Array<CompiledState<TContext>>>,
  ): Array<Candidate<TContext>> => {
    const selected: Array<Candidate<TContext>> = [];
    for (const candidate of candidates) {
      const targets = effectiveTargets(candidate.transition, memory);
      const resolved: Candidate<TContext> = {
        ...candidate,
        targets,
        exit: exitSetFor(candidate.source, targets),
      };
      const clashing = selected.filter((existing) => intersects(resolved.exit, existing.exit));
      if (clashing.some((existing) => !outranks(resolved, existing))) {
        continue;
      }
      for (const preempted of clashing) {
        selected.splice(selected.indexOf(preempted), 1);
      }
      selected.push(resolved);
    }
    return selected;
  };

  /**
   * Records history memory for every exiting state that declares history pseudo-states, before any
   * exit hook runs, so the memory describes the configuration as it was when the state was left.
   * Shallow memory keeps the parent's active children, deep memory every active atomic descendant.
   */
  const recordHistory = (
    exiting: Set<CompiledState<TContext>>,
    memory: Map<string, Array<CompiledState<TContext>>>,
  ): void => {
    for (const state of exiting) {
      for (const history of state.history.values()) {
        memory.set(
          history.path,
          history.memory === "deep"
            ? activeLeaves.filter((leaf) => isDescendantOf(leaf, state))
            : [...state.children.values()].filter((child) => activeStates.has(child)),
        );
      }
    }
  };

  /** The configuration a microstep commits: leaves it left alone, plus the leaves it entered. */
  const nextConfiguration = (
    exit: Set<CompiledState<TContext>>,
    entry: Set<CompiledState<TContext>>,
  ): Array<CompiledState<TContext>> => {
    const leaves = activeLeaves.filter((leaf) => !exit.has(leaf));
    for (const state of entry) {
      if (state.kind === "atomic" && !leaves.includes(state)) {
        leaves.push(state);
      }
    }
    return leaves.sort((left, right) => left.order - right.order);
  };

  /** True for the virtual root, which is its own parent and is not part of any configuration. */
  const isRoot = (state: CompiledState<TContext>): boolean => state.parent === state;

  /**
   * Validates a stored configuration and decodes it into compiled leaves.
   *
   * A payload is a list of active atomic paths, so every entry must be declared, must not be a
   * history pseudo-state, and must be atomic, and the whole set must be a legal configuration:
   * exactly one top-level state, exactly one active child per active compound state, and every
   * region of an active parallel state active.
   */
  const validateConfiguration = (value: unknown): Array<CompiledState<TContext>> => {
    if (!Array.isArray(value)) {
      throw new SnapshotValidationError(
        `Snapshot configuration for machine "${machineId}" must be an array of active state paths.`,
      );
    }
    if (value.length === 0) {
      throw new SnapshotValidationError(
        `Snapshot configuration for machine "${machineId}" must name at least one active state.`,
      );
    }

    const leaves: Array<CompiledState<TContext>> = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw new SnapshotValidationError(
          `Snapshot configuration for machine "${machineId}" contains ${describe(entry)}, which is not a state path.`,
        );
      }
      if (historyIndex.has(entry)) {
        throw new SnapshotValidationError(
          `Snapshot configuration for machine "${machineId}" names history pseudo-state ${describe(entry)}, which is never active.`,
        );
      }
      const state = pathIndex.get(entry);
      if (!state) {
        throw new SnapshotValidationError(
          `Snapshot state ${describe(entry)} is not declared by machine "${machineId}".`,
        );
      }
      if (state.kind !== "atomic") {
        throw new SnapshotValidationError(
          `Snapshot state ${describe(entry)} of machine "${machineId}" is a ${state.kind} state, which the machine cannot be in on its own; store the active atomic states instead.`,
        );
      }
      if (!leaves.includes(state)) {
        leaves.push(state);
      }
    }

    leaves.sort((left, right) => left.order - right.order);

    const active = activeSetOf(leaves);
    const topLevel = [...active].filter((state) => isRoot(state.parent));
    if (topLevel.length !== 1) {
      throw new SnapshotValidationError(
        `Snapshot configuration for machine "${machineId}" activates ${topLevel.length} top-level states; exactly one must be active.`,
      );
    }
    for (const state of active) {
      const activeChildren = [...state.children.values()].filter((child) => active.has(child));
      if (state.kind === "compound" && activeChildren.length !== 1) {
        throw new SnapshotValidationError(
          `Snapshot configuration for machine "${machineId}" activates ${activeChildren.length} children of compound state ${describe(state.path)}; exactly one must be active.`,
        );
      }
      if (state.kind === "parallel" && activeChildren.length !== state.children.size) {
        throw new SnapshotValidationError(
          `Snapshot configuration for machine "${machineId}" activates ${activeChildren.length} of the ${state.children.size} regions of parallel state ${describe(state.path)}; every region must be active.`,
        );
      }
    }
    return leaves;
  };

  /**
   * Validates and decodes stored history memory: every key is a declared history pseudo-state and
   * every remembered path is a state the pseudo-state could have recorded. A shallow pseudo-state
   * remembers direct children of its parent, a deep one remembers atomic descendants.
   */
  const validateHistory = (
    value: unknown,
  ): Map<string, Array<CompiledState<TContext>>> => {
    if (value === undefined) {
      return new Map<string, Array<CompiledState<TContext>>>();
    }
    if (!isPlainObject(value)) {
      throw new SnapshotValidationError(
        `Snapshot history for machine "${machineId}" must be an object keyed by history pseudo-state path.`,
      );
    }

    const memory = new Map<string, Array<CompiledState<TContext>>>();
    for (const [path, remembered] of Object.entries(value)) {
      const history = historyIndex.get(path);
      if (!history) {
        throw new SnapshotValidationError(
          `Snapshot history for machine "${machineId}" has an entry for ${describe(path)}, which is not a history pseudo-state.`,
        );
      }
      if (!Array.isArray(remembered)) {
        throw new SnapshotValidationError(
          `Snapshot history entry for pseudo-state ${describe(path)} of machine "${machineId}" must be an array of state paths.`,
        );
      }

      const states: Array<CompiledState<TContext>> = [];
      for (const entry of remembered) {
        const state = typeof entry === "string" ? pathIndex.get(entry) : undefined;
        if (!state || !isDescendantOf(state, history.parent)) {
          throw new SnapshotValidationError(
            `Snapshot history entry for pseudo-state ${describe(path)} of machine "${machineId}" names ${describe(entry)}, which is not a state inside ${describe(history.parent.path)}.`,
          );
        }
        if (history.memory === "shallow" && state.parent !== history.parent) {
          throw new SnapshotValidationError(
            `Snapshot history entry for shallow pseudo-state ${describe(path)} of machine "${machineId}" names ${describe(entry)}, which is not a direct child of ${describe(history.parent.path)}.`,
          );
        }
        if (history.memory === "deep" && state.kind !== "atomic") {
          throw new SnapshotValidationError(
            `Snapshot history entry for deep pseudo-state ${describe(path)} of machine "${machineId}" names ${describe(entry)}, which is not an atomic state.`,
          );
        }
        if (!states.includes(state)) {
          states.push(state);
        }
      }
      states.sort((left, right) => left.order - right.order);
      memory.set(path, states);
    }
    return memory;
  };


  const execute = async (
    actions: Array<ActionFn<TContext, string, unknown>>,
    args: GuardContext<TContext, string, unknown>,
  ): Promise<void> => {
    for (const action of actions) {
      await action(args);
    }
  };

  /**
   * Runs one microstep to completion.
   *
   * Every guard runs first, before any hook, against the same pre-transition staging clone, so no
   * guard observes another region's action effects. A guard returning `false` disables only its own
   * transition and the microstep continues with whatever else is enabled, which is SCXML's `cond`
   * semantics; a guard that throws or rejects aborts the whole microstep instead.
   *
   * The exit hooks of the whole exit set then run deepest first, followed by the selected
   * transitions' actions in document order of their declaring states, followed by the entry hooks
   * shallowest first. All of them operate on staged values, and the configuration, context, history
   * memory and revision are replaced only after every one of them succeeds, so a failure leaves the
   * machine exactly as it was.
   */
  const runTransition = async (
    event: TMachineEvent,
  ): Promise<MachineSnapshot<TContext, TMachinePath, TMachineEvent>> => {
    const eventName = normaliseEvent(event);
    const previousConfiguration = [...activeLeaves];
    const candidates = resolveCandidates(eventName);

    const stagedContext = cloneContext(currentContext);
    const enabled: Array<Candidate<TContext>> = [];
    for (const candidate of candidates) {
      if (!candidate.transition.guard) {
        enabled.push(candidate);
        continue;
      }
      const accepted = await candidate.transition.guard({
        context: stagedContext,
        state: candidate.source.path,
        event,
      });
      if (accepted) {
        enabled.push(candidate);
      }
    }
    if (enabled.length === 0) {
      throw new GuardRejectedError(
        `Guard rejected event "${eventName}" in ${describeConfiguration(activeLeaves)} of machine "${machineId}".`,
      );
    }

    const selected = selectCandidates(enabled, historyMemory);
    const exit = new Set<CompiledState<TContext>>();
    for (const candidate of selected) {
      for (const state of candidate.exit) {
        exit.add(state);
      }
    }
    const entry = new Set<CompiledState<TContext>>(
      [
        ...completeTargetSet(
          selected.flatMap((candidate) => candidate.targets),
          new Set([...activeStates].filter((state) => !exit.has(state))),
        ),
      ].filter((state) => !activeStates.has(state) || exit.has(state)),
    );

    // History is captured into a copy, so a microstep that fails below leaves the memory untouched.
    const stagedMemory = new Map(historyMemory);
    recordHistory(exit, stagedMemory);

    for (const state of [...exit].sort((left, right) => right.order - left.order)) {
      await execute(state.exit, { context: stagedContext, state: state.path, event });
    }
    for (const candidate of [...selected].sort((left, right) => left.source.order - right.source.order)) {
      if (candidate.transition.actions) {
        await execute(candidate.transition.actions, {
          context: stagedContext,
          state: candidate.source.path,
          event,
        });
      }
    }
    for (const state of [...entry].sort((left, right) => left.order - right.order)) {
      await execute(state.entry, { context: stagedContext, state: state.path, event });
    }

    // The commit point. Cloning can still fail here, in which case nothing is committed and no
    // subscriber is notified, so the machine stays on its previous configuration.
    const committedContext = cloneContext(stagedContext, () => {
      throw new MachineConfigurationError(
        `Machine "${machineId}" context was made unclonable while transitioning, so the transition was aborted.`,
      );
    });

    const nextLeaves = nextConfiguration(exit, entry);
    applyConfiguration(nextLeaves);
    historyMemory = stagedMemory;
    currentContext = committedContext;
    revision += 1;

    const committed = buildSnapshot(
      nextLeaves,
      cloneContext(committedContext),
      event,
      previousConfiguration,
    );
    notify(committedContext, committed);
    return committed;
  };

  return {
    get id(): string {
      return machineId;
    },
    get state(): TMachinePath {
      return configurationRoot(activeLeaves).path as TMachinePath;
    },
    get configuration(): ReadonlyArray<TMachinePath> {
      return activeLeaves.map((leaf) => leaf.path as TMachinePath);
    },
    get context(): TContext {
      return cloneContext(currentContext);
    },
    send(event: TMachineEvent): Promise<MachineSnapshot<TContext, TMachinePath, TMachineEvent>> {
      try {
        const preparedEvent = prepareEvent(event);
        return enqueue(() => runTransition(preparedEvent));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    /**
     * Reports whether any region would accept the event, queued behind pending events.
     *
     * The answer is the question `send()` asks: a region is enabled when its nearest declaring
     * transition has no guard, or its guard accepts. Every candidate's guard is evaluated in
     * document order against one staging clone, and nothing is committed: no exit or entry hook, no
     * action, no notification, no revision change and no history change. A guard that throws rejects
     * with that error, exactly as `send()` does. See {@link Machine.can} for the full contract.
     */
    can(event: TMachineEvent): Promise<boolean> {
      let preparedEvent: TMachineEvent;
      try {
        preparedEvent = prepareEvent(event);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(async () => {
        const eventName = normaliseEvent(preparedEvent);
        const candidates = candidatesFor(eventName);
        if (candidates.length === 0) {
          return false;
        }
        const stagedContext = cloneContext(currentContext);
        let enabled = false;
        for (const candidate of candidates) {
          if (!candidate.transition.guard) {
            enabled = true;
            continue;
          }
          const accepted = await candidate.transition.guard({
            context: stagedContext,
            state: candidate.source.path,
            event: preparedEvent,
          });
          enabled = Boolean(accepted) || enabled;
        }
        return enabled;
      });
    },
    /**
     * Declared events of the whole active configuration, in document order of the declaring states
     * and declaration order within a state, with duplicates removed. For a machine with no parallel
     * state that is the same "shallowest state first" order as before.
     *
     * The answer is structural: it reports which events the configuration can reach and never
     * evaluates guards, so an event listed here can still be disabled by every region's guard, and
     * `can()` is what answers that question.
     */
    getNextEvents(): EventNameOf<TMachineEvent>[] {
      const events: EventNameOf<TMachineEvent>[] = [];
      const seen = new Set<string>();
      for (const state of [...activeStates].sort((left, right) => left.order - right.order)) {
        for (const eventName of state.transitions.keys()) {
          if (!seen.has(eventName)) {
            seen.add(eventName);
            events.push(eventName as EventNameOf<TMachineEvent>);
          }
        }
      }
      return events;
    },
    /**
     * True when the path is part of the active configuration: an active leaf, or a state above one.
     * A parallel state and each of its regions match while they are active, and a leaf in one
     * region does not make a sibling region's leaf match. A history pseudo-state is never active,
     * so its path never matches.
     */
    matches(path: TMachinePath): boolean {
      return activePaths.has(path);
    },
    subscribe(listener: Subscription<TContext, TMachinePath, TMachineEvent>): Unsubscribe {
      if (typeof listener !== "function") {
        throw new TypeError(`Machine "${machineId}" subscribe() expects a function listener.`);
      }
      const record: ListenerRecord<TContext, TMachinePath, TMachineEvent> = { listener };
      listeners.add(record);
      return () => {
        listeners.delete(record);
      };
    },
    snapshot,
    toJSON(): MachineSnapshot<TContext, TMachinePath, TMachineEvent> {
      return snapshot();
    },
    /**
     * Restores a validated snapshot. Restoration is queued behind pending events, runs no
     * lifecycle hooks and notifies no subscribers because it is not a transition.
     *
     * The stored snapshot is read in whichever format version it declares. A snapshot that carries
     * no `configuration` is a 0.1.0 snapshot and is migrated by `migrateSnapshotV1ToV2`: its single
     * `state` becomes the configuration and its history memory starts empty. A snapshot that
     * carries a `configuration` is validated as the current format, including that every path is a
     * declared atomic state and that the set is a legal configuration. A `schemaVersion` the build
     * does not read rejects with `UnsupportedSnapshotVersionError` carrying a stable code.
     */
    restore(input: unknown): Promise<MachineSnapshot<TContext, TMachinePath, TMachineEvent>> {
      return enqueue(() => {
        const candidate = assertPlainObject(
          input,
          "Snapshot must be a plain object.",
          "snapshot",
        );
        const { id, context } = candidate;

        if (typeof id !== "string" || id !== machineId) {
          throw new SnapshotValidationError(
            `Snapshot id ${describe(id)} does not match machine id "${machineId}".`,
          );
        }

        const storedVersion = candidate.schemaVersion;
        // Version 1 is the 0.1.0 shape, which this build migrates. Version 2 is the current shape.
        // Any other version, including one from a newer release, is refused rather than guessed at.
        const knownVersion =
          storedVersion === undefined ||
          storedVersion === SNAPSHOT_FORMAT_VERSION - 1 ||
          storedVersion === schemaVersion;
        if (!knownVersion) {
          throw new UnsupportedSnapshotVersionError(
            `Snapshot schemaVersion ${describe(storedVersion)} is not supported by machine "${machineId}", which reads versions ${SUPPORTED_SNAPSHOT_VERSIONS.join(" and ")} and writes ${schemaVersion}.`,
            typeof storedVersion === "number" ? storedVersion : undefined,
            SUPPORTED_SNAPSHOT_VERSIONS,
          );
        }

        // A snapshot without a configuration was written before parallel states existed, so its
        // single `state` path is the whole configuration and its history memory is empty.
        const migrated =
          candidate.configuration === undefined
            ? migrateSnapshotV1ToV2(candidate)
            : (candidate as Record<string, unknown>);

        const restoredLeaves = validateConfiguration(migrated.configuration);
        const derivedState = configurationRoot(restoredLeaves).path;
        if (migrated.state !== undefined && migrated.state !== derivedState) {
          throw new SnapshotValidationError(
            `Snapshot state ${describe(migrated.state)} of machine "${machineId}" does not match its configuration, which is in ${describe(derivedState)}.`,
          );
        }
        const restoredHistory = validateHistory(migrated.history);

        assertPlainObject(
          context,
          `Snapshot context for machine "${machineId}" must be a plain object.`,
          "snapshot",
        );

        const validatedContext = parseContext
          ? parseRestoredContext(parseContext, context, machineId)
          : (context as TContext);

        const nextContext = cloneContext(validatedContext, () => {
          throw new SnapshotValidationError(
            `Snapshot context for machine "${machineId}" must be structured-cloneable.`,
          );
        });

        applyConfiguration(restoredLeaves);
        historyMemory = restoredHistory;
        currentContext = nextContext as TContext;
        return snapshot();
      });
    },
    whenIdle(): Promise<void> {
      if (pending === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
    },
  };
}

/** Error kind selector used by {@link assertPlainObject}. */
type ErrorKind = "configuration" | "snapshot";

/**
 * Runs a machine's `parseContext` validator against a stored context, converting any failure into
 * a {@link SnapshotValidationError} whose `cause` preserves the original error.
 */
const parseRestoredContext = <TContext>(
  parseContext: (input: unknown) => TContext,
  context: unknown,
  machineId: string,
): TContext => {
  try {
    return parseContext(context);
  } catch (cause) {
    throw new SnapshotValidationError(
      `Snapshot context for machine "${machineId}" was rejected by parseContext.`,
      { cause },
    );
  }
};

/** Ownership check that ignores inherited prototype members. */
const hasOwn = (target: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Renders an arbitrary value for an error message without ever throwing. */
const describe = (value: unknown): string => {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

/**
 * Describes the active configuration in an error message: the state a sequential machine is in,
 * or the list of active leaves when several are active at once.
 *
 * A single leaf keeps the 0.1.0 wording, so an error raised by a machine with no parallel state
 * reads exactly as it always did.
 */
const describeConfiguration = <TContext>(leaves: Array<CompiledState<TContext>>): string => {
  const [only, ...rest] = leaves;
  if (only !== undefined && rest.length === 0) {
    return `state ${describe(only.path)}`;
  }
  return `configuration [${leaves.map((leaf) => describe(leaf.path)).join(", ")}]`;
};

/**
 * Migrates a 0.1.0 snapshot to the current format.
 *
 * A 0.1.0 snapshot stored one `state` path and had no configuration and no history memory. The
 * migration makes that single path the whole configuration and starts the memory empty, and copies
 * every other field unchanged, so the context, the event, the previous state and the revision all
 * survive. `restore()` validates the result, so this function only reshapes what it is given.
 *
 * Exported so the migration can be tested directly, and so a persistence adapter can upgrade
 * stored data before handing it to `restore()`.
 *
 * @param snapshot - A snapshot object in the 0.1.0 shape.
 * @returns The same snapshot with `configuration` and `history` added.
 */
export const migrateSnapshotV1ToV2 = (
  snapshot: Record<string, unknown>,
): Record<string, unknown> => ({
  ...snapshot,
  schemaVersion: SNAPSHOT_FORMAT_VERSION,
  configuration: typeof snapshot.state === "string" ? [snapshot.state] : [],
  history: {},
});

/**
 * Clones a context value so machine internals and callers never share mutable references.
 * `structuredClone` is used when available, with a JSON fallback for older runtimes.
 */
const cloneContext = <T>(value: T, onFailure?: () => never): T => {
  try {
    if (typeof globalThis.structuredClone === "function") {
      return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (cause) {
    if (onFailure) {
      onFailure();
    }
    throw cause;
  }
};

/** Clones an event payload so guards, hooks, snapshots and listeners share no caller-owned data. */
const cloneEvent = <TEvent>(event: TEvent, machineId: string): TEvent => {
  if (typeof event === "string") {
    return event;
  }
  return cloneContext(event, () => {
    throw new MachineConfigurationError(
      `Machine "${machineId}" received an event that is not structured-cloneable.`,
    );
  });
};

const assertPlainObject = (
  value: unknown,
  message: string,
  kind: ErrorKind = "configuration",
): Record<string, unknown> => {
  if (!isPlainObject(value)) {
    throw kind === "snapshot" ? new SnapshotValidationError(message) : new MachineConfigurationError(message);
  }
  return value;
};

const assertActionList = <TAction>(value: unknown, message: string): Array<TAction> => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "function")) {
    throw new MachineConfigurationError(message);
  }
  return value as Array<TAction>;
};

/**
 * Looks a child up by key where an earlier check has already proved it exists, which keeps the
 * lookup expression rather than a second unreachable guard.
 */
const requireChild = <TContext>(
  parent: CompiledState<TContext>,
  key: string,
): CompiledState<TContext> => parent.children.get(key) as CompiledState<TContext>;

/**
 * Compiles a raw `states` declaration into a state tree, resolving every transition target and
 * rejecting malformed definitions eagerly.
 */
const compileTree = <TContext>(
  machineId: string,
  rawStates: Record<string, unknown>,
  initialKey: string,
): {
  root: CompiledState<TContext>;
  initialConfiguration: Array<CompiledState<TContext>>;
  pathIndex: Map<string, CompiledState<TContext>>;
  historyIndex: Map<string, CompiledHistory<TContext>>;
  recognizedEvents: Set<string>;
} => {
  const root = {
    kind: "compound" as const,
    path: "",
    key: "",
    parent: undefined as unknown as CompiledState<TContext>,
    order: -1,
    children: new Map<string, CompiledState<TContext>>(),
    history: new Map<string, CompiledHistory<TContext>>(),
    entry: [],
    exit: [],
    transitions: new Map<string, CompiledTransition<TContext>>(),
  };
  root.parent = root;

  const pathIndex = new Map<string, CompiledState<TContext>>();
  const historyIndex = new Map<string, CompiledHistory<TContext>>();
  const recognizedEvents = new Set<string>();
  let orderCursor = 0;
  const declaredTransitions: Array<{
    state: CompiledState<TContext>;
    event: string;
    declared: unknown;
  }> = [];
  const declaredHistory: Array<{ history: CompiledHistory<TContext>; declared: unknown }> = [];

  /** Walks the raw declaration once, building every state and collecting transitions to resolve. */
  const build = (states: Record<string, unknown>, parent: CompiledState<TContext>): void => {
    for (const key of Object.keys(states)) {
      if (key.includes(".")) {
        throw new MachineConfigurationError(
          `State name ${describe(key)} in machine "${machineId}" cannot contain a dot, because a dot separates a state path into nested states.`,
        );
      }

      const path = parent.path === "" ? key : `${parent.path}.${key}`;
      const definition = assertPlainObject(
        states[key],
        `State "${path}" of machine "${machineId}" must be a plain object.`,
      );
      const declaredType = assertStateType(machineId, path, definition.type);

      if (declaredType === "history") {
        if (parent === root) {
          throw new MachineConfigurationError(
            `History pseudo-state "${path}" of machine "${machineId}" is declared at the top level, but it must be declared inside the state whose configuration it remembers.`,
          );
        }
        for (const forbidden of ["states", "initial", "on", "entry", "exit"]) {
          if (definition[forbidden] !== undefined) {
            throw new MachineConfigurationError(
              `History pseudo-state "${path}" of machine "${machineId}" cannot declare "${forbidden}", because it is never active.`,
            );
          }
        }
        const memory = definition.history ?? "shallow";
        if (memory !== "shallow" && memory !== "deep") {
          throw new MachineConfigurationError(
            `History pseudo-state "${path}" of machine "${machineId}" has an invalid "history": expected "shallow" or "deep", received ${describe(memory)}.`,
          );
        }
        const history: CompiledHistory<TContext> = {
          kind: "history",
          path,
          key,
          parent,
          order: orderCursor,
          memory,
        };
        orderCursor += 1;
        parent.history.set(key, history);
        historyIndex.set(path, history);
        declaredHistory.push({ history, declared: definition.target });
        continue;
      }

      const hasChildren = definition.states !== undefined;
      const kind: CompiledStateKind = declaredType ?? (hasChildren ? "compound" : "atomic");

      if (kind === "atomic" && hasChildren) {
        throw new MachineConfigurationError(
          `State "${path}" of machine "${machineId}" is declared "atomic" but declares "states"; declare "compound" or "parallel" instead.`,
        );
      }
      if (kind === "atomic" && definition.initial !== undefined) {
        throw new MachineConfigurationError(
          `State "${path}" of machine "${machineId}" declares "initial" without nested "states".`,
        );
      }
      if (kind !== "atomic" && !hasChildren) {
        throw new MachineConfigurationError(
          `State "${path}" of machine "${machineId}" is declared ${describe(kind)} but declares no "states"; declare at least one child state or remove "type".`,
        );
      }
      if (kind === "parallel" && definition.initial !== undefined) {
        throw new MachineConfigurationError(
          `Parallel state "${path}" of machine "${machineId}" cannot declare "initial", because entering it enters every region at once.`,
        );
      }

      const node: CompiledState<TContext> = {
        kind,
        path,
        key,
        parent,
        order: orderCursor,
        children: new Map<string, CompiledState<TContext>>(),
        history: new Map<string, CompiledHistory<TContext>>(),
        entry: assertActionList<ActionFn<TContext, string, unknown>>(
          definition.entry,
          `State "${path}" of machine "${machineId}" has an invalid "entry" hook: expected an array of functions.`,
        ),
        exit: assertActionList<ActionFn<TContext, string, unknown>>(
          definition.exit,
          `State "${path}" of machine "${machineId}" has an invalid "exit" hook: expected an array of functions.`,
        ),
        transitions: new Map<string, CompiledTransition<TContext>>(),
      };
      orderCursor += 1;

      parent.children.set(key, node);
      pathIndex.set(path, node);

      if (definition.on !== undefined) {
        const on = assertPlainObject(
          definition.on,
          `State "${path}" of machine "${machineId}" has an invalid "on" map: expected an object.`,
        );
        for (const eventName of Object.keys(on)) {
          declaredTransitions.push({ state: node, event: eventName, declared: on[eventName] });
        }
      }

      if (hasChildren) {
        const children = assertPlainObject(
          definition.states,
          `State "${path}" of machine "${machineId}" has an invalid "states" map: expected an object.`,
        );
        if (Object.keys(children).length === 0) {
          throw new MachineConfigurationError(
            `State "${path}" of machine "${machineId}" declares an empty "states" map; declare at least one child state or omit it.`,
          );
        }
        if (kind === "compound") {
          if (typeof definition.initial !== "string" || !hasOwn(children, definition.initial)) {
            throw new MachineConfigurationError(
              `Compound state "${path}" of machine "${machineId}" must declare an "initial" child state, but ${describe(definition.initial)} is not one of its states.`,
            );
          }
          const initialDeclaration = children[definition.initial];
          if (isPlainObject(initialDeclaration) && initialDeclaration.type === "history") {
            throw new MachineConfigurationError(
              `Compound state "${path}" of machine "${machineId}" declares history pseudo-state ${describe(definition.initial)} as its "initial" child, but a history pseudo-state is never active; name the state it should restore instead.`,
            );
          }
        }

        build(children, node);
        if (kind === "compound") {
          node.initialChild = requireChild(node, definition.initial as string);
        }
      }
    }
  };

  build(rawStates, root);

  // Targets are resolved after the whole tree exists, because a transition may name a sibling or
  // an ancestor that the walk above has not reached yet.
  for (const { state, event, declared } of declaredTransitions) {
    state.transitions.set(event, normalizeTransition<TContext>(machineId, root, state, declared, event));
    recognizedEvents.add(event);
  }

  // A history default target is read like a target written on the parent, because the pseudo-state
  // itself has no children for a bare or relative name to be resolved against.
  for (const { history, declared } of declaredHistory) {
    if (declared === undefined) {
      continue;
    }
    const resolved = resolveTarget(
      machineId,
      root,
      history.parent,
      declared,
      `History default target of pseudo-state "${history.path}" of machine "${machineId}"`,
    );    if (resolved.kind === "history") {
      throw new MachineConfigurationError(
        `History default target of pseudo-state "${history.path}" of machine "${machineId}" names another history pseudo-state, which would never become active.`,
      );
    }
    if (history.memory === "shallow" && resolved.parent !== history.parent) {
      throw new MachineConfigurationError(
        `Shallow history pseudo-state "${history.path}" of machine "${machineId}" declares a default target that is not a direct child of ${describe(history.parent.path)}; a shallow history remembers only direct children. Declare the pseudo-state as "deep" to name a descendant.`,
      );
    }
    history.defaultTarget = resolved;
  }

  // The caller validated the initial key against the same raw object, so the state exists. A
  // top-level history pseudo-state is already rejected while the tree is built, because a
  // pseudo-state has to sit inside the state whose configuration it remembers.
  const initialNode = requireChild(root, initialKey);

  return {
    root,
    initialConfiguration: defaultEntryLeaves(initialNode),
    pathIndex,
    historyIndex,
    recognizedEvents,
  };
};

/**
 * Leaves entered by a state's default entry: a compound state enters its initial child, a parallel
 * state enters every region, and both descend recursively until an atomic state is reached.
 */
const defaultEntryLeaves = <TContext>(
  state: CompiledState<TContext>,
): Array<CompiledState<TContext>> => {
  if (state.kind === "parallel") {
    return [...state.children.values()].flatMap((child) => defaultEntryLeaves(child));
  }
  if (state.kind === "compound" && state.initialChild) {
    return defaultEntryLeaves(state.initialChild);
  }
  return [state];
};

/**
 * Validates a state's `type` field, returning the declared kind or `undefined` when it is absent.
 *
 * The compiler rejects an unknown kind rather than ignoring it, so a definition written against a
 * newer release fails loudly instead of being read as a compound or atomic state.
 */
const assertStateType = (
  machineId: string,
  path: string,
  declared: unknown,
): "atomic" | "compound" | "parallel" | "history" | undefined => {
  if (declared === undefined) {
    return undefined;
  }
  if (
    declared === "atomic" ||
    declared === "compound" ||
    declared === "parallel" ||
    declared === "history"
  ) {
    return declared;
  }
  throw new MachineConfigurationError(
    `State "${path}" of machine "${machineId}" has an invalid "type": expected "atomic", "compound", "parallel" or "history", received ${describe(declared)}.`,
  );
};

/**
 * Validates one raw transition declaration and resolves its target.
 *
 * Omitting `target` produces a targetless transition: its guard and its actions run, nothing is
 * exited and nothing is entered, and the active configuration is unchanged (`SEMANTICS.md` TL1).
 *
 * A `type` field is rejected rather than ignored, because only external transitions are
 * implemented and silently reading `internal` as `external` would change what a definition means.
 */
const normalizeTransition = <TContext>(
  machineId: string,
  root: CompiledState<TContext>,
  source: CompiledState<TContext>,
  declared: unknown,
  eventName: string,
): CompiledTransition<TContext> => {
  const prefix = `Transition for event "${eventName}" in state "${source.path}" of machine "${machineId}"`;

  if (typeof declared === "string") {
    return { target: resolveTarget(machineId, root, source, declared, prefix) };
  }

  const transition = assertPlainObject(
    declared,
    `${prefix} must be a state name or a transition object.`,
  );

  if (transition.type !== undefined) {
    throw new UnsupportedTransitionTypeError(
      `${prefix} declares "type": ${describe(transition.type)}, but internal transitions are not supported in this version. Remove the field; a transition with no "target" runs its guard and actions without exiting or entering anything.`,
      typeof transition.type === "string" ? transition.type : undefined,
    );
  }

  const normalized: CompiledTransition<TContext> = {
    target:
      transition.target === undefined
        ? null
        : resolveTarget(machineId, root, source, transition.target, prefix),
  };

  if (transition.guard !== undefined) {
    if (typeof transition.guard !== "function") {
      throw new MachineConfigurationError(`${prefix} has an invalid "guard": expected a function.`);
    }
    normalized.guard = transition.guard as GuardFn<TContext, string, unknown>;
  }

  const actions = assertActionList<ActionFn<TContext, string, unknown>>(
    transition.actions,
    `${prefix} has an invalid "actions" list: expected an array of functions.`,
  );
  if (actions.length > 0) {
    normalized.actions = actions;
  }

  return normalized;
};

/**
 * Resolves a raw transition target to a compiled node, which is either a real state or a history
 * pseudo-state.
 *
 * - A leading dot is relative to the declaring state: in `draft`, `.editing` is `draft.editing`.
 * - A dotted path is absolute: `draft.editing` starts at the top level and can be written from
 *   anywhere in the tree.
 * - A bare name is looked up in the declaring state's own children first, then in each enclosing
 *   state's children as the walk moves up. That is what lets a parent's `on` map act as a
 *   fallback, and it is why a bare name can still name a sibling or a top-level state.
 */
const resolveTarget = <TContext>(
  machineId: string,
  root: CompiledState<TContext>,
  source: CompiledState<TContext>,
  target: unknown,
  prefix: string,
): CompiledNode<TContext> => {
  if (typeof target !== "string") {
    throw new MachineConfigurationError(
      `${prefix} targets ${describe(target)}, which is not a state name.`,
    );
  }

  const resolved = target.startsWith(".")
    ? descend(source, target.slice(1))
    : target.includes(".")
      ? descend(root, target)
      : lookupBare(root, source, target);

  if (resolved === undefined) {
    throw new MachineConfigurationError(
      `${prefix} targets undeclared state ${describe(target)}.`,
    );
  }
  return resolved;
};

/**
 * Looks a key up in a state's children and then in its history pseudo-states, so a transition can
 * target a history pseudo-state the same way it targets a state.
 */
const childOrHistory = <TContext>(
  state: CompiledState<TContext>,
  key: string,
): CompiledNode<TContext> | undefined => state.children.get(key) ?? state.history.get(key);

/**
 * Looks a bare target name up in the declaring state's own children, then in each enclosing
 * state's children, moving one level up at a time until the top level has been searched.
 */
const lookupBare = <TContext>(
  root: CompiledState<TContext>,
  source: CompiledState<TContext>,
  name: string,
): CompiledNode<TContext> | undefined => {
  let node: CompiledState<TContext> | undefined = source;
  while (node) {
    const found = childOrHistory(node, name);
    if (found) {
      return found;
    }
    node = node === root ? undefined : node.parent;
  }
  return undefined;
};

/**
 * Walks a dotted path from a starting state, or returns `undefined` at the first missing key. A
 * history pseudo-state has no children, so a path that walks through one resolves to nothing.
 */
const descend = <TContext>(
  from: CompiledState<TContext>,
  path: string,
): CompiledNode<TContext> | undefined => {
  let node: CompiledNode<TContext> | undefined = from;
  for (const segment of path.split(".")) {
    if (node === undefined || node.kind === "history") {
      return undefined;
    }
    node = childOrHistory(node, segment);
  }
  return node;
};
