/**
 * Vitest configuration for Motivo Stateflow.
 *
 * Runs the runtime suites from `tests/**\/*.test.ts` in a Node environment and type-checks the
 * compile-time suites from `tests/**\/*.test-d.ts` with the project tsconfig, so inference
 * regressions fail the build rather than slipping through.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['tests/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
