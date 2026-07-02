# Feature Status Ledger

This file tracks every user-facing feature that is NOT currently in a `solid`
state (statuses: `works-with-caveats`, `suspicious`, `half-baked`, `broken`,
`dead-pending-removal`). It exists so an agent touching a feature inherits the
known state instead of rediscovering it. Rule (see `CONTRIBUTING.md`): when a
change alters a feature listed here, update or delete its row in the same
commit. A feature that becomes solid loses its row — this ledger shrinks toward
empty; growth is a regression signal.

The full 355-row audit inventory behind this ledger (including solid rows and
per-domain reports with file:line evidence) is a local operator artifact from
the 2026-07-02 v0.14.1 audit; this public ledger carries the actionable subset.

> Seeded during the v0.15 stabilization program (Phase 1 populates the rows
> from the audit; later phases delete rows as fixes land). Until Phase 1 lands,
> the authoritative problem inventory is the v0.15 plan.
