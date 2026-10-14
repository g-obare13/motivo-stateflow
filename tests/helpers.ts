/**
 * Shared helpers for the Motivo Stateflow test suites.
 *
 * These helpers keep the suites deterministic: asynchronous behaviour is driven with explicit
 * promises and `whenIdle()` instead of timers.
 */

import { createMachine } from "../src/index.js";
import type { Machine, MachineDefinition } from "../src/index.js";

/** A promise plus its resolvers, for controlling asynchronous guards and actions. */
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/** Creates a promise that can be settled later, without timers. */
export const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Creates a machine from an arbitrary value so runtime validation can be exercised with
 * definitions that the compiler would otherwise reject.
 */
export const createLooseMachine = (
  definition: unknown,
): Machine<Record<string, unknown>, string, string> =>
  createMachine(definition as unknown as MachineDefinition<Record<string, unknown>, string, string>);

/** Casts an arbitrary string into the declared event union for negative runtime tests. */
export const asEvent = <TEvent extends string>(event: string): TEvent => event as TEvent;
