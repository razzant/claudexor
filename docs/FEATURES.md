# Feature Status Ledger

This file tracks every user-facing feature that is NOT currently in a `solid`
state (statuses: `works-with-caveats`, `suspicious`, `half-baked`, `broken`,
`dead-pending-removal`). It exists so an agent touching a feature inherits the
known state instead of rediscovering it. Rule (see `CONTRIBUTING.md`): when a
change alters a feature listed here, update or delete its row in the same
commit. A feature that becomes solid loses its row — this ledger shrinks toward
empty; growth is a regression signal.

> Status: seeded during the v0.15 stabilization program. No public rows are
> published yet — Phase 1 of that program populates this table from a full
> repository audit, and later phases delete rows as fixes land. Until rows
> exist here, treat features conservatively: verify current behavior against
> code and tests rather than assuming any non-documented feature is solid.
