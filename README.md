# Motivo Stateflow

State machines, workflows and reliable execution for TypeScript.

Motivo Stateflow is built as layers around a dependency-free machine engine: the engine decides
where a machine may move next, and everything else (durable workflows, actors, tooling) is added on
top of it without turning the engine into a framework.

## Status

| Capability | Package | Status |
| --- | --- | --- |
| Machine Engine: hierarchical and parallel states, guards, transitions, history | `motivo-stateflow` ([packages/core](packages/core)) | In progress. Flat machines, guards, hooks, snapshots and validated restoration are implemented. Hierarchical, parallel and history states are next. |
| Workflow Runtime: long-running workflows, timers, retries, recovery, cancellation | `@motivo/workflow` | Planned. Design is pinned by the durability decision below. |
| Durability: persistence, checkpoints, event logs, replay, crash recovery | `@motivo/persistence` and adapters (`@motivo/persistence-sqlite`, `@motivo/persistence-postgres`) | Planned. v1 targets recovery after a process restart or crash, with in-memory and SQLite adapters. |
| Observability: execution traces, transition history, metrics, inspection | `@motivo/devtools` | Planned. |
| Actors and Messaging: independent machine instances, mailboxes, routing, supervision | `@motivo/actors` | Planned. |
| Ecosystem: adapters, CLI, visualization, testing utilities, framework bindings | `@motivo/cli`, `@motivo/testing`, `@motivo/react` | Planned. |

Nothing is published to npm yet. The engine package is versioned `0.1.0` and its npm name was
verified as available before publication.

## What works today

- Declarative machines with inferred state, event and context types. The state union follows the
  `states` map, `initial` and every transition target are checked against it, and unknown events are
  compile errors.
- Guards (sync or async), transition actions, and entry and exit hooks, with atomic commits: a
  failure anywhere in a transition changes nothing.
- Deterministic processing. Events are queued per machine and processed in submission order, so
  concurrent `send()` calls never commit against stale state.
- Snapshots, subscriptions and validated restoration, including a `schemaVersion` check and an
  optional `parseContext` validator for contexts that JSON cannot represent.
- 156 runtime tests and 16 compile-time tests, including property-based invariants, plus CI across
  Linux and Windows on Node 20 and 22.

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
pnpm check              # lint, test, build and smoke test everything
pnpm lint               # eslint across the workspace
pnpm test               # unit, compile-time and property tests for every package
pnpm build              # bundle every package
pnpm smoke              # import the built engine package the way a consumer would
```

Node.js 18 or newer and pnpm 10 are required. TypeScript 5.4 or newer is required to consume the
published types.

## Roadmap

The engine is being finished first, then the workflow runtime on top of it. The detailed plan, the
current limitations and the stability notes live in
[packages/core/README.md](packages/core/README.md#known-limitations-and-roadmap).

Order of work:

1. Machine Engine: hierarchical, parallel and history states, state-specific inference, transition
   queries and inspection.
2. Workflow Runtime: timers and scheduling, retry with backoff, cancellation, lifecycle status and
   recovery, with an injectable clock. The persistence contract is designed with this API rather
   than after it.
3. Durability: checkpointing, leases, migrations and crash recovery, starting with in-memory and
   SQLite adapters.
4. Actors and composition, then tooling: CLI, graph analysis, visualization, model-based testing and
   framework bindings.

## License

MIT
