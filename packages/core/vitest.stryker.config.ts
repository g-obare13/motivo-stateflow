/**
 * Vitest configuration for mutation runs.
 *
 * Stryker runs each mutant against the runtime suite, so the project's own configuration is reused
 * with two changes: the compile-time suites are skipped, because a mutant changes compiled
 * behaviour rather than types, and vitest's typecheck mode is disabled, because it spawns `tsc`
 * from inside Stryker's sandbox where TypeScript is not resolvable.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    typecheck: { enabled: false },
    coverage: { enabled: false },
  },
});
