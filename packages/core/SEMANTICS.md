# Statechart Semantics

Normative statement of the semantics the Motivo Stateflow engine implements, including parallel
states and history pseudo-states. Every rule below carries a stable ID (`ST1`, `TS4`, `HS2`, ...).
The test suite is organised so that each ID has at least one dedicated test, and the
[conformance matrix](#conformance-matrix) at the end maps every ID to the test that proves it.

Where this document and the code disagree, the code is wrong.

## Scope and conformance target

This engine follows [SCXML](https://www.w3.org/TR/scxml/) (§3.1.2 compound states, §3.1.3 parallel
states, §3.4 `<parallel>`, §3.10 `<history>`, §3.11 legal state configurations, and the
interpretation algorithm in §3.13, whose ordering predicates are defined in its Annex D pseudocode).
Specifically it implements SCXML's **external** transition semantics, its document-order
conflict resolution, its exit and entry set computation, and its history recording rules.

Six deliberate deviations exist. They are listed in [Deviations from SCXML](#deviations-from-scxml)
with the reason for each. No other deviation is intended, and an unlisted deviation found during
implementation is a bug in the implementation, not a licence to update this document silently.

## ST: Structure

| ID | Rule |
| --- | --- |
| ST1 | A state is one of four kinds: **atomic** (no `states`), **compound** (declares `states` and `initial`), **parallel** (`type: "parallel"`, declares `states`, must not declare `initial`), or a **history pseudo-state** (`type: "history"`). |
| ST2 | `type` is optional. Omitting it keeps the 0.1.0 inference: a state that declares `states` is compound, a state that declares neither `states` nor `type` is atomic. `type: "compound"` is accepted and means the same as declaring `states` plus `initial`. |
| ST3 | A compound state has **exactly one** active child at any time. A parallel state has **all** of its children active whenever it is active. |
| ST4 | A history pseudo-state is a child of the state whose configuration it remembers. It is declared with `type: "history"`, `history: "shallow" \| "deep"` (default `"shallow"`), and an optional `target`. It must not declare `states`, `initial`, `on`, `entry` or `exit`. |
| ST5 | A history pseudo-state is never active, never appears in a configuration, and is not a legal value for `initial`. It must have a parent state, so a top-level history pseudo-state is a configuration error. |
| ST6 | State paths are the keys from the top level joined with dots. A key must not contain a dot. Document order is the depth-first, pre-order walk of the `states` maps in declaration order, so an ancestor precedes its descendants and siblings follow declaration order. |

`ST6` is the order SCXML calls document order. It has three uses: it ranks conflicting transitions
(`TS4`), it orders exit and entry (`EO1`, `EO2`), and it orders the reported configuration (`CF4`).

## CF: Active configuration

| ID | Rule |
| --- | --- |
| CF1 | The **active configuration** is the set of states that have been entered and not subsequently exited. |
| CF2 | The engine stores and reports the configuration in its **canonical form**: the ordered, deduplicated list of active **atomic** paths, in document order. Every active non-atomic state is an ancestor of at least one of those paths, so nothing is lost. |
| CF3 | A configuration is **legal** when (a) exactly one child of the virtual root is active, (b) it contains at least one atomic state, (c) every atomic state's ancestors are active, (d) a compound state is active with exactly one of its children active, and (e) a parallel state is active with all of its children active. The engine only ever commits a legal configuration, and `restore()` rejects a snapshot whose configuration is illegal. |
| CF4 | `snapshot().configuration` is the canonical form of `CF2`: a `readonly` array of atomic paths in document order. It is the authoritative view of the configuration. |
| CF5 | `snapshot().state` is the **deepest active state that contains the whole configuration**. For a sequential configuration that is the single active atomic path, exactly as in 0.1.0. For a parallel configuration it is the parallel state, because no deeper state contains every active leaf. |
| CF6 | `snapshot().previous` is `CF5` applied to the configuration before the microstep, or `null` for a snapshot that did not come from a transition. |
| CF7 | `matches(path)` is `true` when `path` is an ancestor of, or equal to, any path in the configuration. A parallel state therefore matches while it is active, its regions match, and a leaf in one region does not make a sibling region's leaf match. |
| CF8 | `getNextEvents()` lists the event names declared by every active state, visiting the active states in document order and keeping each state's declaration order, with duplicates removed. This generalises the 0.1.0 behaviour documented as "shallowest state first": for a sequential configuration document order is outermost first. History pseudo-states declare no transitions and contribute nothing. |
| CF9 | `snapshot().done` is `true` when no active state declares any transition, across every region. |

## TS: Transition selection

| ID | Rule |
| --- | --- |
| TS1 | One delivered event produces **one microstep**. The engine has no internal event queue, so a microstep is a macrostep (`X2`). |
| TS2 | A transition `T` is a **candidate** for an active atomic state `S` when `T` is declared on `S` or on an ancestor of `S`, and the deepest such declaring state wins. Each active atomic state therefore contributes at most one candidate, from its nearest declaring ancestor. |
| TS3 | Candidates are deduplicated by identity. When two active atomic states find the same declaration on a shared ancestor, that declaration is one transition and fires once. |
| TS4 | Two candidates **conflict** when their exit sets (`TD3`) intersect. Conflicts can only arise between candidates whose declaring states are related by ancestry, because regions that are disjoint have disjoint exit sets. |
| TS5 | Conflicting candidates are ranked: `T1` has higher priority than `T2` when (a) `T1`'s declaring state is a proper descendant of `T2`'s declaring state, or (b) neither declaring state is an ancestor of the other, in which case the active atomic state for which `T1` is the candidate precedes the one for `T2` in document order. Rule (a) is the common case: a region's handler preempts a handler on the parallel state that contains the region. |
| TS6 | The **selected set** is the largest conflict-free subset of the candidates such that no excluded candidate has higher priority than a member of the set. Equivalently: rank the candidates by `TS5` and accept them greedily, skipping any candidate that conflicts with an already accepted one. |
| TS7 | Guards participate in selection. A candidate whose guard returns `false` is **not enabled**, and a disabled candidate neither fires nor blocks another candidate. |
| TS8 | When at least one candidate is enabled, the microstep commits and each enabled candidate fires. A disabled candidate's region simply does not transition, which means one region can take a transition while a sibling ignores the same event. |
| TS9 | When the event resolves to candidates but none is enabled, the microstep is rejected with `GuardRejectedError` and nothing changes. For a machine with no parallel state this reproduces 0.1.0 exactly: the single candidate's guard returned `false`. |
| TS10 | An event that no active state declares, and that the machine declares nowhere, rejects with `InvalidEventError`. An event the machine declares somewhere but that no active state declares rejects with `InvalidTransitionError`. |

TS7, TS8 and TS9 are SCXML's `cond` semantics applied to this engine's guards. TS9 is the case where
the whole microstep is refused, which is what keeps the 0.1.0 single-transition contract intact.

## BB: Event bubbling and several regions handling one event

| ID | Rule |
| --- | --- |
| BB1 | Bubbling is per active atomic state, not per machine. Each active atomic state searches its own ancestor chain, from itself upward, for the nearest declaring state (`TS2`). |
| BB2 | The search covers the whole chain including parallel ancestors, so a handler declared on a parallel state acts as the fallback for every region that does not declare the event itself. |
| BB3 | When several regions declare the event, each selects its own candidate and all selected candidates fire in a single microstep, in document order. One event can therefore advance several regions at once, which is the parallel composability `ST3` promises. |
| BB4 | A candidate's guard returning `false` does not stop the other regions (`TS7`, `TS8`). There is no fallback from a disabled candidate to a handler on an ancestor: the nearest declarer is chosen structurally, before any guard runs. |
| BB5 | A handler on a parallel state is preempted by a deeper handler in any region for the same event, because the ancestor's exit set covers the whole parallel subtree and therefore conflicts with the region's, and the deeper declaring state has priority (`TS5a`). A **targetless** ancestor handler is the exception: its exit set is empty, so it conflicts with nothing and runs alongside the region handlers (`TL6`). |
| BB6 | A region whose nearest declarer is the parallel state itself does not transition when that ancestor handler is preempted by a sibling region, since that one transition was its only candidate. |

## TD: Domain, exit set and entry set

| ID | Rule |
| --- | --- |
| TD1 | The **transition domain** of a candidate with targets is the **least common compound ancestor** of its declaring state and its effective targets: the nearest ancestor of all of them that is compound or the virtual root. Parallel states are skipped when looking for that ancestor, matching SCXML's definition of LCCA. |
| TD2 | Every transition that declares a target is external, so `TD1` applies to it. A targetless transition has no domain at all, and therefore no exit set and no entry set (`TL1`). |
| TD3 | The **exit set** of a candidate is every active state that is a proper descendant of its domain. It is empty for a targetless transition, which has no domain (`TL1`). The exit set of the selected set is the union of the candidates' exit sets. |
| TD4 | The **complete target set** of the selected set is the union of the effective targets plus all of their ancestors, closed under two expansions: if a parallel state is a member, all of its children are added; if a compound state is a member and none of its children is, its default initial descendants are added recursively, **unless one of its children is still active after the exit set is applied**. That exception is what stops a parallel sibling region from being reset when only the other region transitions. |
| TD5 | The **entry set** is every member of the complete target set that is not currently active or is in the exit set. |
| TD6 | An **effective target** is what a target resolves to after dereferencing: a history pseudo-state is replaced by its remembered configuration, or by its default target when there is no memory (`HS4`, `HS5`). Dereferencing happens before the domain, exit set and entry set are computed, so everything after it is ordinary transition semantics. |
| TD7 | Targeting a compound state enters its initial child and then that child's default entry, recursively. Targeting a parallel state enters all of its regions. |
| TD8 | A cross-region target, or a target outside a parallel state, exits and re-enters the parallel state itself, because the parallel state is a proper descendant of the domain. Regions that the complete target set does not name are re-entered through their default entry, which resets them. |

## EO: Exit, action and entry ordering

| ID | Rule |
| --- | --- |
| EO1 | The exit set is exited in **reverse document order**: descendants before ancestors, innermost first. One `exit` hook list runs per exited state, in declaration order within that list. |
| EO2 | The entry set is entered in **document order**: ancestors before descendants, shallowest first, with siblings in declaration order. One `entry` hook list runs per entered state. |
| EO3 | Transition actions run after the last `exit` hook and before the first `entry` hook. When several candidates are selected, their action lists run in document order of their declaring states. |
| EO4 | A self-transition on a compound state resets it to its initial child, because the state is exited and re-entered (`TD3`, `TD4`). |
| EO5 | A self-transition on the region of a parallel state exits and re-enters the whole parallel subtree, including sibling regions, because the LCCA of a region and itself is the nearest compound ancestor *above* the parallel state (`TD1`). To reset only one region's interior, declare the transition on a descendant inside that region and target a state inside that region. |

Worked example for `EO1` and `EO2`, which the tests use directly. The machine is sequential and
`a` declares `GO` with target `e`:

```
a            (compound, initial: b)   on: { GO: "e" }
  b          (compound, initial: c)
    c        (atomic, active)
    d        (atomic)
  e          (compound, initial: f)
    f        (atomic)
```

Domain is the virtual root (the only compound proper ancestor of `a` and `e`), exit set is
`{a, b, c}`, entry set is `{a, e, f}`. The order is
`exit c, exit b, exit a, <actions>, enter a, enter e, enter f`.

Worked example for a parallel machine, which the tests use directly:

```
p            (parallel)
  r1         (compound, initial: r1a)  on: { INC: "r1b" }
    r1a      (atomic, active)
    r1b      (atomic)
  r2         (compound, initial: r2a)  on: { INC: "r2b" }
    r2a      (atomic, active)
    r2b      (atomic)
```

`INC` gives two candidates, one per region, with domains `r1` and `r2`, so the exit sets are
`{r1a}` and `{r2a}` and they do not conflict (`TS4`). Both fire in one microstep: exit `r2a`, exit
`r1a` (reverse document order), actions in document order of the declaring states, enter `r1b`,
enter `r2b` (document order). The configuration becomes `["p.r1.r1b", "p.r2.r2b"]` and `revision`
advances by one.

Declaring the same two transitions on the regions themselves instead of on their children would
change the outcome, and the difference is worth knowing. A region is not a proper ancestor of
itself, so the region's own declaration and its target have no common compound ancestor below the
parallel state: the domain is the root, the exit set is the whole configuration, and the two
regions conflict. Document order then selects the first region's transition and the second region
never transitions at all. In-region transitions therefore belong on a state *inside* the region,
which is what the example above does.

## TL: Targetless transitions

SCXML defines the exit set and the entry set of a transition with no `target` as empty, so such a
transition runs its content without moving the machine. Both definitions are normative (§3.13.2):
"If the transition does not contain a 'target', its exit set is empty" and "If a transition does not
contain a 'target', its entry set is empty".

| ID | Rule |
| --- | --- |
| TL1 | A transition declared without `target` has an **empty exit set and an empty entry set**. Nothing is exited, nothing is entered, and the configuration is unchanged. |
| TL2 | Its guard is evaluated and its actions run, exactly as for any other transition, and the microstep commits: `revision` advances by one, one notification is delivered, and the snapshot reports the unchanged configuration as both `state` and `previous`. |
| TL3 | No `entry` or `exit` hook runs, on the declaring state or on any other state, because no state is entered or exited. |
| TL4 | It is local by construction. A targetless transition inside one region of a parallel state leaves sibling regions and every nested state exactly as they were, which makes it the way to react to an event without resetting a subtree. |
| TL5 | It records no history, because history is captured for states that are exited and none are. |
| TL6 | It never conflicts, because two empty exit sets cannot intersect (`TS4`). Several regions can therefore run their own targetless handlers for one event in a single microstep. |

`TL4` is the counterpart of `EO5`: a declaration that should re-enter its own state must name that
state as its `target` explicitly.

## HS: History

| ID | Rule |
| --- | --- |
| HS1 | A history pseudo-state remembers the configuration of its parent. It is declared as a child of its parent (`ST4`, `ST5`). |
| HS2 | `history: "shallow"` remembers the **active direct children** of the parent. Entering a remembered child then applies that child's default entry, so a compound remembered child starts at its own `initial` descendant. |
| HS3 | `history: "deep"` remembers every **active atomic descendant** of the parent, so entering the memory restores exactly the leaves that were active. For a parallel parent this restores each region's exact leaf. |
| HS4 | Memory is captured when the parent state is exited, into a staged copy of the memory, **before** that state's `exit` hooks run. It therefore records the configuration as it was when the parent was left, including the states that are about to exit. |
| HS5 | On first entry, meaning a target that dereferences a history pseudo-state with no memory, the history's `target` is used when declared. With no `target`, the parent is entered through its ordinary default entry: its `initial` child for a compound parent, all regions for a parallel parent. |
| HS6 | A shallow history under a compound parent remembers exactly one child, so its `target` must name a direct child of the parent; a deep history's `target` may name any descendant. Because a `target` is a single path, a history under a parallel parent cannot name one specific leaf per region as its default; the unnamed regions take their default entry. |
| HS7 | Memory is per machine instance and is not affected by the number of times the parent is entered. Re-entering a parent without a history target never consults the memory. |
| HS8 | Memory is serialized in the snapshot (`SR1`) and restored by `restore()`, so a resumed machine remembers what it did before it was serialized. |
| HS9 | Targeting a history pseudo-state re-enters its remembered states even when they are already active, because they are proper descendants of the transition's domain and so belong to the exit set. Their exit and entry hooks therefore run again, and region state is not preserved for free. |

## AT: Atomicity and failure

| ID | Rule |
| --- | --- |
| AT1 | A microstep runs in this order: normalise the event, select candidates (`TS2` to `TS6`), evaluate the enabled candidates' guards (`TS7`, `TS9`), capture history memory for the states being exited (`HS4`), run `exit` hooks in reverse document order (`EO1`), run the selected transitions' actions in document order (`EO3`), run `entry` hooks in document order (`EO2`), then commit. |
| AT2 | Guards, actions and hooks all operate on **staged** values: one staged context clone and one staged history memory. Nothing the machine reports changes until the commit point. |
| AT3 | When any guard, action or hook throws or returns a rejected promise, the whole microstep is discarded: the configuration, context, history memory, revision and snapshot are exactly what they were before the event, and no subscriber is notified. The caller's promise rejects with the original error. This holds when only one region's action fails: the sibling region does not commit either. |
| AT4 | External side effects performed by hooks and actions that already ran are **not** undone. The library's guarantee covers machine state, context, history, revision and notifications; a hook that calls out to another system must be idempotent. |
| AT5 | The commit point is the only place machine state changes, and it happens after every hook has succeeded. A failed microstep therefore cannot leave a partially committed configuration or a duplicate notification. |
| AT6 | Exactly one `revision` increment and one subscriber notification per committed microstep, however many regions transitioned. |

## SR: Serialization, versions and migration

| ID | Rule |
| --- | --- |
| SR1 | A snapshot is `{ id, state, context, event, previous, revision, done, schemaVersion, configuration, history }`. `configuration` is the canonical configuration (`CF4`). `history` maps a history parent path to the remembered atomic paths (`HS2`, `HS3`), and is `{}` for a machine without history memory. |
| SR2 | The default `schemaVersion` becomes `2`, because the parallel and history fields make the format distinguishable from 0.1.0 snapshots. The meaning of the option is unchanged: it is stamped into every snapshot and gates `restore()`. |
| SR3 | `restore()` accepts a stored snapshot whose `schemaVersion` is absent or `1`. That is a 0.1.0 snapshot: its `configuration` is `[state]` and its `history` is `{}`, and the machine then continues writing the current version. |
| SR4 | `restore()` accepts a stored snapshot whose `schemaVersion` equals the machine's configured version and validates `configuration` and `history` (`CF3`, `HS8`). Any other stored version rejects with `SnapshotValidationError`, which is the existing behaviour. |
| SR5 | When a snapshot carries both `state` and `configuration`, `state` must equal `CF5` applied to `configuration`; otherwise the snapshot rejects. `configuration` is authoritative when present. |
| SR6 | `restore()` rejects a configuration containing a history pseudo-state or a non-atomic path, a configuration with a missing region of an active parallel state, and a history entry whose parent is not declared or whose remembered paths are not atomic descendants of that parent. |

## TY: Typing

| ID | Rule |
| --- | --- |
| TY1 | The path union is derived recursively from the `states` map, including regions of a parallel state. `parallel` states and their regions contribute paths exactly as compound states do. |
| TY2 | History pseudo-states are excluded from the machine's state union (`CF4` to `CF9`, so `matches`, `configuration`, `state` and `restore()` never accept one) while remaining valid transition and history `target` values (`TD6`). |
| TY3 | A transition `target` accepts any declared path: atomic, compound, parallel or history. `initial` accepts any declared path except a history pseudo-state. |
| TY4 | `history: "shallow" \| "deep"` and `type` are typed, so a misspelled variant, a `parallel` state that also declares `initial`, and a history pseudo-state that also declares `states` or `on` are compile errors, backed by the same runtime validation in `MachineConfigurationError`. |

## Deviations from SCXML

| ID | Deviation | Reason |
| --- | --- | --- |
| X2 | One event produces exactly one microstep. There is no internal event queue, no eventless (`NULL`) transitions, and no macrostep loop. | The engine has no internal events and no `done.state.*` completion events, so a loop would have nothing to iterate over. |
| X3 | A rejected or failed microstep is atomic; SCXML leaves action failure undefined and removes guard-disabled transitions from the set and continues. | The library's headline guarantee is that a failure changes nothing, and `AT3` is what makes it true for parallel machines too. Guard-disabled transitions do follow SCXML (`TS7`). |
| X4 | A state declares at most one transition per event. SCXML allows several transitions with the same event in one state, ordered by document order and `cond`. | This engine's `on` map is an event-keyed map. The `TS5` document-order tie-break is still needed, because sibling regions can both target a state outside the parallel state. |
| X5 | Only external transitions exist. SCXML's `type="internal"` is not implemented. | Keeps the change focused. See the open question in [Open questions](#open-questions) for the consequence, which `EO5` documents. |
| X6 | No `final` states, no `done.state.*` events, no `<invoke>`, no data model or `<script>`, no delayed or `send`-generated events, no `cond` on a targetless transition. | Out of scope for 0.1.0, unchanged by this work. |
| X7 | A history `target` is a single path, not a set of paths. | Matches the request and the rest of the API, where a transition names one target. `HS6` documents the consequence for a parallel parent. |

## Decisions taken

These were open questions, and the answers below are what the engine implements.

1. **Guards follow SCXML.** A guard returning `false` disables only its own region's transition
   (`TS7`, `TS8`); every enabled region still fires. When no region is enabled the microstep rejects
   with `GuardRejectedError` (`TS9`), which keeps a machine with no parallel state behaving exactly
   as it did in 0.1.0. Guards are all evaluated against the pre-transition staging clone, before any
   exit hook or action, so no guard observes another region's action effects. A guard that throws or
   rejects is not a disabled transition: it aborts the whole microstep (`AT3`).
2. **One snapshot shape at version 2, with migration.** Every snapshot carries `configuration` and
   `history`, even for a machine with no parallel state and no history, where `history` is `{}`.
   `schemaVersion` defaults to `2`, a stored `1` or absent version is migrated by
   `migrateSnapshotV1ToV2`, and any other version rejects with `UnsupportedSnapshotVersionError`.
   Three existing expectations were updated to assert the exact version 2 shape rather than being
   loosened: the snapshot object in `tests/creation.test.ts`, and the two version expectations in
   `tests/snapshots.test.ts`. `scripts/verify-consumer.mjs` asserts the same default.
3. **External transitions only, with the field reserved.** A transition that declares `type` is
   rejected at creation with `UnsupportedTransitionTypeError`, so adding `type: "internal"` later
   stays a non-breaking change. A targetless transition covers the common case of reacting without
   moving (`TL1` to `TL4`); internal transitions are still needed to re-enter a state *without*
   leaving its content, which is what `EO5` describes.

### Reacting without resetting a subtree

A targetless transition is the way to react to an event while leaving the configuration alone: its
guard and actions run, and nothing is exited or entered (`TL1` to `TL3`). Declaring it on a state
inside a region keeps the change local to that region and leaves sibling regions and nested state
untouched (`TL4`), which is what a self-transition cannot do, because a self-transition on a region
reaches above the parallel state (`EO5`).

```ts
on: {
  AUDIT: { actions: [({ context }) => { context.audited += 1; }] },
  RESET: { target: "editing", actions: [() => log.push("reset")] },
}
```

`AUDIT` reacts without moving anything. `RESET` names its own state, so it is an external
self-transition: the state and everything below it is exited and entered again.

## Non-goals

Internal transitions (`X5`), final states and completion events, internal and delayed events,
`<invoke>`, a data model, and any change to the existing sequential behaviour beyond the additions
this document describes.

## Conformance matrix

Test files: `tests/parallel.test.ts`, `tests/history.test.ts`, `tests/ordering.test.ts`,
`tests/targetless.test.ts`, plus extensions to `tests/snapshots.test.ts`, `tests/events.test.ts` and
`tests/properties.test.ts`.

| Rule | Test |
| --- | --- |
| ST1 to ST6 | `parallel.test.ts` and `history.test.ts`: kind inference, `type` validation errors, document order of a mixed tree. |
| CF1 to CF3, CF7 to CF9 | `parallel.test.ts`: canonical configuration order, `matches` for parallel states and regions, `getNextEvents` document order, `done` across regions. |
| CF4 to CF6 | `snapshots.test.ts`: `configuration`, `state` and `previous` for parallel and sequential machines. |
| TS2 to TS6 | `parallel.test.ts`: per-region candidates, deduplication on a shared ancestor, conflict, precedence by depth, the document-order tie-break when sibling regions target outside the parallel state. |
| TS7 to TS9 | `parallel.test.ts` and `guards.test.ts`: a guard disabled in one region, another region still firing, and every guard disabled rejecting with `GuardRejectedError`. |
| TS10 | `parallel.test.ts`: undeclared event and declared-but-not-active event errors. |
| BB1 to BB6 | `parallel.test.ts`: bubbling per region, the parallel state as fallback, one event advancing several regions, and a sibling region preempting the parallel state's handler. |
| TD1 to TD8 | `parallel.test.ts`: LCCA skipping parallel states, exit set union, cross-region and outside targets resetting unnamed regions. |
| EO1 to EO4 | `ordering.test.ts`: the two worked examples above and their exact hook sequences. |
| EO5 | `parallel.test.ts`: a region self-transition resetting the whole parallel subtree, and the documented in-region workaround. |
| TL1 to TL6 | `targetless.test.ts`: a targetless leaf, a targetless compound state with an active child, a targetless declaration inside one region with siblings and nested state untouched, history unaffected, and two regions reacting to one event without conflicting. |
| HS1 to HS3, HS7, HS9 | `history.test.ts`: shallow memory of a direct child including its default entry, deep memory of exact leaves, parallel deep memory, first entry, and re-entry without a history target. |
| HS4 | `history.test.ts`: the exit hooks observe memory captured before the parent's `exit` hooks run, and a failed microstep leaves memory unchanged. |
| HS5, HS6 | `history.test.ts`: default target on first entry, the compound default-entry fallback, and the parallel default-target limitation. |
| HS8, SR1 to SR6 | `snapshots.test.ts`: history survives a serialize and restore round trip, a legacy `schemaVersion: 1` snapshot migrates, and each rejection case throws `SnapshotValidationError`. |
| AT1 to AT6 | `parallel.test.ts` and `actions.test.ts`: one region's action throwing leaves the sibling region uncommitted and the revision unchanged, with no notification. |
| TY1 to TY4 | `types.test-d.ts`: parallel paths inferred, history path rejected by `matches`, accepted as a target, and the `type` and `history` validation compile-time rejections. |
| Spec-derived ordering | `ordering.test.ts`: the SCXML external-transition ordering rules exercised through compound and parallel fixtures, asserting the exit sequence (innermost first) and the entry sequence (outermost first) for targets inside the domain, in a sibling subtree, and outside the parallel state. |

### Required properties

`tests/properties.test.ts` carries two properties, each over randomly generated machines and event
sequences:

1. "always keeps the active configuration legal and consistently reported": after any sequence of
   accepted and rejected events the reported configuration is legal (`CF3`), no leaf is reported
   twice, every reported path matches, `state` equals `CF5` of `configuration`, the snapshot agrees,
   and `can()` agrees with the configuration.
2. "restores a serialized snapshot into an indistinguishable machine": a restored machine has the
   same configuration, context, `done`, history, `getNextEvents()` and outcome for the next event as
   the machine it was serialized from.

### Regression requirement

The full existing suite must pass with no changes other than the three version-related expectations
listed in [Open questions](#open-questions). Behaviour asserted by `tests/nested.test.ts`,
`tests/transitions.test.ts`, `tests/guards.test.ts`, `tests/actions.test.ts`,
`tests/inspection.test.ts`, `tests/concurrency.test.ts`, `tests/subscriptions.test.ts`,
`tests/isolation.test.ts`, `tests/regressions.test.ts`, `tests/runtime-fallbacks.test.ts` and
`tests/events.test.ts` is unchanged, and the run is the evidence for that.
