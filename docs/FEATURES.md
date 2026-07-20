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

Rows: **5** (works-with-caveats: 5)

| Area | Feature | Status | What is wrong / caveat | Evidence | Planned |
|---|---|---|---|---|---|
| macos/accounts | Account-row subscription email/plan identity line (deferred to 3.1) | works-with-caveats | The accounts surface shows each account's name, readiness, and quota but NOT the vendor login email or plan. The 3.0.0 batch-6 attempt read the vendor credential stores app-side (`~/.codex/auth.json`, `~/.claude/.claude.json`, including a bare-home fallback) — removed as an INV-067/INV-002 violation: a thin macOS surface must never parse token-bearing vendor files, and a native-login row (nil isolation_locator) also misattributed another store's identity as Claudexor's login. The honest version needs a daemon-side NON-SECRET identity projection (doctor/status, allowlisted email/plan fields), not an app-side file read | apps/macos/ClaudexorApp/Sources/ClaudexorApp/AccountsPresentation.swift `rows()` (no email/plan detail); VendorIdentityLoader deleted in the wave-2 batch | 3.1 |
| macos/updater | Engine-runtime auto-install (3.0 is check-only; auto-install deferred to 3.1 per D1) | works-with-caveats | 3.0 ships the update CHECK only (owner-locked D1). The app reads the release runtime manifest and, when a newer engine is published, surfaces an informational "Update available → vX.Y.Z" chip that links to the GitHub release for a MANUAL download; there is no in-app install. The one-click auto-install (download → sha256-verify → unpack → stop the idle daemon → atomic pointer swap → handshake-verify → rollback) is deferred to 3.1 because it signals a running daemon process — an idle-check/recycled-pid/rollback hazard flagged across three review waves — so it ships whole and reviewed in 3.1, never half-wired in 3.0. The release pipeline (closure tarball + `runtime-manifest.json`), `claudexor release check`/`release stats`, and the `current.json` pointer READ used by `DaemonLauncher` all stay, forward-compatible with the 3.1 installer | apps/macos/ClaudexorApp/Sources/ClaudexorApp/RuntimeUpdater.swift (`check()` only, no install method); AccountsPopover.swift `UpdateChip` (links to the release, no in-app install) | 3.1 |
| engine/profiles | Profile-policy `limit_action: ask` interactive UX (2.1) | works-with-caveats | The engine records the typed `route.profile.headroom_exceeded` breach and PROCEEDS on the selected profile — no surface actually asks the user yet (the router consumer shipped first, sol #28) | packages/orchestrator/src/credential-profiles.ts preflightCredentialProfile (`ask` falls through to proceed) | backlog |
| macos+cursor | Cursor-harness manual QA phases (v3.0.0) | works-with-caveats | The v3.0.0 release verified cursor through the automated battery + typed-refusal canaries only; the interactive manual-QA phases (live cursor plan/agent runs driven from the app) were waived by owner decision for this release and ride the next dogfood pass | docs/CHECKLISTS.md release protocol (manual-QA waiver rule); real-harness-battery cursor rows | backlog |
| acp/interactions | ACP free-text mid-run questions (v3.0.0) | works-with-caveats | ACP's permission mechanism is choice-only, so an option-less (free-text) mid-run question cannot be answered inside the editor; the surface never silently skips it — it is disclosed as turn text naming the remedy and the run stays paused until answered via `claudexor follow <run>` or `POST /v2/runs/:id/interactions/:id/answer`. Choice and multi-select questions ARE answered inline (multi-select via per-option include/skip rounds) | packages/acp-server/src/index.ts requestAnswers; packages/acp-server/src/acp.test.ts (option-less turn-text + multi-select) | backlog |

New rows are added the moment a non-solid feature ships (see the rule above).
Deliberate design boundaries that used to live here as "caveats" are
documented in the "Design constraints" sections of `docs/ARCHITECTURE.md`
(engine) and `docs/INTEGRATIONS.md` (host/external surfaces).
