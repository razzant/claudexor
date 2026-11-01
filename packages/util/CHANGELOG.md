# @claudexor/util

## 5.0.0

### Patch Changes

- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- d9e7977: `claudexor project remove <project-id> --purge-trashed-threads` (`DELETE /v2/projects/:id?trashedThreads=purge`) removes a project together with the threads already in its trash, in one action (#333). Without the option, removal is unchanged and still refuses while any non-purged thread remains. The option purges only threads that are in the trash: an active or closed thread must be trashed first. The whole removal is refused, with nothing changed, while any thread is outside the trash (`project_has_threads`) or while any of the project's work is queued or running, including a thread Apply or a run started under a former root (`project_has_active_run`). The purges and the project's retirement are one store transaction. Each purged thread then loses what a thread purge deletes: its isolated worktree and `claudexor/thread-*` branch with any changes never applied, and its lane homes. The project folder, a delegated thread's caller-owned workspace and run artifacts are never deleted; the conversation rows stay in the engine store, while the threads leave every listing and can no longer be restored or resumed. The receipt's new `purgedThreads` lists each purged thread with `cleanup: "completed"`, or `"pending"` with the error; a pending cleanup is retried when the daemon next starts. A repeated or inexact `trashedThreads` value is refused with 400 before anything changes. Other query parameters stay ignored as before, so a misspelled parameter name gets the default removal, which still refuses while any non-purged thread remains.

  Every thread purge (Delete Now, expired trash, the retention retry, daemon startup and this removal) now reports a cleanup as completed only once the thread's worktree with its Git registration and branch and its lane homes are gone. When Git refuses, for example for a worktree locked with `git worktree lock` or a ref lock held by another Git process, the cleanup stays pending with Git's error, nothing Git still records is deleted, and a later attempt finishes it once the cause is gone. Git is asked in the repository that registered the worktree, which the worktree's own `.git` file names; a branch, registration or directory already gone there counts as removed. Without that file, the project folder's repository is asked. Because Git deletes the file with the worktree and a project folder can be replaced, the cleanup records the repository it asks before Git's first change there, so a later attempt or the next daemon start finishes in that same repository, and syncs its Git directories to disk, also when the project folder is gone or another repository is at the project path by then. Git drops a worktree's registration even when it fails to delete the worktree directory, for example a read-only one; the cleanup stays pending with Git's error, and once the directory can be deleted, a later attempt finishes it in that recorded repository. A repository moved without relinking the project, or deleted (the two look the same), keeps the cleanup pending too; after a move, `git worktree repair` in the moved repository lets the next daemon start finish it, and a recorded repository that moves away or is replaced at its path afterwards keeps it pending until it is back. Thread purge, the account lane cleanup and the orphan-lane sweep no longer follow a link inside Claudexor's runtime directory: a link above what they delete is refused with an error and its target is left untouched, and a link in place of what they delete is only unlinked. Before, such a link made the deletion follow it into the linked folder, and a Git refusal was reported as completed and never retried.

## 4.8.2

### Patch Changes

- 97e2f17: Keep retained run observation off the control event loop: share request-local reads, preserve complete history for event folds, and use one lazy bulk worker for detail, summaries, artifact reads and finite event replay. Inbox attention stays independent of the bulk queue; disconnected turn-card readers stop scheduling summaries, and unreadable runs retain per-row diagnostics. Resume sequenced streams from the tail while preserving legacy cursors, redaction and terminal delivery. Expose route outcomes and separate worker queue/projection timing.

## 4.8.1

## 4.8.0

### Patch Changes

- 6c31c44: Add the Grok Build subscription CLI harness: named accounts with isolated
  profile homes, device login, account model lists, shared effort placement,
  stream parsing and reactive quota cooldowns for pools and rotation. Readiness
  comes from `grok models` in the profile env, and an inconclusive probe stays
  unknown instead of marking the account dead; failure text from a run is never
  read as an authentication verdict either. Session login is confirmed from
  Grok's init frame; a contradicting source fails the attempt as the new typed
  `credential_source_unconfirmed` request refusal, without a retry or account
  rotation, even when the same frame also contradicts the scoped tool policy.
  Claudexor never selects an API key, but a key in Grok's own configuration can
  send a paid request before that check, as the adapter README discloses.
  Subscription cash is reported unknown, not zero. Grok joins the macOS Add Account picker and
  the shared credential-store path rules, so a directory run never copies or
  publishes a selected `.grok/` directory; leave it out of `--scope-path`. An app
  built before this change cannot decode an active Grok login job, and its
  engine-update check reports busy until that login finishes or is cancelled.
  Applied attempt facts now name the HOME a Grok, Antigravity or Cursor profile
  child actually received.
- Add bounded thread history reads. `GET /v2/threads/:id/history` returns one page of at most 20 turns with prompt and answer previews and receipt facts, chosen by a cursor or a before, after or around turn id, and `GET /v2/threads/:id/turns/:turnId/prompt` returns a bounded UTF-8 part of a turn's complete stored prompt, refused turns included, with its total size and SHA-256. CLI `thread history` and `thread prompt` and MCP `claudexor_thread_history` and `claudexor_thread_prompt` expose the same reads; they require an existing daemon and never start one. The existing thread detail read remains available.

  A page stays within 2 MiB of JSON. A stale cursor fails as `thread_history_cursor_stale` with the `resnapshot` required action, and a turn whose run record was pruned reads as `not_retained` instead of failing the page.

  Engine-store schema 5 adds only the `turn_plan_answer` index in an atomic forward-only migration; building it scans existing turns once without rewriting them, and older engines refuse an upgraded store.

## 4.7.1

## 4.7.0

## 4.6.2

## 4.6.1

## 4.6.0

### Minor Changes

- a81897c: Choose the native prompt-cache lifetime of Claude Code sessions per run: `POST /v2/runs` and `POST /v2/threads/:id/turns` accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`, including plan answers the same command submits inline), and omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities` projects them as `harnesses[].promptCacheTtls` and lists the key in `runControlKeys`. The value is frozen into the task contract, inherited by a bare `continueFrom` (a successor cannot go back to Default; that takes a new run), re-injected by Exact Retry, and forwarded to task lanes, the continuity summary, reviewers and delegation-belt children on declaring harnesses. Elsewhere it is an `ignored_settings` disclosure, except in best-of synthesis, which emits no `harness.started`: an undeclared synthesis harness runs without the lifetime and without a disclosure. The deep-scan reducer's `harness.started` now discloses every route knob its harness ignores, including `max_turns` and tool lists. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, keeps forcing and disabling controls, and discloses the ones known to govern instead (and a known older CLI). Each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the lifetime routed to its sessions (`requested`), the configured value and the observed split of the reported five-minute and one-hour cache-write tokens; an unreported split stays unknown.

## 4.5.0

## 4.4.0

### Minor Changes

- Daemon status reports per-route request latency (one count of completed responses or disconnects with p50, p99 and max for the lifetime and the last loop window, keyed by HTTP method and operation-catalog template) and the 32 longest labelled synchronous sections since start (store BEGIN and COMMIT, external writes, run detail and summary projections, scope persistence), plus lifetime COMMIT p50 and p99. A request whose client has already hung up skips its pending heavy read projections; an admitted mutation still completes. `POST /v2/handshake` returns the durable engine store id as `storeId` to a client that sends `X-Claudexor-Store-Identity: 1`, and every other client keeps the earlier response shape. `scripts/daemon-load-bench.mjs` compares an exact base against the working tree in alternating trials inside temporary roots it owns. Moving checkpoints off the request thread was measured and not adopted: it lowered COMMIT tails but not the event-loop tail consistently (`docs/benchmarks/daemon-sync-20261020.md`).
- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).

## 4.3.1

## 4.3.0

## 4.2.0

## 4.1.1

## 4.1.0

## 4.0.1

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

## 3.25.1

## 3.25.0

## 3.24.0

## 3.23.2

## 3.23.1

## 3.23.0

## 3.22.1

### Patch Changes

- 902532e: Select retained commands by an explicit address before compact collection projection, preserving exact retry, HTTP run pages, continuation admission and uncapped cancellation. Remove the control API's whole-history self-RPC and make project activity checks synchronous with removal.

  Report daemon transport failures as retryable 503 problems while preserving typed refusal context and required actions; a thread turn whose enqueue answer was lost stays retryable and its retry reads the journal instead of enqueueing a duplicate. Untyped enqueue failures on POST /v2/runs now carry code internal_error instead of http_500. Refuse an admitted continuation whose source vanished before starting any harness work.

  Expose current and admission memory through authenticated GET /v2/daemon/status without changing the handshake. Publish engine heap launch arguments in the additive probe contract and apply them in the CLI and the macOS app launcher, honoring explicit NODE_OPTIONS. Resident journal-history growth and archive continuation remain outside this patch.

## 3.22.0

## 3.21.0

### Patch Changes

- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).

## 3.20.1

## 3.20.0

### Minor Changes

- c12828c: Add a generic ACP v1 client harness with GitHub Copilot CLI as its first vendor.
  Use managed tokens and scoped homes, bounded typed streams, process-tree
  cancellation, a free session doctor and explicit paid write conformance.
  Model inventory is advisory; missing cost remains unknown. Copilot ACP is in
  preview: workspace writes are unfenced when permission callbacks are absent.
  Live input, native login and MCP injection are not included in this stage.

  Port permission, environment, launch, translation and lifecycle semantics from
  Róger Valderrama (@germago119), razzant/ouroboros#769, with the Q00 MIT notice
  retained in the new package.

## 3.19.0

## 3.18.0

## 3.17.2

## 3.17.1

## 3.17.0

## 3.16.0

## 3.15.1

## 3.15.0

## 3.14.0

## 3.13.0

## 3.12.10

## 3.12.9

## 3.12.8

## 3.12.7

## 3.12.6

## 3.12.5

## 3.12.4

## 3.12.3

## 3.12.2

## 3.12.1

## 3.12.0

## 3.11.0

## 3.10.5

## 3.10.4

## 3.10.3

## 3.10.2

## 3.10.1

## 3.10.0

## 3.9.8

## 3.9.7

## 3.9.6

## 3.9.5

## 3.9.4

## 3.9.3

## 3.9.2

## 3.9.1

## 3.9.0

## 3.8.4

## 3.8.3

## 3.8.2

## 3.8.1

### Patch Changes

- ce6dba1: Prepare an isolated macOS keychain inside each Antigravity credential profile before vendor probes, quota reads, logins, and runs. The vendor's existing file fallback and profile separation remain unchanged.
- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.

## 3.8.0

## 3.7.0

## 3.6.0

## 3.5.0

### Minor Changes

- 2316ef8: Add the Antigravity CLI (`agy`) as a harness, so a Google AI Pro/Ultra
  subscription runs through Claudexor like the other vendor CLIs.

  Named Google identities are Claudexor-owned profile HOMEs (`config_dir_login`),
  so several subscriptions stay signed in side by side without touching the
  operator's real home or login keychain. `claudexor quota` reads each profile's
  own `/quota` windows, and the windows are model-scoped: exhausting the Gemini
  budget does not block the account's Claude/GPT slugs. `claudexor harness
install agy` downloads Google's official installer in full, prints its size and
  sha256, and runs the file you were shown — it is never piped into a shell.

  The vendor exposes no config-dir environment variable, so the profile HOME also
  holds its conversation and cache state, and it publishes no machine-readable
  account identity — both are disclosed rather than papered over. Windows support
  is best effort in this release.

## 3.4.2

## 3.4.1

## 3.4.0

## 3.3.16

## 3.3.15

## 3.3.14

## 3.3.13

## 3.3.12

## 3.3.0

## 3.2.1

## 3.2.0

### Patch Changes

- Add bounded problem redaction and normalized retry-delay helpers for every control and harness surface.
- Reject unsigned extension fields in the signed runtime-update manifest.

## 3.1.2

## 3.1.1

## 3.1.0

## 3.0.3

## 3.0.0

## 2.1.3

## 2.1.2

## 2.1.1

## 2.1.0

## 2.0.2

## 2.0.1

## 2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

## 0.14.0

## 0.13.3

## 0.12.1
