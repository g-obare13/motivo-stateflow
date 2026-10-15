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
  GuardContext,
  GuardFn,
  Machine,
  MachineDefinition,
  MachineOptions,
  MachineSnapshot,
  Subscription,
  Unsubscribe,
} from "./types.js";

/**
 * A transition after normalization: the target state is resolved eagerly and every hook list is
 * copied into a local array, so later mutation of the caller's definition cannot change the
 * behaviour of a running machine.
 */
type NormalizedTransition<TContext, TState extends string, TEvent extends string> = {
  target: TState;
  guard?: GuardFn<TContext, TState, TEvent>;
  actions?: Array<ActionFn<TContext, TState, TEvent>>;
};

/**
 * A state after normalization. Transitions live in a `Map`, which removes every prototype-chain
 * hazard: events such as `toString`, `constructor` or `hasOwnProperty` resolve only when they
 * are declared explicitly.
 */
type NormalizedState<TContext, TState extends string, TEvent extends string> = {
  entry: Array<ActionFn<TContext, TState, TEvent>>;
  exit: Array<ActionFn<TContext, TState, TEvent>>;
  transitions: Map<string, NormalizedTransition<TContext, TState, TEvent>>;
};

/**
 * A single `subscribe()` call. Subscriptions are tracked per call instead of per function, so
 * subscribing the same function twice can be undone one subscription at a time.
 */
type ListenerRecord<TContext, TState extends string, TEvent extends string> = {
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
 * `subscribe`, `snapshot`, `restore`, `whenIdle` and `toJSON`.
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
export function createMachine<TContext extends object, TState extends string, TEvent extends string>(
  definition: MachineDefinition<TContext, TState, TEvent>,
  options: MachineOptions<TContext> = {},
): Machine<TContext, TState, TEvent> {
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
  const stateNames = Object.keys(rawStates);
  if (stateNames.length === 0) {
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

  const initialState = raw.initial as TState;
  const states = normalizeStates<TContext, TState, TEvent>(machineId, rawStates);
  const recognizedEvents = new Set<string>();
  for (const state of states.values()) {
    for (const eventName of state.transitions.keys()) {
      recognizedEvents.add(eventName);
    }
  }

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

  let currentState = initialState;
  let currentContext: TContext = cloneContext(raw.context as TContext, () => {
    throw new MachineConfigurationError(
      `Machine "${machineId}" context must be structured-cloneable: it cannot contain functions or other non-cloneable values.`,
    );
  });
  let revision = 0;
  let queueTail: Promise<void> = Promise.resolve();
  let pending = 0;
  const idleWaiters = new Set<() => void>();
  const listeners = new Set<ListenerRecord<TContext, TState, TEvent>>();

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

  const isTerminal = (state: TState): boolean => (states.get(state)?.transitions.size ?? 0) === 0;

  const buildSnapshot = (
    state: TState,
    context: TContext,
    event: TEvent | null,
    previous: TState | null,
  ): MachineSnapshot<TContext, TState, TEvent> => ({
    id: machineId,
    state,
    context,
    event,
    previous,
    revision,
    done: isTerminal(state),
    schemaVersion,
  });

  const snapshot = (): MachineSnapshot<TContext, TState, TEvent> =>
    buildSnapshot(currentState, cloneContext(currentContext), null, null);

  const notify = (
    committedContext: TContext,
    committed: MachineSnapshot<TContext, TState, TEvent>,
  ): void => {
    for (const record of [...listeners]) {
      try {
        record.listener({
          ...committed,
          context: cloneContext(committedContext),
        });
      } catch {
        // A misbehaving subscriber must never corrupt machine state or stall the queue.
      }
    }
  };

  const normaliseEvent = (event: TEvent): string => {
    if (typeof event !== "string") {
      throw new InvalidEventError(
        `Machine "${machineId}" can only process string events, received ${describe(event)}.`,
      );
    }
    return event;
  };

  /**
   * Looks up the transition a state declares for an event, or `undefined` when the state declares
   * none. Shared by `send()` and `can()` so both agree on what is accepted where.
   */
  const findTransition = (
    state: TState,
    event: string,
  ): NormalizedTransition<TContext, TState, TEvent> | undefined =>
    states.get(state)?.transitions.get(event);

  const resolveTransition = (event: string): NormalizedTransition<TContext, TState, TEvent> => {
    const transition = findTransition(currentState, event);
    if (transition) {
      return transition;
    }
    if (!recognizedEvents.has(event)) {
      throw new InvalidEventError(`Event "${event}" is not recognised by machine "${machineId}".`);
    }
    throw new InvalidTransitionError(
      `Event "${event}" is not allowed in state "${currentState}" of machine "${machineId}".`,
    );
  };

  const execute = async (
    actions: Array<ActionFn<TContext, TState, TEvent>>,
    args: GuardContext<TContext, TState, TEvent>,
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
  const runTransition = async (event: TEvent): Promise<MachineSnapshot<TContext, TState, TEvent>> => {
    const eventName = normaliseEvent(event);
    const previousState = currentState;
    const transition = resolveTransition(eventName);
    const stagedContext = cloneContext(currentContext);
    const args: GuardContext<TContext, TState, TEvent> = {
      context: stagedContext,
      state: previousState,
      event,
    };

    if (transition.guard) {
      const accepted = await transition.guard(args);
      if (!accepted) {
        throw new GuardRejectedError(
          `Guard rejected event "${eventName}" in state "${previousState}" of machine "${machineId}".`,
        );
      }
    }

    await execute(states.get(previousState)?.exit ?? [], args);
    if (transition.actions) {
      await execute(transition.actions, args);
    }
    await execute(states.get(transition.target)?.entry ?? [], {
      context: stagedContext,
      state: transition.target,
      event,
    });

    // The commit point. Cloning can still fail here, in which case nothing is committed and no
    // subscriber is notified, so the machine stays on its previous snapshot.
    const committedContext = cloneContext(stagedContext, () => {
      throw new MachineConfigurationError(
        `Machine "${machineId}" context was made unclonable while transitioning to "${transition.target}", so the transition was aborted.`,
      );
    });

    currentState = transition.target;
    currentContext = committedContext;
    revision += 1;

    const committed = buildSnapshot(
      transition.target,
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
    get state(): TState {
      return currentState;
    },
    get context(): TContext {
      return cloneContext(currentContext);
    },
    send(event: TEvent): Promise<MachineSnapshot<TContext, TState, TEvent>> {
      return enqueue(() => runTransition(event));
    },
    /**
     * Reports whether the event would be accepted, queued behind pending events. The guard runs
     * against a staging clone and nothing is committed: no hooks, no notification, no revision
     * change. See {@link Machine.can} for the full contract.
     */
    can(event: TEvent): Promise<boolean> {
      return enqueue(async () => {
        const eventName = normaliseEvent(event);
        const transition = findTransition(currentState, eventName);
        if (!transition) {
          return false;
        }
        if (!transition.guard) {
          return true;
        }
        return Boolean(
          await transition.guard({
            context: cloneContext(currentContext),
            state: currentState,
            event,
          }),
        );
      });
    },
    /** Declared events of the committed state, in declaration order. Guards are not evaluated. */
    getNextEvents(): TEvent[] {
      return [...(states.get(currentState)?.transitions.keys() ?? [])] as TEvent[];
    },
    subscribe(listener: Subscription<TContext, TState, TEvent>): Unsubscribe {
      if (typeof listener !== "function") {
        throw new TypeError(`Machine "${machineId}" subscribe() expects a function listener.`);
      }
      const record: ListenerRecord<TContext, TState, TEvent> = { listener };
      listeners.add(record);
      return () => {
        listeners.delete(record);
      };
    },
    snapshot,
    toJSON(): MachineSnapshot<TContext, TState, TEvent> {
      return snapshot();
    },
    /**
     * Restores a validated snapshot. Restoration is queued behind pending events, runs no
     * lifecycle hooks and notifies no subscribers because it is not a transition.
     */
    restore(input: unknown): Promise<MachineSnapshot<TContext, TState, TEvent>> {
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
        if (typeof state !== "string" || !hasOwn(rawStates, state)) {
          throw new SnapshotValidationError(
            `Snapshot state ${describe(state)} is not declared by machine "${machineId}".`,
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

        currentState = state as TState;
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

/** Rejects transition targets that are not declared states, including prototype members. */
const assertTarget = (
  target: unknown,
  rawStates: Record<string, unknown>,
  prefix: string,
): string => {
  if (typeof target !== "string" || !hasOwn(rawStates, target)) {
    throw new MachineConfigurationError(`${prefix} targets undeclared state ${describe(target)}.`);
  }
  return target;
};

/**
 * Validates a raw `states` declaration and copies it into the internal lookup tables, rejecting
 * every malformed value and every transition whose target is not a declared state.
 */
const normalizeStates = <TContext, TState extends string, TEvent extends string>(
  machineId: string,
  rawStates: Record<string, unknown>,
): Map<TState, NormalizedState<TContext, TState, TEvent>> => {
  const states = new Map<TState, NormalizedState<TContext, TState, TEvent>>();

  for (const stateName of Object.keys(rawStates)) {
    const stateDefinition = assertPlainObject(
      rawStates[stateName],
      `State "${stateName}" of machine "${machineId}" must be a plain object.`,
    );
    const entry = assertActionList<ActionFn<TContext, TState, TEvent>>(
      stateDefinition.entry,
      `State "${stateName}" of machine "${machineId}" has an invalid "entry" hook: expected an array of functions.`,
    );
    const exit = assertActionList<ActionFn<TContext, TState, TEvent>>(
      stateDefinition.exit,
      `State "${stateName}" of machine "${machineId}" has an invalid "exit" hook: expected an array of functions.`,
    );
    const transitions = new Map<string, NormalizedTransition<TContext, TState, TEvent>>();

    if (stateDefinition.on !== undefined) {
      const on = assertPlainObject(
        stateDefinition.on,
        `State "${stateName}" of machine "${machineId}" has an invalid "on" map: expected an object.`,
      );

      for (const eventName of Object.keys(on)) {
        const declared = on[eventName];
        const prefix = `Transition for event "${eventName}" in state "${stateName}" of machine "${machineId}"`;

        if (typeof declared === "string") {
          transitions.set(eventName, { target: assertTarget(declared, rawStates, prefix) as TState });
          continue;
        }

        const transition = assertPlainObject(
          declared,
          `${prefix} must be a state name or a transition object.`,
        );
        const target = (
          transition.target === undefined
            ? stateName
            : assertTarget(transition.target, rawStates, prefix)
        ) as TState;

        const normalized: NormalizedTransition<TContext, TState, TEvent> = { target };
        if (transition.guard !== undefined) {
          if (typeof transition.guard !== "function") {
            throw new MachineConfigurationError(
              `${prefix} has an invalid "guard": expected a function.`,
            );
          }
          normalized.guard = transition.guard as GuardFn<TContext, TState, TEvent>;
        }
        const actions = assertActionList<ActionFn<TContext, TState, TEvent>>(
          transition.actions,
          `${prefix} has an invalid "actions" list: expected an array of functions.`,
        );
        if (actions.length > 0) {
          normalized.actions = actions;
        }

        transitions.set(eventName, normalized);
      }
    }

    states.set(stateName as TState, { entry, exit, transitions });
  }

  return states;
};
