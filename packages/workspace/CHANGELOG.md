# @claudexor/workspace

## 5.0.1

### Patch Changes

- @claudexor/core@5.0.1
- @claudexor/event-log@5.0.1
- @claudexor/schema@5.0.1
- @claudexor/util@5.0.1

## 5.0.0

### Patch Changes

- 66d5b6a: A run whose changes cannot be captured no longer ends as `failed / workspace_unavailable` with advice to retry the run. When capture fails, for example for lack of disk space, on a Git process that stalls or is killed, on a file that cannot be read, on a missing object, or on an I/O or scratch fault, the run ends `failed` with the new reason `capture_refused` ("Failed (changes not captured)") and its capture failure keeps the typed cause. The refusal names what was not recorded (the exact result, a revert point for live changes, apply eligibility, and the configured checks and requested review, which did not run) and what is kept (the final answer, which stays the diagnostic primary output, run-produced media, and the changed files in place or in the retained isolated source); its next actions no longer suggest retrying the run. Completed work whose only defect is the capture is no longer published as resumable; a harness error, a cancellation or an unfinished work state still is. Screenshots and other produced media are now kept on a refusal: the run copies them and in-place cleanup leaves the run's artifact directory. When the capture had written its candidate tree, a separate bounded pass records a non-exact `inventory` of the largest changed files (path, change kind, size) on the capture failure; `claudexor inspect` and the run summary print it.
- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- 66d5b6a: Large results are now kept exactly, without a size ceiling (#535). Before, a result whose exact patch exceeded 256 MiB failed its capture. Every Git capture's canonical result is now Git objects identified by a typed digest (`git_objects/v1`), kept in a private per-project object store that is never an alternate of your repository; objects are imported into your repository only before an operation needs them. Results of every size are verified in a fresh private clone, applied onto the current state of your project (your unrelated changes are kept; paths changed on both sides follow `git apply` rules, except that an identical change on both sides is accepted outside rename and copy endpoints), committed or branched, and reverted on the actual delivery pair, keeping later edits outside it (a file the delivery added that your ignore rules now hide, or that sits inside a nested Git repository, is removed too, or the revert refuses if you changed it or cannot read it); a rendered result's `pr` passes the same publication scan as any `pr`, on the exact commit it pushes. Operator decisions and the apply gate bind the result's digest instead of the patch text. The patch becomes a view: when an estimate computed from the changed files' blob sizes exceeds the 256 MiB view limit, or the render itself overflows it, `final/patch.diff` is absent with a typed reason and a bounded inventory (never an empty file), `claudexor inspect`, the run summary, MCP results and the macOS Changes tab say so, and `pr` of such a result refuses typed (`pr_unrendered_result`) before any scan; scanning such a result for `pr` is a follow-up. Because that estimate is computed before rendering, a small edit of a very large file (one changed line in a 110 MiB file) also gets no patch view and `pr` refuses it; the result itself stays exact, deliverable and revertable. A delivery refused for a typed reason (`result_objects_missing`, `pr_unrendered_result`, a publication scan refusal, a conflict, a changed target, a store fault) answers that reason as the HTTP 409 problem code on `POST /v2/runs/:id/apply` and `accept_clean_patch` (a refusal with no typed reason answers `delivery_refused` on both), a replay with the same `Idempotency-Key` answers the same, and `apply/check` returns it as `refusal`, a store, Git or filesystem fault included; a run whose result record is there but cannot be read answers 503 `artifact_read_failed` on apply, apply/check and the decisions instead of "no patch artifact". For a Git result, a `commit`, `branch` or `pr` delivery that fails after writing now answers that HTTP 409 problem, where the last release answered such a failure with HTTP 200 `applied:false` (a legacy patch's delivery still does). A delivery that fails after writing is taken back on its retained pair, keeping later edits outside it (restored as Git holds it: a file whose checkout conversion does not round-trip, an LF file under `core.autocrlf` for one, can come back with converted bytes, which the receipt says); only a write that cannot be taken back stays, reported as `treeMutated` with the action that recovers it and recorded `applied_review_blocked` with a revert anchor instead of `not_applied`. A `pr` whose push fails returns the working tree to where HEAD was and keeps the commit on the local branch; when that checkout fails, the receipt says where HEAD stayed and how to return. A delivery never writes over what Git does not track: a file or directory at a path the result adds that your ignore rules hide refuses `delivery_path_occupied`, naming it, with nothing written, and `apply/check` answers the same (a new file in a directory that already exists still delivers, and so does a rename that only changes case; a hard link of a removed file is never taken for one). In a sparse checkout (cone or non-cone), a result that adds, changes or removes a path outside the sparse-checkout patterns refuses `delivery_outside_sparse_checkout`, naming those paths, with nothing written, and `apply/check` answers the same; the last release's `git apply` wrote such an added file, after which every later snapshot of that checkout failed. A revert that must change such a path, because you narrowed the patterns after the apply, refuses the same way. Widen the sparse checkout (`git sparse-checkout add`) to deliver or revert there. Every path a delivery, take-back or revert does not address keeps its bytes, including a clean file outside the patterns that has no skip-worktree mark (Git's own checkout would delete it), and its index mark, except that in a sparse checkout Git itself clears the skip-worktree mark of a file that is present, which sticks once a `branch`, `commit` or `pr` delivery writes the index; such a write also drops the assume-unchanged mark of a path it changes. This check uses `git sparse-checkout check-rules` (Git 2.41 or newer); with an older Git, a sparse checkout's deliveries, `apply/check` and reverts refuse `git_failed` before writing, naming the Git they need. A file you marked skip-worktree and then deleted counts as deleted, not as unchanged (except a file the sparse patterns leave out), so a revert brings back what a delivery deleted, refuses rather than undo your later deletion, and a delivery does not silently recreate it. A `branch`, `commit` or `pr` delivery commits the result onto HEAD and leaves what your assume-unchanged or skip-worktree marks hide (a local edit, a deleted file) on disk and out of the commit, their marks with them (but for the sparse-checkout case above); a result that changes such a file refuses `delivery_conflict`. A checkout that cannot fit refuses `space_insufficient` before its first write, and a store fault on the way there (the import, the snapshot, the composition) answers the same typed 409 instead of HTTP 400 or 500. A path the result changes whose name is not valid UTF-8 refuses `result_path_encoding` with nothing written, and so does its revert; a name only your project changed is never addressed, so it does not stop an unrelated result. Written paths are proven the way `git status` compares them, and every private proof, snapshot and checkout reads the bytes whatever your configuration or index marks say (`core.ignoreStat`, a filesystem monitor, an assume-unchanged mark); apply, its check and revert also read the paths they decide on by content rather than from the index's stat cache, so a file that kept its size and mtime is neither already applied nor called reverted (`branch`, `commit` and `pr` keep that cache for what they write, as `git checkout` does). A committed CRLF blob under `text=auto` or `core.autocrlf` applies and reverts, and a directory that becomes a file or symlink composes and a file that became a directory reverts on an unchanged target. When a patch render fails for a reason other than its size, the capture keeps the result with `patch_view.reason: render_failed`. Review and synthesis of a result with no patch view read a copy of its saved candidate tree, converted only as that tree's own attributes define with Git's defaults, in a private Git directory, never the workspace, so a configured check that rewrites an output, an attribute rule (tracked or in `.git/info/attributes`) or the repository's filter configuration cannot make review read different bytes than apply consumes (a filter driver is configuration the result does not carry, so a filtered file is read as its stored blob, as in the patch view: a Git LFS pointer or an encrypted blob is reviewed as stored, which says nothing about the content it stands for, and no smudged copy is kept); a changed file that copy cannot hold, a disk too full for it included, is named with its typed cause (`space_insufficient` for a full disk) to reviewers and synthesis, and the review cannot pass clean. A copy that fails holds none of the files: reviewers and synthesis get those causes and nothing to read, never what the failed copy left in its directory or a directory that is gone, and a copy that cannot be removed afterwards stays instead of ending the run, with a best-effort `<copy>.cleanup-error.json` saying why (on a disk too full to write that record whole, the leftover stays with its cleanup unconfirmed). After an earlier apply and revert, a later delivery that strands HEAD on its branch clears the old revert anchor, so `revert_run` refuses instead of answering a false success. A `revert_run` refused for anything but a later edit of what the run changed (the sparse patterns, a file it cannot read, a full disk, a Git fault) now answers `reverse_apply_failed` with its typed cause as `context.refusalCode`, instead of saying the revert is no longer available. Runs recorded by earlier releases keep their patch for apply and revert.
- d9e7977: `claudexor project remove <project-id> --purge-trashed-threads` (`DELETE /v2/projects/:id?trashedThreads=purge`) removes a project together with the threads already in its trash, in one action (#333). Without the option, removal is unchanged and still refuses while any non-purged thread remains. The option purges only threads that are in the trash: an active or closed thread must be trashed first. The whole removal is refused, with nothing changed, while any thread is outside the trash (`project_has_threads`) or while any of the project's work is queued or running, including a thread Apply or a run started under a former root (`project_has_active_run`). The purges and the project's retirement are one store transaction. Each purged thread then loses what a thread purge deletes: its isolated worktree and `claudexor/thread-*` branch with any changes never applied, and its lane homes. The project folder, a delegated thread's caller-owned workspace and run artifacts are never deleted; the conversation rows stay in the engine store, while the threads leave every listing and can no longer be restored or resumed. The receipt's new `purgedThreads` lists each purged thread with `cleanup: "completed"`, or `"pending"` with the error; a pending cleanup is retried when the daemon next starts. A repeated or inexact `trashedThreads` value is refused with 400 before anything changes. Other query parameters stay ignored as before, so a misspelled parameter name gets the default removal, which still refuses while any non-purged thread remains.

  Every thread purge (Delete Now, expired trash, the retention retry, daemon startup and this removal) now reports a cleanup as completed only once the thread's worktree with its Git registration and branch and its lane homes are gone. When Git refuses, for example for a worktree locked with `git worktree lock` or a ref lock held by another Git process, the cleanup stays pending with Git's error, nothing Git still records is deleted, and a later attempt finishes it once the cause is gone. Git is asked in the repository that registered the worktree, which the worktree's own `.git` file names; a branch, registration or directory already gone there counts as removed. Without that file, the project folder's repository is asked. Because Git deletes the file with the worktree and a project folder can be replaced, the cleanup records the repository it asks before Git's first change there, so a later attempt or the next daemon start finishes in that same repository, and syncs its Git directories to disk, also when the project folder is gone or another repository is at the project path by then. Git drops a worktree's registration even when it fails to delete the worktree directory, for example a read-only one; the cleanup stays pending with Git's error, and once the directory can be deleted, a later attempt finishes it in that recorded repository. A repository moved without relinking the project, or deleted (the two look the same), keeps the cleanup pending too; after a move, `git worktree repair` in the moved repository lets the next daemon start finish it, and a recorded repository that moves away or is replaced at its path afterwards keeps it pending until it is back. Thread purge, the account lane cleanup and the orphan-lane sweep no longer follow a link inside Claudexor's runtime directory: a link above what they delete is refused with an error and its target is left untouched, and a link in place of what they delete is only unlinked. Before, such a link made the deletion follow it into the linked folder, and a Git refusal was reported as completed and never retried.

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
  - @claudexor/event-log@5.0.0

## 4.8.2

### Patch Changes

- 67b8833: Release old unreferenced artifacts and native sessions after archived project bindings are cleared. Reclaim aged, unnamed revert/exact-patch objects and empty engine containers while preserving surviving runs and recovery holds. Expose a durable last cleanup outcome, counted holds and errors through `claudexor gc --last` and `GET /v2/maintenance/gc`.

  Preserve complete NUL-delimited interaction IDs on Node 24.15 when pruning commands and observing retention changes, so question event groups and bodies are released and questions published during cleanup protect their runs.

  Preserve live workspace, Git checkout and harness-home directories during cleanup. Keep hold history through interrupted inventory, recover unreadable last-pass records with a passive diagnostic, and report unsupported native adapters without false holds.

  Keep foreign Codex session entries informational and preserve unobserved holds through interrupted cleanup. Reclaim empty run-retirement containers and avoid removal attempts on nonempty containers.

- Updated dependencies [97e2f17]
- Updated dependencies [67b8833]
- Updated dependencies [f88a561]
  - @claudexor/event-log@4.8.2
  - @claudexor/schema@4.8.2
  - @claudexor/util@4.8.2
  - @claudexor/core@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/core@4.8.1
- @claudexor/event-log@4.8.1
- @claudexor/schema@4.8.1
- @claudexor/util@4.8.1

## 4.8.0

### Patch Changes

- Add bounded thread history reads. `GET /v2/threads/:id/history` returns one page of at most 20 turns with prompt and answer previews and receipt facts, chosen by a cursor or a before, after or around turn id, and `GET /v2/threads/:id/turns/:turnId/prompt` returns a bounded UTF-8 part of a turn's complete stored prompt, refused turns included, with its total size and SHA-256. CLI `thread history` and `thread prompt` and MCP `claudexor_thread_history` and `claudexor_thread_prompt` expose the same reads; they require an existing daemon and never start one. The existing thread detail read remains available.

  A page stays within 2 MiB of JSON. A stale cursor fails as `thread_history_cursor_stale` with the `resnapshot` required action, and a turn whose run record was pruned reads as `not_retained` instead of failing the page.

  Engine-store schema 5 adds only the `turn_plan_answer` index in an atomic forward-only migration; building it scans existing turns once without rewriting them, and older engines refuse an upgraded store.

- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
- Updated dependencies [7dfbc42]
- Updated dependencies
  - @claudexor/schema@4.8.0
  - @claudexor/core@4.8.0
  - @claudexor/util@4.8.0
  - @claudexor/event-log@4.8.0

## 4.7.1

### Patch Changes

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
- Updated dependencies [8a9c2f6]
  - @claudexor/schema@4.7.1
  - @claudexor/core@4.7.1
  - @claudexor/event-log@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Minor Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/core@4.7.0
  - @claudexor/event-log@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/core@4.6.2
- @claudexor/event-log@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/util@4.6.2

## 4.6.1

### Patch Changes

- @claudexor/core@4.6.1
- @claudexor/event-log@4.6.1
- @claudexor/schema@4.6.1
- @claudexor/util@4.6.1

## 4.6.0

### Patch Changes

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
  - @claudexor/event-log@4.6.0

## 4.5.0

### Patch Changes

- 85e312d: Skip write-oriented baseline inventory and output capture for readonly live
  directory Agents, so broad source scopes containing sockets do not block startup
  and source files are not copied into attempt artifacts. Readonly answers no longer
  fail file capture because a selected path resembles a credential file. Align empty
  answer delivery and readonly `noChanges` with the Git readonly convention: no
  write-backed result, not a filesystem comparison. Writable and isolated directory
  preparation and capture remain unchanged.
- Updated dependencies [032b44b]
  - @claudexor/schema@4.5.0
  - @claudexor/core@4.5.0
  - @claudexor/event-log@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/core@4.4.0
  - @claudexor/event-log@4.4.0

## 4.3.1

### Patch Changes

- 64ee7fc: Keep a run's candidate when its working copy holds untracked folders with their own Git repository. The candidate capture used to stage everything with `git add -A`, which fails outright on a nested repository without a commit (and records a commit link for one with commits), so a finished agent-mode run — for example a reviewer that kept a copy of a repository under `.review-evidence/` — lost its whole work product. Untracked nested repositories that the worktree's `.gitmodules` does not declare are now left out of the patch, which cannot carry another repository anyway, and named top-relative and redacted as `excluded_nested_repositories` in the attempt record and the final work product's meta. A declared submodule is still captured as its commit link, the names stay correct when the project root is a subdirectory of the worktree, and the in-place turn snapshot leaves the same folders out, so a thread's next turn no longer fails on one an earlier turn left behind.
  - @claudexor/core@4.3.1
  - @claudexor/schema@4.3.1
  - @claudexor/util@4.3.1

## 4.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies [23a74cb]
  - @claudexor/core@4.3.0
  - @claudexor/schema@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/core@4.2.0
- @claudexor/schema@4.2.0
- @claudexor/util@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/core@4.1.1
- @claudexor/schema@4.1.1
- @claudexor/util@4.1.1

## 4.1.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/core@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/core@4.0.1
- @claudexor/schema@4.0.1
- @claudexor/util@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/core@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/core@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/core@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/core@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/core@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/core@3.22.1

## 3.22.0

### Minor Changes

- 51578d4: Continue a stopped run instead of restarting it: `POST /v2/runs {continueFrom: <runId>, continueCarrier?: "auto" | "packet"}` starts the next run of a continuation chain. Admission is one daemon-atomic rule shared by every ingress (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain `head`): the accepted successor command is the durable claim, so a predecessor has exactly one accepted successor, also across restarts and concurrent requests. Omitted mode, scope, execution, harness and model come from the predecessor, and the prompt is the caller's continuation text (it may be empty). The successor's first try is planned through the in-run continuation planner from the predecessor's session capsule and terminal facts — the same account resumes the vendor session by id, another account resumes the moved session, otherwise a fresh session is briefed with the evidence index — and is disclosed by a `run.continuity` receipt naming the predecessor and whether it runs in the same root. A stopped isolated Agent run now keeps its envelope (tree and scoped home, Claudexor-seeded auth removed) under a durable custody record until a successor adopts it, its result is applied or it is discarded; the crash sweep and disk retention keep it, and a run interrupted by a daemon restart with changes is kept the same way. `GET /v2/runs/:id` projects `resumable` (derived as `host_restart` for runs the daemon found running at its restart), the per-try `continuity` receipts, `retainedEnvelope` (disk use) and `continueFrom`; `continueFrom` is advertised in `runControlKeys`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/core@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0

## 3.20.1

### Patch Changes

- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
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
  - @claudexor/core@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/core@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/core@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/core@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/core@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/core@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/core@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/core@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/core@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/core@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- dd02e0a: Relativize a bare GNU diff 3.8 `Binary files … differ` record that follows a hunk with no `diff` echo (#252), so an owned binary artifact's absolute paths no longer escape the exact-prefix exclusion and repo-relative policy globs of captured workspace diffs.
  - @claudexor/core@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/core@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/core@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/core@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/core@3.9.1
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
  - @claudexor/core@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/core@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/core@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/core@3.8.2
- @claudexor/schema@3.8.2
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

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/core@3.7.0
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
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/schema@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/core@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/core@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/core@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/core@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/core@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/core@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/core@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/core@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/core@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/core@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Detect typed Git capability and stub repositories before workspace operations, and preserve that truth through thread workspace creation and initialization.
- @claudexor/core@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/core@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/core@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/core@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/core@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/core@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/util@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/core@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/core@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/core@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/core@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/core@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/core@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
