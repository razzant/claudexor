# @claudexor/daemon

## 4.0.0

### Major Changes

- Move engine state to one SQLite store with addressed reads, resumable legacy import, generation-scoped recovery and explicit durability barriers. Require Node 24.15 or newer. Remove the implicit shared admission ceiling, preserve explicit global caps, and allow separate model and long-session caps in the existing queue. Preserve managed host bindings across plugin repair. Engine 4.0 requires desktop application 4.0; the updater keeps an older working engine until the app is updated. Legacy journals, run artifacts and accounts remain intact; the migrated format supports forward recovery, not downgrade to 3.x.

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/core@4.0.0
  - @claudexor/workspace@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/core@3.25.1
- @claudexor/journal@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1
- @claudexor/workspace@3.25.1

## 3.25.0

### Minor Changes

- Expose independently dated account resources and explicit Codex and Claude resets through the control API, CLI, MCP and native Accounts. Preserve original request identity through uncertain outcomes and keep provider results separate from resource refresh.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/workspace@3.25.0
  - @claudexor/journal@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/workspace@3.24.0
  - @claudexor/journal@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/core@3.23.2
- @claudexor/journal@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2
- @claudexor/workspace@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/core@3.23.1
- @claudexor/journal@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1
- @claudexor/workspace@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/core@3.23.0
- @claudexor/journal@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0
- @claudexor/workspace@3.23.0

## 3.22.1

### Patch Changes

- 902532e: Select retained commands by an explicit address before compact collection projection, preserving exact retry, HTTP run pages, continuation admission and uncapped cancellation. Remove the control API's whole-history self-RPC and make project activity checks synchronous with removal.

  Report daemon transport failures as retryable 503 problems while preserving typed refusal context and required actions; a thread turn whose enqueue answer was lost stays retryable and its retry reads the journal instead of enqueueing a duplicate. Untyped enqueue failures on POST /v2/runs now carry code internal_error instead of http_500. Refuse an admitted continuation whose source vanished before starting any harness work.

  Expose current and admission memory through authenticated GET /v2/daemon/status without changing the handshake. Publish engine heap launch arguments in the additive probe contract and apply them in the CLI and the macOS app launcher, honoring explicit NODE_OPTIONS. Resident journal-history growth and archive continuation remain outside this patch.

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/core@3.22.1
  - @claudexor/workspace@3.22.1
  - @claudexor/journal@3.22.1

## 3.22.0

### Minor Changes

- 51578d4: Continue a stopped run instead of restarting it: `POST /v2/runs {continueFrom: <runId>, continueCarrier?: "auto" | "packet"}` starts the next run of a continuation chain. Admission is one daemon-atomic rule shared by every ingress (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain `head`): the accepted successor command is the durable claim, so a predecessor has exactly one accepted successor, also across restarts and concurrent requests. Omitted mode, scope, execution, harness and model come from the predecessor, and the prompt is the caller's continuation text (it may be empty). The successor's first try is planned through the in-run continuation planner from the predecessor's session capsule and terminal facts — the same account resumes the vendor session by id, another account resumes the moved session, otherwise a fresh session is briefed with the evidence index — and is disclosed by a `run.continuity` receipt naming the predecessor and whether it runs in the same root. A stopped isolated Agent run now keeps its envelope (tree and scoped home, Claudexor-seeded auth removed) under a durable custody record until a successor adopts it, its result is applied or it is discarded; the crash sweep and disk retention keep it, and a run interrupted by a daemon restart with changes is kept the same way. `GET /v2/runs/:id` projects `resumable` (derived as `host_restart` for runs the daemon found running at its restart), the per-try `continuity` receipts, `retainedEnvelope` (disk use) and `continueFrom`; `continueFrom` is advertised in `runControlKeys`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/workspace@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/journal@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- a4ff572: Reconcile older quota refusals with newer account observations, preserve genuine credential rejections without duplicating poller state, and pace quota reads per affected account. Ordinary Accounts and account-catalog reads retain their first observation instead of repeatedly probing vendors. Discover Antigravity models for the selected account, forward explicitly requested unlisted models with disclosure, and preserve known quota-family applicability for new model IDs.
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/core@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/journal@3.21.0

## 3.20.1

### Patch Changes

- eb506c1: Keep account refusal and recovery evidence consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results. Preserve independently measured Claude Code and Codex quota windows from running sessions without treating partial observations as a complete refresh. Retain safe native refusal and refresh diagnostics.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/journal@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/journal@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/journal@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/journal@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Preserve native input-size refusals without account retries or unrelated quota resets, publish measured ASK input budgets, distinguish proven undelivered Codex model requests, and move large Claude and AGY inputs off process arguments.
- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/journal@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/journal@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- 951489f: `POST /v2/runs` and Exact Retry for a project root that was never registered now answer a typed `404 project_not_registered` (not retryable, with the remedy: register the root with `POST /v2/projects` or declare `scope.ephemeral`) instead of a retryable `503 idempotency_status_unavailable`.
- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/journal@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/journal@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/core@3.15.1
- @claudexor/journal@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/journal@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/journal@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/core@3.13.0
- @claudexor/journal@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/journal@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/journal@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/core@3.12.8
- @claudexor/journal@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/journal@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/core@3.12.6
- @claudexor/journal@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- State a served-model mismatch on a model operation as the typed `modelMismatch` result fact without changing its outcome, rank an account that recently answered a model's request with a different model after the other selectable accounts for later Auto selections (a 30-minute in-memory observation that never excludes an account, a pin or a preferred account), and send a turn the same account served with another model through its canonical content and tool calls instead of refusing the next request with `invalid_continuation`.
- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/journal@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/core@3.12.4
- @claudexor/journal@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/core@3.12.3
- @claudexor/journal@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/journal@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Reading ONE run no longer serializes every retained run. The daemon's retained-command list RPC takes an optional query addressing a single subject (one run id, or one parent's direct Delegate children) and selects before it redacts, so `GET /v2/runs/:id` stops recursively projecting the prompts of unrelated runs; the unqualified read and the global `GET /v2/runs` page are unchanged, and an engine older than the query answers in full so callers keep applying their own selection.
- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/journal@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Minor Changes

- 217d53f: The daemon stops writing dead history into its journal and forgets it on replay. Per-token harness deltas no longer reach the journal (the per-run event log and the live stream keep them), the journaled `run.created` carries the prompt's digest instead of its text, `command.updated` frames omit the immutable params, quota snapshots are journaled only when their evidence changes and the projection marker carries a digest, and the retained params of terminal commands are capped by a code constant. Every partition replays and compacts through the daemon's fold policy, so startup memory follows the retained state rather than the file (a resolved question and its request are forgotten together, so answering an already-resolved question after a restart reports `not_found` rather than `already_resolved` — both non-delivery statuses; within one process life `already_resolved` is unchanged); crash-GC reads project roots from the already prepared command projection instead of replaying the journal a second time, journaled run events are validated once per generation, and journal maintenance re-requests itself when the file crosses the threshold again while logging typed declines and `journal.records_retired` receipts. An engine from before this change refuses a served root loudly. A restart on an already-compacted partition no longer rewrites it to reclaim nothing, and the daemon reports its own memory (rss, heap, external) on the normal-admission line and on every maintenance receipt. Legacy `command.pruned` tombstones carry no run ids, so terminals of runs pruned before this release stay retained (none on the acceptance root); runs that never received a journaled terminal keep their pre-release progress frames until their command is pruned (then the tombstone's run_ids retire them — bounded by the 500 / 30-day / 256 MiB rule); two such runs hold about 3.1k `harness.event` frames on the acceptance root.

### Patch Changes

- Updated dependencies [217d53f]
- Updated dependencies [1b1476c]
  - @claudexor/schema@3.12.0
  - @claudexor/journal@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/journal@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/core@3.10.5
- @claudexor/journal@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/journal@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/core@3.10.3
- @claudexor/journal@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
- Updated dependencies
  - @claudexor/journal@3.10.2
  - @claudexor/schema@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/journal@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- dd518f0: Reduce journal startup work by selecting projection record types before copying payloads and validating run-event projections once during creation. Stop compression at the existing frame output limit while preserving full history, recovery checks, and compaction maintenance.
- Updated dependencies
- Updated dependencies [dd518f0]
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/journal@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/journal@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/core@3.9.7
- @claudexor/journal@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- 7e1269c: Background quota polling no longer lets one revoked, never-logged-in, or failing profile pin its vendor's healthy profiles to the 15-minute retry ceiling: a lane whose fresh evidence is about to expire renews on schedule even mid-ladder. The Claude OAuth source also remembers a proven vendor rejection per presented token and stops re-presenting it on background cycles — until the token changes, a login or profile change, an explicit refresh, or six hours, after which one remembered token is re-verified per cycle — so a rejected token reaches the vendor at most once per six hours instead of every cycle, removing the 401 storm behind the one-hour vendor 429 that blacked out every healthy sibling.
  - @claudexor/core@3.9.6
  - @claudexor/journal@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- 6e54444: Request background quota renewal on the last existing poll tick before primary evidence would become stale, while preserving current-time freshness and existing vendor pacing.
  - @claudexor/core@3.9.5
  - @claudexor/journal@3.9.5
  - @claudexor/schema@3.9.5
  - @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/core@3.9.4
- @claudexor/journal@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/journal@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/core@3.9.2
- @claudexor/journal@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/core@3.9.1
- @claudexor/journal@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/util@3.9.1

## 3.9.0

### Minor Changes

- 69500f8: Foreground quota refreshes (POST /v2/quota and the atomic Accounts snapshot) now honor each vendor's poll rate-limit cooldown: a vendor that recently answered 429 is served from last-known registry data instead of a fresh fan-out, disclosed additively as `refresh_skipped` rows on the quota response.
- e39c57b: Suppressed quota polls never fall silent: gap absences (rate_limited, probe_skipped_rate_limited, and the new derived poll_paced) coexist with stale snapshots and are silenced only by fresh ones, so downstream exhaustion readers stay fail-open while a vendor's poll pacing is cooling.
- 48ae659: Quota poll pacing is now per vendor lane: each vendor's refreshers own an independent completion-anchored backoff, a typed rate_limited absence arms a persisted vendor Retry-After floor in daemon-private pacer state (never the quota journal), and a daemon restart or credential change no longer resets the vendor cooldown into a 429 amplifier.

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/journal@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/core@3.8.4
- @claudexor/journal@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- Updated dependencies [16f0c27]
  - @claudexor/journal@3.8.3
  - @claudexor/core@3.8.3
  - @claudexor/schema@3.8.3
  - @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/core@3.8.2
- @claudexor/journal@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- 39dae8d: Run up to twelve regular daemon jobs concurrently before queueing additional work.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/journal@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/journal@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/core@3.7.0
- @claudexor/journal@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Minor Changes

- 895967f: Unified account model (INV-135 rewrite, owner-approved). Every account is a
  named registry row — the separate "default"/"CLI login" account type is gone.
  A detected legacy claude/codex default-store login auto-registers at daemon
  start as the ordinary `<harness>-default` row through a crash-recoverable
  migration (typed per-harness run refusal while incomplete; rollback command
  as the supported downgrade path). Unpinned runs route through a quota-aware
  pool of enabled+ready rows with sticky, disclosed thread bindings; explicit
  pins are strict (typed `subscription_window_exhausted` refusal, no silent
  rotation); pool exhaustion is a typed `credential_pool_exhausted` terminal
  carrying the pool's earliest known reset, and the paid API-key route serves
  it only under the explicit `api_key` preference — never silently under
  `auto` (owner Q3=A). New wire: additive `accountPools` pool
  authority plus `GET /v2/account-pools` (the feature marker) and
  `POST /v2/accounts-migration/rollback`; `harnessAccounts` stays on the wire
  as `[]` for legacy strict clients. Cursor host-Keychain logins are retired:
  every cursor account lives in an isolated vendor file-store row, and
  `auth login` becomes bootstrap sugar into the `<harness>-default` row.
  Deleting a row is provable (typed retryable error on partial cleanup) and
  retires migrated legacy aliases in the same operation.

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/journal@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/journal@3.5.0
  - @claudexor/schema@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/core@3.4.2
- @claudexor/journal@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/core@3.4.1
- @claudexor/journal@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/core@3.4.0
- @claudexor/journal@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/core@3.3.16
- @claudexor/journal@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/core@3.3.15
- @claudexor/journal@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/core@3.3.14
- @claudexor/journal@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/core@3.3.13
- @claudexor/journal@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/core@3.3.12
- @claudexor/journal@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/core@3.3.0
- @claudexor/journal@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- Persist independent model-scoped Claude cooldown windows, pruning expired scoped siblings without staling an active family.
- @claudexor/core@3.2.1
- @claudexor/journal@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Add an internal atomic runtime-replacement stop that refuses queued, running,
  or indeterminate activity without fencing the live daemon.
- Support finite-or-disabled interaction waits and preserve profile readiness, settlement, refused-turn context, and retry truth across restart and projection reload.
- @claudexor/core@3.2.0
- @claudexor/journal@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/journal@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/journal@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/journal@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/core@3.0.3
- @claudexor/journal@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/core@3.0.0
- @claudexor/journal@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/core@2.1.3
- @claudexor/journal@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/core@2.1.2
- @claudexor/journal@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/core@2.1.1
- @claudexor/journal@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/util@2.1.1

## 2.1.0

### Minor Changes

- Claudexor 2.1.0: credential profiles (INV-135). Multiple subscriptions per
  harness with isolated vendor config dirs and namespaced secret slots; strict
  per-turn / thread-sticky selection with profile-isolated native-session
  resume; per-profile doctor probes and proactive per-profile subscription
  quota from the vendor oauth/usage endpoint; one typed profile policy per
  harness with provenance-recorded rotation on typed vendor-limit evidence
  only. Includes the unpublished 2.0.1 honest-engine and 2.0.2 simple-UI
  passes.

### Patch Changes

- 0fc050b: Credential profiles (INV-135): durable non-secret `credential_profiles`
  registry in the global config; the orchestrator resolves an explicit per-run
  profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
  consume exactly the profile's transport (claude config-dir login / non-bare
  token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
  raw-api secret-ref keys) or refuse typed — never a fallback to default
  credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
  doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
  `claudexor profiles login`, profile-stamped route evidence, and
  profile-isolated native-session resume.
- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/journal@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/core@2.0.2
- @claudexor/journal@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/core@2.0.1
- @claudexor/journal@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/journal@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
