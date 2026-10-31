# @claudexor/delivery

## 5.0.0

### Patch Changes

- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- 66d5b6a: Large results are now kept exactly, without a size ceiling (#535). Before, a result whose exact patch exceeded 256 MiB failed its capture. Every Git capture's canonical result is now Git objects identified by a typed digest (`git_objects/v1`), kept in a private per-project object store that is never an alternate of your repository; objects are imported into your repository only before an operation needs them. Results of every size are verified in a fresh private clone, applied onto the current state of your project (your unrelated changes are kept; paths changed on both sides follow `git apply` rules, except that an identical change on both sides is accepted outside rename and copy endpoints), committed or branched, and reverted on the actual delivery pair, keeping later edits outside it (a file the delivery added that your ignore rules now hide, or that sits inside a nested Git repository, is removed too, or the revert refuses if you changed it or cannot read it); a rendered result's `pr` passes the same publication scan as any `pr`, on the exact commit it pushes. Operator decisions and the apply gate bind the result's digest instead of the patch text. The patch becomes a view: when an estimate computed from the changed files' blob sizes exceeds the 256 MiB view limit, or the render itself overflows it, `final/patch.diff` is absent with a typed reason and a bounded inventory (never an empty file), `claudexor inspect`, the run summary, MCP results and the macOS Changes tab say so, and `pr` of such a result refuses typed (`pr_unrendered_result`) before any scan; scanning such a result for `pr` is a follow-up. Because that estimate is computed before rendering, a small edit of a very large file (one changed line in a 110 MiB file) also gets no patch view and `pr` refuses it; the result itself stays exact, deliverable and revertable. A delivery refused for a typed reason (`result_objects_missing`, `pr_unrendered_result`, a publication scan refusal, a conflict, a changed target, a store fault) answers that reason as the HTTP 409 problem code on `POST /v2/runs/:id/apply` and `accept_clean_patch` (a refusal with no typed reason answers `delivery_refused` on both), a replay with the same `Idempotency-Key` answers the same, and `apply/check` returns it as `refusal`, a store, Git or filesystem fault included; a run whose result record is there but cannot be read answers 503 `artifact_read_failed` on apply, apply/check and the decisions instead of "no patch artifact". For a Git result, a `commit`, `branch` or `pr` delivery that fails after writing now answers that HTTP 409 problem, where the last release answered such a failure with HTTP 200 `applied:false` (a legacy patch's delivery still does). A delivery that fails after writing is taken back on its retained pair, keeping later edits outside it (restored as Git holds it: a file whose checkout conversion does not round-trip, an LF file under `core.autocrlf` for one, can come back with converted bytes, which the receipt says); only a write that cannot be taken back stays, reported as `treeMutated` with the action that recovers it and recorded `applied_review_blocked` with a revert anchor instead of `not_applied`. A `pr` whose push fails returns the working tree to where HEAD was and keeps the commit on the local branch; when that checkout fails, the receipt says where HEAD stayed and how to return. A delivery never writes over what Git does not track: a file or directory at a path the result adds that your ignore rules hide refuses `delivery_path_occupied`, naming it, with nothing written, and `apply/check` answers the same (a new file in a directory that already exists still delivers, and so does a rename that only changes case; a hard link of a removed file is never taken for one). In a sparse checkout (cone or non-cone), a result that adds, changes or removes a path outside the sparse-checkout patterns refuses `delivery_outside_sparse_checkout`, naming those paths, with nothing written, and `apply/check` answers the same; the last release's `git apply` wrote such an added file, after which every later snapshot of that checkout failed. A revert that must change such a path, because you narrowed the patterns after the apply, refuses the same way. Widen the sparse checkout (`git sparse-checkout add`) to deliver or revert there. Every path a delivery, take-back or revert does not address keeps its bytes, including a clean file outside the patterns that has no skip-worktree mark (Git's own checkout would delete it), and its index mark, except that in a sparse checkout Git itself clears the skip-worktree mark of a file that is present, which sticks once a `branch`, `commit` or `pr` delivery writes the index; such a write also drops the assume-unchanged mark of a path it changes. This check uses `git sparse-checkout check-rules` (Git 2.41 or newer); with an older Git, a sparse checkout's deliveries, `apply/check` and reverts refuse `git_failed` before writing, naming the Git they need. A file you marked skip-worktree and then deleted counts as deleted, not as unchanged (except a file the sparse patterns leave out), so a revert brings back what a delivery deleted, refuses rather than undo your later deletion, and a delivery does not silently recreate it. A `branch`, `commit` or `pr` delivery commits the result onto HEAD and leaves what your assume-unchanged or skip-worktree marks hide (a local edit, a deleted file) on disk and out of the commit, their marks with them (but for the sparse-checkout case above); a result that changes such a file refuses `delivery_conflict`. A checkout that cannot fit refuses `space_insufficient` before its first write, and a store fault on the way there (the import, the snapshot, the composition) answers the same typed 409 instead of HTTP 400 or 500. A path the result changes whose name is not valid UTF-8 refuses `result_path_encoding` with nothing written, and so does its revert; a name only your project changed is never addressed, so it does not stop an unrelated result. Written paths are proven the way `git status` compares them, and every private proof, snapshot and checkout reads the bytes whatever your configuration or index marks say (`core.ignoreStat`, a filesystem monitor, an assume-unchanged mark); apply, its check and revert also read the paths they decide on by content rather than from the index's stat cache, so a file that kept its size and mtime is neither already applied nor called reverted (`branch`, `commit` and `pr` keep that cache for what they write, as `git checkout` does). A committed CRLF blob under `text=auto` or `core.autocrlf` applies and reverts, and a directory that becomes a file or symlink composes and a file that became a directory reverts on an unchanged target. When a patch render fails for a reason other than its size, the capture keeps the result with `patch_view.reason: render_failed`. Review and synthesis of a result with no patch view read a copy of its saved candidate tree, converted only as that tree's own attributes define with Git's defaults, in a private Git directory, never the workspace, so a configured check that rewrites an output, an attribute rule (tracked or in `.git/info/attributes`) or the repository's filter configuration cannot make review read different bytes than apply consumes (a filter driver is configuration the result does not carry, so a filtered file is read as its stored blob, as in the patch view: a Git LFS pointer or an encrypted blob is reviewed as stored, which says nothing about the content it stands for, and no smudged copy is kept); a changed file that copy cannot hold, a disk too full for it included, is named with its typed cause (`space_insufficient` for a full disk) to reviewers and synthesis, and the review cannot pass clean. A copy that fails holds none of the files: reviewers and synthesis get those causes and nothing to read, never what the failed copy left in its directory or a directory that is gone, and a copy that cannot be removed afterwards stays instead of ending the run, with a best-effort `<copy>.cleanup-error.json` saying why (on a disk too full to write that record whole, the leftover stays with its cleanup unconfirmed). After an earlier apply and revert, a later delivery that strands HEAD on its branch clears the old revert anchor, so `revert_run` refuses instead of answering a false success. A `revert_run` refused for anything but a later edit of what the run changed (the sparse patterns, a file it cannot read, a full disk, a Git fault) now answers `reverse_apply_failed` with its typed cause as `context.refusalCode`, instead of saying the revert is no longer available. Runs recorded by earlier releases keep their patch for apply and revert.
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
- Updated dependencies [fe7e2ae]
- Updated dependencies [338729e]
- Updated dependencies [28dfe1a]
  - @claudexor/schema@5.0.0
  - @claudexor/workspace@5.0.0
  - @claudexor/core@5.0.0
  - @claudexor/util@5.0.0
  - @claudexor/review@5.0.0
  - @claudexor/policy@5.0.0

## 4.8.2

### Patch Changes

- 67b8833: Release old unreferenced artifacts and native sessions after archived project bindings are cleared. Reclaim aged, unnamed revert/exact-patch objects and empty engine containers while preserving surviving runs and recovery holds. Expose a durable last cleanup outcome, counted holds and errors through `claudexor gc --last` and `GET /v2/maintenance/gc`.

  Preserve complete NUL-delimited interaction IDs on Node 24.15 when pruning commands and observing retention changes, so question event groups and bodies are released and questions published during cleanup protect their runs.

  Preserve live workspace, Git checkout and harness-home directories during cleanup. Keep hold history through interrupted inventory, recover unreadable last-pass records with a passive diagnostic, and report unsupported native adapters without false holds.

  Keep foreign Codex session entries informational and preserve unobserved holds through interrupted cleanup. Reclaim empty run-retirement containers and avoid removal attempts on nonempty containers.

- Updated dependencies [97e2f17]
- Updated dependencies [67b8833]
- Updated dependencies [f88a561]
  - @claudexor/schema@4.8.2
  - @claudexor/util@4.8.2
  - @claudexor/workspace@4.8.2
  - @claudexor/core@4.8.2
  - @claudexor/policy@4.8.2
  - @claudexor/review@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/core@4.8.1
- @claudexor/policy@4.8.1
- @claudexor/review@4.8.1
- @claudexor/schema@4.8.1
- @claudexor/util@4.8.1
- @claudexor/workspace@4.8.1

## 4.8.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
- Updated dependencies [7dfbc42]
- Updated dependencies
  - @claudexor/schema@4.8.0
  - @claudexor/core@4.8.0
  - @claudexor/util@4.8.0
  - @claudexor/policy@4.8.0
  - @claudexor/review@4.8.0
  - @claudexor/workspace@4.8.0

## 4.7.1

### Patch Changes

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
- Updated dependencies [8a9c2f6]
  - @claudexor/schema@4.7.1
  - @claudexor/core@4.7.1
  - @claudexor/policy@4.7.1
  - @claudexor/review@4.7.1
  - @claudexor/workspace@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/core@4.7.0
  - @claudexor/workspace@4.7.0
  - @claudexor/policy@4.7.0
  - @claudexor/review@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/core@4.6.2
- @claudexor/policy@4.6.2
- @claudexor/review@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/util@4.6.2
- @claudexor/workspace@4.6.2

## 4.6.1

### Patch Changes

- @claudexor/core@4.6.1
- @claudexor/policy@4.6.1
- @claudexor/review@4.6.1
- @claudexor/schema@4.6.1
- @claudexor/util@4.6.1
- @claudexor/workspace@4.6.1

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
  - @claudexor/review@4.6.0
  - @claudexor/workspace@4.6.0
  - @claudexor/policy@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [032b44b]
- Updated dependencies [85e312d]
  - @claudexor/schema@4.5.0
  - @claudexor/workspace@4.5.0
  - @claudexor/core@4.5.0
  - @claudexor/policy@4.5.0
  - @claudexor/review@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/core@4.4.0
  - @claudexor/policy@4.4.0
  - @claudexor/review@4.4.0
  - @claudexor/workspace@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [64ee7fc]
  - @claudexor/workspace@4.3.1
  - @claudexor/review@4.3.1
  - @claudexor/core@4.3.1
  - @claudexor/policy@4.3.1
  - @claudexor/schema@4.3.1
  - @claudexor/util@4.3.1

## 4.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies [23a74cb]
  - @claudexor/core@4.3.0
  - @claudexor/review@4.3.0
  - @claudexor/schema@4.3.0
  - @claudexor/workspace@4.3.0
  - @claudexor/policy@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/core@4.2.0
- @claudexor/policy@4.2.0
- @claudexor/review@4.2.0
- @claudexor/schema@4.2.0
- @claudexor/util@4.2.0
- @claudexor/workspace@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/core@4.1.1
- @claudexor/policy@4.1.1
- @claudexor/review@4.1.1
- @claudexor/schema@4.1.1
- @claudexor/util@4.1.1
- @claudexor/workspace@4.1.1

## 4.1.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@4.1.0
  - @claudexor/core@4.1.0
  - @claudexor/policy@4.1.0
  - @claudexor/review@4.1.0
  - @claudexor/workspace@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/core@4.0.1
- @claudexor/policy@4.0.1
- @claudexor/review@4.0.1
- @claudexor/schema@4.0.1
- @claudexor/util@4.0.1
- @claudexor/workspace@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/schema@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/core@4.0.0
  - @claudexor/policy@4.0.0
  - @claudexor/review@4.0.0
  - @claudexor/workspace@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/core@3.25.1
- @claudexor/policy@3.25.1
- @claudexor/review@3.25.1
- @claudexor/schema@3.25.1
- @claudexor/util@3.25.1
- @claudexor/workspace@3.25.1

## 3.25.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/policy@3.25.0
  - @claudexor/review@3.25.0
  - @claudexor/workspace@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/review@3.24.0
  - @claudexor/workspace@3.24.0
  - @claudexor/policy@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/core@3.23.2
- @claudexor/policy@3.23.2
- @claudexor/review@3.23.2
- @claudexor/schema@3.23.2
- @claudexor/util@3.23.2
- @claudexor/workspace@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/core@3.23.1
- @claudexor/policy@3.23.1
- @claudexor/review@3.23.1
- @claudexor/schema@3.23.1
- @claudexor/util@3.23.1
- @claudexor/workspace@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/core@3.23.0
- @claudexor/policy@3.23.0
- @claudexor/review@3.23.0
- @claudexor/schema@3.23.0
- @claudexor/util@3.23.0
- @claudexor/workspace@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/schema@3.22.1
  - @claudexor/util@3.22.1
  - @claudexor/core@3.22.1
  - @claudexor/policy@3.22.1
  - @claudexor/review@3.22.1
  - @claudexor/workspace@3.22.1

## 3.22.0

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/workspace@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/policy@3.22.0
  - @claudexor/review@3.22.0
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
  - @claudexor/review@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/workspace@3.21.0
  - @claudexor/policy@3.21.0

## 3.20.1

### Patch Changes

- Updated dependencies [eb506c1]
- Updated dependencies [dc30eda]
- Updated dependencies [705c2c1]
  - @claudexor/schema@3.20.1
  - @claudexor/core@3.20.1
  - @claudexor/review@3.20.1
  - @claudexor/policy@3.20.1
  - @claudexor/workspace@3.20.1
  - @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/core@3.20.0
  - @claudexor/workspace@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/review@3.20.0
  - @claudexor/policy@3.20.0
  - @claudexor/schema@3.20.0

## 3.19.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/review@3.19.0
  - @claudexor/workspace@3.19.0
  - @claudexor/policy@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/review@3.18.0
  - @claudexor/workspace@3.18.0
  - @claudexor/policy@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/policy@3.17.2
  - @claudexor/review@3.17.2
  - @claudexor/workspace@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/policy@3.17.1
  - @claudexor/review@3.17.1
  - @claudexor/workspace@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/review@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/policy@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- Updated dependencies [788ddca]
  - @claudexor/schema@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/policy@3.16.0
  - @claudexor/review@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/core@3.15.1
- @claudexor/policy@3.15.1
- @claudexor/review@3.15.1
- @claudexor/schema@3.15.1
- @claudexor/util@3.15.1
- @claudexor/workspace@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/review@3.15.0
  - @claudexor/workspace@3.15.0
  - @claudexor/policy@3.15.0
  - @claudexor/schema@3.15.0
  - @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/review@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/policy@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/core@3.13.0
- @claudexor/policy@3.13.0
- @claudexor/review@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/util@3.13.0
- @claudexor/workspace@3.13.0

## 3.12.10

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/policy@3.12.10
  - @claudexor/review@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/policy@3.12.9
  - @claudexor/review@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/core@3.12.8
- @claudexor/policy@3.12.8
- @claudexor/review@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/util@3.12.8
- @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/policy@3.12.7
  - @claudexor/review@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/core@3.12.6
- @claudexor/policy@3.12.6
- @claudexor/review@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/util@3.12.6
- @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/policy@3.12.5
  - @claudexor/review@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/core@3.12.4
- @claudexor/policy@3.12.4
- @claudexor/review@3.12.4
- @claudexor/schema@3.12.4
- @claudexor/util@3.12.4
- @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/core@3.12.3
- @claudexor/policy@3.12.3
- @claudexor/review@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/policy@3.12.2
  - @claudexor/review@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/policy@3.12.1
  - @claudexor/review@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- Updated dependencies [217d53f]
  - @claudexor/schema@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/policy@3.12.0
  - @claudexor/review@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/policy@3.11.0
  - @claudexor/review@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/core@3.10.5
- @claudexor/policy@3.10.5
- @claudexor/review@3.10.5
- @claudexor/schema@3.10.5
- @claudexor/util@3.10.5
- @claudexor/workspace@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/policy@3.10.4
  - @claudexor/review@3.10.4
  - @claudexor/workspace@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/core@3.10.3
- @claudexor/policy@3.10.3
- @claudexor/review@3.10.3
- @claudexor/schema@3.10.3
- @claudexor/util@3.10.3
- @claudexor/workspace@3.10.3

## 3.10.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/policy@3.10.2
  - @claudexor/review@3.10.2
  - @claudexor/workspace@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/policy@3.10.1
  - @claudexor/review@3.10.1
  - @claudexor/workspace@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/review@3.10.0
  - @claudexor/workspace@3.10.0
  - @claudexor/policy@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Make internal model review opt-in for ordinary Agent work, independently of executor selection. Preserve explicit panels, Best-of, and requested review cycles; persist intent separately from results and retain historical behavior on replay. Deliberately unreviewed changes remain normally applicable with honest Not reviewed status while required checks and patch integrity remain enforced. Expose the same choice through API, CLI, MCP, ACP, and the native composer.
- Updated dependencies
  - @claudexor/schema@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/policy@3.9.8
  - @claudexor/review@3.9.8
  - @claudexor/workspace@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/core@3.9.7
- @claudexor/policy@3.9.7
- @claudexor/review@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/util@3.9.7
- @claudexor/workspace@3.9.7

## 3.9.6

### Patch Changes

- Updated dependencies [dd02e0a]
  - @claudexor/workspace@3.9.6
  - @claudexor/review@3.9.6
  - @claudexor/core@3.9.6
  - @claudexor/policy@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/core@3.9.5
- @claudexor/policy@3.9.5
- @claudexor/review@3.9.5
- @claudexor/schema@3.9.5
- @claudexor/util@3.9.5
- @claudexor/workspace@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/core@3.9.4
- @claudexor/policy@3.9.4
- @claudexor/review@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/util@3.9.4
- @claudexor/workspace@3.9.4

## 3.9.3

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/policy@3.9.3
  - @claudexor/review@3.9.3
  - @claudexor/workspace@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/core@3.9.2
- @claudexor/policy@3.9.2
- @claudexor/review@3.9.2
- @claudexor/schema@3.9.2
- @claudexor/util@3.9.2
- @claudexor/workspace@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/core@3.9.1
- @claudexor/policy@3.9.1
- @claudexor/review@3.9.1
- @claudexor/schema@3.9.1
- @claudexor/util@3.9.1
- @claudexor/workspace@3.9.1

## 3.9.0

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [fd623ff]
- Updated dependencies [278e436]
  - @claudexor/schema@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/policy@3.9.0
  - @claudexor/review@3.9.0
  - @claudexor/workspace@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/core@3.8.4
- @claudexor/policy@3.8.4
- @claudexor/review@3.8.4
- @claudexor/schema@3.8.4
- @claudexor/util@3.8.4
- @claudexor/workspace@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/core@3.8.3
- @claudexor/policy@3.8.3
- @claudexor/review@3.8.3
- @claudexor/schema@3.8.3
- @claudexor/util@3.8.3
- @claudexor/workspace@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/core@3.8.2
- @claudexor/policy@3.8.2
- @claudexor/review@3.8.2
- @claudexor/schema@3.8.2
- @claudexor/util@3.8.2
- @claudexor/workspace@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/workspace@3.8.1
  - @claudexor/review@3.8.1
  - @claudexor/policy@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/policy@3.8.0
  - @claudexor/review@3.8.0
  - @claudexor/workspace@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/core@3.7.0
- @claudexor/policy@3.7.0
- @claudexor/review@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/util@3.7.0
- @claudexor/workspace@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/schema@3.6.0
  - @claudexor/workspace@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/policy@3.6.0
  - @claudexor/review@3.6.0
  - @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/policy@3.5.0
  - @claudexor/review@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/workspace@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/core@3.4.2
- @claudexor/policy@3.4.2
- @claudexor/review@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/util@3.4.2
- @claudexor/workspace@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/core@3.4.1
- @claudexor/policy@3.4.1
- @claudexor/review@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/util@3.4.1
- @claudexor/workspace@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/core@3.4.0
- @claudexor/policy@3.4.0
- @claudexor/review@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/util@3.4.0
- @claudexor/workspace@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/core@3.3.16
- @claudexor/policy@3.3.16
- @claudexor/review@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/util@3.3.16
- @claudexor/workspace@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/core@3.3.15
- @claudexor/policy@3.3.15
- @claudexor/review@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/util@3.3.15
- @claudexor/workspace@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/core@3.3.14
- @claudexor/policy@3.3.14
- @claudexor/review@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/util@3.3.14
- @claudexor/workspace@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/core@3.3.13
- @claudexor/policy@3.3.13
- @claudexor/review@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/util@3.3.13
- @claudexor/workspace@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/core@3.3.12
- @claudexor/policy@3.3.12
- @claudexor/review@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/util@3.3.12
- @claudexor/workspace@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/core@3.3.0
- @claudexor/policy@3.3.0
- @claudexor/review@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/util@3.3.0
- @claudexor/workspace@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/core@3.2.1
- @claudexor/policy@3.2.1
- @claudexor/review@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/util@3.2.1
- @claudexor/workspace@3.2.1

## 3.2.0

### Patch Changes

- @claudexor/core@3.2.0
- @claudexor/policy@3.2.0
- @claudexor/review@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/util@3.2.0
- @claudexor/workspace@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/review@3.1.2
  - @claudexor/workspace@3.1.2
  - @claudexor/policy@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/review@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/workspace@3.1.1
  - @claudexor/policy@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/policy@3.1.0
  - @claudexor/review@3.1.0
  - @claudexor/workspace@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/core@3.0.3
- @claudexor/policy@3.0.3
- @claudexor/review@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/util@3.0.3
- @claudexor/workspace@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/core@3.0.0
- @claudexor/policy@3.0.0
- @claudexor/review@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/util@3.0.0
- @claudexor/workspace@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/core@2.1.3
- @claudexor/policy@2.1.3
- @claudexor/review@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/util@2.1.3
- @claudexor/workspace@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/core@2.1.2
- @claudexor/policy@2.1.2
- @claudexor/review@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/util@2.1.2
- @claudexor/workspace@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/core@2.1.1
- @claudexor/policy@2.1.1
- @claudexor/review@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/util@2.1.1
- @claudexor/workspace@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/policy@2.1.0
  - @claudexor/review@2.1.0
  - @claudexor/workspace@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/core@2.0.2
- @claudexor/policy@2.0.2
- @claudexor/review@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/util@2.0.2
- @claudexor/workspace@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/core@2.0.1
- @claudexor/policy@2.0.1
- @claudexor/review@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/util@2.0.1
- @claudexor/workspace@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/core@2.0.0
- @claudexor/policy@2.0.0
- @claudexor/review@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/util@2.0.0
- @claudexor/workspace@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Updated dependencies
  - @claudexor/core@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/workspace@0.14.1
  - @claudexor/policy@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/core@0.14.0
- @claudexor/policy@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/util@0.14.0
- @claudexor/workspace@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/core@0.13.3
- @claudexor/policy@0.13.3
- @claudexor/schema@0.13.3
- @claudexor/util@0.13.3
- @claudexor/workspace@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/core@0.12.1
- @claudexor/policy@0.12.1
- @claudexor/schema@0.12.1
- @claudexor/util@0.12.1
- @claudexor/workspace@0.12.1
