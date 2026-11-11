# @claudexor/harness-claude

## 6.0.0

### Patch Changes

- f4f8caf: Questions now say whether the agent waits for the answer (#628). Each pending
  question carries `delivery`: `blocking` (every question so far, and the
  meaning of a stored question without the field) or `async`, a question the
  agent asks while it keeps working. An async question is still attention: it
  sets `waitingOnUser`, wakes `claudexor_run_wait`, and can be answered through
  the same routes. It does not pause the inactivity watchdog or refuse live
  messages, and the new run-summary flag `asyncQuestionsOnly` is true only while
  every pending question is async, so a blocking question is never hidden behind
  one. `claudexor follow`, ACP and the macOS app no longer call such a run paused
  or waiting: they keep it working, say that silence or expiry sends nothing,
  and a blocking question is asked before an open async prompt. ACP and MCP
  answer prompts for an async question no longer hold the run's terminal; they
  close when the question is answered elsewhere or the run ends. In the macOS app a
  run that has ended no longer shows a question card, a Send button or a question
  state while its last snapshot still lists the question; a late answer the engine
  refuses reads as a sentence saying it was not sent, instead of a raw HTTP error;
  the deadline label keeps counting down; and an async question between the last
  message and the final answer no longer leaves a copy of that answer in Activity.

  A failed answer surface is no longer reported as the user's decline. When the
  engine cannot register or keep a question, the run's interaction channel now
  rejects with the cause instead of returning "no answer"; a question that was
  never registered is not announced. A Codex approval or access request whose
  answer channel failed stays declined and records `interaction_answer_unavailable`
  instead of failing the run. A failed read of a run's pending questions is no
  longer reported as having none: `GET /v2/runs/:id` for a live run answers with
  the typed problem, so an open prompt stays open and a kept answer is retried,
  while a finished run's detail, a run list and a child card still render.

  A Codex app-server run now raises Codex's `request_user_input_async` as such a
  question: one async interaction per native item, with Codex's own question ids
  and options. Its text stays visible as an agent message but is never taken as
  the run's answer, even when the turn produced no other text. A committed answer
  goes to the turn that asked, once, as Codex's reply envelope (`turn/steer` with
  client message id `interaction-answer:<id>`), and each send leaves an
  `interaction_answer_steer` receipt. The end of that turn,
  Stop and the run's end withdraw an open question and send nothing. A sub-agent's
  question cannot be answered, and a question Claudexor cannot read, a run without
  an answer channel and a failing channel are recorded as
  `interaction_answer_unavailable`. This follows the Codex 0.162.1 source; it was
  not checked against a live Codex run.

- f4f8caf: Live messages and questions keep reaching a resumed Claude session while its
  prompt is still running (#536). The adapter remembers the uuid of the prompt
  frame it writes. Once Claude Code shows that it identifies commands by uuid (a
  lifecycle frame names the prompt, or a result names only commands the session
  never sent), the session's input stays open until a result names the prompt or
  the prompt's own lifecycle ends. Previously the first result closed the input
  whenever no message or background task was pending, so a result for an earlier
  turn of a resumed session could close it while Claude kept working; later
  messages were then refused with `not_active`/`no_live_session`. The input now
  stays open whether that earlier result arrives before or after Claude Code
  reports the prompt. An error result that names no command still ends the
  prompt, as the first result always did, and a Claude Code build that names no
  command keeps the close on the first result. An earlier result that names no
  command and arrives before the prompt's lifecycle still closes the input, and a
  success result that names no command leaves an identified prompt open until its
  own result, its lifecycle end or the run's time limits. A finished run still
  closes on its own result, queued messages and claimed background tasks still
  hold it, and a Monitor task without that claim still does not.

  A result for another turn also no longer decides the run's outcome. While the
  prompt runs, a result naming only commands the session never sent keeps its
  usage, and its failure, answer or context limit is kept as a `foreign_result`
  status instead of this run's error or final answer, so an earlier failed turn
  of a resumed session cannot fail a prompt that then succeeds. The prompt's own
  result, a live message's result and a result naming no command keep their
  meaning.

- f4f8caf: A Claude question whose answer the adapter could not obtain or deliver is no
  longer recorded as the user's decline (#622). An `AskUserQuestion` error result
  is now a neutral record with the CLI's own detail ("returned an error instead
  of answers") and the session input Claudexor held when it read the question.
  Frames can arrive in batches, so that state does not say when the model asked.
  When the adapter itself cannot obtain or send an answer, an
  `interaction_answer_unavailable` status names the reason with the request and
  tool-use ids: the run has no answer channel, the channel failed, the process
  ended before an answer was sent, the response could not be written, or the
  CLI's permission request was read after Claudexor had closed the session's
  stdin. That late request carries its exact native input instead of counting as
  a dropped frame. Only the no-channel and failed-channel denies tell the model
  why it got no answer; in the other cases it sees at most the CLI's own error,
  and a deny that cannot be written adds a second status. The stdin handle of a
  bidirectional session gains `send`, which reports whether a frame reached the
  child's pipe: nothing is written once the child has exited, even while a
  descendant still holds its output pipes, and a refused write reports its error.
  A declined or expired question keeps its benign decline and typed interaction
  events, and none of these is a blocking tool error. A failure inside the
  orchestrator's answer surface that it resolves as no answer is still sent as
  the benign decline.
- b9e88de: Interaction text reaches callers exactly (#651). The Codex access question
  now quotes the worker's complete final output instead of silently cutting it
  at 32,000 characters. A Codex approval refused for details over the
  32,000-character review limit now says so, with the measured size, instead of
  the generic "cannot grant" reason; readonly and workspace_write command refusals
  keep their priority. The bounded display labels (a harness event's timeline
  `title` and a Claude question's preview text) end in a visible "…" and never
  split a character; the complete text still rides beside them.
  `claudexor_run_wait` reports `wakeReason: "interactions"` when the next event is
  a question too large for any page. Each ACP multi-select include/skip round
  shows every option of the question with its description.
- 7be23bd: A Codex usage refusal that names no reopening time (#558) now lasts until its
  own five-minute recheck (#318). Before, any newer successful quota read, an
  empty one included, cleared it, so a Refresh or the background poll let the
  refused account be tried again at once. Reads no longer clear or extend it; a
  generic cooldown and a vendor-dated window keep their existing behavior. After
  the recheck the next requested run may try the account; nothing probes the
  vendor in between, and runs requested at the same moment each start.

  Claude's exact `oauth_not_allowed_for_organization` API error is now the
  existing subscription refusal (`oauth_org_not_allowed`) instead of an untyped
  failure, so the same request is no longer retried on the same account. The
  vendor's own code and words stay in the failure record, and the account is set
  aside for that refusal's existing period: up to an hour, or until a new sign-in
  or a later success on it. A pinned run still never moves to another account or
  an API key.

- Updated dependencies [80ca9ee]
- Updated dependencies [f4f8caf]
- Updated dependencies [f4f8caf]
- Updated dependencies [b9e88de]
- Updated dependencies [7be23bd]
- Updated dependencies [163b570]
  - @claudexor/schema@6.0.0
  - @claudexor/core@6.0.0
  - @claudexor/util@6.0.0
  - @claudexor/secrets@6.0.0

## 5.1.0

### Patch Changes

- 43b0491: The daemon's credential invalidation also drops the cached Claude model picker (#572). After a setup-job login, a profile created, toggled or removed, or a secret set, the next model listing that reads a profile's catalog probes it again, where it could previously answer with the earlier account's rows from the hour-long cache; a profile whose secret is missing, as after a delete, answers the hint rows without probing. The drop runs before the configuration and quota reads that can fail. A probe that started before the change still neither stores its answer nor displaces a newer probe. The same invalidation runs on every settings save, whatever it changed, and drops every scope including the credential-free binary one, so the next read of each scope spawns one prompt-free `initialize` probe again. The cache belongs to the daemon process and nothing re-reads it on a schedule: after a change the daemon does not observe, such as the CLI's direct Claude profile login or a vendor logout, `models()` keeps the earlier rows until its first call past the hour, an observed invalidation, a changed binary or a daemon restart, and no daemon models API offers a fresh picker read. The account view (`?view=accounts`) retains its own copy past that hour until an observed invalidation, harness maintenance, an Accounts refresh or a restart discards it, and a refresh inside the hour retains the adapter's cached rows again.
- b9f57d9: Continuation packets and D-16d checkpoints no longer drop a run's own recorded output because the carried answer, report or prompt contains its words (#568). Only the carried final itself is left out, with its keyed fragments and exact adjacent repeats; other attempts, earlier tries and earlier turns keep their messages whatever their text. `final/retained-output.md` groups keyed text by its speech key and keeps each native turn's final separate. In a Claude `text_runs_joined` response, the one deferred frame of a run of text blocks names the keys it joins (`payload.joined_speech_keys`) and becomes their single block when its words are exactly theirs; otherwise every block stays as recorded. Limits: a represented try without a typed final is still left out whole, since its joined narration is the answer; more evidence now competes for the bounded evidence section, whose cut stays marked; when the represented try is unknown nothing is left out, so the answer can appear twice; the earlier carried-text argument and option are still accepted and ignored.
- b63ceac: A credential refusal now keeps its actual scope (#609). A vendor model refusal on a run that named no model no longer marks the whole account failed or refuses other models on it for up to an hour: nothing is recorded as a hard mark, the run keeps its own failure diagnostics, and the existing pre-progress ordering mark applies only under its own conditions. A proven denial of subscription access, meaning the vendor's exact `oauth_org_not_allowed` code or its recorded organization-disabled result on a subscription route, now covers every model of that exact account and route even when the run named a model, and never another route, account or harness. Prose that only the parser's fallback files under that category proves nothing about other models: it keeps its diagnostics and retry class and restricts only the model the run named. A refusal of a known model stays exact, and success, expiry and credential-change clearing are unchanged.
- 2be1a9c: Questions Claude Code asks through `AskUserQuestion` now reach every answering surface without the former length cuts (2,000 characters for a question, 100 for a header, 500 for an option label and 1,000 for a description), and a selected long label goes back unchanged (#560). Non-blank free text is sent as written; `claudexor follow` and the macOS card take one line per question. The daemon refuses an answer row that names a question the interaction does not list, repeats a question, or carries neither a label nor non-blank text (`rejected`), and the question stays pending; partial answers, the empty-set decline and selected labels are handled as before. A pending question that no live session holds is answered `not_found` instead of `delivered`, and `delivered` does not prove that the Claude process read the answer. In ACP, each permission prompt now also shows the question's header and option descriptions, a multi-select question with every option skipped is left out instead of sent as an empty row, and a turn-text message names every question left without an answer: with nothing chosen the run stays paused on the set until it is answered elsewhere or expires, and otherwise the message says the chosen answers will be submitted as a partial answer that closes the set once it is accepted. The macOS question card wraps long option labels and scrolls long questions inside a bounded area. No live Claude CLI was run for this change, and the cause of the incident reported in #560 is not established.
- 8905c72: Add exact thread export (`claudexor thread export`, `GET /v2/threads/:id/export`) and conditional retirement against that export (`claudexor thread-retire`, `POST /v2/threads/:id/retire`), with `POST /v2/threads/:id/retire/abandon` to settle an unanswered operation and `GET /v2/threads/:id/retirement` (`claudexor thread retirement`) to read its outcome. A partial export names each gap and cannot retire. Retirement reaches only what a recorded real session proved, currently Claude 2.1.316 transcripts and spilled tool output on Darwin; any other host platform or session material is a named gap, exported byte-exact only where its harness declares its layout. A name the bundle's volume cannot hold is kept by item id, with the complete name in the manifest and the place in the receipt. `thread-retire` re-hashes and syncs every byte its bundle received, and the directories above it, before it sends a new operation, keeps that request in the bundle until an answer settles it, and names it in every unknown answer, so repeating the command repeats that operation. A purged thread admits no new work: a turn's create or retry, Exact Retry and decision rerun answer 409 `thread_purged`, while a command the thread accepted still answers its replay and a run's retained result can still be applied, discarded or reverted. Stop ends an export's journal or transcript read at its next chunk, and a restart's replay of an open retirement cleanup between lane entries. An export observes the thread's closure in the store maintenance worker's read-only snapshot, off the request thread, and an export read cancelled by Stop answers 503 `daemon_stopping` (retryable); the retirement decision still rereads the closure synchronously inside its transaction, at a cost that grows with the closure.
- 2e8b440: A run stopped by its max-turns cap now ends `interrupted` with the new reason `turn_limit_reached` (label "Turn limit reached", ACP stop reason `max_turn_requests`), and the caller decides what happens next (#299). Claude Code ends a capped turn with an `error_max_turns` result and exits 1; Claudexor read that exit as a process crash, resumed the same session under the same cap until the retry budget ran out, and reported a generic harness failure. Claude and Grok now report the capped turn as one error carrying the typed `turn_limit` field, whatever the exit code, so consumers that only read errors (the thread summary pass, the auth capability smoke, the reviewer engine) never take the partial narration for an answer. Nothing re-runs the work implicitly: the attempt is not resumed, moved to another account or replayed under the same cap, and neither the Ask `fallback_model` replay nor the solo Plan fallback to the next harness runs after it. The partial output stays in `final/retained-output.md` and is never written as the answer. An Agent run keeps its unfinished tree where the run keeps stopped work, and Agent and Ask terminals carry `resumable.cause: turn_limit` for an explicit `continueFrom`; Plan reports the same reason without in-run continuation facts, and an interrupted Plan attempt with no error of its own is described in the same words as Agent and Ask. The macOS app names the stop "Turn limit reached". New wire values: `RunReason` `turn_limit_reached`, `ResumableCause` `turn_limit` and `HarnessEvent.turn_limit`, so strict readers of those enums need the additions. The read-only terminals now also report a typed limit on an attempt whose CLI exited non-zero: an Ask whose Claude context was exhausted ends `interrupted / context_capacity_exhausted` instead of `failed / harness_failed`. Verified through the core run loop with a stand-in process that prints Claude Code 2.1.316's capped frames; no live capped run was made, and the Grok mapping is tested on synthetic frames only.
- 0d2d858: Run receipts now say what Web Off and an access profile actually did on each route, without changing either (#118, #413). Just before dispatching an adapter, the per-spawn gate records a `route_controls` receipt of what was prepared: the route's own web switch (`native`, `tools`, `uncontrolled` or `none`), the access profile, the vendor access arguments the adapter passes (for example Cursor `--force --sandbox enabled --trust --mode ask`, Codex `sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review`) and the access mechanism, where only `fs_sandbox`, the vendor's own sandbox, declares an OS file boundary and `native_settings` (`inherit_native`) leaves it unknown. `native_session_started` reports whether the attempt's native session was reported started, so a pre-spawn refusal or a stop stays distinct from a launch; `false` never proves that no process ran. The gate checks Stop again after recording the receipt, so a stop that lands at the receipt keeps it and never dispatches the adapter. Agent attempts also carry their applied HOME fact, where `false` means the engine did not replace HOME; Ask and Plan record none, so none is claimed. The web evidence states its scope (`observation`: typed web tool calls and engine Browser calls; network traffic not measured), so `attempted: false` no longer reads as "no network". The run summary projects the distinct routes as `routeControls` together with `webEvidence.verification` and `webEvidence.observation`, and `claudexor inspect` prints `access route`, `web route`, `web retrieval` and `web scope` lines. Retrieval strength now says what came back. A verified result carries `verified_content`: Claude's WebFetch and a Browser navigation or snapshot of a loaded http(s) page are a `page`, while Claude's WebSearch is `search_results`, which is not a fetched page; its strength and the required-web gate are unchanged. A Browser page read that got an HTTP error status is `dispatched`, and a Browser call that read no web page (closing, clicking, listing tabs, an `about:blank` or `data:` page) carries no retrieval stamp: it still counts as completed web activity for the unchanged required-web gate, but the strength stays `none`. The Browser rule is checked against recorded replies of the pinned Browser MCP, and a denied or cancelled Claude web call is no longer stamped as a verified retrieval. The macOS run facts show "Web verified" for a verified page, "Web searched" for verified search results, "Web reached" for a web call without a typed result and "Web tools used" when completed web tools retrieved nothing or the engine sent no strength; for Web Off they show "Web tools off" only when a route reported a native session under the off switch, otherwise "Web Off requested"; and they describe access by its native setting and declared boundary instead of "enforced".
- Updated dependencies [b63ceac]
- Updated dependencies [b1320a9]
- Updated dependencies [b1320a9]
- Updated dependencies [0d2d858]
- Updated dependencies [d9e8247]
- Updated dependencies [b63ceac]
- Updated dependencies [8de1106]
- Updated dependencies [2be1a9c]
- Updated dependencies [6bce7ce]
- Updated dependencies [6bce7ce]
- Updated dependencies [8fb1023]
- Updated dependencies [40b3ce8]
- Updated dependencies [8905c72]
- Updated dependencies [2e8b440]
- Updated dependencies [0d2d858]
  - @claudexor/schema@5.1.0
  - @claudexor/util@5.1.0
  - @claudexor/core@5.1.0
  - @claudexor/secrets@5.1.0

## 5.0.2

### Patch Changes

- Updated dependencies [d9f50f5]
- Updated dependencies [6ba9b91]
  - @claudexor/schema@5.0.2
  - @claudexor/util@5.0.2
  - @claudexor/core@5.0.2
  - @claudexor/secrets@5.0.2

## 5.0.1

### Patch Changes

- @claudexor/core@5.0.1
- @claudexor/schema@5.0.1
- @claudexor/secrets@5.0.1
- @claudexor/util@5.0.1

## 5.0.0

### Patch Changes

- fe7e2ae: Codex MCP tool results keep what the server returned. A completed call now carries the text of its result, or its structured content when no text came back, as the bounded `content_summary`, so a Browser navigation records the page URL and title it actually loaded instead of only the tool name. A failed call keeps the vendor's `error.message`, or the text of a result the server marked as an error, instead of a generic "mcp tool call failed". A completion with any other status is no longer reported as a success; it stays statusless. Tool names and the `server:tool` target that Browser and Delegate evidence match are unchanged. In both Codex and Claude, an MCP result's `content_summary` now keeps the line breaks of the server's text, so a Browser result's page fields, code and snapshot stay on their own lines; whitespace within a line still collapses, blank lines are dropped, and the 1,000-character bound is unchanged. The `error_summary`, the event text and the summaries of all other tools stay on one line.
- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- 2d83b87: Claude quota families now reach newly released models of that family (#394). A weekly Opus limit, whether read from the usage endpoint, reported during a run or carried by a typed Opus rejection, applies to every `claude-opus-…` id, including ones newer than the built-in model list, and no longer applies to `best`, a run that names no model, or another family. A weekly limit the vendor does not name, and an Antigravity quota group the adapter does not recognize, no longer block the whole account: each such window's id, usage and reset are written to the daemon's `quota.observation` log instead, even when the reading held no other window, while known family and account-wide limits keep blocking. A reading that held only such windows counts as a failed refresh, never as an account with no limits. Quota records written by earlier versions are read back in the new form, so an old Opus limit stops refusing `best` and is replaced by the next reading of the same window; an old reading that held only such unknown windows is read back as unknown, so it is not shown as current and the account is still polled. Other accounts, routes and windows are untouched.

  A short quota window that has reset no longer counts against an account, and no longer hides a weekly limit read at the same time (#457). Run admission judges each window separately at the moment it decides: within the five minutes a reading stays current, a weekly reserve still applies after the five-hour window resets. A reading never becomes fresher than when it was taken, and a reset window is not treated as new free quota. The next-account hint (both the ordinary Accounts read and an explicit refresh) and model operations make the same per-window decision as runs, so the hint never names an account a run would refuse. The quota display and the Accounts cards keep their existing whole-reading freshness.

  A pinned account refused by quota now says why (#318). The refusal keeps the `subscription_window_exhausted` code and adds `quotaRefusal.basis` to the run's failure record, `refusal_basis` to the problem context and `basis` to the `route.profile.headroom_exceeded` event: `owner_reserve` when usage reached your saved `headroom_threshold` while the provider still reports quota left, `provider_window` when the provider reports the window spent, and `provider_cooldown` for a provider rate-limit cooldown or a limit hit by the pinned run itself, in Agent, Ask, `--attempts` and Plan runs. A pinned Plan stopped by a provider limit now ends with the same typed code, reset time and basis instead of a generic harness error; a limit the vendor recovered from, or a Plan that ended for another reason (context exhaustion, an empty plan, an invalid work report, an outdated Claude Code CLI, a Claude API error other than HTTP 429 such as a rejected login, a crash or cancellation), keeps its own cause. A provider limit is never labelled as your reserve, whatever the threshold, including a spent window whose reset time is unknown. The window, usage and reset time reported with a refusal all come from the limit that decided it, and a run whose candidates hit different windows reports only what they share. The saved reserve still applies to a pinned account and a pin still never moves to another account; the default threshold stays 100%. When every account stopped only at its saved reserve, the next-account hint says so. Authentication and billing failures are not quota refusals and are not covered by this change.

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

- 8a9c2f6: On Windows, never hand a `.exe`/`.com` without the PE minimum shape (`MZ`, then `PE\0\0`) to the OS. The harness resolver skips such a PATH candidate or standard npm launcher target, naming the file, and uses a later healthy candidate; a broken Node interpreter is passed over for a later healthy one and named only when none remains. When nothing is selected, a bare-name spawn is refused before any process starts with `EFTYPE` if the install was proven broken, or if the spawn's own search (the cwd first, then PATH) would reach such a file; the message leads with that file. This covers the placeholder `claude.exe` an npm install leaves when the package's postinstall did not run. Windows PATH is read as libuv reads it: a quoted entry may contain `;`, and a child env without PATH searches the daemon's own PATH. Relative PATH entries resolve at the daemon's cwd for runs and probes alike, and the selected file is spawned by its absolute path; an explicitly relative override resolves from the spawn's cwd.

  Claude doctor and discovery report the unlaunchable file instead of "claude CLI not found on PATH", and the broken-install advisory shown by login and Codex doctor uses the same wording. The Claude auth-status probe treats a format failure (`EFTYPE`/`ENOEXEC`) as structural: one attempt, with no retry and no last-known-good fallback. Unreadable files, failed reads, busy or missing files and unknown loader errors keep their previous handling, and nothing about a refusal is remembered, so replacing the file recovers without a restart.

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
- Updated dependencies [8a9c2f6]
  - @claudexor/schema@4.7.1
  - @claudexor/core@4.7.1
  - @claudexor/secrets@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Patch Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.
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

### Minor Changes

- a81897c: Choose the native prompt-cache lifetime of Claude Code sessions per run: `POST /v2/runs` and `POST /v2/threads/:id/turns` accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`, including plan answers the same command submits inline), and omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities` projects them as `harnesses[].promptCacheTtls` and lists the key in `runControlKeys`. The value is frozen into the task contract, inherited by a bare `continueFrom` (a successor cannot go back to Default; that takes a new run), re-injected by Exact Retry, and forwarded to task lanes, the continuity summary, reviewers and delegation-belt children on declaring harnesses. Elsewhere it is an `ignored_settings` disclosure, except in best-of synthesis, which emits no `harness.started`: an undeclared synthesis harness runs without the lifetime and without a disclosure. The deep-scan reducer's `harness.started` now discloses every route knob its harness ignores, including `max_turns` and tool lists. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, keeps forcing and disabling controls, and discloses the ones known to govern instead (and a known older CLI). Each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the lifetime routed to its sessions (`requested`), the configured value and the observed split of the reported five-minute and one-hour cache-write tokens; an unreported split stays unknown.

### Patch Changes

- Updated dependencies [b344c39]
- Updated dependencies [a81897c]
- Updated dependencies [2593b90]
  - @claudexor/core@4.6.0
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0
  - @claudexor/secrets@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [032b44b]
  - @claudexor/schema@4.5.0
  - @claudexor/core@4.5.0
  - @claudexor/secrets@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Declares its native sessions not pruned, because independent deletion safety is not proven, so engine retention leaves them in place (#477).

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

### Patch Changes

- A Claude `workspace_write` run pre-approves `Read`, `Glob` and `Grep` outside its working folder, as `readonly` already does (#469). File-tool edits still follow `acceptEdits`; the default pre-approved shell was already unconfined (`write_mechanism: tool_policy`). Narrowing or denying `Bash`, or denying only one bare read tool, does not confine the remaining read tools: use explicit path-scoped `Read(...)` rules or the vendor's working-directory read block when that boundary is required. An explicit read allow pattern keeps all three bare tools out; deny rules remain effective, and a bare deny skips its own tool. Other access profiles are unchanged. The corrected flags have source and deterministic-test evidence, not a qualified live vendor run.
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

- 1111845: Keep session history bound to both its harness and profile when locating, moving and continuing it. Recognize Claude's failed missing-session diagnostic and continue through the existing evidence packet instead of retrying the unavailable native session. Previously misplaced histories remain preserved and are not relocated automatically.
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

- f0ab916: Make one effort word work on every route. The vendor's own order still ranks every level it lists; the shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) now places a word a route's ladder does not list, so `ultra` on a Claude binary that stops at `max` resolves downward to `max` and `none`/`minimal` resolve to the known minimum instead of refusing the run. The receipt names that placement and claims neither vendor support nor equal quality across vendors. One resolution result feeds the native flag, the typed receipt and the disclosure on Claude, Codex (sessions and raw model calls) and the ACP client, which now resolves `--effort` through the same resolver and records a receipt. A reviewer whose harness declares no effort controls keeps the preference as omitted with disclosure instead of failing the explicit panel or erasing the automatic panel's request. A word neither order knows is still refused before generation on routes that have a native effort knob.
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
- dc30eda: Complete managed CLI and remote sign-in flows, preserve actionable Claude CLI version failures, and resolve native and standard npm Node entrypoints consistently across launch, probes and login.
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

- Updated dependencies [b00408e]
  - @claudexor/core@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/secrets@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

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

### Minor Changes

- 092ec2b: Claude Code runs accept live messages: `POST /v2/runs/:id/messages` now reaches a running Claude Code attempt through the adapter's native stdin queue fold (`capability_profile.live_input = "next_tool_boundary"`).

  A message is written to the live stream-json stdin as a user frame carrying the message id as its `uuid`. Claude Code queues it at once (`command_lifecycle queued`, the `accepted` receipt) and consumes it inside the same turn right after the current tool batch; the `--replay-user-messages` echo (or the `started` lifecycle frame) is the consumption receipt (`delivered` when it settles a still-open request, otherwise the adapter's status event with code `live_input_delivered` keyed by `message_id`). A message that arrives while the model composes its final text runs as the next native turn of the same process: the run loop's new `session.onIo` seam and a `closeStdinOn` that returns false while a message is `queued|started` or a run-owned background task is open keep stdin open, the parser folds the second `system/init` into one `started` (a typed `native_turn_started` status marks the turn) and emits each result's cost as the delta of the cumulative `total_cost_usd`, and the last result's final text is the run's answer. No `queued` frame within 2 s answers `delivery_unknown`/`response_timeout`; a lost stdin answers `delivery_unknown`/`transport_lost`; a `cancelled|discarded|refused` lifecycle state is typed `live_input_refused` and never fails the run. Both flows were recorded on Claude Code 2.1.283 through the real adapter path (`packages/harness-claude/fixtures/stream-json/recorded-live-fold-2.1.283.jsonl`, `recorded-live-final-text-2.1.283.jsonl`) and are replayed 1:1 by the conformance tests. Cursor, Antigravity, OpenCode and raw-api keep `none`.

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

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

### Patch Changes

- 2c024ac: Claude models are discovered from the installed binary instead of a shipped list (#338, #340).

  The claude adapter gains a live `models()`: the prompt-free `initialize` handshake of the installed `claude` binary (one stdin frame, exit on EOF, never `--model`, `--setting-sources ""`, `--strict-mcp-config`, model-override env scrubbed) answers the picker's selectors with their vendor-reported resolutions; the rows travel as `origin: live` with `resolved_model`, followed by the frozen `CLAUDE_KNOWN_MODELS` ids as `origin: hint` so presence never shrinks below the manifest. A `config_dir_login` profile is probed under its own config dir and keychain bridge, an `api_key`/`oauth_token` profile with its own credential in the env var its runs use under a scratch HOME (the account's own rows in `?view=accounts`, cache keyed by profile id, never by a secret); the unscoped listing is a credential-free binary probe under a scratch HOME with non-essential traffic off. The answer is total: a missing or failing binary yields the hint rows and the registry reports `source: manifest` with the frozen `verifiedAgainst` stamp rather than a live claim. One cached single-flight capture per (scope, binary identity) lives an hour (a minute for failures); `harnessBinaryIdentity` in core keys it and the `--help` effort memo by realpath, inode, size and mtime, so an in-place CLI update is re-read without a daemon restart; a run whose env patch carries a PATH has its effort ladder, readonly flag set and `--version` read from the binary that PATH selects. The manifest declares `model_inventory_absence: "advisory"` and freezes `known_models_verified_against` at the literal 2.1.261. `HarnessModel` gains optional `origin` and `resolved_model` (absent = live; producers that predate the field need no change); `claudexor models` prints resolutions and hint marks.

  Invariants: INV-104 governs the declaration (amended in the sibling commit); INV-020/INV-022 hold (both new fields have a producer and readers).

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

- Updated dependencies
  - @claudexor/schema@3.12.10
  - @claudexor/core@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/core@3.12.8
- @claudexor/schema@3.12.8
- @claudexor/secrets@3.12.8
- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/core@3.12.6
- @claudexor/schema@3.12.6
- @claudexor/secrets@3.12.6
- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

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

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Pin Claude Code 2.1.261 so Fable 5.1 is runnable through the managed installer, and refresh its effort and native protocol recordings. Preserve historical asynchronous MCP startup coverage separately from current connection evidence.
- 069c6e3: Admit `claude-fable-5-1` (Claude Fable 5.1) to the Claude manifest known-model list, so an explicit Fable 5.1 pin is accepted and the Fable weekly window names the id; the model itself requires Claude Code 2.1.251 or newer.
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

- 14e1dd3: Refresh expired Claude subscription credentials through Claude Code before reading quota, without sending a model prompt or taking custody of refresh tokens.
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

- fc15ea8: Keep transient Claude native auth-status transport failures typed as unknown,
  with bounded retry and last-known-good disclosure instead of a false logout.
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

- Keep `allowed_warning` advisory and project proven quota/rejection family names onto verified model aliases.
- @claudexor/core@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- Emit typed retry and status signals and keep interactive wait, answer, and cancellation semantics aligned with the shared run contract.
- The known-model list is a strict catalog verified against the installed vendor CLI, with the catalog and its verified-against stamp moved into capability-profile.ts.
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
