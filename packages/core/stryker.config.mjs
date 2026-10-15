/**
 * Mutation testing configuration.
 *
 * Mutation testing answers a question coverage cannot: whether the tests would notice if the code
 * were wrong. Every mutant is a small deliberate change to the source, and a mutant that survives
 * means no test failed while it was in place, which is a gap in the suite rather than in the code.
 *
 * Only the engine's changed modules are mutated, because a full run over the package takes long
 * enough to be a chore rather than a signal. `types.ts` declares types only, so it produces no
 * mutants and is not listed.
 *
 * Run with: pnpm --filter motivo-stateflow run test:mutation
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  // Listed explicitly because pnpm's virtual store keeps each package's dependencies separate, so
  // Stryker's own plugin discovery cannot reach a sibling package on its own.
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts" },
  mutate: ["src/machine.ts", "src/errors.ts"],
  coverageAnalysis: "perTest",
  concurrency: 4,
  timeoutMS: 20000,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 90, low: 80, break: null },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  ignoreStatic: false,
};
