/**
 * Public types of Motivo Stateflow.
 *
 * The types in this module drive inference for `createMachine()`. State paths, event names, event
 * payloads and context shape are inferred from the definition, so the compiler rejects unknown
 * events, invalid payloads and invalid transition targets wherever that is statically knowable.
 *
 * @packageDocumentation
 */

/**
 * Compile-time declaration of event payload shapes.
 *
 * Map each event name to its payload object, or to `undefined` for a payload-free event. The
 * machine uses the keys from its transition maps to determine which declared events it accepts.
 */
export type EventPayloadMap = Record<string, object | undefined>;

/**
 * Literal event names explicitly provided by an event payload map.
 */
export type EventPayloadNames<TPayloads extends EventPayloadMap> = string extends keyof TPayloads
  ? never
  : keyof TPayloads & string;

/**
 * Event value accepted for one declared event name.
 *
 * Payload-free events keep their string shorthand. Events with payloads use a discriminated
 * object so their name and payload travel together.
 */
export type EventFromName<
  TName extends string,
  TPayloads extends EventPayloadMap = Record<never, never>,
> = TName extends keyof TPayloads
  ? TPayloads[TName] extends object
    ? { type: TName } & TPayloads[TName]
    : TName
  : TName;

/**
 * Event names represented by an event union.
 */
export type EventNameOf<TEvent> = TEvent extends string
  ? TEvent
  : TEvent extends { type: infer TName extends string }
    ? TName
    : never;

/**
 * Context and metadata passed to guards, transition actions and lifecycle hooks.
 *
 * The `context` object is a per-transition staging clone. Mutating it updates the pending
 * context: the change is committed atomically with the transition, or discarded entirely when
 * the guard rejects or any hook throws.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type GuardContext<TContext, TState extends string, TEvent> = {
  /** Staged context for the pending transition. */
  context: TContext;
  /** State the machine is transitioning from, or the target state for entry hooks. */
  state: TState;
  /** The event being processed. */
  event: TEvent;
};

/**
 * A transition guard. Returning `false` rejects the transition; a thrown error or a rejected
 * promise aborts the transition and rejects the caller's promise.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type GuardFn<TContext, TState extends string, TEvent> = (
  args: GuardContext<TContext, TState, TEvent>,
) => boolean | Promise<boolean>;

/**
 * A transition action or lifecycle hook. May be synchronous or asynchronous; the engine awaits
 * the result before continuing, so ordering is deterministic.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type ActionFn<TContext, TState extends string, TEvent> = (
  args: GuardContext<TContext, TState, TEvent>,
) => unknown | Promise<unknown>;

/**
 * State paths that have no parent. These are the keys a `states` map writes, at the top level or
 * inside a compound state.
 */
type TopLevelPaths<TPath extends string> = TPath extends `${string}.${string}` ? never : TPath;

/**
 * Full paths of the direct children of the state at `TPrefix`, or `never` when it has none.
 *
 * A path is a dot-joined chain of state keys from the top level, so `"draft.editing"` is the
 * child `editing` of the top-level state `draft`.
 */
type ChildPaths<TPath extends string, TPrefix extends string> = TPath extends `${TPrefix}.${infer TRest}`
  ? TRest extends `${string}.${string}`
    ? never
    : `${TPrefix}.${TRest}`
  : never;

/**
 * Keys of the direct children of the state at `TPrefix`, which is what a nested `states` map and a
 * compound state's `initial` are written against.
 */
type ChildKeys<TPath extends string, TPrefix extends string> =
  ChildPaths<TPath, TPrefix> extends `${TPrefix}.${infer TKey}` ? TKey : never;

/**
 * Placeholder type used where a nested `states` map is written without the machine's path union.
 * Its property name is the error message, because TypeScript reports the offending key when a
 * definition is checked against it.
 */
type PathUnionRequired = {
  "states: nesting needs the full state path union, supplied as the fourth type argument of MachineDefinition or through NestedMachineDefinition": never;
};

/**
 * Bare target names: the last segment of every declared path, which is every state key in the
 * tree. The runtime searches for a bare name in the declaring state's children, then in each
 * enclosing state's children, so a key that exists in another branch compiles here and is
 * rejected when the machine is created. Deriving the set from `TPath` alone, rather than from the
 * declaring state, keeps it computable while the definition is still being checked.
 */
type BareTargets<TPath extends string> = TPath extends `${string}.${infer TRest}`
  ? BareTargets<TRest>
  : TPath;

/**
 * Relative targets are written with a leading dot and start at the declaring state's own
 * children. Only the first segment is statically checkable, so further segments are accepted here
 * and validated when the machine is created. A flat machine accepts none: it has no nesting for a
 * relative path to walk into.
 */
type RelativeTargets<TPath extends string> = TPath extends `${string}.${string}`
  ? `.${string}`
  : never;

/**
 * Every form a transition target may take: a full path, a bare state key, or a relative path
 * written with a leading dot.
 */
type TargetName<TPath extends string> = TPath | BareTargets<TPath> | RelativeTargets<TPath>;

/**
 * Object form of a transition. Omitting `target` declares a targetless transition: the guard and
 * the actions run, nothing is exited or entered, and the active configuration does not change.
 *
 * A transition is written inside the state that declares it, so its guard and actions receive
 * that state as `state` and the full typed event value declared for that transition as `event`.
 * Both are narrowed from the machine-wide unions, so a guard cannot compare `state` against a
 * state it is not declared in, and cannot read an event the state does not declare.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TPath - Union of every state path, top-level and nested.
 * @typeParam TEvent - Union of declared event names.
 * @typeParam TSource - State path that declares this transition, narrowed to that single path.
 * @typeParam TOwnEvent - Event this transition is declared under, narrowed to that single event.
 */
export type TransitionDefinition<
  TContext,
  TPath extends string,
  TEvent extends string,
  TSource extends string = TPath,
  TOwnEvent extends TEvent = TEvent,
  TPayloads extends EventPayloadMap = Record<never, never>,
> = {
  /**
   * Declared state path to enter, in one of three forms:
   *
   * - a full path, such as `"draft.reviewing"`, which is absolute and can be written anywhere;
   * - a bare name, such as `"reviewing"`, resolved in the declaring state's children first and
   *   then in each enclosing state's children;
   * - a relative path with a leading dot, such as `".reviewing"`, which starts at the declaring
   *   state's own children.
   *
   * Omit to declare a targetless transition: its guard and actions run, and the configuration is
   * unchanged. The `NoInfer` wrapper keeps the full path
   * union out of type inference: `TPath` must come from the state map keys, otherwise a target
   * that happens to be mentioned here would narrow the union and every other declared state would
   * be rejected.
   */
  target?: NoInfer<TargetName<TPath>>;
  /** Condition that must return `true` for the transition to be committed. */
  guard?: GuardFn<TContext, TSource, EventFromName<TOwnEvent, TPayloads>>;
  /** Actions executed after exit hooks and before entry hooks. */
  actions?: ReadonlyArray<ActionFn<TContext, TSource, EventFromName<TOwnEvent, TPayloads>>>;
  /**
   * Reserved for internal transitions, which are not supported in this version.
   *
   * Typed as `never` so `type: "internal"` is a compile error rather than a silently ignored
   * field, and rejected at runtime with `UnsupportedTransitionTypeError`. Reserving the field
   * keeps adding internal transitions later a non-breaking change.
   */
  type?: never;
};

/**
 * Shape of an atomic state: a leaf in the path tree with no child to enter and no nested states.
 */
type AtomicStateShape = {
  /** Atomic states declare no child to enter. */
  initial?: never;
  /** Atomic states declare no nested states. */
  states?: PathUnionRequired;
  /** An atomic state is not parallel and not a history pseudo-state. */
  type?: "atomic" | "compound";
  /** Only a history pseudo-state declares `history`. */
  history?: never;
  /** Only a history pseudo-state declares a default target. */
  target?: never;
};

/**
 * Shape of a history pseudo-state: a leaf in the path tree that remembers the configuration of
 * its parent. It is never active itself, so it declares no hooks and no transitions.
 */
type HistoryStateShape<TPath extends string> = {
  /** Marks this state as a history pseudo-state. */
  type: "history";
  /** Depth of the memory. Defaults to `"shallow"`. */
  history?: "shallow" | "deep";
  /** State entered on first entry, before any memory has been recorded. */
  target?: NoInfer<TargetName<TPath>>;
  /** A history pseudo-state declares no child to enter. */
  initial?: never;
  /** A history pseudo-state declares no nested states. */
  states?: PathUnionRequired;
  /** A history pseudo-state declares no entry hooks. */
  entry?: never;
  /** A history pseudo-state declares no exit hooks. */
  exit?: never;
  /** A history pseudo-state declares no transitions. */
  on?: never;
};

/**
 * Shape of a compound state: nested states plus the single child entered by default.
 */
type CompoundStateShape<
  TContext,
  TPath extends string,
  TEvent extends string,
  TKey extends string,
  TPayloads extends EventPayloadMap,
> = {
  /** A compound state is not parallel and not a history pseudo-state. */
  type?: "atomic" | "compound";
  /** Key of the child state entered when this compound state is entered. */
  initial: ChildKeys<TPath, TKey>;
  /** Nested states, keyed by their own name. */
  states: {
    [TChildKey in ChildKeys<TPath, TKey>]: StateDefinition<
      TContext,
      TPath,
      TEvent,
      `${TKey}.${TChildKey}`,
      TPayloads
    >;
  };
  /** Only a history pseudo-state declares `history`. */
  history?: never;
  /** Only a history pseudo-state declares a default target. */
  target?: never;
};

/**
 * Shape of a parallel state: every child is a region, and all of them are active together, so
 * there is no single `initial` child.
 */
type ParallelStateShape<
  TContext,
  TPath extends string,
  TEvent extends string,
  TKey extends string,
  TPayloads extends EventPayloadMap,
> = {
  /** Marks this state as a parallel state. */
  type: "parallel";
  /** Regions, keyed by their own name. Every one of them is entered with the parallel state. */
  states: {
    [TChildKey in ChildKeys<TPath, TKey>]: StateDefinition<
      TContext,
      TPath,
      TEvent,
      `${TKey}.${TChildKey}`,
      TPayloads
    >;
  };
  /** A parallel state has no single initial child. */
  initial?: never;
  /** Only a history pseudo-state declares `history`. */
  history?: never;
  /** Only a history pseudo-state declares a default target. */
  target?: never;
};

/**
 * Declaration of a single state.
 *
 * Four kinds exist, and the kind decides which fields are legal:
 *
 * - **atomic**: no `states`, no `initial`, nothing else to enter;
 * - **compound**: declares `states` and the `initial` child that is entered by default;
 * - **parallel**: declares `states` and `type: "parallel"`, and enters every child at once, so it
 *   must not declare `initial`;
 * - **history**: declares `type: "history"`, remembers its parent's configuration, and declares
 *   neither `states` nor hooks nor transitions, because it is never active.
 *
 * Lifecycle hooks run only while the machine is inside the state that declares them, so their
 * `state` is narrowed to that single path. Their `event` stays the machine-wide union, because
 * the event that enters or leaves a state varies with the transition being taken.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TPath - Union of every state path, top-level and nested.
 * @typeParam TEvent - Union of declared event names.
 * @typeParam TKey - Path of the state this definition belongs to, narrowed to that single path.
 */
export type StateDefinition<
  TContext,
  TPath extends string,
  TEvent extends string,
  TKey extends string = TPath,
  TPayloads extends EventPayloadMap = Record<never, never>,
> = {
  /** Hooks executed when the state is entered, after transition actions. */
  entry?: ReadonlyArray<ActionFn<TContext, TKey, NoInfer<EventFromName<TEvent, TPayloads>>>>;
  /** Hooks executed when the state is left, before transition actions. */
  exit?: ReadonlyArray<ActionFn<TContext, TKey, NoInfer<EventFromName<TEvent, TPayloads>>>>;
  /**
   * Event map for the state. A string value is shorthand for `{ target: value }`. A key that is
   * not declared here is not part of the machine's event union, so it cannot be sent.
   *
   * The map's keys are the inference source for `TEvent`, and each entry receives its own key
   * type so that a guard or action under `CONFIRM` sees `event` as `"CONFIRM"`. The shorthand
   * target is wrapped in `NoInfer` for the same reason `target` is.
   */
  on?: {
    [TEventKey in TEvent]?:
      | NoInfer<TargetName<TPath>>
      | TransitionDefinition<TContext, TPath, TEvent, TKey, TEventKey, TPayloads>;
  };
} & ([ChildPaths<TPath, TKey>] extends [never]
  ? AtomicStateShape | HistoryStateShape<TPath>
  : | CompoundStateShape<TContext, TPath, TEvent, TKey, TPayloads>
    | ParallelStateShape<TContext, TPath, TEvent, TKey, TPayloads>);

/**
 * A complete machine definition.
 *
 * `states` is keyed by state name, and it is the single source of the state union: every key and
 * nested path becomes part of the state union, even a state that no transition targets. `initial`
 * and transition targets are checked against the union of state paths.
 *
 * Hook and action lists accept mutable and readonly arrays alike, so a definition held in a
 * `const` variable as `as const` or checked with `satisfies` is a valid input.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of top-level state names, the keys of `states`.
 * @typeParam TEvent - Union of declared event names.
 * @typeParam TPath - Union of every state path, including nested ones. `createMachine()` derives
 * this recursively from its `states` map. This parameter remains available for explicit type
 * annotations.
 */
export type MachineDefinition<
  TContext,
  TState extends string,
  TEvent extends string,
  TPath extends string = TState,
  TPayloads extends EventPayloadMap = Record<never, never>,
> = {
  /** Stable machine identifier, echoed in snapshots and error messages. */
  id: string;
  /**
   * State the machine starts in. Must be a declared top-level state.
   *
   * The `NoInfer` wrapper keeps this value position out of type inference, so `TState` is
   * derived from the `states` keys alone.
   */
  initial: NoInfer<TState>;
  /** Initial context. Must be a plain object and structured-cloneable. */
  context: TContext;
  /**
   * Optional event payload declarations. Use `undefined` for payload-free events; object types
   * produce event objects shaped as `{ type: "EVENT_NAME", ...payload }`.
   *
   * ```ts
   * events: {} as { ADD: { amount: number }; RESET: undefined }
   * ```
   */
  events?: TPayloads;
  /**
   * Reserved: a machine declares no transitions of its own, so a top-level `on` map is rejected by
   * `createMachine()` with `UnsupportedDefinitionKeyError`. Declare transitions on the states that
   * react instead, which is also where `state` and `event` are narrowed for guards and hooks.
   */
  on?: never;
  /**
   * Declared states. Every transition target must be a key of this object.
   *
   * The mapped form feeds each key into its own state definition, which is what narrows the
   * `state` and `event` a hook, guard or action receives. It is also the inference source for
   * `TState`, so the state union is exactly the declared keys.
   */
  states: {
    [TKey in TState]: StateDefinition<
      TContext,
      TPath,
      TEvent | EventPayloadNames<TPayloads>,
      TKey,
      TPayloads
    >;
  };
};

/**
 * Explicitly annotated definition shape for a machine with nested states.
 *
 * The top-level keys are derived from the supplied path union. Inline calls to `createMachine()`
 * infer paths recursively and do not need this helper:
 *
 * ```ts
 * type OrderPath = "draft" | "draft.editing" | "draft.reviewing" | "published";
 *
 * const definition: NestedMachineDefinition<OrderContext, OrderPath, OrderEvent> = {
 *   id: "order",
 *   initial: "draft",
 *   context: { paymentAuthorized: false },
 *   states: {
 *     draft: {
 *       initial: "editing",
 *       states: { editing: {}, reviewing: {} },
 *     },
 *     published: {},
 *   },
 * };
 *
 * const machine = createMachine(definition);
 * ```
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TPath - Union of every state path, top-level and nested.
 * @typeParam TEvent - Union of declared event names.
 */
export type NestedMachineDefinition<
  TContext,
  TPath extends string,
  TEvent extends string,
  TPayloads extends EventPayloadMap = Record<never, never>,
> = MachineDefinition<TContext, TopLevelPaths<TPath>, TEvent, TPath, TPayloads>;

/**
 * An immutable snapshot of a machine at a point in time.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type MachineSnapshot<TContext, TState extends string, TEvent = string> = {
  /** Machine identifier. */
  id: string;
  /** State committed at the time the snapshot was taken. */
  state: TState;
  /** Deep clone of the context; mutating it never affects machine internals. */
  context: TContext;
  /** Event that produced the snapshot, or `null` for an initial or restored snapshot. */
  event: TEvent | null;
  /** State the machine was in before the transition, or `null` for an initial or restored snapshot. */
  previous: TState | null;
  /** Number of transitions committed by this instance; never restored from a serialized snapshot. */
  revision: number;
  /** `true` when no state in the active configuration declares an outgoing transition. */
  done: boolean;
  /**
   * Version of the snapshot format, taken from the machine's `schemaVersion` option.
   *
   * `restore()` rejects a snapshot whose version differs from the machine's, which stops data
   * written by an older shape of the machine from being applied silently.
   */
  schemaVersion: number;
  /**
   * Every active atomic state path, in document order. This is the authoritative view of the
   * active configuration, and it is the only field that can express a parallel state, where
   * several states are active at once.
   *
   * A sequential machine holds exactly one path here, which is the same value as `state`.
   */
  configuration: readonly TState[];
  /**
   * Remembered configuration per history pseudo-state path, keyed by that pseudo-state's path.
   *
   * Empty for a machine that declares no history pseudo-states, and for one that has not left a
   * state whose history is being remembered yet. Shallow history records the parent's active
   * direct children, deep history records every active atomic descendant.
   */
  history: Readonly<Record<string, readonly TState[]>>;
};

/**
 * A change listener registered through `machine.subscribe()`.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type Subscription<TContext, TState extends string, TEvent> = (
  snapshot: MachineSnapshot<TContext, TState, TEvent>,
) => void;

/** Removes a single subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * Optional behaviour for a machine, passed as the second argument to `createMachine`.
 *
 * @typeParam TContext - Shape of the machine context.
 */
export type MachineOptions<TContext> = {
  /**
   * Version stamped into every snapshot and checked by `restore()`.
   *
   * Defaults to `1`. Bump it when the context shape or the transition graph changes in a way that
   * makes previously persisted snapshots unsafe to apply; `restore()` then rejects the old data
   * instead of applying it silently.
   */
  schemaVersion?: number;
  /**
   * Validates and rehydrates the context of a restored snapshot.
   *
   * `restore()` can only check that a stored context is a plain object of cloneable values. It
   * cannot know which TypeScript type the context is supposed to have, so without this function a
   * stored context whose shape has drifted is applied as-is. Supply a validator to close that gap:
   * it receives the raw `context` value from the snapshot and must return a valid context, or
   * throw to reject the snapshot. It is also the place to rebuild values that JSON cannot carry,
   * such as `Date` or `Map`.
   *
   * @param input - The raw `context` value found in the snapshot.
   * @returns A valid context for the machine.
   */
  parseContext?: (input: unknown) => TContext;
  /**
   * Caps how many submissions may be queued at once.
   *
   * Every submission that queues work counts: `send()`, `can()` and `restore()`, including the
   * one currently running. A submission that arrives while the queue is already at the limit is
   * refused with a `QueueOverflowError` instead of being queued, so a burst of events fails fast
   * rather than growing without bound. Awaiting the queued work, or `whenIdle()`, makes room for
   * the next submission.
   *
   * Defaults to `Infinity`, which leaves the queue unbounded.
   */
  maxQueueDepth?: number;
};

/**
 * A running machine instance.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export interface Machine<TContext, TState extends string, TEvent> {
  /** Machine identifier taken from the definition. */
  readonly id: string;
  /**
   * State committed by the most recent successful transition.
   *
   * This is the deepest active state that contains the whole configuration: for a machine with no
   * parallel state it is the single active leaf, and while a parallel state is active it is that
   * parallel state, because no deeper state contains every active leaf. Use `configuration` for
   * the individual leaves.
   */
  readonly state: TState;
  /**
   * Every active atomic state path, committed by the most recent successful transition, in
   * document order.
   *
   * The authoritative view of the configuration, and the only one that can express a parallel
   * state, where several states are active at once. A sequential machine reports exactly one path.
   */
  readonly configuration: readonly TState[];
  /** Clone of the committed context. Mutating it never affects machine internals. */
  readonly context: TContext;
  /**
   * Submits an event for processing.
   *
   * Events are processed strictly in submission order on a FIFO queue; concurrent calls never
   * commit against stale state. The returned promise rejects with the original error when the
   * transition fails and resolves with the committed snapshot otherwise. A failure never blocks
   * later events.
   *
   * @param event - A declared payload-free event name or typed event object.
   * @returns The snapshot committed by this transition.
   */
  send(event: TEvent): Promise<MachineSnapshot<TContext, TState, TEvent>>;
  /**
   * Reports whether the event would be accepted, without committing anything.
   *
   * Answers the same question as `send()` without performing the transition: the event must be
   * declared in the committed state, and its guard - synchronous or asynchronous - must accept
   * the pending context. No hooks run, no subscriber is notified, the revision does not move and
   * the machine stays on its current snapshot.
   *
   * The check is queued behind pending events, so it evaluates the transition as it would run
   * once everything already submitted has settled. That makes the answer match what `send()`
   * would do if it were called at the same point.
   *
   * An event that the committed state does not declare resolves to `false` rather than rejecting.
   * A guard that throws rejects with the original error, exactly as `send()` does, so a broken
   * guard cannot be mistaken for a rejected transition.
   *
   * Guards observe a staging clone of the context, as they do during a transition, so a guard
   * that writes to the context it receives cannot reach the machine from here.
   *
   * @param event - Payload-free event name or typed event object to test.
   * @returns `true` when the transition would commit, `false` when it would not.
   */
  can(event: TEvent): Promise<boolean>;
  /**
   * Lists the event names the committed state declares, in declaration order.
   *
   * The answer is structural: it reports which events the state accepts and never evaluates
   * guards, which is what `can()` is for. Like `snapshot()`, it reads the committed state without
   * waiting for queued events. A terminal state declares no events and returns an empty array.
   *
   * @returns A fresh array of event names (the `type` discriminators for payload events).
   */
  getNextEvents(): EventNameOf<TEvent>[];
  /**
   * Reports whether the state at `path` is active.
   *
   * True for every path in the active configuration: the active leaf and every state above it, so
   * a nested machine answers both `matches("draft.editing")` and `matches("draft")` while editing
   * a draft. While a parallel state is active its regions match, and a leaf in one region does not
   * make a sibling region's leaf match. A history pseudo-state is never active, so it never
   * matches, and the compiler rejects the path outright.
   *
   * @param path - A declared state path.
   * @returns `true` when the path is part of the active configuration.
   */
  matches(path: TState): boolean;
  /**
   * Registers a listener called once per committed transition.
   *
   * Listeners are not called for the initial state, rejected transitions or restoration, and
   * each notification receives its own cloned snapshot. Subscribing the same function twice
   * creates two independent subscriptions. Subscriber exceptions are isolated.
   *
   * @param listener - Function invoked with the committed snapshot.
   * @returns A function that removes exactly this subscription.
   */
  subscribe(listener: Subscription<TContext, TState, TEvent>): Unsubscribe;
  /**
   * Takes a snapshot of the committed state without waiting for queued events.
   *
   * @returns An immutable snapshot carrying a cloned context.
   */
  snapshot(): MachineSnapshot<TContext, TState, TEvent>;
  /**
   * Restores a serialized snapshot, waiting for queued events to finish first.
   *
   * Runs no lifecycle hooks and notifies no subscribers, because restoration is not a
   * transition. Malformed input rejects with `SnapshotValidationError` and leaves the machine
   * untouched.
   *
   * The snapshot's `id` is checked, the context must be a plain object of cloneable values, and
   * the stored format version must be one this build understands. Version `2` is the current
   * shape and is validated field by field. Version `1`, or no version at all, is a 0.1.0 snapshot
   * and is migrated by `migrateSnapshotV1ToV2`: its configuration becomes the single state it was
   * in, and its history memory starts empty. Any other version rejects with
   * `UnsupportedSnapshotVersionError`. When the machine was created with `parseContext`, that
   * function validates and rehydrates the stored context, and an error thrown by it rejects the
   * snapshot.
   *
   * @param snapshot - A snapshot produced by `snapshot()` or `toJSON()`.
   * @returns The restored snapshot.
   */
  restore(snapshot: unknown): Promise<MachineSnapshot<TContext, TState, TEvent>>;
  /**
   * Resolves once the queue is empty and every submitted event has settled.
   *
   * Deterministic alternative to timing-based waits in tests and shutdown sequences.
   *
   * @returns A promise resolved when no work is pending.
   */
  whenIdle(): Promise<void>;
  /** Serialization hook used by `JSON.stringify`. */
  toJSON(): MachineSnapshot<TContext, TState, TEvent>;
}
