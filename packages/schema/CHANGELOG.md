# @claudexor/schema

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/util@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/util@3.25.1

## 3.25.0

### Minor Changes

- Expose independently dated account resources and explicit Codex and Claude resets through the control API, CLI, MCP and native Accounts. Preserve original request identity through uncertain outcomes and keep provider results separate from resource refresh.

### Patch Changes

- @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- 902532e: Select retained commands by an explicit address before compact collection projection, preserving exact retry, HTTP run pages, continuation admission and uncapped cancellation. Remove the control API's whole-history self-RPC and make project activity checks synchronous with removal.

  Report daemon transport failures as retryable 503 problems while preserving typed refusal context and required actions; a thread turn whose enqueue answer was lost stays retryable and its retry reads the journal instead of enqueueing a duplicate. Untyped enqueue failures on POST /v2/runs now carry code internal_error instead of http_500. Refuse an admitted continuation whose source vanished before starting any harness work.

  Expose current and admission memory through authenticated GET /v2/daemon/status without changing the handshake. Publish engine heap launch arguments in the additive probe contract and apply them in the CLI and the macOS app launcher, honoring explicit NODE_OPTIONS. Resident journal-history growth and archive continuation remain outside this patch.

- Updated dependencies [902532e]
  - @claudexor/util@3.22.1

## 3.22.0

### Minor Changes

- 51578d4: Continue a stopped run instead of restarting it: `POST /v2/runs {continueFrom: <runId>, continueCarrier?: "auto" | "packet"}` starts the next run of a continuation chain. Admission is one daemon-atomic rule shared by every ingress (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain `head`): the accepted successor command is the durable claim, so a predecessor has exactly one accepted successor, also across restarts and concurrent requests. Omitted mode, scope, execution, harness and model come from the predecessor, and the prompt is the caller's continuation text (it may be empty). The successor's first try is planned through the in-run continuation planner from the predecessor's session capsule and terminal facts — the same account resumes the vendor session by id, another account resumes the moved session, otherwise a fresh session is briefed with the evidence index — and is disclosed by a `run.continuity` receipt naming the predecessor and whether it runs in the same root. A stopped isolated Agent run now keeps its envelope (tree and scoped home, Claudexor-seeded auth removed) under a durable custody record until a successor adopts it, its result is applied or it is discarded; the crash sweep and disk retention keep it, and a run interrupted by a daemon restart with changes is kept the same way. `GET /v2/runs/:id` projects `resumable` (derived as `host_restart` for runs the daemon found running at its restart), the per-try `continuity` receipts, `retainedEnvelope` (disk use) and `continueFrom`; `continueFrom` is advertised in `runControlKeys`.
- 785bba7: Automatic continuation inside one attempt ("auto-rotation inside the work"). After a try that acted, a typed vendor limit hops the attempt to the next eligible account and the next process continues the same work: the claude/codex session file is moved into the target account's store and resumed there (`native_moved`), or — when it cannot be moved — a fresh session is re-grounded by a mechanical evidence index (`packet`); a transport death resumes the same session on the same account (`native`), bounded by `transient_retry.max_retries` per account. A partially acted attempt never replays its original prompt; the continued process receives one constant notice instead. Pinned accounts, `fail`/`ask` policies and a spent pool end typed. Every continued try settles with a `run.continuity` receipt (carrier, cause, accounts, memory, this try's attested model, identity check, input delivery) and every terminal whose work is unfinished carries `resumable` (cause, reset, carriers, native session, workspace) on the terminal event and in `final/resumable.yaml`. Adapters gain an optional `continuity` capability (`locate` / `move` / `rejectsCarriedState`); codex compares the recovered thread id before `turn/start`. The engine compares a resumed session's id with the requested one only on adapters with that capability (Claude Code and Codex keep the id on resume); other harnesses record a new id after a resume as before. A process that dies after it acted without ever reporting a session id continues on the same account with a packet re-brief, bounded by `transient_retry.max_retries`. Schema: `SessionCapsule`, `RunResumable`, `RunContinuityReceipt`; `RunEventType` gains `run.continuity`.

### Patch Changes

- @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 7c541ba: One effort word now works on Cursor and Antigravity too, where the level is a token of the compound model id. Given an effort preference, the adapter's preparation selects the listed level variant of the requested model's family from the inventory of the account that will run (`grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh`; `gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`): the family is the id with exactly one shared-order level token removed, `fast` and `thinking` stay in the family key so the choice never crosses fast/standard or thinking/no-thinking, a family exists only when the account lists two or more levels, and the level is placed by the shared preference order alone. One preparation yields the final id (the processing receipt's `submittedNative`, which is the `--model` argument) and the effort receipt (`parameter: --model`, `submitted` = level token), recorded once per spawn and per reviewer dispatch; the requested id stays in the model hint and in `attempts[].requested_model`. Nothing new refuses: an unknown word, an ambiguous id, a family-less id or an empty account list keep the id unchanged with an `omitted` receipt and a note. Antigravity rewrites only from the pinned account's live `agy models` list; the static hint list never authorizes a rewrite. Settings writes accept the preference for these routes, the existing fast-pair and paid policy run after the level choice, and the final telemetry `model_mismatch` compares the observation with the id actually sent.
- f0ab916: Make one effort word work on every route. The vendor's own order still ranks every level it lists; the shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) now places a word a route's ladder does not list, so `ultra` on a Claude binary that stops at `max` resolves downward to `max` and `none`/`minimal` resolve to the known minimum instead of refusing the run. The receipt names that placement and claims neither vendor support nor equal quality across vendors. One resolution result feeds the native flag, the typed receipt and the disclosure on Claude, Codex (sessions and raw model calls) and the ACP client, which now resolves `--effort` through the same resolver and records a receipt. A reviewer whose harness declares no effort controls keeps the preference as omitted with disclosure instead of failing the explicit panel or erasing the automatic panel's request. A word neither order knows is still refused before generation on routes that have a native effort knob.
- 83bc0da: On routes where the WorkReport footer is only requested (Cursor, Antigravity, ACP), a missing or broken footer no longer fails the run: the run succeeds with `work_state.state: unverified`, a typed `unverified_reason`, and the complete answer text kept with nothing cut: a trailing JSON or code block that is not the footer stays, and so does a broken footer attempt. Valid `needs_input`/`incomplete` reports still veto, and the native Codex/Claude envelopes stay strict.
- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).
- a4ff572: Reconcile older quota refusals with newer account observations, preserve genuine credential rejections without duplicating poller state, and pace quota reads per affected account. Ordinary Accounts and account-catalog reads retain their first observation instead of repeatedly probing vendors. Discover Antigravity models for the selected account, forward explicitly requested unlisted models with disclosure, and preserve known quota-family applicability for new model IDs.
- Updated dependencies [9ccd45d]
  - @claudexor/util@3.21.0

## 3.20.1

### Patch Changes

- eb506c1: Keep account refusal and recovery evidence consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results. Preserve independently measured Claude Code and Codex quota windows from running sessions without treating partial observations as a complete refresh. Retain safe native refusal and refresh diagnostics.
- dc30eda: Complete managed CLI and remote sign-in flows, preserve actionable Claude CLI version failures, and resolve native and standard npm Node entrypoints consistently across launch, probes and login.
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/util@3.20.0

## 3.19.0

### Patch Changes

- Claudexor ships as portable Claude Code and Cursor packages (`plugins/claude`, `plugins/cursor`) that carry the canonical Skill and the MCP server registration (no runtime, credentials, hooks or status-line collector; those stay with the managed `claudexor plugin install` integration), and the canonical Skill plus the managed-integration text describe `claudexor_accounts` truthfully (the plain call returns the cached listing; `fresh: true` is the expensive atomic snapshot). Production dependencies move to @agentclientprotocol/sdk 1.5.1, @modelcontextprotocol/server 2.2.0, @playwright/mcp 0.0.83, zod 4.6.5 and yaml 2.9.1; the release SBOM test reads the packaged Browser MCP version from packages/core instead of a literal.
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Adapt Codex raw-model Ultra preferences to the strongest supported generation effort in the vendor order, preserve explicit effort evidence, and keep native Ultra delegation unchanged (#368).

- Preserve native input-size refusals without account retries or unrelated quota resets, publish measured ASK input budgets, distinguish proven undelivered Codex model requests, and move large Claude and AGY inputs off process arguments.
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- 951489f: `POST /v2/runs` and Exact Retry for a project root that was never registered now answer a typed `404 project_not_registered` (not retryable, with the remedy: register the root with `POST /v2/projects` or declare `scope.ephemeral`) instead of a retryable `503 idempotency_status_unavailable`.
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- @claudexor/util@3.15.0

## 3.14.0

### Minor Changes

- fb42a94: Model admission is the harness's own declaration, honoured on every list it owns.

  `model_inventory_absence` used to govern only a live `models()` answer; every manifest hint list stayed strict by construction, so a settings write, the doctor's configured-model check and the explicit reviewer panel refused any id the shipped list lacked (and `claudexor models` could show nothing beyond that list), so a new vendor model needed a Claudexor release to become usable through them (#338, #340). `validateModel` now takes the list, its source and the declaration with no defaults; the manifest branches of the run gate and the reviewer panel read the declaration; one registry gate (`checkHarnessModel`) replaces the four hand-built copies in the settings write, doctor readiness and the capability catalog.

  Claude, Codex and Cursor declare `advisory` (cursor gains the declaration here; claude's producer lands beside it): their lists prove presence, never absence, so an unlisted explicit model is persisted or forwarded byte-identical and the vendor decides. Each admitting consumer says so once: the settings read-back carries server-owned `notes` (the CLI prints them), the readiness row carries the note in its detail (the text `doctor` prints it too), the per-spawn gate keeps its status event; the agent capability catalog's `configuredModelValid` stays a boolean that reports such an admission as valid without the note (its description says so). raw-api, agy and opencode stay authoritative; the automatic reviewer panel keeps skipping an unlisted family at zero cost; HTTP model operations stay strict against the account catalog read at a named client version. Refusals state observations (which account supplied which list, how many models) instead of guessing a cause such as re-authentication.

  Invariants: INV-104 amended with the owner's approval of 2026-09-24 (CONCEPT-CHANGE): absence is a per-harness declaration honoured on live and manifest lists alike; the settings-write-strict canary moves to agy and `[INV-104:settings-write-advisory]` pins the codex path. INV-105 unchanged (the per-spawn disclosure stays). INV-020/INV-022 hold: `notes` has a producer (the settings write) and readers (the CLI, the canary).

### Patch Changes

- 2c024ac: Claude models are discovered from the installed binary instead of a shipped list (#338, #340).

  The claude adapter gains a live `models()`: the prompt-free `initialize` handshake of the installed `claude` binary (one stdin frame, exit on EOF, never `--model`, `--setting-sources ""`, `--strict-mcp-config`, model-override env scrubbed) answers the picker's selectors with their vendor-reported resolutions; the rows travel as `origin: live` with `resolved_model`, followed by the frozen `CLAUDE_KNOWN_MODELS` ids as `origin: hint` so presence never shrinks below the manifest. A `config_dir_login` profile is probed under its own config dir and keychain bridge, an `api_key`/`oauth_token` profile with its own credential in the env var its runs use under a scratch HOME (the account's own rows in `?view=accounts`, cache keyed by profile id, never by a secret); the unscoped listing is a credential-free binary probe under a scratch HOME with non-essential traffic off. The answer is total: a missing or failing binary yields the hint rows and the registry reports `source: manifest` with the frozen `verifiedAgainst` stamp rather than a live claim. One cached single-flight capture per (scope, binary identity) lives an hour (a minute for failures); `harnessBinaryIdentity` in core keys it and the `--help` effort memo by realpath, inode, size and mtime, so an in-place CLI update is re-read without a daemon restart; a run whose env patch carries a PATH has its effort ladder, readonly flag set and `--version` read from the binary that PATH selects. The manifest declares `model_inventory_absence: "advisory"` and freezes `known_models_verified_against` at the literal 2.1.261. `HarnessModel` gains optional `origin` and `resolved_model` (absent = live; producers that predate the field need no change); `claudexor models` prints resolutions and hint marks.

  Invariants: INV-104 governs the declaration (amended in the sibling commit); INV-020/INV-022 hold (both new fields have a producer and readers).

- 7e615b6: The Codex HTTP model transport declares its own verified client version when it reads an account's model catalog, instead of the managed-installer pin.

  The Codex backend filters `GET /backend-api/codex/models` by the `client_version` the caller declares: a model is listed only for clients at or above that model's minimum version. Claudexor's raw model transport sent the installer pin (`CODEX_VENDOR_CLI_VERSION`, 0.153.3), so a newly floored model such as `gpt-6-sol` was absent from the catalog and refused as `model_unavailable`, while the same account and the same request shape generated with it (issue #339). A release that only moved the installer therefore decided which models an account could see through this route.

  `CODEX_HTTP_CLIENT_VERSION` (0.156.1) is the version this release's catalog parser and Responses projection were verified against; it is raised to the installed Codex CLI's version when that is newer, never lowered, and an unparseable version falls back to the constant because the parameter is required. The value is memoised per binary identity, so an in-place CLI upgrade is seen on the next catalog read. The negotiated account view (`?view=accounts`) carries `clientVersion` and `clientVersionSource` per catalog (`verified_transport` or `installed_cli`; null for catalogs from an older engine) while the legacy `GET /model-sources/:id/models` keeps its pre-existing shape, and both membership refusals — account selection and invocation — name the declared version so a miss is not read as an account or login problem. The catalog stays strict: its rows are the request contract (efforts, service tiers, windows). A recorded fixture pair (`fixtures/models-http-0.153.3.json`, `models-http-0.156.1.json`) pins that every row present at both versions is identical and only `gpt-6-sol`/`gpt-6-luna` were added, with the default unchanged; bumping the constant re-records the pair.

  Invariants: INV-104 is unchanged (HTTP model operations stay strict against the account catalog, now read at a named client version). INV-020/INV-022 hold: the two schema fields are produced by the transport, read by both membership refusals (`describeCodexClientVersion`) and returned on the account-view wire. The managed installer pin keeps its two other meanings (install target, fixture/effort-snapshot stamp).
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- A run's failure record carries the vendor's own failure code beside its words.

  When a Codex turn fails, `codex exec --json` delivers only the vendor's sentence, while Codex's own rollout record of the same thread keeps a machine-readable code (a capacity refusal is `server_overloaded`). Claudexor labelled such a run a process crash, advised that the harness process crashed, and reported the configured retry ceiling as if two retries had run.

  `RunFailure` gains one optional, nullable object, `vendorFailure: { code, message, source }`: the vendor's code and words, read fail-soft from the rollout after the process exited, bound to the current turn, `null` on any doubt and for every harness without such a channel. The code is opaque evidence: nothing in Claudexor branches on its value, and it is not a member of `RunFailureCode`.

  The shared run loop records a typed terminal fact, `harness_reported_error`, only when the harness's own stdout frames produced an error event. A harness that voiced its own error and then exited non-zero is classified `unknown_harness_error` with an explicit `retryable: false` instead of `process_crash`; a signal kill, a spawn failure and a silent non-zero exit keep their labels. Retry, rotation, cooldown and credential condemnation read exactly the inputs they read before. `route.transient.exhausted` reports the observed retries beside the configured maximum.

  Invariants: none amended. INV-013, INV-046 and INV-049 hold (typed adapter evidence, no prose governance); INV-104's disclosed residual stays literally true, and the new field is additive evidence beside it. INV-020 and INV-022 hold: the schema field ships with its producer (the Codex adapter and the terminal writers) and its consumers (the failure record and the CLI inspect line). The app compatibility floor is unchanged.
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- 125aea9: A Codex model list that omits a model no longer refuses a run that asks for it.

  The vendor CLI fetches its model list remotely and falls back to a bundled default list when that fetch times out, and nothing on the wire says which list answered. Claudexor treated the answer as account truth, so an explicit model the list lacked was refused before dispatch, in under a second, as an untyped failure. Observed live: `gpt-6-astra` was refused 32 times over two days on thirteen accounts that ran it successfully 262 times in the same window, and an empty answer refused the same way.

  A harness now declares what its live inventory proves. The new optional manifest capability `model_inventory_absence` defaults to `authoritative`, which is today's strict behaviour for every harness; Codex declares `advisory`, because its list can prove a model is present but never that one is absent. On an advisory source a missing (or empty) list stops being a refusal: the explicit model is forwarded to the vendor exactly as asked, the vendor accepts or refuses it, and the per-spawn gate discloses once, in the run's events, that the model was not listed. The same decision now serves the explicit reviewer panel, so an owner-chosen reviewer model is no longer refused by a stale list either.

  Nothing else moved. Manifest truth stays strict and is never substituted to admit a model, settings writes and the doctor's configured-model check still read the manifest and still refuse, automatic reviewer selection still skips an unlisted family at zero cost, authenticated account catalog operations still return a typed `model_unavailable`, pinned accounts still never rotate, and the probe cache and its TTL are unchanged.

  Three consequences are worth stating plainly. The explicit reviewer panel forwards an unlisted model without the run-event disclosure, because a reviewer spawn does not pass through the per-spawn gate. A vendor CLI that refuses a forwarded model reports it as an ordinary error carrying the vendor's own text, not as a typed model failure (only the HTTP model operations are typed, and those stay strict). And a mistyped model name on such a harness now costs one spawn at the vendor instead of failing for free at the gate.

  Invariants: INV-104 is amended with the owner's explicit approval of 2026-09-21 — strict wherever the truth source can prove absence, forward and disclose where it cannot, and never substitute one list for another. INV-105 follows from it: an explicit model can now reach a route its truth source could not vouch for, and the run discloses that instead of staying silent. INV-020 (schema first, regenerate, then consumers) and INV-022 (a field ships with its producer and consumer) hold: the capability is declared by the Codex manifest and read by the model gate and the reviewer panel in this change. The app compatibility floor is unchanged.
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Restore adapter-created nulls for optional review fields before original-schema validation, preserving the caller contract and substantive findings. Codex Responses failure evidence now records monotonic chunk timing and deterministic interrupted-stream diagnostics without adding automatic retries.
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- State a served-model mismatch on a model operation as the typed `modelMismatch` result fact without changing its outcome, rank an account that recently answered a model's request with a different model after the other selectable accounts for later Auto selections (a 30-minute in-memory observation that never excludes an account, a pin or a preferred account), and send a turn the same account served with another model through its canonical content and tool calls instead of refusing the next request with `invalid_continuation`.
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Keep accounts eligible by default until their quota reaches 100% usage instead of reserving the final 10%. Explicitly configured thresholds remain effective.
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Reading ONE run no longer serializes every retained run. The daemon's retained-command list RPC takes an optional query addressing a single subject (one run id, or one parent's direct Delegate children) and selects before it redacts, so `GET /v2/runs/:id` stops recursively projecting the prompts of unrelated runs; the unqualified read and the global `GET /v2/runs` page are unchanged, and an engine older than the query answers in full so callers keep applying their own selection.
  - @claudexor/util@3.12.1

## 3.12.0

### Minor Changes

- 217d53f: The daemon stops writing dead history into its journal and forgets it on replay. Per-token harness deltas no longer reach the journal (the per-run event log and the live stream keep them), the journaled `run.created` carries the prompt's digest instead of its text, `command.updated` frames omit the immutable params, quota snapshots are journaled only when their evidence changes and the projection marker carries a digest, and the retained params of terminal commands are capped by a code constant. Every partition replays and compacts through the daemon's fold policy, so startup memory follows the retained state rather than the file (a resolved question and its request are forgotten together, so answering an already-resolved question after a restart reports `not_found` rather than `already_resolved` — both non-delivery statuses; within one process life `already_resolved` is unchanged); crash-GC reads project roots from the already prepared command projection instead of replaying the journal a second time, journaled run events are validated once per generation, and journal maintenance re-requests itself when the file crosses the threshold again while logging typed declines and `journal.records_retired` receipts. An engine from before this change refuses a served root loudly. A restart on an already-compacted partition no longer rewrites it to reclaim nothing, and the daemon reports its own memory (rss, heap, external) on the normal-admission line and on every maintenance receipt. Legacy `command.pruned` tombstones carry no run ids, so terminals of runs pruned before this release stay retained (none on the acceptance root); runs that never received a journaled terminal keep their pre-release progress frames until their command is pruned (then the tombstone's run_ids retire them — bounded by the 500 / 30-day / 256 MiB rule); two such runs hold about 3.1k `harness.event` frames on the acceptance root.

### Patch Changes

- @claudexor/util@3.12.0

## 3.11.0

### Minor Changes

- Add advisory Standard, Fast and Economy processing with exact native precedence, account-scoped catalogs and honest observed service and cost evidence. Support ordinary folders through direct work or complete selected copies, retained binary file results, conflict-aware application and explicit discard.

### Patch Changes

- @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Codex model operations carry the caller's live `x-codex-turn-state` transport continuation on the existing route-bound opaque envelope (opt-in per request, first successful header captured before the body, replayed unchanged on the matching route, empty on a changed route). Attempt telemetry, run telemetry and run summaries gain an additive normalized `input_token_usage` / `inputTokenUsage` object (complete input total, cache reads, cache writes; null stays unknown) folded strictly across contributions; legacy token fields keep their harness-specific meanings.
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Keep Antigravity model and quota checks non-interactive by closing piped input instead of using a null device. Preserve ambiguous authentication timeouts as probe failures and expose failed refreshes alongside stale quota data.
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Make internal model review opt-in for ordinary Agent work, independently of executor selection. Preserve explicit panels, Best-of, and requested review cycles; persist intent separately from results and retain historical behavior on replay. Deliberately unreviewed changes remain normally applicable with honest Not reviewed status while required checks and patch integrity remain enforced. Expose the same choice through API, CLI, MCP, ACP, and the native composer.
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Preserve typed text-fragment metadata in delegated run timelines so hosts can join streamed words and whitespace without inserting event separators. Keep complete messages, tool events, final answers, and omission disclosures distinct.

  Allow release review by any two distinct approved model families on any harness, recording the actual model and harness while retaining exact-candidate evidence, independent reports, and signed attestation checks.
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/util@3.9.1

## 3.9.0

### Minor Changes

- d9cccac: The cursor adapter can now host the delegation belt: engine-owned MCP servers are injected by reconciling `mcp.json` inside the Claudexor-owned lane `CURSOR_CONFIG_DIR` (sidecar-manifest reconcile; the host `~/.cursor` is never written; stale managed entries are removed on non-delegate runs) with `--approve-mcps`, and `capability_profile.mcp_injection` is declared true. The owner-set live delegated E2E recorded in docs/FEATURES.md has been executed (bounded probe: a real cursor-agent loaded the injected belt and it answered typed over MCP; the full parent-run hop remains follow-up evidence).
- 69500f8: Foreground quota refreshes (POST /v2/quota and the atomic Accounts snapshot) now honor each vendor's poll rate-limit cooldown: a vendor that recently answered 429 is served from last-known registry data instead of a fresh fan-out, disclosed additively as `refresh_skipped` rows on the quota response.
- e39c57b: Suppressed quota polls never fall silent: gap absences (rate_limited, probe_skipped_rate_limited, and the new derived poll_paced) coexist with stale snapshots and are silenced only by fresh ones, so downstream exhaustion readers stay fail-open while a vendor's poll pacing is cooling.
- fd623ff: Parse Retry-After on oauth/usage 429 into a typed `rate_limited` quota absence carrying `retry_after_ms`, so poll pacing can honor the vendor floor instead of recording an undiagnosed refresh failure.
- 278e436: The claude oauth-usage candidate loop short-circuits after the first 429 (unprobed siblings get the honest distinct `probe_skipped_rate_limited` absence, never a fabricated `rate_limited`), and the agy profile fan-out is bounded to 3 concurrent vendor probes; the same short-circuit seam is in place for agy and arms once its vendor classifier learns to type 429s (today the live agy win is the concurrency bound).

### Patch Changes

- @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- ce6dba1: Prepare an isolated macOS keychain inside each Antigravity credential profile before vendor probes, quota reads, logins, and runs. The vendor's existing file fallback and profile separation remain unchanged.
- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/util@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

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

- @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- Carry optional model applicability on vendor quota constraints, live rate-limit signals, and budget observations.
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Add shared contracts for nullable interaction waits, run applicability and Git capability, atomic credential snapshots, durable problems, and canonical run strategy and presentation truth.
- Remove the unproduced `WorkProduct.evidence_dir` placeholder; evidence paths remain owned by concrete run and review receipts.
- Add the optional sealed relative permit window used by deferred client-PTY
  setup runners after a deadline extension.
- Keep frozen plan references server-owned at the thread-turn boundary and carry
  the deciding credential profile in the run auth-route receipt.
- Reject transient device-code projections outside an active Codex login that
  is awaiting the user.
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Effort ladders are per (harness, model) and follow the vendor-advertised order.
  Levels are discovered live from each CLI (with a snapshot fallback when a probe
  is unavailable), the full official vocabularies are supported, and a level the
  run cannot honor is disclosed instead of silently clamped. A profile-scoped run
  is no longer held to the default account's ladder, and hint-less runs resolve
  against the default model's own ladder.
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

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

## 2.0.2

## 2.0.1

## 2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Add `TaskContract.constraints.auto_protected_paths` so per-run approvals can
  narrow engine-derived gate/test protections without weakening spec/config-owned
  `protected_paths`.

## 0.14.0

## 0.13.3

## 0.12.1
