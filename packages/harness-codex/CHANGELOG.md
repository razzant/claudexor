# @claudexor/harness-codex

## 5.0.0

### Patch Changes

- dabf48c: Codex rollout reads are bounded and never follow a link. The observed model, the rollout quota, the vendor failure and session continuity read the native rollout in fixed 1 MiB chunks up to the size captured at open, carrying at most one 8 MiB line, so a very large or newline-dense rollout no longer makes the engine materialize the whole file or abort; a longer line is never parsed and, when it carries the reader's marker, counts like a torn record. A rollout part that is a link, or lies below a linked `sessions` or date directory, is never read or copied: it is still located, and moving it to another account fails with a reason. The run's `CODEX_HOME` is canonicalized first, so a home under a linked directory such as macOS `/tmp` or `/var` keeps working, including moves out of the default home, which were refused before. A move compares homes by directory identity: two spellings of one store, such as the default home and the profile the accounts migration registers for it, are the same home and nothing is copied, and the copy refuses a destination that is its own source before truncating it. One cursor per run serves the model and the quota, so looking again for a model that is not recorded yet reads only appended bytes instead of the whole history. On a resumed session the observed model now comes only from the turn the app-server started, also when a goal continuation's next turn is recorded before the next read: codex records that turn's model seconds after the turn begins, and before this change a resumed run could report the previous turn's model as its own.
- fe7e2ae: Codex MCP tool results keep what the server returned. A completed call now carries the text of its result, or its structured content when no text came back, as the bounded `content_summary`, so a Browser navigation records the page URL and title it actually loaded instead of only the tool name. A failed call keeps the vendor's `error.message`, or the text of a result the server marked as an error, instead of a generic "mcp tool call failed". A completion with any other status is no longer reported as a success; it stays statusless. Tool names and the `server:tool` target that Browser and Delegate evidence match are unchanged. In both Codex and Claude, an MCP result's `content_summary` now keeps the line breaks of the server's text, so a Browser result's page fields, code and snapshot stay on their own lines; whitespace within a line still collapses, blank lines are dropped, and the 1,000-character bound is unchanged. The `error_summary`, the event text and the summaries of all other tools stay on one line.
- 30caf39: Codex's native warnings now reach the run's event trail instead of only raising the dropped-event count. A `configWarning` (a recoverable configuration or initialization problem, such as the Linux bubblewrap user-namespace check Codex runs at startup) and a runtime `warning` each become one status event carrying the vendor's own text with its method and fields unchanged, except that a secret Codex quotes in the text or params is masked by the adapter. The event is stored in `events.jsonl` and appears on the Control timeline as an info row. A warning is evidence only: lifecycle, outcome, access and tool-error telemetry are unchanged, repeated warnings are not merged, and a frame without its text produces no event (the run counts it as dropped when it reads it). A warning the run had not read when it stopped, because `thread/start`, `turn/start` or a resume identity check refused it, or because it arrived while the settled run was read or its process stopped, is still delivered, in arrival order, before the run's terminal event. After an explicit Stop, Ask, Agent and Plan keep recording what the stopping run still reports, warnings included, within the one existing stream-cleanup bound instead of discarding it; those late events are stored evidence only, are not published live, and never become the cancelled attempt's final answer or tool-error verdict. Recorded assistant text can still appear in the diagnostic `final/retained-output.md` used by continuation; it does not make the run successful. In a directory run, files already written before Stop stay in the captured result even when their file-change events are read after Stop; a late raw patch is still neither accepted nor retained. A run stopped before its Codex process starts does not start it. This change does not make Codex's Linux sandbox work on hosts that restrict unprivileged user namespaces; it only keeps Codex's own report of the problem.
- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- Updated dependencies [f428c0a]
- Updated dependencies [66d5b6a]
- Updated dependencies [30caf39]
- Updated dependencies [d16170f]
- Updated dependencies [f428c0a]
- Updated dependencies [8bae6ae]
- Updated dependencies [66d5b6a]
- Updated dependencies [f428c0a]
- Updated dependencies [d9e7977]
- Updated dependencies [2d83b87]
- Updated dependencies [f428c0a]
- Updated dependencies [28dfe1a]
  - @claudexor/schema@5.0.0
  - @claudexor/core@5.0.0
  - @claudexor/util@5.0.0
  - @claudexor/secrets@5.0.0

## 4.8.2

### Patch Changes

- Updated dependencies [97e2f17]
- Updated dependencies [67b8833]
- Updated dependencies [f88a561]
  - @claudexor/schema@4.8.2
  - @claudexor/util@4.8.2
  - @claudexor/core@4.8.2
  - @claudexor/secrets@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/core@4.8.1
- @claudexor/schema@4.8.1
- @claudexor/secrets@4.8.1
- @claudexor/util@4.8.1

## 4.8.0

### Patch Changes

- 7dfbc42: Add document ingress over the existing upload owner. MCP gains the upload stage tools (`claudexor_upload_create`, `claudexor_upload_import_local`, `claudexor_upload_status`, `claudexor_upload_finalize`, `claudexor_upload_cancel`) with matching CLI verbs, and public runs, thread turns and continuations accept strict `attachments: [{resourceId}]` refs. Codex carries verified references for TXT, Markdown, JSON, PDF and DOCX; this is byte access with no parsing or OCR promise.

  A keyed import binds one source to one immutable resource under a saved store id and caller key: `claudexor_store_identity` and `claudexor_upload_import`, CLI `store-identity` and `upload-import`, and HTTP `POST /v2/uploads/imports`. A completed import replays its original resource before the client reads the source, even after the source changed or was deleted. Other arguments or other bytes under the same key are refused without effects, another store is refused before any effect, and verified bytes received before a lost reply or a daemon restart are published on replay. An import's interrupted or unverified transfer returns to `open` so the same key can resend it; ordinary uploads keep their single-shot cancellation. CLI runs take ready refs with `--attach-resource`.

  Existing callers see three behavior changes. CLI `--attach` now labels `.pdf` and `.docx` files `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (previously `application/octet-stream`), so lane admission matches those types. Codex now declares TXT, Markdown and JSON as well as PDF and DOCX file inputs, so Auto routing keeps Codex for runs that carry them where it used to drop it, and explicit pools that include Codex now admit them; Auto and pool choices for such runs can change. The Delegate belt's run tools accept `attachments: [{resourceId}]` refs, while the belt still exposes no upload controls.

- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
- Updated dependencies [7dfbc42]
- Updated dependencies
  - @claudexor/schema@4.8.0
  - @claudexor/core@4.8.0
  - @claudexor/util@4.8.0
  - @claudexor/secrets@4.8.0

## 4.7.1

### Patch Changes

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
- Updated dependencies [8a9c2f6]
  - @claudexor/schema@4.7.1
  - @claudexor/core@4.7.1
  - @claudexor/secrets@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Minor Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/core@4.7.0
  - @claudexor/secrets@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/core@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/secrets@4.6.2
- @claudexor/util@4.6.2

## 4.6.1

### Patch Changes

- @claudexor/core@4.6.1
- @claudexor/schema@4.6.1
- @claudexor/secrets@4.6.1
- @claudexor/util@4.6.1

## 4.6.0

### Patch Changes

- b344c39: Preserve U+2028 and U+2029 inside Codex run-adapter app-server JSON-RPC messages.
  Frame protocol stdout on LF and scan each incoming chunk once, without changing
  ordinary CLI line readers. Auxiliary auth, quota and login readers remain separate;
  see the Unicode framing follow-up in `docs/BACKLOG.md`.
- 2593b90: On Windows, background harness runs and captures start the vendor with an invisible
  console instead of none, so the shells, `git`, MCP servers and other console programs
  a run starts inherit it instead of opening windows of their own. Agy keeps the
  console-less start because its print mode treats an openable console input as
  interactive, and Claudexor's own `git` calls keep the console-less start they always
  had.
  Cancellation still stops the whole tree with `taskkill /T`, and a background child
  now also ends when the daemon process dies. The no-Terminal sign-in
  children (URL disclosure and the device-code app-server) open no console window, and
  Codex quota and model discovery, the install version proof and the `login --help`
  probe start their direct child hidden. The Node preload that defaulted `windowsHide`
  inside npm wrappers is removed: the inherited console covers those children.
- Updated dependencies [b344c39]
- Updated dependencies [a81897c]
- Updated dependencies [2593b90]
  - @claudexor/core@4.6.0
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0
  - @claudexor/secrets@4.6.0

## 4.5.0

### Patch Changes

- 032b44b: Demote Codex accounts for a model after a pre-generation refusal. A recognized capability refusal (`model_capability_refused`) marks the account at once; any other definite provider HTTP 4xx before generation on an auto operation (outside sign-in, timeouts, conflicts, rate and quota limits, the processing fallback, server failures and typed request faults) offers the same single correlated host retry, which becomes a confirmed mark when another account serves and marks nothing when it refuses too. Both kinds also record the shared pre-progress refusal observation, so Agent runs of that model order the account last as well, and an older in-flight refusal never undoes a newer model operation's service. Auto selection prefers accounts whose live catalog lists the model, then advisory misses, then accounts with only a soft observation (a recent refusal, or a served-model substitution of a non-preferred account), then capability-marked accounts; history bound to an unmarked, unrefused preferred account stays on that account. Refusal problems carry `modelMarks` (each live mark with the start of its episode) and `alternativeRemains` (whether another selectable account without a mark remains). Routing receipts (`captureRoutingEvidence=true` on `POST /v2/model-operations`) and capability rows (`includeCapabilities=true` on `GET /v2/accounts/routing-evidence`) are opt-in over HTTP, so strict 4.4.0 clients keep their shapes; Claudexor's own CLI and MCP readers request the rows. Behavior change: the recognized Codex refusals (an explicit `model_not_found` or `model_not_supported` code, the ChatGPT-account unsupported-model sentence, the narrow missing-model sentences) now return `model_capability_refused` instead of `invalid_request` or `model_unavailable` (an explicit vendor `model_not_found` still records the model-scoped unusable verdict), and `preferredProfileId` no longer wins over a listed account or over its own mark or recent refusal; history bound to that account keeps it first over a catalog miss only while it has neither.
- Updated dependencies [032b44b]
  - @claudexor/schema@4.5.0
  - @claudexor/core@4.5.0
  - @claudexor/secrets@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).
- A fresh managed Codex install resolves npm `latest` once to an exact version, discloses it and installs exactly that version; `--release-tested` uses the release baseline, a latest older than that baseline refuses (`latest_older_than_tested`), and `pinnedVersion` now names the selected install target. Thanks to @josephsteuerjr (#476).

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/core@4.4.0
  - @claudexor/secrets@4.4.0

## 4.3.1

### Patch Changes

- @claudexor/core@4.3.1
- @claudexor/schema@4.3.1
- @claudexor/secrets@4.3.1
- @claudexor/util@4.3.1

## 4.3.0

### Minor Changes

- Ordinary Codex Fast (`fast`/`priority`) on a verified ChatGPT subscription is included service under no-paid routing and every cash cap, including `finite(0)`; verified Codex subscription work now reports its cash as unknown (`spendUsd` and `budget_summary.spend_usd` null, cost basis `debit: "unobserved"`) beside the cap-governed `controllableSpendUsd` instead of exact zero, and without a preference keeps the first account's chosen speed across retries, Exact Retry, rotation and continuation (#468, thanks @IlidanNaga). Codex catalogs keep a declared `inputModalities` list only when it is wholly valid and non-empty, as metadata that gates no request (#435, thanks @josephsteuerjr). The opt-in `GET /v2/quota?view=resources_freshness` view adds a required `availability_scope` echo, Cursor accounts report dated display-only monetary resources from Cursor's internal dashboard through the existing refresh cycle, and Antigravity's native headless permission auto-denial becomes typed `permission_denial` evidence without retry or access elevation (#467).

  Codex workspace-write uses native on-request with auto_review by default and an explicit one-action retry handback; HTTP/MCP can revise the existing live soft/hard timer, and configuration can disable only inactivity timing with null (#466, thanks @IlidanNaga). This adds no session-wide grant, readonly bypass, automatic retry authorization by Claudexor, per-run idle field or installed CLI update; timers are not restored after daemon loss and native UI/vendor qualification remains limited.

### Patch Changes

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

- Updated dependencies
- Updated dependencies [23a74cb]
  - @claudexor/core@4.3.0
  - @claudexor/schema@4.3.0
  - @claudexor/secrets@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/core@4.2.0
- @claudexor/schema@4.2.0
- @claudexor/secrets@4.2.0
- @claudexor/util@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/core@4.1.1
- @claudexor/schema@4.1.1
- @claudexor/secrets@4.1.1
- @claudexor/util@4.1.1

## 4.1.0

### Minor Changes

- Generate and edit images through subscription-backed Codex accounts as a payload kind of the existing caller-owned model operations. Upload an `ImageCallRequest` with `purpose: "model"` and create it with `POST /v2/model-operations?requestKind=image` (omission stays text): the same idempotency key, queue, SQL flush barrier before the provider request, cancellation, private result with 30-day unacknowledged retention and whole-result digest ACK serve both kinds, with no second scheduler and no subscription-to-API fallback. A failed barrier or a cancellation before the request reports that nothing was sent. `ImageCallResult` keeps the requested model apart from the provider-observed route model, the applied options, reported usage, unknown cash and every usable image with its verified MIME, size and digest; rejected siblings are named in the problem context instead of discarding the good ones. `GET /v2/model-sources?view=accounts` declares the source's structural `imageGeneration` facet, whose model ids are presence hints, not an entitlement. Quota constraints may declare `applies_to_request_kinds` (absent applies to both kinds): Codex `codex`/`default` windows are text and `image_gen` is image, an image 429 with an observed reset enters the registry as image-only evidence, and `GET /v2/quota` (including its resources and constraint-freshness views) and `POST /v2/quota` accept optional `requestKind` and `model`. Image windows stay visible in Accounts, labelled, but no longer drive text availability, the compact text percentage, the cooldown badge or a run's quota-pressure disclosure; legacy unscoped windows keep applying to both kinds until a newer measured scoped read replaces them. Unrecognised Codex full-read and rollout buckets are no longer recorded as quota constraints; notification payloads retain diagnostic evidence without guessed applicability. Request-kind availability selection is HTTP-only; CLI/MCP remain text-default. Live proof covers one generation and one edit through the real adapter on one managed account before the SQL store; SQL custody is covered by real-store tests over a synthetic endpoint, and other accounts' entitlement, image quota headers and the released live chain remain unverified. Thanks to @josephsteuerjr for the original image-operations contribution (#428).

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/core@4.1.0
  - @claudexor/secrets@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/core@4.0.1
- @claudexor/schema@4.0.1
- @claudexor/secrets@4.0.1
- @claudexor/util@4.0.1

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/core@4.0.0
  - @claudexor/secrets@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/core@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/secrets@3.25.1
- @claudexor/util@3.25.1

## 3.25.0

### Minor Changes

- Expose independently dated account resources and explicit Codex and Claude resets through the control API, CLI, MCP and native Accounts. Preserve original request identity through uncertain outcomes and keep provider results separate from resource refresh.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/secrets@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/secrets@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/core@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/secrets@3.23.2
- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/core@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/secrets@3.23.1
- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/core@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/secrets@3.23.0
- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/core@3.22.1
  - @claudexor/secrets@3.22.1

## 3.22.0

### Minor Changes

- 785bba7: Automatic continuation inside one attempt ("auto-rotation inside the work"). After a try that acted, a typed vendor limit hops the attempt to the next eligible account and the next process continues the same work: the claude/codex session file is moved into the target account's store and resumed there (`native_moved`), or — when it cannot be moved — a fresh session is re-grounded by a mechanical evidence index (`packet`); a transport death resumes the same session on the same account (`native`), bounded by `transient_retry.max_retries` per account. A partially acted attempt never replays its original prompt; the continued process receives one constant notice instead. Pinned accounts, `fail`/`ask` policies and a spent pool end typed. Every continued try settles with a `run.continuity` receipt (carrier, cause, accounts, memory, this try's attested model, identity check, input delivery) and every terminal whose work is unfinished carries `resumable` (cause, reset, carriers, native session, workspace) on the terminal event and in `final/resumable.yaml`. Adapters gain an optional `continuity` capability (`locate` / `move` / `rejectsCarriedState`); codex compares the recovered thread id before `turn/start`. The engine compares a resumed session's id with the requested one only on adapters with that capability (Claude Code and Codex keep the id on resume); other harnesses record a new id after a resume as before. A process that dies after it acted without ever reporting a session id continues on the same account with a packet re-brief, bounded by `transient_retry.max_retries`. Schema: `SessionCapsule`, `RunResumable`, `RunContinuityReceipt`; `RunEventType` gains `run.continuity`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/secrets@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- b7439d3: Codex app-server runs bind finality to the root thread. Frames of native sub-agent threads (codex proactive multi-agent mode) stay on the timeline tagged with their thread, their tokens stay counted and their text becomes a status row, but they never supply the final answer, the terminal turn, the steer target or a root failure; after the root turn completes, settlement is re-checked on any frame or after the poll interval.
- f0ab916: Make one effort word work on every route. The vendor's own order still ranks every level it lists; the shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) now places a word a route's ladder does not list, so `ultra` on a Claude binary that stops at `max` resolves downward to `max` and `none`/`minimal` resolve to the known minimum instead of refusing the run. The receipt names that placement and claims neither vendor support nor equal quality across vendors. One resolution result feeds the native flag, the typed receipt and the disclosure on Claude, Codex (sessions and raw model calls) and the ACP client, which now resolves `--effort` through the same resolver and records a receipt. A reviewer whose harness declares no effort controls keeps the preference as omitted with disclosure instead of failing the explicit panel or erasing the automatic panel's request. A word neither order knows is still refused before generation on routes that have a native effort knob.
- a4ff572: Reconcile older quota refusals with newer account observations, preserve genuine credential rejections without duplicating poller state, and pace quota reads per affected account. Ordinary Accounts and account-catalog reads retain their first observation instead of repeatedly probing vendors. Discover Antigravity models for the selected account, forward explicitly requested unlisted models with disclosure, and preserve known quota-family applicability for new model IDs.
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/core@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/secrets@3.21.0

## 3.20.1

### Patch Changes

- eb506c1: Keep account refusal and recovery evidence consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results. Preserve independently measured Claude Code and Codex quota windows from running sessions without treating partial observations as a complete refresh. Retain safe native refusal and refresh diagnostics.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/secrets@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0
  - @claudexor/secrets@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/secrets@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Preserve native Codex app-server retry notices as nonterminal activity without changing successful or failed turn outcomes. Thanks to @kzmx23 for investigating the Windows reconnect behavior and preparing the original contribution.
- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/secrets@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Adapt Codex raw-model Ultra preferences to the strongest supported generation effort in the vendor order, preserve explicit effort evidence, and keep native Ultra delegation unchanged (#368).

- Preserve native input-size refusals without account retries or unrelated quota resets, publish measured ASK input budgets, distinguish proven undelivered Codex model requests, and move large Claude and AGY inputs off process arguments.
- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/secrets@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/secrets@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- de234bd: Keep Codex runs active across native goal continuations and run-owned background terminals, and make Stop interrupt that work through the app-server lifecycle.
- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/secrets@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/core@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/secrets@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/secrets@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Minor Changes

- fb42a94: Model admission is the harness's own declaration, honoured on every list it owns.

  `model_inventory_absence` used to govern only a live `models()` answer; every manifest hint list stayed strict by construction, so a settings write, the doctor's configured-model check and the explicit reviewer panel refused any id the shipped list lacked (and `claudexor models` could show nothing beyond that list), so a new vendor model needed a Claudexor release to become usable through them (#338, #340). `validateModel` now takes the list, its source and the declaration with no defaults; the manifest branches of the run gate and the reviewer panel read the declaration; one registry gate (`checkHarnessModel`) replaces the four hand-built copies in the settings write, doctor readiness and the capability catalog.

  Claude, Codex and Cursor declare `advisory` (cursor gains the declaration here; claude's producer lands beside it): their lists prove presence, never absence, so an unlisted explicit model is persisted or forwarded byte-identical and the vendor decides. Each admitting consumer says so once: the settings read-back carries server-owned `notes` (the CLI prints them), the readiness row carries the note in its detail (the text `doctor` prints it too), the per-spawn gate keeps its status event; the agent capability catalog's `configuredModelValid` stays a boolean that reports such an admission as valid without the note (its description says so). raw-api, agy and opencode stay authoritative; the automatic reviewer panel keeps skipping an unlisted family at zero cost; HTTP model operations stay strict against the account catalog read at a named client version. Refusals state observations (which account supplied which list, how many models) instead of guessing a cause such as re-authentication.

  Invariants: INV-104 amended with the owner's approval of 2026-09-24 (CONCEPT-CHANGE): absence is a per-harness declaration honoured on live and manifest lists alike; the settings-write-strict canary moves to agy and `[INV-104:settings-write-advisory]` pins the codex path. INV-105 unchanged (the per-spawn disclosure stays). INV-020/INV-022 hold: `notes` has a producer (the settings write) and readers (the CLI, the canary).

### Patch Changes

- 7e615b6: The Codex HTTP model transport declares its own verified client version when it reads an account's model catalog, instead of the managed-installer pin.

  The Codex backend filters `GET /backend-api/codex/models` by the `client_version` the caller declares: a model is listed only for clients at or above that model's minimum version. Claudexor's raw model transport sent the installer pin (`CODEX_VENDOR_CLI_VERSION`, 0.153.3), so a newly floored model such as `gpt-6-sol` was absent from the catalog and refused as `model_unavailable`, while the same account and the same request shape generated with it (issue #339). A release that only moved the installer therefore decided which models an account could see through this route.

  `CODEX_HTTP_CLIENT_VERSION` (0.156.1) is the version this release's catalog parser and Responses projection were verified against; it is raised to the installed Codex CLI's version when that is newer, never lowered, and an unparseable version falls back to the constant because the parameter is required. The value is memoised per binary identity, so an in-place CLI upgrade is seen on the next catalog read. The negotiated account view (`?view=accounts`) carries `clientVersion` and `clientVersionSource` per catalog (`verified_transport` or `installed_cli`; null for catalogs from an older engine) while the legacy `GET /model-sources/:id/models` keeps its pre-existing shape, and both membership refusals — account selection and invocation — name the declared version so a miss is not read as an account or login problem. The catalog stays strict: its rows are the request contract (efforts, service tiers, windows). A recorded fixture pair (`fixtures/models-http-0.153.3.json`, `models-http-0.156.1.json`) pins that every row present at both versions is identical and only `gpt-6-sol`/`gpt-6-luna` were added, with the default unchanged; bumping the constant re-records the pair.

  Invariants: INV-104 is unchanged (HTTP model operations stay strict against the account catalog, now read at a named client version). INV-020/INV-022 hold: the two schema fields are produced by the transport, read by both membership refusals (`describeCodexClientVersion`) and returned on the account-view wire. The managed installer pin keeps its two other meanings (install target, fixture/effort-snapshot stamp).

- 7ab3c95: Pin the managed harness installer to Claude Code 2.1.281 and Codex 0.156.1, so a fresh managed Codex install can run GPT-6 Sol and GPT-6 Luna, which Codex 0.153.3 neither lists nor runs on a ChatGPT account. The Codex effort snapshot and manifest hints add both models from a live 0.156.1 `model/list` capture (the default stays GPT-6 Astra; older ladders are kept under the snapshot's union rule), and the Claude `--help` effort ladder was re-captured from 2.1.281 unchanged. Stream recordings that need no paid call and no credentials were re-recorded from the pinned binaries; recordings that need a paid live run or a real vendor incident keep the version they were captured from. The Claude known-model hint list keeps its last actual verification stamp (2.1.261) instead of following the pin. An already-installed CLI is not replaced; on an install that keeps 0.153.3 / 2.1.261 the recorded effort snapshot no longer vouches for that CLI, so a run whose live effort probe fails proceeds at the vendor default with the ignored-settings disclosure (INV-105).
- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/secrets@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/core@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/secrets@3.13.0
- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- A run's failure record carries the vendor's own failure code beside its words.

  When a Codex turn fails, `codex exec --json` delivers only the vendor's sentence, while Codex's own rollout record of the same thread keeps a machine-readable code (a capacity refusal is `server_overloaded`). Claudexor labelled such a run a process crash, advised that the harness process crashed, and reported the configured retry ceiling as if two retries had run.

  `RunFailure` gains one optional, nullable object, `vendorFailure: { code, message, source }`: the vendor's code and words, read fail-soft from the rollout after the process exited, bound to the current turn, `null` on any doubt and for every harness without such a channel. The code is opaque evidence: nothing in Claudexor branches on its value, and it is not a member of `RunFailureCode`.

  The shared run loop records a typed terminal fact, `harness_reported_error`, only when the harness's own stdout frames produced an error event. A harness that voiced its own error and then exited non-zero is classified `unknown_harness_error` with an explicit `retryable: false` instead of `process_crash`; a signal kill, a spawn failure and a silent non-zero exit keep their labels. Retry, rotation, cooldown and credential condemnation read exactly the inputs they read before. `route.transient.exhausted` reports the observed retries beside the configured maximum.

  Invariants: none amended. INV-013, INV-046 and INV-049 hold (typed adapter evidence, no prose governance); INV-104's disclosed residual stays literally true, and the new field is additive evidence beside it. INV-020 and INV-022 hold: the schema field ships with its producer (the Codex adapter and the terminal writers) and its consumers (the failure record and the CLI inspect line). The app compatibility floor is unchanged.

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- 125aea9: A Codex model list that omits a model no longer refuses a run that asks for it.

  The vendor CLI fetches its model list remotely and falls back to a bundled default list when that fetch times out, and nothing on the wire says which list answered. Claudexor treated the answer as account truth, so an explicit model the list lacked was refused before dispatch, in under a second, as an untyped failure. Observed live: `gpt-6-astra` was refused 32 times over two days on thirteen accounts that ran it successfully 262 times in the same window, and an empty answer refused the same way.

  A harness now declares what its live inventory proves. The new optional manifest capability `model_inventory_absence` defaults to `authoritative`, which is today's strict behaviour for every harness; Codex declares `advisory`, because its list can prove a model is present but never that one is absent. On an advisory source a missing (or empty) list stops being a refusal: the explicit model is forwarded to the vendor exactly as asked, the vendor accepts or refuses it, and the per-spawn gate discloses once, in the run's events, that the model was not listed. The same decision now serves the explicit reviewer panel, so an owner-chosen reviewer model is no longer refused by a stale list either.

  Nothing else moved. Manifest truth stays strict and is never substituted to admit a model, settings writes and the doctor's configured-model check still read the manifest and still refuse, automatic reviewer selection still skips an unlisted family at zero cost, authenticated account catalog operations still return a typed `model_unavailable`, pinned accounts still never rotate, and the probe cache and its TTL are unchanged.

  Three consequences are worth stating plainly. The explicit reviewer panel forwards an unlisted model without the run-event disclosure, because a reviewer spawn does not pass through the per-spawn gate. A vendor CLI that refuses a forwarded model reports it as an ordinary error carrying the vendor's own text, not as a typed model failure (only the HTTP model operations are typed, and those stay strict). And a mistyped model name on such a harness now costs one spawn at the vendor instead of failing for free at the gate.

  Invariants: INV-104 is amended with the owner's explicit approval of 2026-09-21 — strict wherever the truth source can prove absence, forward and disclose where it cannot, and never substitute one list for another. INV-105 follows from it: an explicit model can now reach a route its truth source could not vouch for, and the run discloses that instead of staying silent. INV-020 (schema first, regenerate, then consumers) and INV-022 (a field ships with its producer and consumer) hold: the capability is declared by the Codex manifest and read by the model gate and the reviewer panel in this change. The app compatibility floor is unchanged.

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- Record parsed SSE event timing separately from later byte chunks so heartbeat or unfinished-frame traffic cannot hide event silence after an interrupted Codex response. Preserve unknown custody and the existing no-retry policy.
  - @claudexor/core@3.12.8
  - @claudexor/schema@3.12.8
  - @claudexor/secrets@3.12.8
  - @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Restore adapter-created nulls for optional review fields before original-schema validation, preserving the caller contract and substantive findings. Codex Responses failure evidence now records monotonic chunk timing and deterministic interrupted-stream diagnostics without adding automatic retries.
- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- Keep a live Codex turn across a response that names no model, so a refused or torn body no longer starts a fresh vendor conversation on the next request.
  - @claudexor/core@3.12.6
  - @claudexor/schema@3.12.6
  - @claudexor/secrets@3.12.6
  - @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- State a served-model mismatch on a model operation as the typed `modelMismatch` result fact without changing its outcome, rank an account that recently answered a model's request with a different model after the other selectable accounts for later Auto selections (a 30-minute in-memory observation that never excludes an account, a pin or a preferred account), and send a turn the same account served with another model through its canonical content and tool calls instead of refusing the next request with `invalid_continuation`.
- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- 67c7a71: Use the shared harness environment for Codex model discovery and quota probes so GUI-launched installs can find the same CLI and Node runtime as sign-in and agent execution.
  - @claudexor/core@3.12.4
  - @claudexor/schema@3.12.4
  - @claudexor/secrets@3.12.4
  - @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/core@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/secrets@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/secrets@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/secrets@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/secrets@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/secrets@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/core@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/secrets@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Codex model operations carry the caller's live `x-codex-turn-state` transport continuation on the existing route-bound opaque envelope (opt-in per request, first successful header captured before the body, replayed unchanged on the matching route, empty on a changed route). Attempt telemetry, run telemetry and run summaries gain an additive normalized `input_token_usage` / `inputTokenUsage` object (complete input total, cache reads, cache writes; null stays unknown) folded strictly across contributions; legacy token fields keep their harness-specific meanings.
- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/secrets@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- Expose successful upstream Codex catalog contact through the existing provenance and observation-time fields while preserving strict old-client compatibility.
  - @claudexor/core@3.10.3
  - @claudexor/schema@3.10.3
  - @claudexor/secrets@3.10.3
  - @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/secrets@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/secrets@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Support GPT-6 Astra through Ultra, pin Codex CLI 0.153.3, and refresh native stream recordings including nonterminal SSE timeout retries. Keep unpriced token usage unknown and retire incompatible saved cost averages instead of using generic fallback tariffs.
- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/secrets@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/core@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/secrets@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/core@3.9.6
- @claudexor/schema@3.9.6
- @claudexor/secrets@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/core@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/secrets@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/core@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/secrets@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/secrets@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/core@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/secrets@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/core@3.9.1
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
  - @claudexor/core@3.9.0
  - @claudexor/secrets@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/core@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/secrets@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/core@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/secrets@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/core@3.8.2
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
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/core@3.7.0
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
  - @claudexor/core@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/core@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/core@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/core@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/core@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/core@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/core@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/core@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/core@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/core@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/core@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Translate native reconnect and retry signals into the shared typed run contract.
- Duplicate native `started` lifecycle frames are recognized and skipped so an attempt emits exactly one started event (fixture-pinned).
- @claudexor/core@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Effort ladders are per (harness, model) and follow the vendor-advertised order.
  Levels are discovered live from each CLI (with a snapshot fallback when a probe
  is unavailable), the full official vocabularies are supported, and a level the
  run cannot honor is disclosed instead of silently clamped. A profile-scoped run
  is no longer held to the default account's ladder, and hint-less runs resolve
  against the default model's own ladder.
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- 6e36993: Doctor and discover now explain WHY the codex CLI failed to resolve when the filesystem still holds evidence of an install: a dangling Homebrew symlink, a stripped exec bit, a directory shadowing the name, or a Caskroom/Cellar registration whose payload vanished — each with the exact `brew reinstall [--cask]` remediation. Diagnostic only: never gates a run, never executes a package manager. The codex doctor probes and diagnoses in the same scoped environment.
- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/core@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/core@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/core@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/core@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/core@2.1.1
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
  - @claudexor/core@2.1.0
  - @claudexor/secrets@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/core@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/core@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/core@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/secrets@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/core@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/secrets@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/core@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/secrets@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/core@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/secrets@0.12.1
- @claudexor/util@0.12.1
