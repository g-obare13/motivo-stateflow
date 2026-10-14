/**
 * Error hierarchy for Motivo Stateflow.
 *
 * Every error thrown by the library derives from {@link StateflowError}, so consumers can
 * distinguish library failures from unrelated runtime exceptions with a single `instanceof`
 * check. Messages always include the machine id and, when relevant, the current state, the
 * event and the target state. Sensitive context values are never included in messages.
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
 *     reportToTelemetry(error.name, error.message);
 *   }
 *   throw error;
 * }
 * ```
 */
export class StateflowError extends Error {
  /**
   * @param message - Human readable description of the failure.
   */
  constructor(message: string) {
    super(message);
    this.name = "StateflowError";
  }
}

/**
 * Thrown by `createMachine()` when a definition is malformed.
 *
 * Raised for a missing or blank `id`, a missing or non-cloneable `context`, an empty or invalid
 * `states` map, an `initial` state that is not declared, a transition target that is not
 * declared, and hooks that are not arrays of functions. Configuration problems always fail at
 * creation time rather than during event processing.
 */
export class MachineConfigurationError extends StateflowError {
  /**
   * @param message - Human readable description of the invalid configuration.
   */
  constructor(message: string) {
    super(message);
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
   */
  constructor(message: string) {
    super(message);
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
   */
  constructor(message: string) {
    super(message);
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
   */
  constructor(message: string) {
    super(message);
    this.name = "GuardRejectedError";
  }
}

/**
 * Thrown by `restore()` when a serialized snapshot is malformed.
 *
 * Raised for non-object input, a mismatched machine id, an undeclared state name, a missing or
 * non-cloneable context, and any other snapshot that cannot be applied safely.
 */
export class SnapshotValidationError extends StateflowError {
  /**
   * @param message - Human readable description of the invalid snapshot.
   */
  constructor(message: string) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}
