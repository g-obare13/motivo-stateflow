/**
 * Error hierarchy for Motivo Stateflow.
 *
 * Every error thrown by the library derives from {@link StateflowError}, so consumers can
 * distinguish library failures from unrelated runtime exceptions with a single `instanceof`
 * check. Messages always include the machine id and, when relevant, the current state, the
 * event and the target state. Sensitive context values are never included in messages.
 *
 * Every class accepts the standard `ErrorOptions`, so a lower level failure can be preserved on
 * `error.cause` instead of being flattened into a message.
 *
 * @packageDocumentation
 */

/**
 * Base class for every error raised by Motivo Stateflow.
 *
 * @example
 * ```ts
 * try {
 *   await machine.send("SHIP");
 * } catch (error) {
 *   if (error instanceof StateflowError) {
 *     reportToTelemetry(error.name, error.message, error.cause);
 *   }
 *   throw error;
 * }
 * ```
 */
export class StateflowError extends Error {
  /**
   * @param message - Human readable description of the failure.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateflowError";
  }
}

/**
 * Thrown by `createMachine()` when a definition or an option is malformed.
 *
 * Raised for a missing or blank `id`, a missing or non-cloneable `context`, an empty or invalid
 * `states` map, an `initial` state that is not declared, a transition target that is not
 * declared, hooks that are not arrays of functions, and invalid machine options. Configuration
 * problems always fail at creation time rather than during event processing.
 */
export class MachineConfigurationError extends StateflowError {
  /**
   * @param message - Human readable description of the invalid configuration.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MachineConfigurationError";
  }
}

/**
 * Thrown when an event is not declared anywhere in the machine.
 *
 * This is a programming error: the event name does not exist in any state's `on` map.
 */
export class InvalidEventError extends StateflowError {
  /**
   * @param message - Human readable description of the unrecognised event.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidEventError";
  }
}

/**
 * Thrown when a declared event is not accepted in the machine's current state.
 *
 * The event was submitted while the machine was in a state that declares no transition for it.
 * The machine keeps its state, its context and its revision unchanged.
 */
export class InvalidTransitionError extends StateflowError {
  /**
   * @param message - Human readable description of the rejected transition.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Thrown when a transition guard returns `false`.
 *
 * A rejected guard is an expected, non-exceptional outcome: no state change is committed, no
 * subscriber is notified, and the queue continues with the next event.
 */
export class GuardRejectedError extends StateflowError {
  /**
   * @param message - Human readable description of the rejected guard.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GuardRejectedError";
  }
}

/**
 * Thrown when a submission is refused because the machine's queue is already at the depth set by
 * the `maxQueueDepth` option.
 *
 * A refused submission is never queued, so it reaches no guard and no hook, and the machine keeps
 * its state, its context and its revision. Awaiting the queued work, or `whenIdle()`, makes room
 * for the next submission.
 */
export class QueueOverflowError extends StateflowError {
  /**
   * @param message - Human readable description of the refused submission.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QueueOverflowError";
  }
}

/**
 * Thrown by `restore()` when a serialized snapshot is malformed.
 *
 * Raised for non-object input, a mismatched machine id, an undeclared state name, a missing or
 * non-cloneable context, a snapshot whose `schemaVersion` does not match the machine, and a
 * context rejected by the machine's `parseContext` option (the original failure is preserved on
 * `cause`).
 */
export class SnapshotValidationError extends StateflowError {
  /**
   * @param message - Human readable description of the invalid snapshot.
   * @param options - Standard error options; `cause` carries the underlying failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotValidationError";
  }
}
