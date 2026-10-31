# @claudexor/control-api

## 5.0.0

### Minor Changes

- d9e7977: `claudexor project remove <project-id> --purge-trashed-threads` (`DELETE /v2/projects/:id?trashedThreads=purge`) removes a project together with the threads already in its trash, in one action (#333). Without the option, removal is unchanged and still refuses while any non-purged thread remains. The option purges only threads that are in the trash: an active or closed thread must be trashed first. The whole removal is refused, with nothing changed, while any thread is outside the trash (`project_has_threads`) or while any of the project's work is queued or running, including a thread Apply or a run started under a former root (`project_has_active_run`). The purges and the project's retirement are one store transaction. Each purged thread then loses what a thread purge deletes: its isolated worktree and `claudexor/thread-*` branch with any changes never applied, and its lane homes. The project folder, a delegated thread's caller-owned workspace and run artifacts are never deleted; the conversation rows stay in the engine store, while the threads leave every listing and can no longer be restored or resumed. The receipt's new `purgedThreads` lists each purged thread with `cleanup: "completed"`, or `"pending"` with the error; a pending cleanup is retried when the daemon next starts. A repeated or inexact `trashedThreads` value is refused with 400 before anything changes. Other query parameters stay ignored as before, so a misspelled parameter name gets the default removal, which still refuses while any non-purged thread remains.

  Every thread purge (Delete Now, expired trash, the retention retry, daemon startup and this removal) now reports a cleanup as completed only once the thread's worktree with its Git registration and branch and its lane homes are gone. When Git refuses, for example for a worktree locked with `git worktree lock` or a ref lock held by another Git process, the cleanup stays pending with Git's error, nothing Git still records is deleted, and a later attempt finishes it once the cause is gone. Git is asked in the repository that registered the worktree, which the worktree's own `.git` file names; a branch, registration or directory already gone there counts as removed. Without that file, the project folder's repository is asked. Because Git deletes the file with the worktree and a project folder can be replaced, the cleanup records the repository it asks before Git's first change there, so a later attempt or the next daemon start finishes in that same repository, and syncs its Git directories to disk, also when the project folder is gone or another repository is at the project path by then. Git drops a worktree's registration even when it fails to delete the worktree directory, for example a read-only one; the cleanup stays pending with Git's error, and once the directory can be deleted, a later attempt finishes it in that recorded repository. A repository moved without relinking the project, or deleted (the two look the same), keeps the cleanup pending too; after a move, `git worktree repair` in the moved repository lets the next daemon start finish it, and a recorded repository that moves away or is replaced at its path afterwards keeps it pending until it is back. Thread purge, the account lane cleanup and the orphan-lane sweep no longer follow a link inside Claudexor's runtime directory: a link above what they delete is refused with an error and its target is left untouched, and a link in place of what they delete is only unlinked. Before, such a link made the deletion follow it into the linked folder, and a Git refusal was reported as completed and never retried.

### Patch Changes

- d16170f: A Cursor shell command that is still running is no longer reported as a finished success. When Cursor moves a command to a background shell (for example after its 30-second shell timeout) or its timeout elapses, the tool result keeps its ordinary tool status but now carries typed `command_outcome` facts (`backgrounded` with the shell handle, process id and reason, `timed_out`, an observed `exited` with its exit code and signal, or `unknown` for an unrecognized shape), and the complete native result is kept in the durable `harness.event` payload. Such a result never recovers an earlier failure of the same command and never discards a delivered answer; the run timeline shows it as a warning, ACP closes it as `failed` with the state as text instead of `completed`, and the macOS transcript shows a caution row that never joins a group of finished calls. A shell spawn error is now an error instead of ok. The timeout and background shapes follow the `agent.v1` shell protocol of cursor-agent 2026.08.11; no such frame has been recorded live yet. Motivation: two reviewer runs reported a 30-second `find` as a successful command while it was still running, and the journal could not tell a timeout from a background handoff (razzant/claudexor#450).
- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- 9a5ef43: `GET /v2/global/events` and `GET /v2/projects/:id/events` now replay and tail the retained journal in bounded pages (at most 256 events and 1 MiB of stored payload each) instead of reading, validating and writing the whole retained history before the first event. Replay stays complete and ordered with the same cursors and the same 409 `resnapshot` refusals; an event larger than a page is sent whole on its own. The daemon waits for a slow reader to drain before writing more, keeps one page read in flight per connection, and stops reading when the client leaves or the daemon stops. A stream whose partition generation is replaced now closes instead of continuing in the new epoch, including a stream that had not received an event yet. Motivation: issue #312, where back-to-back full snapshots of a dense root raised daemon RSS to 4.1 GB.
- 66d5b6a: Large results are now kept exactly, without a size ceiling (#535). Before, a result whose exact patch exceeded 256 MiB failed its capture. Every Git capture's canonical result is now Git objects identified by a typed digest (`git_objects/v1`), kept in a private per-project object store that is never an alternate of your repository; objects are imported into your repository only before an operation needs them. Results of every size are verified in a fresh private clone, applied onto the current state of your project (your unrelated changes are kept; paths changed on both sides follow `git apply` rules, except that an identical change on both sides is accepted outside rename and copy endpoints), committed or branched, and reverted on the actual delivery pair, keeping later edits outside it (a file the delivery added that your ignore rules now hide, or that sits inside a nested Git repository, is removed too, or the revert refuses if you changed it or cannot read it); a rendered result's `pr` passes the same publication scan as any `pr`, on the exact commit it pushes. Operator decisions and the apply gate bind the result's digest instead of the patch text. The patch becomes a view: when an estimate computed from the changed files' blob sizes exceeds the 256 MiB view limit, or the render itself overflows it, `final/patch.diff` is absent with a typed reason and a bounded inventory (never an empty file), `claudexor inspect`, the run summary, MCP results and the macOS Changes tab say so, and `pr` of such a result refuses typed (`pr_unrendered_result`) before any scan; scanning such a result for `pr` is a follow-up. Because that estimate is computed before rendering, a small edit of a very large file (one changed line in a 110 MiB file) also gets no patch view and `pr` refuses it; the result itself stays exact, deliverable and revertable. A delivery refused for a typed reason (`result_objects_missing`, `pr_unrendered_result`, a publication scan refusal, a conflict, a changed target, a store fault) answers that reason as the HTTP 409 problem code on `POST /v2/runs/:id/apply` and `accept_clean_patch` (a refusal with no typed reason answers `delivery_refused` on both), a replay with the same `Idempotency-Key` answers the same, and `apply/check` returns it as `refusal`, a store, Git or filesystem fault included; a run whose result record is there but cannot be read answers 503 `artifact_read_failed` on apply, apply/check and the decisions instead of "no patch artifact". For a Git result, a `commit`, `branch` or `pr` delivery that fails after writing now answers that HTTP 409 problem, where the last release answered such a failure with HTTP 200 `applied:false` (a legacy patch's delivery still does). A delivery that fails after writing is taken back on its retained pair, keeping later edits outside it (restored as Git holds it: a file whose checkout conversion does not round-trip, an LF file under `core.autocrlf` for one, can come back with converted bytes, which the receipt says); only a write that cannot be taken back stays, reported as `treeMutated` with the action that recovers it and recorded `applied_review_blocked` with a revert anchor instead of `not_applied`. A `pr` whose push fails returns the working tree to where HEAD was and keeps the commit on the local branch; when that checkout fails, the receipt says where HEAD stayed and how to return. A delivery never writes over what Git does not track: a file or directory at a path the result adds that your ignore rules hide refuses `delivery_path_occupied`, naming it, with nothing written, and `apply/check` answers the same (a new file in a directory that already exists still delivers, and so does a rename that only changes case; a hard link of a removed file is never taken for one). In a sparse checkout (cone or non-cone), a result that adds, changes or removes a path outside the sparse-checkout patterns refuses `delivery_outside_sparse_checkout`, naming those paths, with nothing written, and `apply/check` answers the same; the last release's `git apply` wrote such an added file, after which every later snapshot of that checkout failed. A revert that must change such a path, because you narrowed the patterns after the apply, refuses the same way. Widen the sparse checkout (`git sparse-checkout add`) to deliver or revert there. Every path a delivery, take-back or revert does not address keeps its bytes, including a clean file outside the patterns that has no skip-worktree mark (Git's own checkout would delete it), and its index mark, except that in a sparse checkout Git itself clears the skip-worktree mark of a file that is present, which sticks once a `branch`, `commit` or `pr` delivery writes the index; such a write also drops the assume-unchanged mark of a path it changes. This check uses `git sparse-checkout check-rules` (Git 2.41 or newer); with an older Git, a sparse checkout's deliveries, `apply/check` and reverts refuse `git_failed` before writing, naming the Git they need. A file you marked skip-worktree and then deleted counts as deleted, not as unchanged (except a file the sparse patterns leave out), so a revert brings back what a delivery deleted, refuses rather than undo your later deletion, and a delivery does not silently recreate it. A `branch`, `commit` or `pr` delivery commits the result onto HEAD and leaves what your assume-unchanged or skip-worktree marks hide (a local edit, a deleted file) on disk and out of the commit, their marks with them (but for the sparse-checkout case above); a result that changes such a file refuses `delivery_conflict`. A checkout that cannot fit refuses `space_insufficient` before its first write, and a store fault on the way there (the import, the snapshot, the composition) answers the same typed 409 instead of HTTP 400 or 500. A path the result changes whose name is not valid UTF-8 refuses `result_path_encoding` with nothing written, and so does its revert; a name only your project changed is never addressed, so it does not stop an unrelated result. Written paths are proven the way `git status` compares them, and every private proof, snapshot and checkout reads the bytes whatever your configuration or index marks say (`core.ignoreStat`, a filesystem monitor, an assume-unchanged mark); apply, its check and revert also read the paths they decide on by content rather than from the index's stat cache, so a file that kept its size and mtime is neither already applied nor called reverted (`branch`, `commit` and `pr` keep that cache for what they write, as `git checkout` does). A committed CRLF blob under `text=auto` or `core.autocrlf` applies and reverts, and a directory that becomes a file or symlink composes and a file that became a directory reverts on an unchanged target. When a patch render fails for a reason other than its size, the capture keeps the result with `patch_view.reason: render_failed`. Review and synthesis of a result with no patch view read a copy of its saved candidate tree, converted only as that tree's own attributes define with Git's defaults, in a private Git directory, never the workspace, so a configured check that rewrites an output, an attribute rule (tracked or in `.git/info/attributes`) or the repository's filter configuration cannot make review read different bytes than apply consumes (a filter driver is configuration the result does not carry, so a filtered file is read as its stored blob, as in the patch view: a Git LFS pointer or an encrypted blob is reviewed as stored, which says nothing about the content it stands for, and no smudged copy is kept); a changed file that copy cannot hold, a disk too full for it included, is named with its typed cause (`space_insufficient` for a full disk) to reviewers and synthesis, and the review cannot pass clean. A copy that fails holds none of the files: reviewers and synthesis get those causes and nothing to read, never what the failed copy left in its directory or a directory that is gone, and a copy that cannot be removed afterwards stays instead of ending the run, with a best-effort `<copy>.cleanup-error.json` saying why (on a disk too full to write that record whole, the leftover stays with its cleanup unconfirmed). After an earlier apply and revert, a later delivery that strands HEAD on its branch clears the old revert anchor, so `revert_run` refuses instead of answering a false success. A `revert_run` refused for anything but a later edit of what the run changed (the sparse patterns, a file it cannot read, a full disk, a Git fault) now answers `reverse_apply_failed` with its typed cause as `context.refusalCode`, instead of saying the revert is no longer available. Runs recorded by earlier releases keep their patch for apply and revert.
- f428c0a: Account resources can now show an OpenRouter key's own spending limit, for the key requests actually use, including the default one (#138). The engine reads OpenRouter's `GET /api/v1/key` (no generation, no account balance) for the default key and each enabled registered OpenRouter API-key account, on an explicit full or exact refresh only. Clients that send `includeApiKeys=true` with a resources view of `GET`/`POST /v2/quota` or the Accounts snapshot receive one row per key: the default key as `target.profile_id: null` (the API-key route, not an account) and each registered key, all bound to a non-secret `credential_fingerprint`. A replaced key never shows the previous key's figures and a removed key has no row. The spending row keeps the provider's decimal `limit` and `remaining`, `capped: false` for a key without a per-key limit (never zero or unlimited money), spend for its UTC `window`, and a reset instant only when OpenRouter reports one. Failed reads keep the last figures as stale with the cause. These rows never affect routing, quota admission or polling; clients that do not ask keep the previous response. `claudexor quota --resources` and the MCP `claudexor_account_resources` tool include them, and the macOS OpenRouter Auth sheet shows them in a Key allowance panel with a Refresh that reads only those keys.
- f428c0a: Raw API and OpenRouter requests judge an explicitly chosen model by what the catalog actually answered and send the material the project requires within that model's limits.

  - A model catalog that could not be read is no longer reported as proof that an explicit model does not exist. The read is typed (no credential, a rejected key on 401/403, another HTTP status, network, timeout, a malformed or partial answer, including a `total_count` that does not match the rows) and uses the same key as the run. When the catalog is only unavailable or unusable, the explicitly chosen model is sent unchanged on that same key and every place that admits it says once that it could not be verified: the settings read-back notes, the doctor's readiness detail, the run's status event and the reviewer panel's preflight event. A missing or rejected key still refuses with code `model_catalog_unavailable` (category `auth`): nothing is sent, the run records that typed failure rather than a crashed harness, and the settings write answers HTTP 409 with `cause` and `httpStatus`. A catalog that answered without the model still refuses it. A failed read in the middle of a run does not discard what that run already read with the same credentials, meaning the same account and the same key (a key replaced during the run counts as another credential): the earlier read still decides the model and sizes the request to its known window, and the run says so. `claudexor models`, `claudexor capabilities` and `GET /v2/harnesses/:id/models` report the failure instead of an empty list or a count of zero.
  - OpenRouter's routing variants `:nitro`, `:floor` and `:exacto` of a listed model are accepted in any order OpenRouter documents (`m:free:nitro` and `m:nitro:free` need `m:free` listed) and sent unchanged, with a note that `:nitro` and `:floor` may bill a service-tier rate. Undeclared suffixes still need the exact id listed, and `:online`, which would make OpenRouter search the web, is refused whether or not the catalog can be read. The models listing now carries the declared variants, so the app can find the listed row of a variant id.
  - Model rows now carry the catalog's input modalities and completion limit. An image attached for a model whose catalog lists no image input is still sent, with one note that the provider decides.
  - Raw API patch requests include the project's `context.mandatory_files` complete and honour `include`/`exclude`. Each request is sized from the catalog read that admits its model, made with the key that request uses, and the image note reuses that read; a key replaced while the request is being prepared is used from the next request on. A raw API reviewer, named in the reviewer panel or chosen by the automatic one, likewise sends the key its panel's catalog read checked. An Agent run with `attempts` or `untilClean` now sends a raw API route the same packet, mandatory files and patch protocol as a single attempt, instead of a bare prompt that could never return a patch. The whole request is sized to the selected model's known context window minus instructions, prompt, protocol, attachments and an answer allowance (approximate characters/4 estimates), optional files are omitted deterministically and disclosed, and mandatory content that cannot fit refuses before the request is sent. When the window is unknown the previous 200 000-token selection ceiling still applies and is labelled as an assumption. A patch cut at the provider's output limit is reported as truncated. The sizes are typed for every surface: the run summary's `rawContext` gives the estimate of the request the final attempt last prepared (recorded just before its POST) and the budget its packet honoured, and an over-window refusal's failure record carries `rawContextShortfall` with the window, the request's parts and every mandatory file's estimate, plus next actions. The macOS app shows the estimate and the omitted optional files as run facts, and the refusal with its largest mandatory files.

- 28dfe1a: `claudexor doctor` now ends with the daemon's route health for the terminal runs created in the last seven days: a summary line, then each route (one harness crossed with one effective access profile) that had failures with its failure share and most frequent failure, as facts without thresholds or alarms. The full answer, every route's succeeded, failed, cancelled and other counts with up to three failure groups, is `GET /v2/daemon/route-health` in the control API (listed in the operation catalog; an older engine answers 404, which doctor prints as unavailable) and `route_health` in `doctor --json`. It is computed on demand from the retained run records by a bounded newest-first scan that says when it stopped early (`complete`, `incompleteReason`), and each run contributes only a few small artifacts read once in the shared worker, never its event journal. Motivation: on one install about half of the readonly Antigravity runs failed for two months while claude and codex readonly runs almost never did, and no surface showed failure shares per route.
- 3ba851e: Repeated run detail reads (`GET /v2/runs/:id`, also used by MCP status/wait snapshots) can reuse the bulk worker's folded event prefix and parse only appended lines. Reuse assumes the existing append-only writer: identity changes, shortening below the retained offset or changed start/end guard bytes trigger a full fold. An arbitrary middle-only in-place rewrite can go undetected. A last record without its newline is evaluated without being consumed. Decision, telemetry, answer, reviews, task contract, artifacts and live fields remain fresh per request. Retention is limited to 32 runs and a 64 MiB accounting budget, 8 MiB per run, not an exact JavaScript heap cap; evicted or oversized folds and separate recovery/ancestry readers can still read the whole log. On paired synthetic macOS logs of 8 MiB and 200 MiB, unchanged repeated detail read 8 KiB instead of the whole file, taking about 9 ms and 10 ms rather than 48 ms and 890 ms, with byte-identical responses in the tested supported cases. MCP-shaped polling on the synthetic 200 MiB run reduced SSE delivery p99 from about 1 s to under 10 ms. These measurements are not production or cross-platform guarantees.
- Updated dependencies [f428c0a]
- Updated dependencies [66d5b6a]
- Updated dependencies [d16170f]
- Updated dependencies [8bae6ae]
- Updated dependencies [66d5b6a]
- Updated dependencies [f428c0a]
- Updated dependencies [d9e7977]
- Updated dependencies [2d83b87]
- Updated dependencies [f428c0a]
- Updated dependencies [28dfe1a]
  - @claudexor/schema@5.0.0
  - @claudexor/workspace@5.0.0
  - @claudexor/util@5.0.0
  - @claudexor/delivery@5.0.0
  - @claudexor/event-log@5.0.0
  - @claudexor/secrets@5.0.0

## 4.8.2

### Patch Changes

- 97e2f17: Keep retained run observation off the control event loop: share request-local reads, preserve complete history for event folds, and use one lazy bulk worker for detail, summaries, artifact reads and finite event replay. Inbox attention stays independent of the bulk queue; disconnected turn-card readers stop scheduling summaries, and unreadable runs retain per-row diagnostics. Resume sequenced streams from the tail while preserving legacy cursors, redaction and terminal delivery. Expose route outcomes and separate worker queue/projection timing.
- 67b8833: Release old unreferenced artifacts and native sessions after archived project bindings are cleared. Reclaim aged, unnamed revert/exact-patch objects and empty engine containers while preserving surviving runs and recovery holds. Expose a durable last cleanup outcome, counted holds and errors through `claudexor gc --last` and `GET /v2/maintenance/gc`.

  Preserve complete NUL-delimited interaction IDs on Node 24.15 when pruning commands and observing retention changes, so question event groups and bodies are released and questions published during cleanup protect their runs.

  Preserve live workspace, Git checkout and harness-home directories during cleanup. Keep hold history through interrupted inventory, recover unreadable last-pass records with a passive diagnostic, and report unsupported native adapters without false holds.

  Keep foreign Codex session entries informational and preserve unobserved holds through interrupted cleanup. Reclaim empty run-retirement containers and avoid removal attempts on nonempty containers.

- f88a561: Fix multi-run waits and task-group recovery (#513, #514, #515).

  A daemon that stops while `POST /v2/runs/wait-many` (`claudexor_runs_wait`, CLI `runs-wait`) is waiting now answers a retryable `503 daemon_stopping` at once instead of holding the shutdown until a forced exit; a launch whose run has not started yet gets its `202` receipt. `waitMs` bounds the wait between reads, never a read: a read under way at the deadline finishes and its facts and attention are the answer, so a short positive `waitMs` no longer returns every target `not_observed`. A problem row's `null` token can be echoed as `seen: null` to acknowledge that problem, so the wait continues for the healthy targets instead of returning at once; output shapes are unchanged. Observation tokens never match the secret scan that guards MCP input. A request body the daemon refuses keeps its connection until the typed `413` is read, on JSON routes and upload bytes alike, and stop closes only connections still sending such a body.

  Waits wake from the store's post-commit notices for the watched jobs, runs and questions instead of a 250 ms poll that re-read every target, and they re-read only the targets a notice names. Group pages add each member once instead of re-serializing the page per member.

  Task-group membership now ignores the letter case of the group UUID: engine schema 6 stores the canonical lower-case group in a `command.task_group_id` column, backfilled for live and archived rows, and answers keep the caller's spelling. Older engines refuse the upgraded store, and group cursors issued before the upgrade restart with `stale_cursor`. A tagged launch, retry or decision rerun is refused before acceptance when the store identity is unavailable; a decision rerun keeps its group and answers `newJobId` with the group receipt. A CLI wait that fails after acceptance keeps the job receipt in the error context. CLI `--wait-ms` and `--limit` accept only plain decimal integers.

  Changes that controllers and embedders can see: earlier CLI and MCP clients check `seen` locally and refuse `null`, and an earlier daemon refuses a request that carries it, so acknowledging a problem needs both sides upgraded. A token saved from an earlier engine that the MCP secret scan refuses can be dropped from `seen` once to receive its re-derived replacement. A target hidden by pruning, archive or a generation change during a wait shows `not_found` at the deadline's read rather than at once. `GET /v2/task-groups/:id/runs` refuses a `limit` with a leading zero. The CLI's bounded observation reads report a malformed daemon answer as non-retryable `invalid_service_response` and a read timeout as `run_observation_timeout`. Embedders of `DaemonControlApiServer` can pass the new optional `runObservationChanges` feed; without it waits keep the 250 ms poll, and wait-many no longer subscribes to the `bus` option, which still drives the event streams.

- Updated dependencies [97e2f17]
- Updated dependencies [67b8833]
- Updated dependencies [f88a561]
  - @claudexor/event-log@4.8.2
  - @claudexor/schema@4.8.2
  - @claudexor/util@4.8.2
  - @claudexor/workspace@4.8.2
  - @claudexor/delivery@4.8.2
  - @claudexor/secrets@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/delivery@4.8.1
- @claudexor/event-log@4.8.1
- @claudexor/schema@4.8.1
- @claudexor/secrets@4.8.1
- @claudexor/util@4.8.1
- @claudexor/workspace@4.8.1

## 4.8.0

### Minor Changes

- 7dfbc42: Add document ingress over the existing upload owner. MCP gains the upload stage tools (`claudexor_upload_create`, `claudexor_upload_import_local`, `claudexor_upload_status`, `claudexor_upload_finalize`, `claudexor_upload_cancel`) with matching CLI verbs, and public runs, thread turns and continuations accept strict `attachments: [{resourceId}]` refs. Codex carries verified references for TXT, Markdown, JSON, PDF and DOCX; this is byte access with no parsing or OCR promise.

  A keyed import binds one source to one immutable resource under a saved store id and caller key: `claudexor_store_identity` and `claudexor_upload_import`, CLI `store-identity` and `upload-import`, and HTTP `POST /v2/uploads/imports`. A completed import replays its original resource before the client reads the source, even after the source changed or was deleted. Other arguments or other bytes under the same key are refused without effects, another store is refused before any effect, and verified bytes received before a lost reply or a daemon restart are published on replay. An import's interrupted or unverified transfer returns to `open` so the same key can resend it; ordinary uploads keep their single-shot cancellation. CLI runs take ready refs with `--attach-resource`.

  Existing callers see three behavior changes. CLI `--attach` now labels `.pdf` and `.docx` files `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (previously `application/octet-stream`), so lane admission matches those types. Codex now declares TXT, Markdown and JSON as well as PDF and DOCX file inputs, so Auto routing keeps Codex for runs that carry them where it used to drop it, and explicit pools that include Codex now admit them; Auto and pool choices for such runs can change. The Delegate belt's run tools accept `attachments: [{resourceId}]` refs, while the belt still exposes no upload controls.

- Add bounded thread history reads. `GET /v2/threads/:id/history` returns one page of at most 20 turns with prompt and answer previews and receipt facts, chosen by a cursor or a before, after or around turn id, and `GET /v2/threads/:id/turns/:turnId/prompt` returns a bounded UTF-8 part of a turn's complete stored prompt, refused turns included, with its total size and SHA-256. CLI `thread history` and `thread prompt` and MCP `claudexor_thread_history` and `claudexor_thread_prompt` expose the same reads; they require an existing daemon and never start one. The existing thread detail read remains available.

  A page stays within 2 MiB of JSON. A stale cursor fails as `thread_history_cursor_stale` with the `resnapshot` required action, and a turn whose run record was pruned reads as `not_retained` instead of failing the page.

  Engine-store schema 5 adds only the `turn_plan_answer` index in an atomic forward-only migration; building it scans existing turns once without rewriting them, and older engines refuse an upgraded store.

### Patch Changes

- Add operator-only editable next messages for daemon-owned one-shot Agent and Ask runs: `claudexor_next_message` and `claudexor_next_message_read`, CLI `next-message` and `next-message-read`, and HTTP `/v2/runs/next-message`. One revisioned draft reserves the predecessor's single successor claim. An eligible settled success sends it once as an ordinary continuation through the existing admission and queue; failure, unknown process custody, Stop, restart or admission refusal holds it without retry. Controls and Settings execution preferences are captured at creation and shown by origin on the bounded read, while permissions, trust, accounts and quota stay current at dispatch.

  Public Stop (`POST /v2/runs/:id/control`, `claudexor_run_cancel`) holds a waiting draft whatever the predecessor's lifecycle and reports an already accepted successor as `next_message_dispatched` without cancelling it. If the hold cannot be saved, the run is still stopped, the draft is not sent, and Stop answers 503 `next_message_hold_failed`. `claudexor_run_cancel` failures now keep the control API's typed problem: their text starts with the code (for example `http_409: run is succeeded; cancel has nothing to stop`), and the structured failure carries the code, required actions and context.

  The orchestrator exports `captureRunDefaults`, `executionRunConfig` and `resolveRunInputDefaults`, accepts captured `executionDefaults`, and adds `preflightOneShot` for dispatch validation without starting a run.

  Engine-store schema 4 adds the `deferred_message` table in an atomic forward-only migration; older engines refuse an upgraded store.

- 4a028bb: Run detail now selects the newest 500 displayable timeline rows before redacting and validating them, so a long `events.jsonl` no longer pays the per-row projection cost of rows the bounded timeline omits. For valid, canonical events the response is unchanged: the same rows in the same order, the same omitted count and evidence markers, and budget, plan progress and `lastSeq` still read the complete event snapshot. A corrupted log can now behave differently. A malformed row whose projection throws, such as a `project.git.initialized` row whose `failed_stage` is an object without a callable `toString`, used to fail every detail request for the run; it now fails a request only while it is among the displayed rows and is otherwise counted as omitted. An event whose `type` cannot be converted to a string still fails the request wherever it appears.

- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
- Updated dependencies [7dfbc42]
- Updated dependencies
  - @claudexor/schema@4.8.0
  - @claudexor/util@4.8.0
  - @claudexor/delivery@4.8.0
  - @claudexor/event-log@4.8.0
  - @claudexor/workspace@4.8.0
  - @claudexor/secrets@4.8.0

## 4.7.1

### Patch Changes

- 30f8195: Preserve optional caller-generated task group membership in accepted one-shot jobs and their receipts. Tagged receipts identify the accepting store, Exact Retry retains membership, and new continuations join a group only when explicitly requested. Add atomic engine-store schema version 3 expression indexes for retained group membership.

  Recover original queued and bound job handles with the bounded `task-group-runs` CLI, `claudexor_task_group_runs` MCP tool and HTTP group page. Store/view/filter-bound cursors require explicit paging; compact member observations share the multi-run attention contract. Results cover retained rows in currently served generations, not a permanent roster. Discovery adds no launch, retry, resume, answer, permissions or budget authority.

  Document durable caller receipts, exact keyed replay, separate interaction/result reads and storage downgrade precautions. Add deterministic built CLI/MCP/HTTP qualification stories for controller loss, queued binding, replay conflicts, store mismatch, archive visibility and daemon-crash interruption without autoresume. Manual host UI and real-vendor qualification remain separate.

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
  - @claudexor/schema@4.7.1
  - @claudexor/delivery@4.7.1
  - @claudexor/event-log@4.7.1
  - @claudexor/workspace@4.7.1
  - @claudexor/secrets@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Minor Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/workspace@4.7.0
  - @claudexor/delivery@4.7.0
  - @claudexor/event-log@4.7.0
  - @claudexor/secrets@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/delivery@4.6.2
- @claudexor/event-log@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/secrets@4.6.2
- @claudexor/util@4.6.2
- @claudexor/workspace@4.6.2

## 4.6.1

### Patch Changes

- ed646a5: Attachment and Browser request admission now uses execution's pool projection, candidate membership and profile precedence. An explicit or inherited profile selects its harness even when the default harness home is logged out, a Settings default pool stays strict, and a missing, disabled or wrong-harness pin is refused with a typed `harness_unavailable` 400 instead of being substituted. Admission adds no selected-profile readiness gate; Auto retains host-status discovery for candidate membership. The run checks account readiness, quota and model before any provider starts. An empty Auto candidate pool now returns 400 `harness_unavailable`; static profile ambiguity returns 409 `credential_profile_ambiguous` after incompatible attachment lanes are removed. Browser-only Auto may still reject ambiguous AGY profiles on Windows that execution would have discarded as unready. A direct run that carries `threadId` is refused before admission reads that thread.
  - @claudexor/delivery@4.6.1
  - @claudexor/event-log@4.6.1
  - @claudexor/schema@4.6.1
  - @claudexor/secrets@4.6.1
  - @claudexor/util@4.6.1
  - @claudexor/workspace@4.6.1

## 4.6.0

### Minor Changes

- a81897c: Choose the native prompt-cache lifetime of Claude Code sessions per run: `POST /v2/runs` and `POST /v2/threads/:id/turns` accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`, including plan answers the same command submits inline), and omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities` projects them as `harnesses[].promptCacheTtls` and lists the key in `runControlKeys`. The value is frozen into the task contract, inherited by a bare `continueFrom` (a successor cannot go back to Default; that takes a new run), re-injected by Exact Retry, and forwarded to task lanes, the continuity summary, reviewers and delegation-belt children on declaring harnesses. Elsewhere it is an `ignored_settings` disclosure, except in best-of synthesis, which emits no `harness.started`: an undeclared synthesis harness runs without the lifetime and without a disclosure. The deep-scan reducer's `harness.started` now discloses every route knob its harness ignores, including `max_turns` and tool lists. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, keeps forcing and disabling controls, and discloses the ones known to govern instead (and a known older CLI). Each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the lifetime routed to its sessions (`requested`), the configured value and the observed split of the reported five-minute and one-hour cache-write tokens; an unreported split stays unknown.

### Patch Changes

- Updated dependencies [a81897c]
- Updated dependencies [2593b90]
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0
  - @claudexor/delivery@4.6.0
  - @claudexor/workspace@4.6.0
  - @claudexor/event-log@4.6.0
  - @claudexor/secrets@4.6.0

## 4.5.0

### Minor Changes

- 032b44b: Demote Codex accounts for a model after a pre-generation refusal. A recognized capability refusal (`model_capability_refused`) marks the account at once; any other definite provider HTTP 4xx before generation on an auto operation (outside sign-in, timeouts, conflicts, rate and quota limits, the processing fallback, server failures and typed request faults) offers the same single correlated host retry, which becomes a confirmed mark when another account serves and marks nothing when it refuses too. Both kinds also record the shared pre-progress refusal observation, so Agent runs of that model order the account last as well, and an older in-flight refusal never undoes a newer model operation's service. Auto selection prefers accounts whose live catalog lists the model, then advisory misses, then accounts with only a soft observation (a recent refusal, or a served-model substitution of a non-preferred account), then capability-marked accounts; history bound to an unmarked, unrefused preferred account stays on that account. Refusal problems carry `modelMarks` (each live mark with the start of its episode) and `alternativeRemains` (whether another selectable account without a mark remains). Routing receipts (`captureRoutingEvidence=true` on `POST /v2/model-operations`) and capability rows (`includeCapabilities=true` on `GET /v2/accounts/routing-evidence`) are opt-in over HTTP, so strict 4.4.0 clients keep their shapes; Claudexor's own CLI and MCP readers request the rows. Behavior change: the recognized Codex refusals (an explicit `model_not_found` or `model_not_supported` code, the ChatGPT-account unsupported-model sentence, the narrow missing-model sentences) now return `model_capability_refused` instead of `invalid_request` or `model_unavailable` (an explicit vendor `model_not_found` still records the model-scoped unusable verdict), and `preferredProfileId` no longer wins over a listed account or over its own mark or recent refusal; history bound to that account keeps it first over a catalog miss only while it has neither.

### Patch Changes

- Updated dependencies [032b44b]
- Updated dependencies [85e312d]
  - @claudexor/schema@4.5.0
  - @claudexor/workspace@4.5.0
  - @claudexor/delivery@4.5.0
  - @claudexor/event-log@4.5.0
  - @claudexor/secrets@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Daemon status reports per-route request latency (one count of completed responses or disconnects with p50, p99 and max for the lifetime and the last loop window, keyed by HTTP method and operation-catalog template) and the 32 longest labelled synchronous sections since start (store BEGIN and COMMIT, external writes, run detail and summary projections, scope persistence), plus lifetime COMMIT p50 and p99. A request whose client has already hung up skips its pending heavy read projections; an admitted mutation still completes. `POST /v2/handshake` returns the durable engine store id as `storeId` to a client that sends `X-Claudexor-Store-Identity: 1`, and every other client keeps the earlier response shape. `scripts/daemon-load-bench.mjs` compares an exact base against the working tree in alternating trials inside temporary roots it owns. Moving checkpoints off the request thread was measured and not adopted: it lowered COMMIT tails but not the event-loop tail consistently (`docs/benchmarks/daemon-sync-20261020.md`).
- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).
- MCP controllers get idempotent one-shot launches and durable run supervision: `claudexor_run_wait`, `claudexor_run_message`, `claudexor_run_continue` and bounded `claudexor_run_event_read` parts. Thanks to @IlidanNaga (#478).

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/delivery@4.4.0
  - @claudexor/event-log@4.4.0
  - @claudexor/secrets@4.4.0
  - @claudexor/workspace@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [64ee7fc]
  - @claudexor/workspace@4.3.1
  - @claudexor/delivery@4.3.1
  - @claudexor/event-log@4.3.1
  - @claudexor/schema@4.3.1
  - @claudexor/secrets@4.3.1
  - @claudexor/util@4.3.1

## 4.3.0

### Minor Changes

- Ordinary Codex Fast (`fast`/`priority`) on a verified ChatGPT subscription is included service under no-paid routing and every cash cap, including `finite(0)`; verified Codex subscription work now reports its cash as unknown (`spendUsd` and `budget_summary.spend_usd` null, cost basis `debit: "unobserved"`) beside the cap-governed `controllableSpendUsd` instead of exact zero, and without a preference keeps the first account's chosen speed across retries, Exact Retry, rotation and continuation (#468, thanks @IlidanNaga). Codex catalogs keep a declared `inputModalities` list only when it is wholly valid and non-empty, as metadata that gates no request (#435, thanks @josephsteuerjr). The opt-in `GET /v2/quota?view=resources_freshness` view adds a required `availability_scope` echo, Cursor accounts report dated display-only monetary resources from Cursor's internal dashboard through the existing refresh cycle, and Antigravity's native headless permission auto-denial becomes typed `permission_denial` evidence without retry or access elevation (#467).

  Codex workspace-write uses native on-request with auto_review by default and an explicit one-action retry handback; HTTP/MCP can revise the existing live soft/hard timer, and configuration can disable only inactivity timing with null (#466, thanks @IlidanNaga). This adds no session-wide grant, readonly bypass, automatic retry authorization by Claudexor, per-run idle field or installed CLI update; timers are not restored after daemon loss and native UI/vendor qualification remains limited.

- 23a74cb: Let any controlling MCP agent inspect and answer native worker approvals through
  the existing interaction tools. Codex workspace-write runs use native automatic
  review and can hand back one exact denied action for an explicitly authorized
  same-session retry, without changing managed policy or granting session-wide access.
  A request the worker withdraws itself emits `interaction.withdrawn`, closing the
  obsolete follow prompt or app card instead of blocking the next approval.

  A completed Codex turn's answer, including a structured WorkReport envelope,
  is kept before any handback; a denial that cannot be presented exactly is
  disclosed and stands natively instead of failing the run. A thread that settles
  in systemError never hands a denial back, authorizes it or starts another turn.

  The verified Codex pin moves from codex-cli 0.156.1 to 0.162.1. Its captured
  model snapshot makes `gpt-6.1-sol` the fallback default and a known model. An
  installed 0.156.1 no longer matches the snapshot provenance: without a live
  `model/list`, its effort snapshot is not trusted (no effort flag is sent) and
  no turn-input bound is published for it.

  Add revision-guarded live run time-limit read, set, extend and disable controls,
  soft warnings and optional inactivity-watchdog disabling. Existing explicit
  maxSeconds limits remain hard by default; omitting a limit adds no deadline, and
  `set` keeps the timer's current mode unless one is named. Inactivity windows
  longer than one Node timer delay are honored instead of firing immediately.

### Patch Changes

- Updated dependencies
- Updated dependencies [23a74cb]
  - @claudexor/schema@4.3.0
  - @claudexor/delivery@4.3.0
  - @claudexor/workspace@4.3.0
  - @claudexor/event-log@4.3.0
  - @claudexor/secrets@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/delivery@4.2.0
- @claudexor/event-log@4.2.0
- @claudexor/schema@4.2.0
- @claudexor/secrets@4.2.0
- @claudexor/util@4.2.0
- @claudexor/workspace@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/delivery@4.1.1
- @claudexor/event-log@4.1.1
- @claudexor/schema@4.1.1
- @claudexor/secrets@4.1.1
- @claudexor/util@4.1.1
- @claudexor/workspace@4.1.1

## 4.1.0

### Minor Changes

- Generate and edit images through subscription-backed Codex accounts as a payload kind of the existing caller-owned model operations. Upload an `ImageCallRequest` with `purpose: "model"` and create it with `POST /v2/model-operations?requestKind=image` (omission stays text): the same idempotency key, queue, SQL flush barrier before the provider request, cancellation, private result with 30-day unacknowledged retention and whole-result digest ACK serve both kinds, with no second scheduler and no subscription-to-API fallback. A failed barrier or a cancellation before the request reports that nothing was sent. `ImageCallResult` keeps the requested model apart from the provider-observed route model, the applied options, reported usage, unknown cash and every usable image with its verified MIME, size and digest; rejected siblings are named in the problem context instead of discarding the good ones. `GET /v2/model-sources?view=accounts` declares the source's structural `imageGeneration` facet, whose model ids are presence hints, not an entitlement. Quota constraints may declare `applies_to_request_kinds` (absent applies to both kinds): Codex `codex`/`default` windows are text and `image_gen` is image, an image 429 with an observed reset enters the registry as image-only evidence, and `GET /v2/quota` (including its resources and constraint-freshness views) and `POST /v2/quota` accept optional `requestKind` and `model`. Image windows stay visible in Accounts, labelled, but no longer drive text availability, the compact text percentage, the cooldown badge or a run's quota-pressure disclosure; legacy unscoped windows keep applying to both kinds until a newer measured scoped read replaces them. Unrecognised Codex full-read and rollout buckets are no longer recorded as quota constraints; notification payloads retain diagnostic evidence without guessed applicability. Request-kind availability selection is HTTP-only; CLI/MCP remain text-default. Live proof covers one generation and one edit through the real adapter on one managed account before the SQL store; SQL custody is covered by real-store tests over a synthetic endpoint, and other accounts' entitlement, image quota headers and the released live chain remain unverified. Thanks to @josephsteuerjr for the original image-operations contribution (#428).

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/delivery@4.1.0
  - @claudexor/event-log@4.1.0
  - @claudexor/workspace@4.1.0
  - @claudexor/secrets@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/delivery@4.0.1
- @claudexor/event-log@4.0.1
- @claudexor/schema@4.0.1
- @claudexor/secrets@4.0.1
- @claudexor/util@4.0.1
- @claudexor/workspace@4.0.1

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/event-log@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/delivery@4.0.0
  - @claudexor/workspace@4.0.0
  - @claudexor/secrets@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/delivery@3.25.1
- @claudexor/event-log@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/secrets@3.25.1
- @claudexor/util@3.25.1
- @claudexor/workspace@3.25.1

## 3.25.0

### Minor Changes

- Expose independently dated account resources and explicit Codex and Claude resets through the control API, CLI, MCP and native Accounts. Preserve original request identity through uncertain outcomes and keep provider results separate from resource refresh.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/delivery@3.25.0
  - @claudexor/event-log@3.25.0
  - @claudexor/workspace@3.25.0
  - @claudexor/secrets@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.24.0
  - @claudexor/delivery@3.24.0
  - @claudexor/workspace@3.24.0
  - @claudexor/event-log@3.24.0
  - @claudexor/secrets@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- Preserve typed idempotency lookup failures and safe underlying causes without losing same-key recovery. Pin canary daemons to the built candidate and retain fixture evidence when cleanup cannot prove the root inactive.
  - @claudexor/delivery@3.23.2
  - @claudexor/event-log@3.23.2
  - @claudexor/schema@3.23.2
  - @claudexor/secrets@3.23.2
  - @claudexor/util@3.23.2
  - @claudexor/workspace@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/delivery@3.23.1
- @claudexor/event-log@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/secrets@3.23.1
- @claudexor/util@3.23.1
- @claudexor/workspace@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/delivery@3.23.0
- @claudexor/event-log@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/secrets@3.23.0
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
  - @claudexor/delivery@3.22.1
  - @claudexor/event-log@3.22.1
  - @claudexor/workspace@3.22.1
  - @claudexor/secrets@3.22.1

## 3.22.0

### Minor Changes

- 51578d4: Continue a stopped run instead of restarting it: `POST /v2/runs {continueFrom: <runId>, continueCarrier?: "auto" | "packet"}` starts the next run of a continuation chain. Admission is one daemon-atomic rule shared by every ingress (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain `head`): the accepted successor command is the durable claim, so a predecessor has exactly one accepted successor, also across restarts and concurrent requests. Omitted mode, scope, execution, harness and model come from the predecessor, and the prompt is the caller's continuation text (it may be empty). The successor's first try is planned through the in-run continuation planner from the predecessor's session capsule and terminal facts — the same account resumes the vendor session by id, another account resumes the moved session, otherwise a fresh session is briefed with the evidence index — and is disclosed by a `run.continuity` receipt naming the predecessor and whether it runs in the same root. A stopped isolated Agent run now keeps its envelope (tree and scoped home, Claudexor-seeded auth removed) under a durable custody record until a successor adopts it, its result is applied or it is discarded; the crash sweep and disk retention keep it, and a run interrupted by a daemon restart with changes is kept the same way. `GET /v2/runs/:id` projects `resumable` (derived as `host_restart` for runs the daemon found running at its restart), the per-try `continuity` receipts, `retainedEnvelope` (disk use) and `continueFrom`; `continueFrom` is advertised in `runControlKeys`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/workspace@3.22.0
  - @claudexor/event-log@3.22.0
  - @claudexor/delivery@3.22.0
  - @claudexor/secrets@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/workspace@3.21.0
  - @claudexor/delivery@3.21.0
  - @claudexor/event-log@3.21.0
  - @claudexor/secrets@3.21.0

## 3.20.1

### Patch Changes

- 705c2c1: Preserve received assistant text and cancelled Git effects without changing completion authority or starting another generation. Show retained Markdown beneath the real failure or cancellation cause, recover interrupted output from its existing event log, and bind manual Revert to the captured execution tree.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/event-log@3.20.1
  - @claudexor/delivery@3.20.1
  - @claudexor/workspace@3.20.1
  - @claudexor/secrets@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/workspace@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/delivery@3.20.0
  - @claudexor/event-log@3.20.0
  - @claudexor/schema@3.20.0
  - @claudexor/secrets@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.19.0
  - @claudexor/delivery@3.19.0
  - @claudexor/workspace@3.19.0
  - @claudexor/event-log@3.19.0
  - @claudexor/secrets@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- @claudexor/delivery@3.18.0
- @claudexor/workspace@3.18.0
- @claudexor/event-log@3.18.0
- @claudexor/schema@3.18.0
- @claudexor/secrets@3.18.0
- @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Adapt Codex raw-model Ultra preferences to the strongest supported generation effort in the vendor order, preserve explicit effort evidence, and keep native Ultra delegation unchanged (#368).

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/delivery@3.17.2
  - @claudexor/event-log@3.17.2
  - @claudexor/workspace@3.17.2
  - @claudexor/secrets@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/delivery@3.17.1
  - @claudexor/event-log@3.17.1
  - @claudexor/workspace@3.17.1
  - @claudexor/secrets@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- 951489f: `POST /v2/runs` and Exact Retry for a project root that was never registered now answer a typed `404 project_not_registered` (not retryable, with the remedy: register the root with `POST /v2/projects` or declare `scope.ephemeral`) instead of a retryable `503 idempotency_status_unavailable`.
- Updated dependencies [951489f]
  - @claudexor/schema@3.17.0
  - @claudexor/delivery@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/event-log@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/delivery@3.16.0
  - @claudexor/event-log@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/secrets@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/delivery@3.15.1
- @claudexor/event-log@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/secrets@3.15.1
- @claudexor/util@3.15.1
- @claudexor/workspace@3.15.1

## 3.15.0

### Patch Changes

- @claudexor/delivery@3.15.0
- @claudexor/workspace@3.15.0
- @claudexor/event-log@3.15.0
- @claudexor/schema@3.15.0
- @claudexor/secrets@3.15.0
- @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/schema@3.14.0
  - @claudexor/delivery@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/event-log@3.14.0
  - @claudexor/secrets@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/delivery@3.13.0
- @claudexor/event-log@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/secrets@3.13.0
- @claudexor/util@3.13.0
- @claudexor/workspace@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/delivery@3.12.10
  - @claudexor/event-log@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/delivery@3.12.9
  - @claudexor/event-log@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/delivery@3.12.8
- @claudexor/event-log@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/secrets@3.12.8
- @claudexor/util@3.12.8
- @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/delivery@3.12.7
  - @claudexor/event-log@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/delivery@3.12.6
- @claudexor/event-log@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/secrets@3.12.6
- @claudexor/util@3.12.6
- @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/delivery@3.12.5
  - @claudexor/event-log@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/delivery@3.12.4
- @claudexor/event-log@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/secrets@3.12.4
- @claudexor/util@3.12.4
- @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/delivery@3.12.3
- @claudexor/event-log@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/secrets@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/delivery@3.12.2
  - @claudexor/event-log@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/secrets@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Reading ONE run no longer serializes every retained run. The daemon's retained-command list RPC takes an optional query addressing a single subject (one run id, or one parent's direct Delegate children) and selects before it redacts, so `GET /v2/runs/:id` stops recursively projecting the prompts of unrelated runs; the unqualified read and the global `GET /v2/runs` page are unchanged, and an engine older than the query answers in full so callers keep applying their own selection.
- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/delivery@3.12.1
  - @claudexor/event-log@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/secrets@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/delivery@3.12.0
  - @claudexor/event-log@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/secrets@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/delivery@3.11.0
  - @claudexor/event-log@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/secrets@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/delivery@3.10.5
- @claudexor/event-log@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/secrets@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Codex model operations carry the caller's live `x-codex-turn-state` transport continuation on the existing route-bound opaque envelope (opt-in per request, first successful header captured before the body, replayed unchanged on the matching route, empty on a changed route). Attempt telemetry, run telemetry and run summaries gain an additive normalized `input_token_usage` / `inputTokenUsage` object (complete input total, cache reads, cache writes; null stays unknown) folded strictly across contributions; legacy token fields keep their harness-specific meanings.
- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/delivery@3.10.4
  - @claudexor/event-log@3.10.4
  - @claudexor/secrets@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/delivery@3.10.3
- @claudexor/event-log@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/secrets@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/delivery@3.10.2
  - @claudexor/event-log@3.10.2
  - @claudexor/secrets@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/delivery@3.10.1
  - @claudexor/event-log@3.10.1
  - @claudexor/secrets@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.0
  - @claudexor/delivery@3.10.0
  - @claudexor/event-log@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/delivery@3.9.8
  - @claudexor/event-log@3.9.8
  - @claudexor/secrets@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/delivery@3.9.7
- @claudexor/event-log@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/secrets@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/delivery@3.9.6
- @claudexor/event-log@3.9.6
- @claudexor/schema@3.9.6
- @claudexor/secrets@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/delivery@3.9.5
- @claudexor/event-log@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/secrets@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/delivery@3.9.4
- @claudexor/event-log@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/secrets@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Preserve typed text-fragment metadata in delegated run timelines so hosts can join streamed words and whitespace without inserting event separators. Keep complete messages, tool events, final answers, and omission disclosures distinct.

  Allow release review by any two distinct approved model families on any harness, recording the actual model and harness while retaining exact-candidate evidence, independent reports, and signed attestation checks.

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/delivery@3.9.3
  - @claudexor/event-log@3.9.3
  - @claudexor/secrets@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/delivery@3.9.2
- @claudexor/event-log@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/secrets@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/delivery@3.9.1
- @claudexor/event-log@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/secrets@3.9.1
- @claudexor/util@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/delivery@3.9.0
  - @claudexor/event-log@3.9.0
  - @claudexor/secrets@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/delivery@3.8.4
- @claudexor/event-log@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/secrets@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/delivery@3.8.3
- @claudexor/event-log@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/secrets@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/delivery@3.8.2
- @claudexor/event-log@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/secrets@3.8.2
- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- 2794ec7: Remove the engine-owned outer Seatbelt wrapper and restore each harness's
  native access policy. Delegated mutating runs now keep stable project identity
  separate from their disposable execution workspace, active requests use
  `readonly`, `workspace_write`, or explicitly trusted `full`, and historical
  outer-confinement artifacts remain readable without enabling new retired-mode
  runs.
- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/event-log@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/event-log@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/delivery@3.7.0
- @claudexor/event-log@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/secrets@3.7.0
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
  - @claudexor/delivery@3.6.0
  - @claudexor/event-log@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/event-log@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/delivery@3.4.2
- @claudexor/event-log@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/delivery@3.4.1
- @claudexor/event-log@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/delivery@3.4.0
- @claudexor/event-log@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/delivery@3.3.16
- @claudexor/event-log@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/delivery@3.3.15
- @claudexor/event-log@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/delivery@3.3.14
- @claudexor/event-log@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/delivery@3.3.13
- @claudexor/event-log@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/delivery@3.3.12
- @claudexor/event-log@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/delivery@3.3.0
- @claudexor/event-log@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/delivery@3.2.1
- @claudexor/event-log@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Preserve typed run applicability, Git capability, safe durable refusal context and exact retry remedies, and one canonical terminal presentation across control projections.
- Preserve the deciding credential profile when projecting telemetry auth-route receipts.
- Keep upload, project, and retention request, service, and response failures distinct; malformed service responses now fail closed against their public schemas.
- Fence stale runless-turn replays across ordinary turns, Exact Retry, and
  decision reruns; preserve Exact Retry plan provenance and replay recorded
  risk decisions before a later turn's idle gate.
- @claudexor/delivery@3.2.0
- @claudexor/event-log@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/event-log@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Exact retry on a pre-start terminal run answers with its typed refusal (a 403,
  not a 202 handle), and the CLI retry and run-again paths read the refusal's
  actual problem message instead of an `error` field the daemon never serves.
- Updated dependencies
  - @claudexor/schema@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/event-log@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
  - @claudexor/schema@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/event-log@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/delivery@3.0.3
- @claudexor/event-log@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/delivery@3.0.0
- @claudexor/event-log@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/delivery@2.1.3
- @claudexor/event-log@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/delivery@2.1.2
- @claudexor/event-log@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/delivery@2.1.1
- @claudexor/event-log@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/secrets@2.1.1
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
  - @claudexor/secrets@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/event-log@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/delivery@2.0.2
- @claudexor/event-log@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/delivery@2.0.1
- @claudexor/event-log@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/delivery@2.0.0
- @claudexor/event-log@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Updated dependencies
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/event-log@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/delivery@0.14.0
- @claudexor/event-log@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/delivery@0.13.3
- @claudexor/event-log@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/delivery@0.12.1
- @claudexor/event-log@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
