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
} from "./errors.js";
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

type DeclaredTargets<TState> = TState extends { on: infer TOn }
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

type InvalidStateTree<TStates> = {
  [TKey in keyof TStates]: TStates[TKey] extends {
    states: infer TChildren extends Record<string, unknown>;
  }
    ? TStates[TKey] extends { initial: infer TInitial extends string }
      ? TInitial extends keyof TChildren
        ? InvalidStateTree<TChildren>
        : `${TKey & string}.initial`
      : `${TKey & string}.initial`
    : TStates[TKey] extends { initial: unknown }
      ? TKey
      : never;
}[keyof TStates];

type ValidateStateTree<TStates> = [InvalidStateTree<TStates>] extends [never]
  ? unknown
  : { __invalid_compound_state__: InvalidStateTree<TStates> };

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
  entry?: ReadonlyArray<ActionFn<TContext, TKey, EventFromName<TEvent, TPayloads>>>;
  exit?: ReadonlyArray<ActionFn<TContext, TKey, EventFromName<TEvent, TPayloads>>>;
  on?: {
    [TEventKey in TEvent]?: TransitionDefinition<
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
 * A transition after normalization: the target state is resolved eagerly and every hook list is
 * copied into a local array, so later mutation of the caller's definition cannot change the
 * behaviour of a running machine.
 */
type CompiledTransition<TContext> = {
  target: CompiledState<TContext>;
  guard?: GuardFn<TContext, string, unknown>;
  actions?: Array<ActionFn<TContext, string, unknown>>;
};

/**
 * A state after compilation. States form a tree: a compound state holds its children by key and
 * remembers the child to enter. Transitions live in a `Map`, which removes every prototype-chain
 * hazard: events such as `toString`, `constructor` or `hasOwnProperty` resolve only when they
 * are declared explicitly.
 *
 * The machine's top level hangs off a virtual root, whose own key and path are empty and which
 * declares no hooks. That gives resolution and the least common ancestor arithmetic one uniform
 * shape: every top-level state is simply a child of the root.
 */
type CompiledState<TContext> = {
  /** Dot-joined path from the top level, for example `"draft.editing"`. Empty for the root. */
  path: string;
  /** This state's own key, as the definition writes it. Empty for the root. */
  key: string;
  /** Enclosing state, or the root itself for the root. */
  parent: CompiledState<TContext>;
  /** Nested states by key, in declaration order. */
  children: Map<string, CompiledState<TContext>>;
  /** Child entered when this state is entered. Absent for a leaf. */
  initialChild?: CompiledState<TContext>;
  entry: Array<ActionFn<TContext, string, unknown>>;
  exit: Array<ActionFn<TContext, string, unknown>>;
  transitions: Map<string, CompiledTransition<TContext>>;
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
  StatePathUnion<TStates>,
  EventFromName<TEvent | EventPayloadNames<TPayloads>, TPayloads>
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
    initial?: unknown;
    context?: unknown;
    states?: unknown;
  };
  const machineId = typeof raw.id === "string" ? raw.id : "";

  if (machineId.trim() === "") {
    throw new MachineConfigurationError('Machine definitions require a non-empty string "id".');
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

  const { root, initialLeaf, pathIndex, recognizedEvents } = compileTree<TContext>(
    machineId,
    rawStates,
    raw.initial,
  );

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
  const schemaVersion = (rawOptions.schemaVersion as number | undefined) ?? 1;
  const parseContext = rawOptions.parseContext as ((input: unknown) => TContext) | undefined;
  const maxQueueDepth =
    (rawOptions.maxQueueDepth as number | undefined) ?? Number.POSITIVE_INFINITY;

  let currentState = initialLeaf;
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

  /** Active states from `state` up to the top level, deepest first. The root is not included. */
  const chainOf = (state: CompiledState<TContext>): Array<CompiledState<TContext>> => {
    const chain: Array<CompiledState<TContext>> = [];
    for (let node = state; node !== root; node = node.parent) {
      chain.push(node);
    }
    return chain;
  };

  /** True when `node` sits anywhere below `ancestor` in the tree. */
  const isDescendantOf = (
    node: CompiledState<TContext>,
    ancestor: CompiledState<TContext>,
  ): boolean => {
    for (let current = node.parent; current !== root; current = current.parent) {
      if (current === ancestor) {
        return true;
      }
    }
    return false;
  };

  /** Deepest state containing both nodes; the root when they only share the top level. */
  const commonAncestor = (
    left: CompiledState<TContext>,
    right: CompiledState<TContext>,
  ): CompiledState<TContext> => {
    let a = left;
    let b = right;
    while (depthOf(a) > depthOf(b)) {
      a = a.parent;
    }
    while (depthOf(b) > depthOf(a)) {
      b = b.parent;
    }
    while (a !== b) {
      a = a.parent;
      b = b.parent;
    }
    return a;
  };

  /**
   * Exit set for a transition: the active states from the leaf up to and including the state that
   * declares the transition, deepest first. A transition bubbled to an ancestor therefore exits
   * every active state below that ancestor as well.
   */
  const exitChain = (source: CompiledState<TContext>): Array<CompiledState<TContext>> => {
    const chain: Array<CompiledState<TContext>> = [];
    for (const node of chainOf(currentState)) {
      chain.push(node);
      if (node === source) {
        break;
      }
    }
    return chain;
  };

  /**
   * Entry set for a transition: the states from just below the boundary that both ends share down
   * to the target, then the target's initial children down to a leaf. A target that is the source
   * itself, or a descendant of it, re-enters the source, which is what makes a self-transition on
   * a compound state reset it to its initial child.
   */
  const entryChain = (
    source: CompiledState<TContext>,
    target: CompiledState<TContext>,
  ): Array<CompiledState<TContext>> => {
    const boundary =
      target === source || isDescendantOf(target, source) ? source.parent : commonAncestor(source, target);
    const chain: Array<CompiledState<TContext>> = [];
    for (let node = target; node !== boundary; node = node.parent) {
      chain.push(node);
    }
    chain.reverse();
    for (let child = target.initialChild; child; child = child.initialChild) {
      chain.push(child);
    }
    return chain;
  };

  /** A configuration is done when no state in it can handle an event. */
  const isDone = (state: CompiledState<TContext>): boolean =>
    chainOf(state).every((node) => node.transitions.size === 0);

  const buildSnapshot = (
    state: CompiledState<TContext>,
    context: TContext,
    event: TMachineEvent | null,
    previous: CompiledState<TContext> | null,
  ): MachineSnapshot<TContext, TMachinePath, TMachineEvent> => ({
    id: machineId,
    state: state.path as TMachinePath,
    context,
    event: event === null ? null : cloneEvent(event, machineId),
    previous: previous === null ? null : (previous.path as TMachinePath),
    revision,
    done: isDone(state),
    schemaVersion,
  });

  const snapshot = (): MachineSnapshot<TContext, TMachinePath, TMachineEvent> =>
    buildSnapshot(currentState, cloneContext(currentContext), null, null);

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
   * Looks up the transition that handles an event, walking from the active leaf up to the top
   * level. The deepest state that declares the event wins, so a parent's `on` map acts as a
   * fallback for events its children do not handle. Shared by `send()` and `can()` so both agree
   * on what is accepted where.
   */
  const findTransition = (
    event: string,
  ): { source: CompiledState<TContext>; transition: CompiledTransition<TContext> } | undefined => {
    for (const node of chainOf(currentState)) {
      const transition = node.transitions.get(event);
      if (transition) {
        return { source: node, transition };
      }
    }
    return undefined;
  };

  const resolveTransition = (
    event: string,
  ): { source: CompiledState<TContext>; transition: CompiledTransition<TContext> } => {
    const found = findTransition(event);
    if (found) {
      return found;
    }
    if (!recognizedEvents.has(event)) {
      throw new InvalidEventError(`Event "${event}" is not recognised by machine "${machineId}".`);
    }
    throw new InvalidTransitionError(
      `Event "${event}" is not allowed in state "${currentState.path}" of machine "${machineId}".`,
    );
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
   * Runs one transition to completion. The guard and every lifecycle hook operate on a staged
   * context clone, and the machine's state, context and revision are only replaced after all of
   * them succeed. A failed transition is therefore a no-op for observers: no snapshot, no
   * notification.
   */
  const runTransition = async (
    event: TMachineEvent,
  ): Promise<MachineSnapshot<TContext, TMachinePath, TMachineEvent>> => {
    const eventName = normaliseEvent(event);
    const previousState = currentState;
    const { source, transition } = resolveTransition(eventName);
    const stagedContext = cloneContext(currentContext);
    const args: GuardContext<TContext, string, unknown> = {
      context: stagedContext,
      state: source.path,
      event,
    };

    if (transition.guard) {
      const accepted = await transition.guard(args);
      if (!accepted) {
        throw new GuardRejectedError(
          `Guard rejected event "${eventName}" in state "${source.path}" of machine "${machineId}".`,
        );
      }
    }

    for (const state of exitChain(source)) {
      await execute(state.exit, { ...args, state: state.path });
    }
    if (transition.actions) {
      await execute(transition.actions, args);
    }
    for (const state of entryChain(source, transition.target)) {
      await execute(state.entry, { context: stagedContext, state: state.path, event });
    }

    // The commit point. Cloning can still fail here, in which case nothing is committed and no
    // subscriber is notified, so the machine stays on its previous snapshot.
    const committedContext = cloneContext(stagedContext, () => {
      throw new MachineConfigurationError(
        `Machine "${machineId}" context was made unclonable while transitioning to "${transition.target.path}", so the transition was aborted.`,
      );
    });

    currentState = leafOf(transition.target);
    currentContext = committedContext;
    revision += 1;

    const committed = buildSnapshot(
      currentState,
      cloneContext(committedContext),
      event,
      previousState,
    );
    notify(committedContext, committed);
    return committed;
  };

  return {
    get id(): string {
      return machineId;
    },
    get state(): TMachinePath {
      return currentState.path as TMachinePath;
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
     * Reports whether the event would be accepted, queued behind pending events. The guard runs
     * against a staging clone and nothing is committed: no hooks, no notification, no revision
     * change. See {@link Machine.can} for the full contract.
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
        const found = findTransition(eventName);
        if (!found) {
          return false;
        }
        if (!found.transition.guard) {
          return true;
        }
        return Boolean(
          await found.transition.guard({
            context: cloneContext(currentContext),
            state: found.source.path,
            event: preparedEvent,
          }),
        );
      });
    },
    /**
     * Declared events of the active configuration, shallowest state first and in declaration
     * order within a state. Guards are not evaluated.
     */
    getNextEvents(): EventNameOf<TMachineEvent>[] {
      const events: EventNameOf<TMachineEvent>[] = [];
      const seen = new Set<string>();
      for (const state of chainOf(currentState).reverse()) {
        for (const eventName of state.transitions.keys()) {
          if (!seen.has(eventName)) {
            seen.add(eventName);
            events.push(eventName as EventNameOf<TMachineEvent>);
          }
        }
      }
      return events;
    },
    /** True for the active leaf and every state above it; false for an undeclared path. */
    matches(path: TMachinePath): boolean {
      return chainOf(currentState).some((state) => state.path === path);
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
     */
    restore(input: unknown): Promise<MachineSnapshot<TContext, TMachinePath, TMachineEvent>> {
      return enqueue(() => {
        const candidate = assertPlainObject(
          input,
          "Snapshot must be a plain object.",
          "snapshot",
        );
        const { id, state, context } = candidate;

        if (typeof id !== "string" || id !== machineId) {
          throw new SnapshotValidationError(
            `Snapshot id ${describe(id)} does not match machine id "${machineId}".`,
          );
        }
        if (typeof state !== "string" || !pathIndex.has(state)) {
          throw new SnapshotValidationError(
            `Snapshot state ${describe(state)} is not declared by machine "${machineId}".`,
          );
        }
        const restoredState = pathIndex.get(state) as CompiledState<TContext>;
        if (restoredState.initialChild) {
          throw new SnapshotValidationError(
            `Snapshot state ${describe(state)} of machine "${machineId}" is a compound state, which the machine cannot be in; store the child state it should be in instead.`,
          );
        }

        // Snapshots written before versioning existed have no field, and are still accepted.
        const storedVersion = candidate.schemaVersion;
        if (storedVersion !== undefined && storedVersion !== schemaVersion) {
          throw new SnapshotValidationError(
            `Snapshot schemaVersion ${describe(storedVersion)} does not match machine "${machineId}" schemaVersion ${schemaVersion}.`,
          );
        }

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

        currentState = restoredState;
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

/** Distance from the top level, used to level two states before comparing their ancestors. */
const depthOf = <TContext>(state: CompiledState<TContext>): number => {
  let depth = 0;
  for (let node = state; node.parent !== node; node = node.parent) {
    depth += 1;
  }
  return depth;
};

/** The state reached by entering initial children until a leaf is reached. */
const leafOf = <TContext>(state: CompiledState<TContext>): CompiledState<TContext> => {
  let node = state;
  while (node.initialChild) {
    node = node.initialChild;
  }
  return node;
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
  initialLeaf: CompiledState<TContext>;
  pathIndex: Map<string, CompiledState<TContext>>;
  recognizedEvents: Set<string>;
} => {
  const root = {
    path: "",
    key: "",
    parent: undefined as unknown as CompiledState<TContext>,
    children: new Map<string, CompiledState<TContext>>(),
    entry: [],
    exit: [],
    transitions: new Map<string, CompiledTransition<TContext>>(),
  };
  root.parent = root;

  const pathIndex = new Map<string, CompiledState<TContext>>();
  const recognizedEvents = new Set<string>();
  const declaredTransitions: Array<{
    state: CompiledState<TContext>;
    event: string;
    declared: unknown;
  }> = [];

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
      const node: CompiledState<TContext> = {
        path,
        key,
        parent,
        children: new Map<string, CompiledState<TContext>>(),
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

      if (definition.states !== undefined) {
        const children = assertPlainObject(
          definition.states,
          `State "${path}" of machine "${machineId}" has an invalid "states" map: expected an object.`,
        );
        if (Object.keys(children).length === 0) {
          throw new MachineConfigurationError(
            `State "${path}" of machine "${machineId}" declares an empty "states" map; declare at least one child state or omit it.`,
          );
        }
        if (typeof definition.initial !== "string" || !hasOwn(children, definition.initial)) {
          throw new MachineConfigurationError(
            `Compound state "${path}" of machine "${machineId}" must declare an "initial" child state, but ${describe(definition.initial)} is not one of its states.`,
          );
        }

        build(children, node);
        node.initialChild = requireChild(node, definition.initial);
      } else if (definition.initial !== undefined) {
        throw new MachineConfigurationError(
          `State "${path}" of machine "${machineId}" declares "initial" without nested "states".`,
        );
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

  // The caller validated the initial key against the same raw object, so the state exists.
  const initialNode = requireChild(root, initialKey);

  return { root, initialLeaf: leafOf(initialNode), pathIndex, recognizedEvents };
};

/**
 * Validates one raw transition declaration and resolves its target.
 *
 * Omitting `target` produces a self-transition, which re-enters the declaring state: a compound
 * state therefore resets to its initial child.
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
    return { target: resolveTarget(root, source, declared, prefix) };
  }

  const transition = assertPlainObject(
    declared,
    `${prefix} must be a state name or a transition object.`,
  );
  const normalized: CompiledTransition<TContext> = {
    target:
      transition.target === undefined
        ? source
        : resolveTarget(root, source, transition.target, prefix),
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
 * Resolves a raw transition target to a compiled state.
 *
 * - A leading dot is relative to the declaring state: in `draft`, `.editing` is `draft.editing`.
 * - A dotted path is absolute: `draft.editing` starts at the top level and can be written from
 *   anywhere in the tree.
 * - A bare name is looked up in the declaring state's own children first, then in each enclosing
 *   state's children as the walk moves up. That is what lets a parent's `on` map act as a
 *   fallback, and it is why a bare name can still name a sibling or a top-level state.
 */
const resolveTarget = <TContext>(
  root: CompiledState<TContext>,
  source: CompiledState<TContext>,
  target: unknown,
  prefix: string,
): CompiledState<TContext> => {
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
 * Looks a bare target name up in the declaring state's own children, then in each enclosing
 * state's children, moving one level up at a time until the top level has been searched.
 */
const lookupBare = <TContext>(
  root: CompiledState<TContext>,
  source: CompiledState<TContext>,
  name: string,
): CompiledState<TContext> | undefined => {
  let node: CompiledState<TContext> | undefined = source;
  while (node) {
    const found = node.children.get(name);
    if (found) {
      return found;
    }
    node = node === root ? undefined : node.parent;
  }
  return undefined;
};

/** Walks a dotted path from a starting state, or returns `undefined` at the first missing key. */
const descend = <TContext>(
  from: CompiledState<TContext>,
  path: string,
): CompiledState<TContext> | undefined => {
  let node: CompiledState<TContext> | undefined = from;
  for (const segment of path.split(".")) {
    node = node.children.get(segment);
    if (node === undefined) {
      return undefined;
    }
  }
  return node;
};
