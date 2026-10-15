# Changelog

## Unreleased

### Breaking changes

- Add typed payload event objects and derive nested state path types recursively. Payload-free
  events continue to accept their string shorthand.
- Add parallel states (`type: "parallel"`) and history pseudo-states (`type: "history"`), and move
  snapshots to format version 2. A snapshot now carries `configuration`, the ordered list of active
  atomic state paths, and `history`, the configuration remembered per history pseudo-state, and
  `schemaVersion` defaults to `2`. `restore()` still accepts 0.1.0 snapshots, which carry no
  `configuration`, by migrating them with the exported `migrateSnapshotV1ToV2`. A snapshot whose
  version is neither 1 nor the machine's own rejects with `UnsupportedSnapshotVersionError`, which
  carries a stable `code` and the `receivedVersion`.
- A transition declared without `target` is no longer a self-transition. SCXML gives a targetless
  transition an empty exit set and an empty entry set, so from this release its guard and actions
  run while nothing is exited or entered and the configuration is unchanged. Reacting to an event
  without resetting a subtree is now expressed by omitting `target`; changing state is expressed by
  naming it, including for a self-transition (`RESET: { target: "editing" }`), which still exits and
  re-enters the state and everything below it.
- A machine definition that declares a top-level `on` map is now rejected by `createMachine()` with
  `UnsupportedDefinitionKeyError` (`code`: `ERR_UNSUPPORTED_DEFINITION_KEY`) instead of being
  ignored. Previously such a definition created a machine that silently never reacted to those
  events, because transitions belong to the states that declare them and a machine has no state of
  its own. Move the map onto the state that should react.

### Added

- `type: "parallel"` states: every child is a region and all of them are active at once, each
  selecting its own transition for an event, with SCXML conflict resolution and document-order
  priority.
- `type: "history"` pseudo-states with `history: "shallow" | "deep"` and an optional default
  `target`, recorded when the parent state is exited and serialized with the snapshot.
- `Machine.configuration` and `snapshot().configuration`, the authoritative view of the active
  configuration, which is the only field that can express a parallel state.
- `UnsupportedSnapshotVersionError` and `UnsupportedTransitionTypeError`, both subclasses of the
  existing error for their category.
- `UnsupportedDefinitionKeyError` for a definition that declares a field the machine does not own.
- `UnsupportedTransitionTypeError.code` and `UnsupportedSnapshotVersionError.code` join the new
  `UnsupportedDefinitionKeyError.code`, so all three can be handled without matching message text.
- `migrateSnapshotV1ToV2`, exported so stored data can be upgraded ahead of a restore.

### Fixed

- A parallel sibling region is no longer reset to its default entry when only the other region
  transitions, which previously produced an illegal configuration with two active children of one
  compound state.

### Changed

- A transition definition that declares `type` is rejected at creation, because only external
  transitions are implemented and `internal` would otherwise be read as `external`. The field is
  reserved, so adding internal transitions later stays a non-breaking change.
- `done`, `matches()`, `getNextEvents()` and `state` are computed from the whole configuration
  rather than from a single active leaf, which preserves their 0.1.0 behaviour for a machine with no
  parallel state.
