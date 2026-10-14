/**
 * Verifies the packed package the way a downstream project consumes it.
 *
 * Packs `packages/core` into a tarball once, then installs that tarball into a throwaway project
 * together with a specific TypeScript release. Each project is type checked with `skipLibCheck`
 * disabled, so the published declarations are validated under a consumer's own compiler settings,
 * and the compiled output is executed so the published JavaScript is exercised too.
 *
 * The versions checked by default are the documented floor, the version the workspace develops
 * against and the latest release, all against the same packed artifact. This catches declarations
 * that compile only under the development compiler, which publishing alone would not reveal.
 *
 * Usage: node scripts/verify-consumer.mjs [--typescript 5.4,5.9,latest] [--keep]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** TypeScript versions checked by default: the floor, the development version and the latest. */
const DEFAULT_TYPESCRIPT_VERSIONS = ["5.4", "5.9", "latest"];

/** The package under test, as a path relative to the workspace root. */
const PACKAGE_PATH = join("packages", "core");

/**
 * The consumer program, compiled and run against the installed package.
 *
 * It deliberately avoids template literals and Node type definitions, so that ambient types cannot
 * mask a problem in the shipped declarations.
 */
const CONSUMER_SOURCE = `import {
  createMachine,
  GuardRejectedError,
  InvalidEventError,
  InvalidTransitionError,
  SnapshotValidationError,
} from "motivo-stateflow";

/** Fails when a condition is not met. */
const ok = (value: unknown, label: string): void => {
  if (!value) {
    throw new Error(label + ": expected a truthy value");
  }
};

/** Fails when two values differ. */
const equal = <T>(actual: T, expected: T, label: string): void => {
  if (!Object.is(actual, expected)) {
    throw new Error(label + ": expected " + String(expected) + ", received " + String(actual));
  }
};

/** Returns the error a call rejects with, or fails when it resolves. */
const rejection = async (run: () => Promise<unknown>, label: string): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error(label + ": expected the call to reject");
};

const order = createMachine({
  id: "order",
  initial: "idle",
  context: { attempts: 0, authorized: false },
  states: {
    idle: { on: { START: "loading" } },
    loading: {
      on: {
        SUCCEED: { target: "ready", guard: ({ context }) => context.authorized },
        FAIL: {
          target: "failed",
          actions: [
            ({ context }) => {
              context.attempts += 1;
            },
          ],
        },
      },
    },
    ready: { on: { CLOSE: "closed" } },
    failed: { on: { RETRY: "loading" } },
    closed: {},
    refunded: {},
  },
});

type State = typeof order.state;

// refunded is declared but never targeted, and still belongs to the state union.
const catalogue: State[] = ["idle", "loading", "ready", "failed", "closed", "refunded"];
equal(catalogue.length, 6, "state catalogue");

// @ts-expect-error the event catalogue is closed
void order.send("NOT_AN_EVENT");
// @ts-expect-error prototype members are never implicit events
void order.send("toString");

const initial = order.snapshot();
equal(initial.state, "idle", "initial state");
equal(initial.revision, 0, "initial revision");
equal(initial.done, false, "a state with outgoing transitions is not done");
equal(initial.schemaVersion, 1, "default schema version");

const delivered: string[] = [];
const first = order.subscribe((snapshot) => delivered.push(snapshot.event ?? "none"));
const second = order.subscribe(() => delivered.push("second"));
ok(typeof first === "function" && typeof second === "function", "subscribe returns an unsubscribe function");

const wrongState = await rejection(() => order.send("RETRY"), "RETRY from idle");
ok(wrongState instanceof InvalidTransitionError, "declared event rejected in the current state");

const undeclared = await rejection(() => order.send("SHIP" as never), "an undeclared event");
ok(undeclared instanceof InvalidEventError, "event declared nowhere");

const refused = await rejection(
  () => order.send("START").then(() => order.send("SUCCEED")),
  "a transition whose guard returns false",
);
ok(refused instanceof GuardRejectedError, "guard refusal is typed");
equal(order.state, "loading", "a refused guard commits nothing");

await order.send("FAIL");
equal(order.state, "failed", "the transition committed");
equal(order.context.attempts, 1, "the action's context change committed");
equal(order.snapshot().revision, 2, "revision counts committed transitions");
equal(order.snapshot().previous, null, "reading the machine reports no transition metadata");

const committed = await order.send("RETRY");
equal(committed.previous, "failed", "the snapshot from send describes its transition");
equal(committed.event, "RETRY", "the snapshot from send carries the event");
equal(delivered.join(","), "START,second,FAIL,second,RETRY,second", "subscriber order");

first();
await order.send("FAIL");
equal(delivered.join(","), "START,second,FAIL,second,RETRY,second,second", "unsubscribing one listener spares the other");

equal(JSON.parse(JSON.stringify(order)).state, "failed", "toJSON round trip");

const report = createMachine(
  {
    id: "report",
    initial: "open",
    context: { generatedAt: new Date("2020-01-01T00:00:00.000Z"), label: "daily" },
    states: { open: { on: { CLOSE: "closed" } }, closed: {} },
  },
  {
    schemaVersion: 2,
    parseContext: (input) => {
      const raw = input as { generatedAt: unknown; label: unknown };
      if (typeof raw.generatedAt !== "string" || typeof raw.label !== "string") {
        throw new Error("stored report context is not the expected shape");
      }
      return { generatedAt: new Date(raw.generatedAt), label: raw.label };
    },
  },
);

const persisted = JSON.stringify(report);
let notifications = 0;
report.subscribe(() => {
  notifications += 1;
});

await report.send("CLOSE");
equal(report.snapshot().done, true, "a state without outgoing transitions is done");

const revisionBeforeRestore = report.snapshot().revision;
await report.restore(JSON.parse(persisted));
equal(notifications, 1, "restore notifies no subscriber");
equal(report.state, "open", "restored state");
equal(report.snapshot().revision, revisionBeforeRestore, "restore leaves the instance revision alone");
ok(report.context.generatedAt instanceof Date, "parseContext rehydrated the date");

const wrongVersion = await rejection(
  () => report.restore({ id: "report", state: "open", context: {}, schemaVersion: 9 }),
  "a snapshot from another schema version",
);
ok(wrongVersion instanceof SnapshotValidationError, "schema version mismatch is rejected");

const badContext = await rejection(
  () => report.restore({ id: "report", state: "open", context: { generatedAt: 5, label: 6 } }),
  "a snapshot whose context fails validation",
);
ok(badContext instanceof SnapshotValidationError, "a rejected parseContext fails the snapshot");

await order.whenIdle();
await report.whenIdle();
`;

/** The consumer compiler settings, kept strict so the published types face real scrutiny. */
const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022"],
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    skipLibCheck: false,
    outDir: "dist",
    rootDir: "src",
    types: [],
  },
  include: ["src"],
};

/**
 * Runs a command and captures its combined output.
 *
 * `shell` is only enabled for package manager shims on Windows, where `pnpm` and `npm` are `.cmd`
 * files that cannot be spawned directly. Two details make that work: the executable itself is never
 * quoted, because a quoted shim misplaces its own directory, and only arguments containing a space
 * are quoted, which is what the workspace path needs.
 *
 * @param {string} executable The executable to run.
 * @param {string[]} args The arguments, unquoted.
 * @param {string} cwd The working directory for the command.
 * @param {boolean} [shell] Whether to route the command through a shell.
 * @returns {{ code: number, output: string }} The exit code and the captured output.
 */
const run = (executable, args, cwd, shell = false) => {
  const quote = (value) => (shell && value.includes(" ") ? `"${value}"` : value);
  const result = spawnSync(executable, args.map(quote), { cwd, encoding: "utf8", shell });
  if (result.error) {
    throw result.error;
  }
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

/** Whether package manager shims must be launched through a shell on this platform. */
const SHIM_NEEDS_SHELL = process.platform === "win32";

/**
 * Packs the package under test and returns the tarball path.
 *
 * @param {string} workspace Absolute path to the workspace root.
 * @param {string[]} temporary Collects directories to remove when the run finishes.
 * @returns {{ tarball: string, directory: string, name: string }} The tarball, its directory and its name.
 */
const packPackage = (workspace, temporary) => {
  const packageDir = join(workspace, PACKAGE_PATH);
  if (!existsSync(join(packageDir, "dist", "index.js"))) {
    throw new Error('The package is not built. Run "pnpm build" before verifying consumers.');
  }

  const directory = mkdtempSync(join(tmpdir(), "stateflow-pack-"));
  temporary.push(directory);
  const result = run("pnpm", ["pack", "--pack-destination", directory], packageDir, SHIM_NEEDS_SHELL);
  if (result.code !== 0) {
    throw new Error(`Packing failed:\n${result.output}`);
  }

  const name = readdirSync(directory).find((entry) => entry.endsWith(".tgz"));
  if (!name) {
    throw new Error(`Packing produced no tarball in ${directory}`);
  }
  return { tarball: join(directory, name), directory, name };
};

/**
 * Writes a fresh consumer project to disk.
 *
 * @returns {string} The directory holding the consumer project.
 */
const writeConsumerProject = () => {
  const directory = mkdtempSync(join(tmpdir(), "stateflow-consumer-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  const manifest = JSON.stringify({ name: "stateflow-consumer", private: true, type: "module" }, null, 2);
  writeFileSync(join(directory, "package.json"), `${manifest}\n`);
  writeFileSync(join(directory, "tsconfig.json"), `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`);
  writeFileSync(join(directory, "src", "consumer.ts"), CONSUMER_SOURCE);
  return directory;
};

/**
 * Installs, type checks and runs one consumer project.
 *
 * @param {string} directory The consumer project directory.
 * @param {string} typescriptVersion The TypeScript release to install.
 * @param {string} tarball Absolute path to the packed tarball.
 * @returns {{ ok: boolean, typescript: string, detail: string }} The outcome of the check.
 */
const verifyVersion = (directory, typescriptVersion, tarball) => {
  const install = run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--silent", tarball, `typescript@${typescriptVersion}`],
    directory,
    SHIM_NEEDS_SHELL,
  );
  if (install.code !== 0) {
    return { ok: false, typescript: typescriptVersion, detail: `install failed:\n${install.output}` };
  }

  const typescript = join(directory, "node_modules", "typescript");
  const installed = JSON.parse(readFileSync(join(typescript, "package.json"), "utf8")).version;

  const typecheck = run(process.execPath, [join(typescript, "bin", "tsc"), "-p", "tsconfig.json"], directory);
  if (typecheck.code !== 0) {
    return { ok: false, typescript: installed, detail: `type check failed:\n${typecheck.output}` };
  }

  const executed = run(process.execPath, [join(directory, "dist", "consumer.js")], directory);
  if (executed.code !== 0) {
    return { ok: false, typescript: installed, detail: `runtime failed:\n${executed.output}` };
  }

  return { ok: true, typescript: installed, detail: "" };
};

/**
 * Parses the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{ versions: string[], keep: boolean }} The requested versions and cleanup policy.
 */
const parseArguments = (argv) => {
  const index = argv.indexOf("--typescript");
  const requested = index === -1 ? [] : argv[index + 1].split(",").filter(Boolean);
  return {
    versions: requested.length > 0 ? requested : DEFAULT_TYPESCRIPT_VERSIONS,
    keep: argv.includes("--keep"),
  };
};

const workspace = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { versions, keep } = parseArguments(process.argv.slice(2));
const temporary = [];
let failed = false;
try {
  const packed = packPackage(workspace, temporary);
  console.log(`packed ${packed.name}`);

  for (const version of versions) {
    const directory = writeConsumerProject();
    temporary.push(directory);
    const result = verifyVersion(directory, version, packed.tarball);
    failed = failed || !result.ok;
    console.log(`typescript ${result.typescript} against the packed package: ${result.ok ? "ok" : "FAILED"}`);
    if (!result.ok) {
      console.log(result.detail);
    }
  }
} finally {
  if (!keep) {
    for (const directory of temporary) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

process.exit(failed ? 1 : 0);
