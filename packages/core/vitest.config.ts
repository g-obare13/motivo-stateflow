/**
 * Vitest configuration for Motivo Stateflow.
 *
 * Runs the runtime suites from `tests/**\/*.test.ts` in a Node environment, type-checks the
 * compile-time suites from `tests/**\/*.test-d.ts` with the project tsconfig so inference
 * regressions fail the build, and reports coverage for `src`.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts"],
      reporter: ["text", "text-summary"],
    },
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
