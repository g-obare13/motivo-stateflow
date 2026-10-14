/**
 * Public entry point of Motivo Stateflow.
 *
 * @example
 * ```ts
 * import { createMachine } from "motivo-stateflow";
 *
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
 * await machine.send("CONFIRM");
 * console.log(machine.state); // "confirmed"
 * ```
 *
 * @packageDocumentation
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./machine.js";
