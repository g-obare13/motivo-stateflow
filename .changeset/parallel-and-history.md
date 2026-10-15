---
"motivo-stateflow": major
---

Add parallel states (`type: "parallel"`) whose regions are all active at once, and history
pseudo-states (`type: "history"`) that remember their parent's configuration shallowly or deeply.
Snapshots move to format version 2, carrying `configuration` and `history`, and 0.1.0 snapshots are
migrated by `restore()` through the exported `migrateSnapshotV1ToV2`. A transition declared without
`target` is no longer a self-transition: following SCXML it has an empty exit set and an empty entry
set, so its guard and actions run while nothing is exited or entered.
