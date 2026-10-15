# Motivo Stateflow

Typed state machines for TypeScript.

The current workspace contains a dependency-free machine engine. Workflow orchestration, actors,
persistence and tooling are planned, not implemented.

## Status

| Capability | Package | Status |
| --- | --- | --- |
| Machine Engine: flat and compound/nested states, guards, transitions | `motivo-stateflow` ([packages/core](packages/core)) | Implemented: compound-state bubbling, typed payload events, hooks, snapshots, validated restoration, subscriptions and inspection. Parallel and history states are not implemented. |
| Workflow Runtime: long-running workflows, timers, retries, recovery, cancellation | `@motivo/workflow` | Planned. Design is pinned by the durability decision below. |
| Durability: persistence, checkpoints, event logs, replay, crash recovery | `@motivo/persistence` and adapters (`@motivo/persistence-sqlite`, `@motivo/persistence-postgres`) | Planned. v1 targets recovery after a process restart or crash, with in-memory and SQLite adapters. |
| Observability: execution traces, transition history, metrics | `@motivo/devtools` | Planned. Core inspection with `can()` and `getNextEvents()` is implemented. |
| Actors and Messaging: independent machine instances, mailboxes, routing, supervision | `@motivo/actors` | Planned. |
| Ecosystem: adapters, CLI, visualization, testing utilities, framework bindings | `@motivo/cli`, `@motivo/testing`, `@motivo/react` | Planned. |

The engine package is currently versioned `0.1.0`.

## What works today

- Declarative machines with inferred state, event and context types. Dotted state paths are derived
  recursively from nested `states` maps. `initial`, transition targets, event names and event
  payloads are checked at compile time.
- Per-state narrowing: a guard, action or hook sees the state that declares it and the event it
  belongs to, so a reach the runtime could never take is a compile error rather than a silent
  comparison against the wrong union.
- Nested states: a state may contain child states and start in one of them. Events bubble to the
  nearest state that declares them, exit and entry hooks run deepest-first and shallowest-first
  across levels, `machine.state` reports the active leaf as a dotted path, and `matches(path)`
  answers for the leaf and every state containing it.
- Payload events use `{ type: "NAME", ...payload }`; payload-free events retain the string
  shorthand. Guards, actions, hooks, snapshots and subscriptions receive the complete event.
- Guards (sync or async), transition actions, and entry and exit hooks, with atomic commits: a
  failure anywhere in a transition changes nothing.
- Deterministic processing. Events are queued per machine and processed in submission order, so
  concurrent `send()` calls never commit against stale state. `maxQueueDepth` caps how much work may
  be queued at once, so a burst fails fast instead of accumulating.
- Snapshots, subscriptions and validated restoration, including a `schemaVersion` check and an
  optional `parseContext` validator for contexts that JSON cannot represent.
- Inspection without side effects: `getNextEvents()` lists what the committed state accepts, and
  `can(event)` reports whether a transition would commit while committing nothing.
- 228 runtime tests and 27 compile-time tests, including property-based invariants. The consumer
  verification script targets TypeScript 5.4, 5.9 and the latest release.

Full API guide, examples and semantics: [packages/core/README.md](packages/core/README.md).

## Repository layout

```
motivo-stateflow/                 # repository root, and the pnpm workspace root
├── packages/
│   └── core/                     # the machine engine, published as motivo-stateflow
├── .github/workflows/            # continuous integration
├── package.json                  # workspace manifest: shared tooling and delegating scripts
├── pnpm-workspace.yaml
└── tsconfig.base.json            # shared compiler options
```

Future packages (`workflow`, `persistence`, `persistence-sqlite`, `persistence-postgres`, `actors`,
`devtools`, `testing`, `react`, `cli`) join `packages/` as they gain real code, and `examples/`,
`benchmarks/` and `docs/` are added alongside them. The tree never carries empty placeholders.

## Working in this repository

```bash
pnpm install            # install the workspace
pnpm check              # everything below, in order
pnpm lint               # eslint across the workspace
pnpm test               # unit, compile-time and property tests for every package
pnpm test:coverage      # the same suite with coverage thresholds enforced
pnpm build              # bundle every package
pnpm smoke              # import the built engine package the way a consumer would
pnpm test:consumer      # install the packed tarball into a throwaway project per TypeScript version
```

Node.js 22 or newer and pnpm 10 are required. TypeScript 5.4 or newer is required to consume the
published types; `pnpm test:consumer` checks the packed artifact against that floor.

## Roadmap

The engine is being finished first, then the workflow runtime on top of it. The detailed plan, the
current limitations and the stability notes live in
[packages/core/README.md](packages/core/README.md#known-limitations-and-roadmap).

Order of work:

1. Machine Engine: parallel states and history.
2. Workflow Runtime: timers and scheduling, retry with backoff, cancellation, lifecycle status and
   recovery, with an injectable clock. The persistence contract is designed with this API rather
   than after it.
3. Durability: checkpointing, leases, migrations and crash recovery, starting with in-memory and
   SQLite adapters.
4. Actors and composition, then tooling: CLI, graph analysis, visualization, model-based testing and
   framework bindings.

## License

MIT
