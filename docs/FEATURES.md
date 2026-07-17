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

Rows: **2** (works-with-caveats: 2)

| Area | Feature | Status | What is wrong / caveat | Evidence | Planned |
|---|---|---|---|---|---|
| engine/profiles | Profile-policy `limit_action: ask` interactive UX (2.1) | works-with-caveats | The engine records the typed `route.profile.headroom_exceeded` breach and PROCEEDS on the selected profile — no surface actually asks the user yet (the router consumer shipped first, sol #28) | packages/orchestrator/src/credential-profiles.ts preflightCredentialProfile (`ask` falls through to proceed) | backlog |
| control-api/threads | Thread-scoped POST /runs preflight ordering | works-with-caveats | run-start preflights BEFORE the thread turn exists, so a preflight refusal on that surface leaves no turn record with an enqueue_error — unlike POST /threads/:id/turns, which creates the turn first (W19/INV-093). The CLI shows the refusal directly, so nothing is silent; the two surfaces just disagree on turn persistence (round-18 scope advisory) | packages/control-api/src/run-start.ts handleRunCreate vs thread-turn-routes.ts | backlog |

New rows are added the moment a non-solid feature ships (see the rule above).
Deliberate design boundaries that used to live here as "caveats" are
documented in the "Design constraints" sections of `docs/ARCHITECTURE.md`
(engine) and `docs/INTEGRATIONS.md` (host/external surfaces).
