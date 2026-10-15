/**
 * Public types of Motivo Stateflow.
 *
 * The types in this module drive inference for `createMachine()`. State names, event names and
 * the context shape are inferred from the definition, so the compiler rejects unknown events,
 * unknown states and invalid transition targets wherever that is statically knowable.
 *
 * @packageDocumentation
 */

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
export type GuardContext<TContext, TState extends string, TEvent extends string> = {
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
export type GuardFn<TContext, TState extends string, TEvent extends string> = (
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
export type ActionFn<TContext, TState extends string, TEvent extends string> = (
  args: GuardContext<TContext, TState, TEvent>,
) => unknown | Promise<unknown>;

/**
 * Object form of a transition. `target` defaults to the current state, which produces a
 * self-transition: exit hooks, transition actions and entry hooks all run, and the state name
 * itself does not change.
 *
 * A transition is written inside the state that declares it, so its guard and actions receive
 * that state as `state` and the event they are declared under as `event`. Both are narrowed from
 * the machine-wide unions, so a guard cannot compare `state` against a state it is not declared
 * in, and cannot read an event the state does not declare.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 * @typeParam TSource - State that declares this transition, narrowed to that single state.
 * @typeParam TOwnEvent - Event this transition is declared under, narrowed to that single event.
 */
export type TransitionDefinition<
  TContext,
  TState extends string,
  TEvent extends string,
  TSource extends TState = TState,
  TOwnEvent extends TEvent = TEvent,
> = {
  /**
   * Declared state to enter. Defaults to the current state (self-transition).
   *
   * The `NoInfer` wrapper keeps this value position out of type inference: `TState` must come
   * from the `states` map keys, otherwise a target that happens to be mentioned here would
   * narrow the union and every other declared state would be rejected.
   */
  target?: NoInfer<TState>;
  /** Condition that must return `true` for the transition to be committed. */
  guard?: GuardFn<TContext, TSource, TOwnEvent>;
  /** Actions executed after exit hooks and before entry hooks. */
  actions?: ReadonlyArray<ActionFn<TContext, TSource, TOwnEvent>>;
};

/**
 * Declaration of a single state.
 *
 * Lifecycle hooks run only while the machine is inside the state that declares them, so their
 * `state` is narrowed to that single state. Their `event` stays the machine-wide union, because
 * the event that enters or leaves a state varies with the transition being taken.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 * @typeParam TKey - The state this definition belongs to, narrowed to that single state.
 */
export type StateDefinition<
  TContext,
  TState extends string,
  TEvent extends string,
  TKey extends TState = TState,
> = {
  /** Hooks executed when the state is entered, after transition actions. */
  entry?: ReadonlyArray<ActionFn<TContext, TKey, NoInfer<TEvent>>>;
  /** Hooks executed when the state is left, before transition actions. */
  exit?: ReadonlyArray<ActionFn<TContext, TKey, NoInfer<TEvent>>>;
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
      | NoInfer<TState>
      | TransitionDefinition<TContext, TState, TEvent, TKey, TEventKey>;
  };
};

/**
 * A complete machine definition.
 *
 * `states` is keyed by state name, and it is the single source of the state union: every key
 * becomes part of `TState`, even a state that no transition targets (an entry-only or planned
 * state). `initial` and the transition targets are checked against that union.
 *
 * Hook and action lists accept mutable and readonly arrays alike, so a definition held in a
 * `const` variable as `as const` or checked with `satisfies` is a valid input.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type MachineDefinition<TContext, TState extends string, TEvent extends string> = {
  /** Stable machine identifier, echoed in snapshots and error messages. */
  id: string;
  /**
   * State the machine starts in. Must be a declared state.
   *
   * The `NoInfer` wrapper keeps this value position out of type inference, so `TState` is
   * derived from the `states` keys alone.
   */
  initial: NoInfer<TState>;
  /** Initial context. Must be a plain object and structured-cloneable. */
  context: TContext;
  /**
   * Declared states. Every transition target must be a key of this object.
   *
   * The mapped form feeds each key into its own state definition, which is what narrows the
   * `state` and `event` a hook, guard or action receives. It is also the inference source for
   * `TState`, so the state union is exactly the declared keys.
   */
  states: { [TKey in TState]: StateDefinition<TContext, TState, TEvent, TKey> };
};

/**
 * An immutable snapshot of a machine at a point in time.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type MachineSnapshot<TContext, TState extends string, TEvent extends string = string> = {
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
  /** `true` when the current state declares no outgoing transitions. */
  done: boolean;
  /**
   * Version of the snapshot format, taken from the machine's `schemaVersion` option.
   *
   * `restore()` rejects a snapshot whose version differs from the machine's, which stops data
   * written by an older shape of the machine from being applied silently.
   */
  schemaVersion: number;
};

/**
 * A change listener registered through `machine.subscribe()`.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export type Subscription<TContext, TState extends string, TEvent extends string> = (
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
};

/**
 * A running machine instance.
 *
 * @typeParam TContext - Shape of the machine context.
 * @typeParam TState - Union of declared state names.
 * @typeParam TEvent - Union of declared event names.
 */
export interface Machine<TContext, TState extends string, TEvent extends string> {
  /** Machine identifier taken from the definition. */
  readonly id: string;
  /** State committed by the most recent successful transition. */
  readonly state: TState;
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
   * @param event - A declared event name.
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
   * @param event - Event name to test against the committed state.
   * @returns `true` when the transition would commit, `false` when it would not.
   */
  can(event: TEvent): Promise<boolean>;
  /**
   * Lists the events the committed state declares, in declaration order.
   *
   * The answer is structural: it reports which events the state accepts and never evaluates
   * guards, which is what `can()` is for. Like `snapshot()`, it reads the committed state without
   * waiting for queued events. A terminal state declares no events and returns an empty array.
   *
   * @returns A fresh array of event names; mutating it affects nothing.
   */
  getNextEvents(): TEvent[];
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
   * The snapshot's `id` and `state` are checked, the context must be a plain object of cloneable
   * values, and the snapshot's `schemaVersion` must match the machine's (a snapshot without that
   * field is accepted, so data written before versioning keeps working). When the machine was
   * created with `parseContext`, that function validates and rehydrates the stored context, and
   * an error thrown by it rejects the snapshot.
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
