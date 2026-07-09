# Feature Status Ledger

This file tracks every user-facing feature that is NOT currently in a `solid`
state. It exists so an agent touching a feature inherits the known state
instead of rediscovering it. Rule (see `CONTRIBUTING.md`): when a change
alters a feature listed here, update or delete its row in the same commit. A
feature that becomes solid loses its row — this ledger shrinks toward empty;
growth is a regression signal.

Statuses: `broken` > `dead` (wired to nothing) > `half-baked` > `suspicious` >
`works-with-caveats`. `Planned` names the stabilization-program phase that
owns the fix (`backlog` = not yet scheduled). Evidence is file:line at the
time of the audit; lines drift with edits — verify before relying on them.

Rows: **0**

The ledger is EMPTY — no known half-baked or caveated features. New rows are
added the moment a non-solid feature ships (see the rule above). Deliberate
design boundaries that used to live here as "caveats" are documented in the
"Design constraints" sections of `docs/ARCHITECTURE.md` (engine) and
`docs/INTEGRATIONS.md` (host/external surfaces).
