/**
 * Vitest configuration for Motivo Stateflow.
 *
 * Runs the runtime suites from `tests/**\/*.test.ts` in a Node environment, type-checks the
 * compile-time suites from `tests/**\/*.test-d.ts` with the project tsconfig so inference
 * regressions fail the build, and enforces coverage thresholds over `src`.
 *
 * The thresholds are a regression gate rather than a target. Statements, lines and functions are
 * pinned at 100 percent because the engine is small enough to keep fully covered. Branches sit at
 * 95 percent because v8 counts uncovered defensive fallbacks, and because the exact branch tally
 * can differ between Node releases.
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
      thresholds: {
        statements: 100,
        lines: 100,
        functions: 100,
        branches: 95,
      },
    },
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
