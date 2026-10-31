# @claudexor/core

## 5.0.0

### Patch Changes

- 30caf39: Codex's native warnings now reach the run's event trail instead of only raising the dropped-event count. A `configWarning` (a recoverable configuration or initialization problem, such as the Linux bubblewrap user-namespace check Codex runs at startup) and a runtime `warning` each become one status event carrying the vendor's own text with its method and fields unchanged, except that a secret Codex quotes in the text or params is masked by the adapter. The event is stored in `events.jsonl` and appears on the Control timeline as an info row. A warning is evidence only: lifecycle, outcome, access and tool-error telemetry are unchanged, repeated warnings are not merged, and a frame without its text produces no event (the run counts it as dropped when it reads it). A warning the run had not read when it stopped, because `thread/start`, `turn/start` or a resume identity check refused it, or because it arrived while the settled run was read or its process stopped, is still delivered, in arrival order, before the run's terminal event. After an explicit Stop, Ask, Agent and Plan keep recording what the stopping run still reports, warnings included, within the one existing stream-cleanup bound instead of discarding it; those late events are stored evidence only, are not published live, and never become the cancelled attempt's final answer or tool-error verdict. Recorded assistant text can still appear in the diagnostic `final/retained-output.md` used by continuation; it does not make the run successful. In a directory run, files already written before Stop stay in the captured result even when their file-change events are read after Stop; a late raw patch is still neither accepted nor retained. A run stopped before its Codex process starts does not start it. This change does not make Codex's Linux sandbox work on hosts that restrict unprivileged user namespaces; it only keeps Codex's own report of the problem.
- f428c0a: A run pinned to a Cursor account no longer fails because `cursor-agent status` took more than 10 seconds on a busy host (#532). The pinned run now waits for that same status check until Cursor answers, the run is cancelled, or 120 seconds pass; with no answer it refuses with "Cursor did not confirm sign-in within 120s", and it still never starts on an unanswered or older answer and never moves to another account. Run admission passes the run's cancellation and the pin to the account probe through an optional argument of `probeCredentialProfile`; an explicit reviewer seat's account preflight does the same under the run's or the diff review's cancellation, and the spawn-time check waits only for a spec the engine stamped as an explicit pin. The status process belongs to a per-store coordinator: each caller waits on its own budget, one caller's cancellation ends only its own wait, the process is stopped as soon as no caller still waits for it (a positive it still returns afterwards is not kept, while a logged-out answer still revokes), and a Claudexor credential change answers pending waits unknown at once. The process does not carry the run marker of the run that started it, so cancelling that run no longer ends a status check another pinned run is still waiting for. Unpinned routing, Accounts, doctor and passes that carry no pin fact, such as the continuity summary, keep the 10-second decision; unpinned routing keeps the five-minute last-positive rule.
- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- 66d5b6a: Large results are now kept exactly, without a size ceiling (#535). Before, a result whose exact patch exceeded 256 MiB failed its capture. Every Git capture's canonical result is now Git objects identified by a typed digest (`git_objects/v1`), kept in a private per-project object store that is never an alternate of your repository; objects are imported into your repository only before an operation needs them. Results of every size are verified in a fresh private clone, applied onto the current state of your project (your unrelated changes are kept; paths changed on both sides follow `git apply` rules, except that an identical change on both sides is accepted outside rename and copy endpoints), committed or branched, and reverted on the actual delivery pair, keeping later edits outside it (a file the delivery added that your ignore rules now hide, or that sits inside a nested Git repository, is removed too, or the revert refuses if you changed it or cannot read it); a rendered result's `pr` passes the same publication scan as any `pr`, on the exact commit it pushes. Operator decisions and the apply gate bind the result's digest instead of the patch text. The patch becomes a view: when an estimate computed from the changed files' blob sizes exceeds the 256 MiB view limit, or the render itself overflows it, `final/patch.diff` is absent with a typed reason and a bounded inventory (never an empty file), `claudexor inspect`, the run summary, MCP results and the macOS Changes tab say so, and `pr` of such a result refuses typed (`pr_unrendered_result`) before any scan; scanning such a result for `pr` is a follow-up. Because that estimate is computed before rendering, a small edit of a very large file (one changed line in a 110 MiB file) also gets no patch view and `pr` refuses it; the result itself stays exact, deliverable and revertable. A delivery refused for a typed reason (`result_objects_missing`, `pr_unrendered_result`, a publication scan refusal, a conflict, a changed target, a store fault) answers that reason as the HTTP 409 problem code on `POST /v2/runs/:id/apply` and `accept_clean_patch` (a refusal with no typed reason answers `delivery_refused` on both), a replay with the same `Idempotency-Key` answers the same, and `apply/check` returns it as `refusal`, a store, Git or filesystem fault included; a run whose result record is there but cannot be read answers 503 `artifact_read_failed` on apply, apply/check and the decisions instead of "no patch artifact". For a Git result, a `commit`, `branch` or `pr` delivery that fails after writing now answers that HTTP 409 problem, where the last release answered such a failure with HTTP 200 `applied:false` (a legacy patch's delivery still does). A delivery that fails after writing is taken back on its retained pair, keeping later edits outside it (restored as Git holds it: a file whose checkout conversion does not round-trip, an LF file under `core.autocrlf` for one, can come back with converted bytes, which the receipt says); only a write that cannot be taken back stays, reported as `treeMutated` with the action that recovers it and recorded `applied_review_blocked` with a revert anchor instead of `not_applied`. A `pr` whose push fails returns the working tree to where HEAD was and keeps the commit on the local branch; when that checkout fails, the receipt says where HEAD stayed and how to return. A delivery never writes over what Git does not track: a file or directory at a path the result adds that your ignore rules hide refuses `delivery_path_occupied`, naming it, with nothing written, and `apply/check` answers the same (a new file in a directory that already exists still delivers, and so does a rename that only changes case; a hard link of a removed file is never taken for one). In a sparse checkout (cone or non-cone), a result that adds, changes or removes a path outside the sparse-checkout patterns refuses `delivery_outside_sparse_checkout`, naming those paths, with nothing written, and `apply/check` answers the same; the last release's `git apply` wrote such an added file, after which every later snapshot of that checkout failed. A revert that must change such a path, because you narrowed the patterns after the apply, refuses the same way. Widen the sparse checkout (`git sparse-checkout add`) to deliver or revert there. Every path a delivery, take-back or revert does not address keeps its bytes, including a clean file outside the patterns that has no skip-worktree mark (Git's own checkout would delete it), and its index mark, except that in a sparse checkout Git itself clears the skip-worktree mark of a file that is present, which sticks once a `branch`, `commit` or `pr` delivery writes the index; such a write also drops the assume-unchanged mark of a path it changes. This check uses `git sparse-checkout check-rules` (Git 2.41 or newer); with an older Git, a sparse checkout's deliveries, `apply/check` and reverts refuse `git_failed` before writing, naming the Git they need. A file you marked skip-worktree and then deleted counts as deleted, not as unchanged (except a file the sparse patterns leave out), so a revert brings back what a delivery deleted, refuses rather than undo your later deletion, and a delivery does not silently recreate it. A `branch`, `commit` or `pr` delivery commits the result onto HEAD and leaves what your assume-unchanged or skip-worktree marks hide (a local edit, a deleted file) on disk and out of the commit, their marks with them (but for the sparse-checkout case above); a result that changes such a file refuses `delivery_conflict`. A checkout that cannot fit refuses `space_insufficient` before its first write, and a store fault on the way there (the import, the snapshot, the composition) answers the same typed 409 instead of HTTP 400 or 500. A path the result changes whose name is not valid UTF-8 refuses `result_path_encoding` with nothing written, and so does its revert; a name only your project changed is never addressed, so it does not stop an unrelated result. Written paths are proven the way `git status` compares them, and every private proof, snapshot and checkout reads the bytes whatever your configuration or index marks say (`core.ignoreStat`, a filesystem monitor, an assume-unchanged mark); apply, its check and revert also read the paths they decide on by content rather than from the index's stat cache, so a file that kept its size and mtime is neither already applied nor called reverted (`branch`, `commit` and `pr` keep that cache for what they write, as `git checkout` does). A committed CRLF blob under `text=auto` or `core.autocrlf` applies and reverts, and a directory that becomes a file or symlink composes and a file that became a directory reverts on an unchanged target. When a patch render fails for a reason other than its size, the capture keeps the result with `patch_view.reason: render_failed`. Review and synthesis of a result with no patch view read a copy of its saved candidate tree, converted only as that tree's own attributes define with Git's defaults, in a private Git directory, never the workspace, so a configured check that rewrites an output, an attribute rule (tracked or in `.git/info/attributes`) or the repository's filter configuration cannot make review read different bytes than apply consumes (a filter driver is configuration the result does not carry, so a filtered file is read as its stored blob, as in the patch view: a Git LFS pointer or an encrypted blob is reviewed as stored, which says nothing about the content it stands for, and no smudged copy is kept); a changed file that copy cannot hold, a disk too full for it included, is named with its typed cause (`space_insufficient` for a full disk) to reviewers and synthesis, and the review cannot pass clean. A copy that fails holds none of the files: reviewers and synthesis get those causes and nothing to read, never what the failed copy left in its directory or a directory that is gone, and a copy that cannot be removed afterwards stays instead of ending the run, with a best-effort `<copy>.cleanup-error.json` saying why (on a disk too full to write that record whole, the leftover stays with its cleanup unconfirmed). After an earlier apply and revert, a later delivery that strands HEAD on its branch clears the old revert anchor, so `revert_run` refuses instead of answering a false success. A `revert_run` refused for anything but a later edit of what the run changed (the sparse patterns, a file it cannot read, a full disk, a Git fault) now answers `reverse_apply_failed` with its typed cause as `context.refusalCode`, instead of saying the revert is no longer available. Runs recorded by earlier releases keep their patch for apply and revert.
- f428c0a: Raw API and OpenRouter requests judge an explicitly chosen model by what the catalog actually answered and send the material the project requires within that model's limits.

  - A model catalog that could not be read is no longer reported as proof that an explicit model does not exist. The read is typed (no credential, a rejected key on 401/403, another HTTP status, network, timeout, a malformed or partial answer, including a `total_count` that does not match the rows) and uses the same key as the run. When the catalog is only unavailable or unusable, the explicitly chosen model is sent unchanged on that same key and every place that admits it says once that it could not be verified: the settings read-back notes, the doctor's readiness detail, the run's status event and the reviewer panel's preflight event. A missing or rejected key still refuses with code `model_catalog_unavailable` (category `auth`): nothing is sent, the run records that typed failure rather than a crashed harness, and the settings write answers HTTP 409 with `cause` and `httpStatus`. A catalog that answered without the model still refuses it. A failed read in the middle of a run does not discard what that run already read with the same credentials, meaning the same account and the same key (a key replaced during the run counts as another credential): the earlier read still decides the model and sizes the request to its known window, and the run says so. `claudexor models`, `claudexor capabilities` and `GET /v2/harnesses/:id/models` report the failure instead of an empty list or a count of zero.
  - OpenRouter's routing variants `:nitro`, `:floor` and `:exacto` of a listed model are accepted in any order OpenRouter documents (`m:free:nitro` and `m:nitro:free` need `m:free` listed) and sent unchanged, with a note that `:nitro` and `:floor` may bill a service-tier rate. Undeclared suffixes still need the exact id listed, and `:online`, which would make OpenRouter search the web, is refused whether or not the catalog can be read. The models listing now carries the declared variants, so the app can find the listed row of a variant id.
  - Model rows now carry the catalog's input modalities and completion limit. An image attached for a model whose catalog lists no image input is still sent, with one note that the provider decides.
  - Raw API patch requests include the project's `context.mandatory_files` complete and honour `include`/`exclude`. Each request is sized from the catalog read that admits its model, made with the key that request uses, and the image note reuses that read; a key replaced while the request is being prepared is used from the next request on. A raw API reviewer, named in the reviewer panel or chosen by the automatic one, likewise sends the key its panel's catalog read checked. An Agent run with `attempts` or `untilClean` now sends a raw API route the same packet, mandatory files and patch protocol as a single attempt, instead of a bare prompt that could never return a patch. The whole request is sized to the selected model's known context window minus instructions, prompt, protocol, attachments and an answer allowance (approximate characters/4 estimates), optional files are omitted deterministically and disclosed, and mandatory content that cannot fit refuses before the request is sent. When the window is unknown the previous 200 000-token selection ceiling still applies and is labelled as an assumption. A patch cut at the provider's output limit is reported as truncated. The sizes are typed for every surface: the run summary's `rawContext` gives the estimate of the request the final attempt last prepared (recorded just before its POST) and the budget its packet honoured, and an over-window refusal's failure record carries `rawContextShortfall` with the window, the request's parts and every mandatory file's estimate, plus next actions. The macOS app shows the estimate and the omitted optional files as run facts, and the refusal with its largest mandatory files.

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
  - @claudexor/util@5.0.0

## 4.8.2

### Patch Changes

- Updated dependencies [97e2f17]
- Updated dependencies [67b8833]
- Updated dependencies [f88a561]
  - @claudexor/schema@4.8.2
  - @claudexor/util@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/schema@4.8.1
- @claudexor/util@4.8.1

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
- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
- Updated dependencies [7dfbc42]
- Updated dependencies
  - @claudexor/schema@4.8.0
  - @claudexor/util@4.8.0

## 4.7.1

### Patch Changes

- 880081d: Record exact catalog proof for Cursor's display-label model. Attempts keep the raw `init.model` string in `observed_model` and, in `final/telemetry.yaml`, add `observed_model_catalog_match` (`label`, `id`, `source: account_catalog`, `profile_id`) when the account catalog that the same spawn's processing preparation read lists exactly one live row with that exact label, with no collision against a different row ID. The per-spawn model gate is the only author and strips any value it did not compute; the attempt keeps the proof of the event that set `observed_model`, never a later try's, the requested model's or a normalized match, and drops it when the Agent or Ask/report loop starts another native try or a later event reports another model, so proof from an earlier try cannot verify a later answer. A missing, empty, unmatched or ambiguous catalog leaves the field null. No vendor call is added, and admission, routing and `auth_route.model_mismatch` are unchanged. The `HarnessEvent` and `RunTelemetry` JSON Schemas gain the optional field.
- 8a9c2f6: On Windows, never hand a `.exe`/`.com` without the PE minimum shape (`MZ`, then `PE\0\0`) to the OS. The harness resolver skips such a PATH candidate or standard npm launcher target, naming the file, and uses a later healthy candidate; a broken Node interpreter is passed over for a later healthy one and named only when none remains. When nothing is selected, a bare-name spawn is refused before any process starts with `EFTYPE` if the install was proven broken, or if the spawn's own search (the cwd first, then PATH) would reach such a file; the message leads with that file. This covers the placeholder `claude.exe` an npm install leaves when the package's postinstall did not run. Windows PATH is read as libuv reads it: a quoted entry may contain `;`, and a child env without PATH searches the daemon's own PATH. Relative PATH entries resolve at the daemon's cwd for runs and probes alike, and the selected file is spawned by its absolute path; an explicitly relative override resolves from the spawn's cwd.

  Claude doctor and discovery report the unlaunchable file instead of "claude CLI not found on PATH", and the broken-install advisory shown by login and Codex doctor uses the same wording. The Claude auth-status probe treats a format failure (`EFTYPE`/`ENOEXEC`) as structural: one attempt, with no retry and no last-known-good fallback. Unreadable files, failed reads, busy or missing files and unknown loader errors keep their previous handling, and nothing about a refusal is remembered, so replacing the file recovers without a restart.

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
  - @claudexor/schema@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Minor Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/schema@4.6.2
- @claudexor/util@4.6.2

## 4.6.1

### Patch Changes

- @claudexor/schema@4.6.1
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
- Updated dependencies [a81897c]
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [032b44b]
  - @claudexor/schema@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0

## 4.3.1

### Patch Changes

- @claudexor/schema@4.3.1
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
  - @claudexor/schema@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/schema@4.2.0
- @claudexor/util@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/schema@4.1.1
- @claudexor/util@4.1.1

## 4.1.0

### Minor Changes

- Generate and edit images through subscription-backed Codex accounts as a payload kind of the existing caller-owned model operations. Upload an `ImageCallRequest` with `purpose: "model"` and create it with `POST /v2/model-operations?requestKind=image` (omission stays text): the same idempotency key, queue, SQL flush barrier before the provider request, cancellation, private result with 30-day unacknowledged retention and whole-result digest ACK serve both kinds, with no second scheduler and no subscription-to-API fallback. A failed barrier or a cancellation before the request reports that nothing was sent. `ImageCallResult` keeps the requested model apart from the provider-observed route model, the applied options, reported usage, unknown cash and every usable image with its verified MIME, size and digest; rejected siblings are named in the problem context instead of discarding the good ones. `GET /v2/model-sources?view=accounts` declares the source's structural `imageGeneration` facet, whose model ids are presence hints, not an entitlement. Quota constraints may declare `applies_to_request_kinds` (absent applies to both kinds): Codex `codex`/`default` windows are text and `image_gen` is image, an image 429 with an observed reset enters the registry as image-only evidence, and `GET /v2/quota` (including its resources and constraint-freshness views) and `POST /v2/quota` accept optional `requestKind` and `model`. Image windows stay visible in Accounts, labelled, but no longer drive text availability, the compact text percentage, the cooldown badge or a run's quota-pressure disclosure; legacy unscoped windows keep applying to both kinds until a newer measured scoped read replaces them. Unrecognised Codex full-read and rollout buckets are no longer recorded as quota constraints; notification payloads retain diagnostic evidence without guessed applicability. Request-kind availability selection is HTTP-only; CLI/MCP remain text-default. Live proof covers one generation and one edit through the real adapter on one managed account before the SQL store; SQL custody is covered by real-store tests over a synthetic endpoint, and other accounts' entitlement, image quota headers and the released live chain remain unverified. Thanks to @josephsteuerjr for the original image-operations contribution (#428).

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/schema@4.0.1
- @claudexor/util@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1

## 3.22.0

### Minor Changes

- 785bba7: Automatic continuation inside one attempt ("auto-rotation inside the work"). After a try that acted, a typed vendor limit hops the attempt to the next eligible account and the next process continues the same work: the claude/codex session file is moved into the target account's store and resumed there (`native_moved`), or — when it cannot be moved — a fresh session is re-grounded by a mechanical evidence index (`packet`); a transport death resumes the same session on the same account (`native`), bounded by `transient_retry.max_retries` per account. A partially acted attempt never replays its original prompt; the continued process receives one constant notice instead. Pinned accounts, `fail`/`ask` policies and a spent pool end typed. Every continued try settles with a `run.continuity` receipt (carrier, cause, accounts, memory, this try's attested model, identity check, input delivery) and every terminal whose work is unfinished carries `resumable` (cause, reset, carriers, native session, workspace) on the terminal event and in `final/resumable.yaml`. Adapters gain an optional `continuity` capability (`locate` / `move` / `rejectsCarriedState`); codex compares the recovered thread id before `turn/start`. The engine compares a resumed session's id with the requested one only on adapters with that capability (Claude Code and Codex keep the id on resume); other harnesses record a new id after a resume as before. A process that dies after it acted without ever reporting a session id continues on the same account with a packet re-brief, bounded by `transient_retry.max_retries`. Schema: `SessionCapsule`, `RunResumable`, `RunContinuityReceipt`; `RunEventType` gains `run.continuity`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Minor Changes

- 7c541ba: One effort word now works on Cursor and Antigravity too, where the level is a token of the compound model id. Given an effort preference, the adapter's preparation selects the listed level variant of the requested model's family from the inventory of the account that will run (`grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh`; `gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`): the family is the id with exactly one shared-order level token removed, `fast` and `thinking` stay in the family key so the choice never crosses fast/standard or thinking/no-thinking, a family exists only when the account lists two or more levels, and the level is placed by the shared preference order alone. One preparation yields the final id (the processing receipt's `submittedNative`, which is the `--model` argument) and the effort receipt (`parameter: --model`, `submitted` = level token), recorded once per spawn and per reviewer dispatch; the requested id stays in the model hint and in `attempts[].requested_model`. Nothing new refuses: an unknown word, an ambiguous id, a family-less id or an empty account list keep the id unchanged with an `omitted` receipt and a note. Antigravity rewrites only from the pinned account's live `agy models` list; the static hint list never authorizes a rewrite. Settings writes accept the preference for these routes, the existing fast-pair and paid policy run after the level choice, and the final telemetry `model_mismatch` compares the observation with the id actually sent.

### Patch Changes

- f0ab916: Make one effort word work on every route. The vendor's own order still ranks every level it lists; the shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) now places a word a route's ladder does not list, so `ultra` on a Claude binary that stops at `max` resolves downward to `max` and `none`/`minimal` resolve to the known minimum instead of refusing the run. The receipt names that placement and claims neither vendor support nor equal quality across vendors. One resolution result feeds the native flag, the typed receipt and the disclosure on Claude, Codex (sessions and raw model calls) and the ACP client, which now resolves `--effort` through the same resolver and records a receipt. A reviewer whose harness declares no effort controls keeps the preference as omitted with disclosure instead of failing the explicit panel or erasing the automatic panel's request. A word neither order knows is still refused before generation on routes that have a native effort knob.
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0

## 3.20.1

### Patch Changes

- eb506c1: Keep account refusal and recovery evidence consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results. Preserve independently measured Claude Code and Codex quota windows from running sessions without treating partial observations as a complete refresh. Retain safe native refusal and refresh diagnostics.
- dc30eda: Complete managed CLI and remote sign-in flows, preserve actionable Claude CLI version failures, and resolve native and standard npm Node entrypoints consistently across launch, probes and login.
- 705c2c1: Preserve received assistant text and cancelled Git effects without changing completion authority or starting another generation. Show retained Markdown beneath the real failure or cancellation cause, recover interrupted output from its existing event log, and bind manual Revert to the captured execution tree.
- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
  - @claudexor/schema@3.20.1
  - @claudexor/util@3.20.1

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

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- Claudexor ships as portable Claude Code and Cursor packages (`plugins/claude`, `plugins/cursor`) that carry the canonical Skill and the MCP server registration (no runtime, credentials, hooks or status-line collector; those stay with the managed `claudexor plugin install` integration), and the canonical Skill plus the managed-integration text describe `claudexor_accounts` truthfully (the plain call returns the cached listing; `fresh: true` is the expensive atomic snapshot). Production dependencies move to @agentclientprotocol/sdk 1.5.1, @modelcontextprotocol/server 2.2.0, @playwright/mcp 0.0.83, zod 4.6.5 and yaml 2.9.1; the release SBOM test reads the packaged Browser MCP version from packages/core instead of a literal.
- Updated dependencies
  - @claudexor/schema@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- b00408e: Request a hidden Windows console when the shared spawn helpers start background child processes (harness runs, capability and version probes, git capture). Interactive sign-in and `setup attach` keep their visible terminal.
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Minor Changes

- 092ec2b: Claude Code runs accept live messages: `POST /v2/runs/:id/messages` now reaches a running Claude Code attempt through the adapter's native stdin queue fold (`capability_profile.live_input = "next_tool_boundary"`).

  A message is written to the live stream-json stdin as a user frame carrying the message id as its `uuid`. Claude Code queues it at once (`command_lifecycle queued`, the `accepted` receipt) and consumes it inside the same turn right after the current tool batch; the `--replay-user-messages` echo (or the `started` lifecycle frame) is the consumption receipt (`delivered` when it settles a still-open request, otherwise the adapter's status event with code `live_input_delivered` keyed by `message_id`). A message that arrives while the model composes its final text runs as the next native turn of the same process: the run loop's new `session.onIo` seam and a `closeStdinOn` that returns false while a message is `queued|started` or a run-owned background task is open keep stdin open, the parser folds the second `system/init` into one `started` (a typed `native_turn_started` status marks the turn) and emits each result's cost as the delta of the cumulative `total_cost_usd`, and the last result's final text is the run's answer. No `queued` frame within 2 s answers `delivery_unknown`/`response_timeout`; a lost stdin answers `delivery_unknown`/`transport_lost`; a `cancelled|discarded|refused` lifecycle state is typed `live_input_refused` and never fails the run. Both flows were recorded on Claude Code 2.1.283 through the real adapter path (`packages/harness-claude/fixtures/stream-json/recorded-live-fold-2.1.283.jsonl`, `recorded-live-final-text-2.1.283.jsonl`) and are replayed 1:1 by the conformance tests. Cursor, Antigravity, OpenCode and raw-api keep `none`.

### Patch Changes

- Updated dependencies [951489f]
  - @claudexor/schema@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Minor Changes

- 3bc8af4: `claudexor harness install codex --target local` works on Windows, and doctor, login and runs resolve the image it installs.

  On Windows an npm global prefix holds only `.cmd`/sh/ps1 shims and no executable image, and Claudexor never spawns a harness through a shell (issue #191). The local target is therefore supported exactly where the pinned package yields a verified package-native image: `@openai/codex` resolves its `@openai/codex-win32-<arch>` platform package and executes `vendor/<triple>/bin/codex.exe`. Core's `runtime-env.ts` becomes the one owner of that layout (`npmGlobalPackagesDir`, `embeddedNpmCli`, `windowsNativeImageDir`, `managedWindowsNativeImageDirs`): the installer runs the embedded `node_modules/npm/bin/npm-cli.js` beside `node.exe`, forwards the Windows process-environment keys, anchors the managed root on the same `HOME` the harness PATH producer reads, and proves the image inside the prefix; the normalized harness PATH carries that image dir on win32 so every local surface resolves the same `codex.exe` by bare name. The receipt fields are unchanged. Claude, OpenCode, Cursor and Antigravity keep a typed `unsupported_platform` refusal on the Windows local target, now naming the exact reason; an unsupported architecture refuses the same way. The Windows CI lane installs the real pinned package on the exact embedded Node with no ambient node/npm and an isolated profile, then checks the receipt, direct and by-name `--version`, the idempotent recheck and `doctor --json` (`scripts/windows-local-install-smoke.mjs`). Linux and macOS behaviour is unchanged.

  Invariants: INV-067 (the same scoped env that spawns a run resolves the binary), INV-121/INV-122 (one layout owner reused by proof and PATH), INV-044 (typed refusals, no silent shim). No Bible change.

### Patch Changes

- @claudexor/schema@3.15.0
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

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/schema@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/schema@3.13.0
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
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Bind Windows interactive-login child standard handles to ConPTY instead of inherited parent pipes, with console-input and exact submitted-input checks.
- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/schema@3.9.6
- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/schema@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/schema@3.9.1
- @claudexor/util@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/schema@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/schema@3.8.2
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
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/schema@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Reset inactivity only for useful agent progress, normalize retry metadata, and harden process spawning without weakening cancellation ownership.
- The remote-runtime vendor PATH prefix (`~/.claudexor/remote/vendor/bin`) is probed only when the remote runtime marker is set; local runtimes never see it.
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/schema@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Engine honesty fixes: a delivered plan now survives an unrecovered tool error
  instead of being escalated to a harness error before finalization, an empty
  thrown message can no longer terminalize a failed harness run as a clean
  success, and the automatic economy-ranking pass reads one pinned clock for all
  candidates instead of a fresh timestamp per comparison.
- Updated dependencies
  - @claudexor/schema@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- 6e36993: Doctor and discover now explain WHY the codex CLI failed to resolve when the filesystem still holds evidence of an install: a dangling Homebrew symlink, a stripped exec bit, a directory shadowing the name, or a Caskroom/Cellar registration whose payload vanished — each with the exact `brew reinstall [--cask]` remediation. Diagnostic only: never gates a run, never executes a package manager. The codex doctor probes and diagnoses in the same scoped environment.
- Updated dependencies [c3b7ece]
  - @claudexor/schema@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

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
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/schema@2.0.0
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

## 0.14.0

### Patch Changes

- @claudexor/schema@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/schema@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/schema@0.12.1
