# @claudexor/cli

## 6.0.0

### Major Changes

- 163b570: Vendor programs are installed and maintained through adapter-declared vendor
  commands under the installation HOME. Selected paths and self-reported versions
  are shared by runs, probes and maintenance. Passive reads reuse the remembered
  answer for the same file identity, including no answer; a failed ask preserves
  an earlier answer. A replacement behind an unchanged wrapper appears at the
  next inventory read, fresh read or native startup frame, not a passive poll.
  Claude, Codex and Copilot supply startup versions; the other adapters use
  remembered evidence or one first version ask. Model lists identify their source
  program. Native attempts retain program evidence and exhausted credential
  pools retain the last bounded, redacted vendor diagnostic.

  Breaking: maintenance inventory and receipts use selection/newest/actions,
  tri-state update availability, command previews and before/after evidence.
  Hosts must update their consumers and use explicit exact versions instead of
  baseline/previous targets. Install --target and --release-tested hard-error;
  use harness install/update with optional --vendor-version <exact>. The host npm
  contract is removed. Product-made npm copies convert during Update only after
  a version-answering replacement that is not known older and belongs to the
  adapter's declared major, where present. Interrupted package hides recover on
  the next explicit maintenance; arbitrary wrappers remain untouched.

  The SSH app consumes the same inventory and receipt contract. Windows executes
  five vendor installation routes. Copilot's MSI folder is declared for inventory,
  probes and native runs without restarting the engine. Cursor Windows (#667), OpenCode's second line
  and unattended Windows installation (#668) remain unsupported. OpenCode stays
  on 1.x; vendor pruning and package-manager advice remain vendor responsibilities.
  Copilot Update can return GitHub's unauthenticated rate-limit refusal; the
  vendor's sentence is the result. No engine timer, update/retry chain, model-to-version table or active-run gate
  is added. Release checks fetch declared sources and report absent verb checks
  as skipped.

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

- f4f8caf: An ACP prompt for a blocking question no longer holds the turn. `session/cancel`
  now reaches a run that is parked on a question, and a prompt whose question was
  answered elsewhere, expired or outlived its run closes without the editor
  replying. The agent stays parked until its question is settled, a turn that was
  cancelled no longer reports a run still paused, and a prompt that fails still
  fails the turn.
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
- a20492c: A file a Raw API patch created is no longer lost when a Git ignore rule matches
  it (#594). The paths an accepted raw patch wrote stay in the candidate: the next
  round's tree, the run's result, Apply and Revert carry them by exact path while
  each is still a file, also after a fresh workspace manager, a `continueFrom`
  successor that adopts the kept envelope, or orphan recovery. Other ignored files,
  a gate's output or a native round's, stay out as before, also when a later patch
  makes the ignore rules match them, and so does a file inside an ignored nested
  repository. The record lives in per-worktree refs of the envelope's own
  repository and is written before the patch's first byte lands; a record that
  cannot be written or read refuses the patch, or the capture, instead of dropping
  the file. Git before 2.43 cannot tell a failed record lookup from a missing one
  and reads it as no record. A persistent thread's Raw API turns keep such files
  between turns, before any Apply; a candidate that was rejected or did not win
  changes neither the thread's files nor its record.
- f4f8caf: `claudexor_run_continue` accepts `effort` and a harness-keyed `efforts` map, so
  an MCP caller can restate the reasoning effort a successor must keep (#604).
  Both reach `POST /v2/runs` exactly as stated, as the REST continuation already
  allowed. Each lane uses its `efforts` entry, else `effort`, else its Settings
  default. A successor still inherits no effort from its predecessor: omitting
  both keeps the ordinary new-run default. An invalid level is refused before the
  request is sent, and an unregistered harness id is refused by the engine as
  before. The generated host skills and the portable skill now list effort among
  the controls to restate. `claudexor_run` now describes its `effort` as the
  engine applies it, to every harness the run executes and not its reviewers,
  instead of only the primary harness.
- Updated dependencies [a0a5b1a]
- Updated dependencies [80ca9ee]
- Updated dependencies [f4f8caf]
- Updated dependencies [f4f8caf]
- Updated dependencies [f4f8caf]
- Updated dependencies [f4f8caf]
- Updated dependencies [860bc04]
- Updated dependencies [b9e88de]
- Updated dependencies [7be23bd]
- Updated dependencies [2241f40]
- Updated dependencies [a20492c]
- Updated dependencies [f4f8caf]
- Updated dependencies [7be23bd]
- Updated dependencies [163b570]
  - @claudexor/harness-agy@6.0.0
  - @claudexor/orchestrator@6.0.0
  - @claudexor/schema@6.0.0
  - @claudexor/core@6.0.0
  - @claudexor/daemon@6.0.0
  - @claudexor/control-api@6.0.0
  - @claudexor/mcp-server@6.0.0
  - @claudexor/acp-server@6.0.0
  - @claudexor/harness-codex@6.0.0
  - @claudexor/harness-claude@6.0.0
  - @claudexor/harness-fake@6.0.0
  - @claudexor/util@6.0.0
  - @claudexor/workspace@6.0.0
  - @claudexor/delivery@6.0.0
  - @claudexor/config@6.0.0
  - @claudexor/gateway@6.0.0
  - @claudexor/harness-acp@6.0.0
  - @claudexor/harness-cursor@6.0.0
  - @claudexor/harness-grok@6.0.0
  - @claudexor/harness-opencode@6.0.0
  - @claudexor/harness-raw-api@6.0.0
  - @claudexor/review@6.0.0
  - @claudexor/artifact-store@6.0.0
  - @claudexor/secrets@6.0.0

## 5.1.0

### Minor Changes

- Keep project-owned run data under the logical project when execution uses a temporary copy, and place explicit one-shot runs in a shared run-addressed namespace. Preserve legacy addresses, retention periods, last-run protection and tombstones; leave live workspace envelopes to their existing owner.

  Add opt-in managed uploads and explicit release of future reuse. Accepted commands, turns, deferred work and exports retain the bytes they need; legacy and default uploads remain indefinite. A released ID refuses new references rather than silently importing again. Store schema 7 is forward-only; returning to an older binary does not undo that migration.

  Make retention observe concurrent partition and reference changes, preserve partial-effect uncertainty, and compact and coalesce the schema-1 run-scope index without dropping unproven entries, repeating a failed write without another reap. Separately bounded later settlement attempts recheck process identity and can release an unchanged deferred message held solely by process custody; cancellation, shutdown, replacement and other holds still win.

  Startup cleanup follows no link below the config root. A linked project namespace, `workspaces` or `threads` directory, thread worktree, or task or attempt entry is reported and kept, with the attempt branches it hides, because it may reach another store. To move Claudexor's data, move the whole root with `CLAUDEXOR_CONFIG_DIR`.

- 1c2bd56: `claudexor scanner prepare [--from-archive <file>]` prepares the pinned publication scanner that `pr` delivery requires (#578). An npm install bundles no scanner and its only way to get one was a script in the source tree, so `pr` from npm refused with no supported path forward. The command downloads the pinned official archive, or takes one you already have, proves both digests and the license and places the complete copy under this machine's config root. Installed package files are not written, and a running daemon uses the copy at its next `pr` with no restart. A complete copy already there is reused, anything else there is reported and left untouched, concurrent runs reuse the winner, and an interrupt ends the extraction and activates nothing. `pr` still never downloads, and the scanner lookup order is unchanged.

- Add the typed, idempotent `taken` decision for terminal patch results captured by a caller. The engine keeps result bytes under the ordinary retention window while exposing the action through the CLI and its decision output.

### Patch Changes

- `claudexor harness install agy|cursor` on Linux and macOS now runs the downloaded vendor script with `/bin/bash` instead of `/bin/sh` (#639). Both vendor installers are Bash programs (Antigravity's starts with `#!/bin/bash` and `set -euo pipefail`; Cursor's uses `${VAR//…}` and `[[ … ]]`), and on Debian and Ubuntu `/bin/sh` is dash, which rejected Antigravity's script with exit 2 before it did anything. The disclosed command names the same `/bin/bash` runner. A host without `/bin/bash` now gets the typed `installer_interpreter_missing` refusal before anything is downloaded, with no `sh` fallback. Download, size and SHA-256 disclosure, the human-observed and unattended evidence classes, failure codes, cleanup and Antigravity's Windows PowerShell runner are unchanged.
- Preserve retention completion history and failed/held streaks, carry latched hold causes, and keep no-change Git captures on the ordinary retention window.
- Sweep orphan lane homes in unregistered runtime namespaces while protecting live, archived and quarantined owners; preserve intermediate registration roots and late recovery holds during retention.
- Keep GC replies compatible with strict older clients by exposing new history and removed-lane facts only through the existing opt-in retention report.
- b63ceac: Accounts now shows a typed refusal of one model on an account (#200). `GET /v2/accounts/routing-evidence?includeCredentialUnusable=true` adds `credentialUnusable[]`: each registered row's live model-scoped credential refusals with the model, the typed code, redacted evidence such as the vendor's error category, and when it was observed and expires. Without the query the response keeps its earlier shape, and an engine that rejects the query is read again without it. `claudexor profiles`, `claudexor accounts` and the MCP accounts tool print or carry these as dated `recent refusal` lines, and the macOS Accounts row leads its one "Recent refusal" line with "<model> (<reason>, <age>)", most recent first, wrapping that line to at most three lines so the ordinary row states it. A refusal of one model never changes the account's status, Enabled state or order; a credential-wide refusal stays in the account's status. An entry clears when the account later serves exactly that model as the vendor reports it, on a credential change, or on expiry; service the vendor reports under another id, such as a dated id for a requested alias, leaves it until expiry.
- 43b0491: The daemon's credential invalidation also drops the cached Claude model picker (#572). After a setup-job login, a profile created, toggled or removed, or a secret set, the next model listing that reads a profile's catalog probes it again, where it could previously answer with the earlier account's rows from the hour-long cache; a profile whose secret is missing, as after a delete, answers the hint rows without probing. The drop runs before the configuration and quota reads that can fail. A probe that started before the change still neither stores its answer nor displaces a newer probe. The same invalidation runs on every settings save, whatever it changed, and drops every scope including the credential-free binary one, so the next read of each scope spawns one prompt-free `initialize` probe again. The cache belongs to the daemon process and nothing re-reads it on a schedule: after a change the daemon does not observe, such as the CLI's direct Claude profile login or a vendor logout, `models()` keeps the earlier rows until its first call past the hour, an observed invalidation, a changed binary or a daemon restart, and no daemon models API offers a fresh picker read. The account view (`?view=accounts`) retains its own copy past that hour until an observed invalidation, harness maintenance, an Accounts refresh or a restart discards it, and a refresh inside the hour retains the adapter's cached rows again.
- 0d2d858: Codex now holds the first turn for an explicitly selected Browser (#215). Codex starts Browser in the background, and a server not ready about a second after `turn/start` was absent from the first model request, so the model could report Browser as unavailable while it was still starting. The adapter waits for Browser's own startup status after `thread/start` and `thread/resume` while Codex's existing 90-second startup limit runs, holding the turn at most 5 seconds longer so that a failure Codex reports at its limit (observed at about 90.06 seconds) keeps Codex's own reason; it waits only when Browser is injected: other optional servers, runs without Browser and runs with web off start as before. Stop during the wait ends as `user_cancelled` without starting a turn, which also fixes a Stop that could hang while waiting for a required server. A Browser that fails to start never fails the run: the turn continues with the remaining tools, and a `codex_browser_startup` status event records the outcome, the wait and Codex's own masked reason, so a task that needs a page stays visibly unmet. The engine also records that outcome as the attempt's `browser.startup`, the run summary projects it as each route's `browserStartup` (null for a Browser that was only handed to the route, never read as connected), `claudexor inspect` prints it as `browser_startup=` on the `web route` line, and the macOS Browser badge states it (`prepared` when nothing was reported, `ready`, `startup failed`, `startup cancelled` or `startup unconfirmed`, never a run failure), with Codex's reason in its help and in Diagnostics. This does not establish why any earlier live Browser run failed.
- 7a6c782: The daemon's credential invalidation also drops the cached Codex model and effort catalog (#610). After a setup-job login, a profile created, toggled or removed, or a secret set or deleted, the next read of a Codex home asks `model/list` again, where it could previously answer with the earlier account's models and effort ladders for up to ten minutes. The drop runs before the configuration and quota reads that can fail. A probe already running when the catalog is dropped, by this invalidation or by harness maintenance, still answers the caller that started it, so that one call can carry the earlier account's rows or ladder into a listing or a run; it no longer stores its answer or its failure, so it cannot reach a later reader or replace what a newer probe stored. The same invalidation runs on every settings save, whatever it changed, and on any harness's login window, and it drops every home, so the next read of each home spawns one prompt-free `app-server` child again (concurrent reads of an empty entry each spawn their own, as on any miss). The cache belongs to the daemon process and nothing re-reads it on a schedule: after a change the daemon does not observe, such as a vendor login or logout it did not run, a live answer stays until its first read past ten minutes, an observed invalidation, a changed binary or a daemon restart. The account view retains its own copy past those ten minutes until an observed invalidation, harness maintenance, an Accounts refresh or a restart discards it, and a refresh inside them retains the adapter's cached rows again.
- d9e8247: A Codex usage refusal is no longer treated as a network blip (#558), and the vendor's own failure record reaches the run's diagnostics without an OS exit code (#414).

  Codex's typed `usage_limit_exceeded` (a spent plan window or a workspace out of credits) now becomes a typed limit with no known reopening time (`rate_limit.reopening: "unknown"`), read from the rollout record or the app-server frame and never from the message words. The run never resumes or replays the same account for it, and neither does an ordinary reviewer when the refusal's words also read as a broken stream; a broken stream with no typed refusal is still retried on the same account as before. A pinned account ends at once with `code: null`, `category: harness_unavailable`, `resetsAt: null` and the vendor's cause, because `subscription_window_exhausted` tells every reader that waiting cures it, which nobody knows here. An unpinned run follows its `limit_action` (the default moves to the next ready account), and with no other account it ends with an undated `credential_pool_exhausted`. The daemon keeps the refusal for its existing bounded cooldown under the identity `cooldown:reopening_unknown`, with no invented usage or reset, so the next pinned run is refused before spawn with the same honest record and the pool ranks the account last and stays undated, even when another of the account's windows has a date. The same record is kept when a pinned Ask's `fallback_model` meets the refusal during attempt setup, and the Accounts `next_up` text no longer says unpinned runs wait for a reset when a member was refused this way. A newer recognized quota read retires the refusal under the same rules as a generic refusal. Vendor-dated windows, retry delays and vendor reset days with no such refusal beside them keep their code and reset. The `vendorFailure` of a failed try is recorded whether or not the try ended with an exit code, on that try's `poolAttempts` row and on the failure record for the attempt's last try only. A candidate that changed files before such a typed refusal now keeps the refusal's code, reset and remedy on its failure record instead of a generic harness error.

- 860bc64: Callers of the shared control-API client no longer pass their own `Authorization` header; the client already sets it on every request. Methods, URLs, header values and bodies are unchanged; only the header order on the wire can differ.
- 8de1106: A Cursor command handed to a background shell no longer reads as running forever. The handoff now says "Handed off to background; completion not observed" (after its timeout when the 30-second shell timeout moved it) instead of "still running". When Cursor later reports, in a `system/task_notification` frame, that this shell ended with `success`, `error` or `aborted`, Claudexor updates the same command instead of dropping the frame as unrecognized: a `status` event with `payload.code: command_outcome_refined` names the original tool call and carries the refined `command_outcome` (`completion_reported` with that word, the handoff facts kept), and the complete native frame is kept as evidence. The exit code stays unknown, because the frame has no typed one and free-text detail is not parsed, so the command reads "Completion reported; exit code unknown" or "Completion reported (error); exit code unknown". It is never shown as a success, a passing test or a recovery from an earlier failure. The run's telemetry keeps each report as a command fact (`reported_command_outcomes`) that `claudexor inspect` lists apart from tool errors: the tool call itself stays `ok`, and a reported `error` or `aborted` is no tool warning, failed attempt or ranking penalty, since a deliberately stopped dev server may simply have finished correctly. The macOS transcript updates that command's row in place (found by its exact tool-use id, never by name, and never to green), the run timeline shows the update as a warning row, and the continuation packet carries the refined outcome. ACP sends one more `tool_call_update` for the already closed call with its new text and `_meta`, leaving `status` out so the terminal `failed` stands. `claudexor acp serve` now actually streams tool activity: its run event feed, which carried only timer notices, also delivers each tool call, its result and these refinements (never narration or thinking), and each ACP call id names the run and try that issued it, so tries or turns that reuse a native id stay separate calls. The macOS transcript pairs a result only with its own try's call of the same tool-use id; a result whose call never arrived gets its own row instead of closing another open command, and an id-less result closes only the one open id-less call of its exact name in its try when the name fits the existing tool-field limit; longer names remain separate rows. `claudexor inspect` says how many reported outcomes it shows of the total. A notification that names no pending handoff of the same session (an unknown or progress id, a duplicate, a shell id shared by two pending handoffs) or carries any other status changes nothing and stays counted as an unrecognized frame. The frame shape follows one native cursor-agent 2026.08.11 run and that build's stream writer; no sanitized recording exists yet (razzant/claudexor#546).
- 43b0491: `claudexor doctor` keeps its Git and harness sections when the route-health read fails for any reason other than an older engine's 404 (an HTTP error, a lost connection, or an answer that does not match the schema), and prints route health as unavailable with that cause rather than losing the whole report (#569). `doctor --json` carries the cause as `route_health_problem` beside `route_health: null`; the field is null after a 404 or an answer. A route's failed share keeps its counts and no longer rounds a nonzero failure to 0% or a partial failure to 100%: `1/201 failed (<1%)`, `200/201 failed (>99%)`.
- 2be1a9c: Questions Claude Code asks through `AskUserQuestion` now reach every answering surface without the former length cuts (2,000 characters for a question, 100 for a header, 500 for an option label and 1,000 for a description), and a selected long label goes back unchanged (#560). Non-blank free text is sent as written; `claudexor follow` and the macOS card take one line per question. The daemon refuses an answer row that names a question the interaction does not list, repeats a question, or carries neither a label nor non-blank text (`rejected`), and the question stays pending; partial answers, the empty-set decline and selected labels are handled as before. A pending question that no live session holds is answered `not_found` instead of `delivered`, and `delivered` does not prove that the Claude process read the answer. In ACP, each permission prompt now also shows the question's header and option descriptions, a multi-select question with every option skipped is left out instead of sent as an empty row, and a turn-text message names every question left without an answer: with nothing chosen the run stays paused on the set until it is answered elsewhere or expires, and otherwise the message says the chosen answers will be submitted as a partial answer that closes the set once it is accepted. The macOS question card wraps long option labels and scrolls long questions inside a bounded area. No live Claude CLI was run for this change, and the cause of the incident reported in #560 is not established.
- cd6e9fa: `claudexor profiles rollback-migration [harness]`, the supported downgrade path of the unified-accounts migration, now runs (#570). The CLI's argument check refused it with a usage error before the command started, so the documented command could not be used. `claudexor help` and the profiles usage now list it. Omitting the harness reverses every migrated harness. An explicitly empty or blank harness, such as an unset `"$HARNESS"`, is refused before the daemon is contacted, as are a second operand and `--harness` in place of the operand. When a harness's runs are blocked by an incomplete migration or an interrupted rollback, the run refusal (and, for an interrupted rollback, the daemon startup log) now names `claudexor profiles rollback-migration <harness>` for that harness instead of the nonexistent `claudexor accounts-migration-rollback`. An externally owned daemon refuses `claudexor daemon stop`, so for an incomplete migration the refusal's restart advice now covers both lifecycle owners: that command for a standalone daemon, and the owning application for an externally owned one. Rollback now ignores inherited object-property names that are not actual migration records, avoiding a corrupt migration entry; rollback of real named records and the all-record form retain their existing semantics.

  **Behavior change:** `--display-name` now works only with `profiles add`. `claudexor profiles` with or without `list`, and its `login`, `enable`, `disable`, `remove` and `rm` verbs, used to accept and ignore the flag; they now refuse it with exit 2 before contacting the daemon. `rollback-migration` refuses it too, so the flag cannot consume the intended harness and leave an all-harness rollback. Remove the flag from any script that passes it to those verbs.

- 4a4d998: Removing a project no longer fails with `409 active_run_scope_unresolved` while a run with no project, such as an Ask started outside any project, is queued or running (#549). The removal check read every such run as having an unknown scope; it now reads the scope the run's accepted request recorded, so a run with no project, including one whose request omitted the scope, holds no project, and the unrelated project is removed while that run continues. A queued or running run of the project itself, also when it names the project's folder through another path such as a symbolic link, still refuses the removal with `409 project_has_active_run`, and a started, unfinished run whose recorded scope cannot be resolved still refuses every project removal with `409 active_run_scope_unresolved`. Finished runs never refuse it.
- 6bce7ce: The macOS app names the new Raw API refusals. A run with no model chosen is headed "Not sent: no model is selected for this harness" (#395). A refused raw patch is headed "Patch refused: …" with what was wrong, and says nothing about whether a request was sent or paid, because the same code can follow a paid answer (#551). The composer marks a route that cannot read files as unable to plan a project, as it already did for a project Ask (#137).
- 6bce7ce: A Raw API request names only a model somebody chose (#395). The built-in fallbacks are gone and no newer name replaces them: the run's model, the saved `harnesses.<id>.default_model` and then that instance's own `CLAUDEXOR_RAWAPI_MODEL` or `CLAUDEXOR_OPENROUTER_MODEL` decide, before admission and sizing, and the same id reaches the request and its receipt. With no choice the run refuses `model_selection_required` before anything is sent, naming the remedy, and no other model or route stands in. An environment model is now judged by the catalog like any explicit model: a known absence refuses, and an unavailable catalog still forwards it with its note.
- 0db02d9: Every daemon stop now closes command admission before it waits for an in-flight retention pass (#603). A runtime-replacement receipt, `claudexor daemon stop` or a signal used to leave the daemon accepting new commands until that pass finished: a command sent over the socket, or an HTTP run start already past its first check, could be accepted and then cancelled. A new key that still reaches the daemon, in process or from an HTTP request already past that check, now refuses with `daemon_stopping`, and an already accepted key that reaches it replays its receipt. Once the listener has closed, a socket client gets a closed connection or `daemon_unavailable` instead, and no command is accepted. Running work is aborted without waiting for the pass, and a failed daemon stop still fails the shutdown and keeps the store open once the pass has settled. While the pass drains the socket is gone but the process and its writer lease are still alive, so a later `claudexord --stop` answers `runtime_activity_unknown` rather than proving the daemon stopped, and a restart still has to wait for the lease.
- 8fb1023: Upload bytes, model-request reads and the full trust-file list no longer run on the daemon's request thread. A scoped trust entry says whether it came from a file or from defaults, so a caller can tell a missing grant from an explicit refusal without listing every repo. The daemon sizes its libuv pool from the host when that variable is unset, and upload writes leave two of those threads free so DNS still runs while parts are being written.
- 40b3ce8: A `no such run` answer now says which engine store answered, so one from another store cannot pass for proof of absence (#163). `GET /v2/runs/:id` adds `context.storeId` to its `http_404` problem, and `claudexor inspect` reports that store in its message and `--json` context. A client can also bind a run to its store at admission: with the request header `X-Claudexor-Store-Identity: 1`, `POST /v2/runs`, Exact Retry, the `rerun_with_feedback` decision, `POST /v2/threads/:id/turns` and its retry name the store that holds the accepted job. The CLI and MCP send that header, so `--json` and NDJSON results, MCP launch and continuation results and `claudexor_thread_turn` handles now carry `storeId`. Without the header receipts keep their shape, so shipped clients that parse them strictly keep working, and an admission whose store has no identity is still accepted and claims nothing. A different or missing store means unknown. The same store means only that it retains no such record, never that the run did not start. After a bound launch receipt has returned, a `--json` or `--json-stream` run whose subsequent detail read fails keeps that receipt's `jobId` and `storeId` (or task group) beside `runId` in the failure envelope. This does not cover an error while still awaiting the admission outcome. A thread-turn refusal no longer passes a producer's `storeId` through as if the server had said it. Other run-scoped 404 routes still name no store.
- 4d96ddb: Stopping the daemon (SIGTERM or `claudexor daemon stop`) while it is still starting its socket and Control API listeners, or still checking that those transports answer as this exact runtime, now ends it as a clean stop with exit code 0 (#278). Before, such a Stop was logged as `daemon lifecycle FAILED` and the process exited with code 1, although its shutdown had completed and released the writer lease. Only that Stop's own cancellation is treated this way: a check that already found another runtime's identity or serving mode, a Control API port that is already taken, and any other startup failure are still reported and still exit with code 1, even when a Stop is under way at the same moment.
- 8905c72: Add exact thread export (`claudexor thread export`, `GET /v2/threads/:id/export`) and conditional retirement against that export (`claudexor thread-retire`, `POST /v2/threads/:id/retire`), with `POST /v2/threads/:id/retire/abandon` to settle an unanswered operation and `GET /v2/threads/:id/retirement` (`claudexor thread retirement`) to read its outcome. A partial export names each gap and cannot retire. Retirement reaches only what a recorded real session proved, currently Claude 2.1.316 transcripts and spilled tool output on Darwin; any other host platform or session material is a named gap, exported byte-exact only where its harness declares its layout. A name the bundle's volume cannot hold is kept by item id, with the complete name in the manifest and the place in the receipt. `thread-retire` re-hashes and syncs every byte its bundle received, and the directories above it, before it sends a new operation, keeps that request in the bundle until an answer settles it, and names it in every unknown answer, so repeating the command repeats that operation. A purged thread admits no new work: a turn's create or retry, Exact Retry and decision rerun answer 409 `thread_purged`, while a command the thread accepted still answers its replay and a run's retained result can still be applied, discarded or reverted. Stop ends an export's journal or transcript read at its next chunk, and a restart's replay of an open retirement cleanup between lane entries. An export observes the thread's closure in the store maintenance worker's read-only snapshot, off the request thread, and an export read cancelled by Stop answers 503 `daemon_stopping` (retryable); the retirement decision still rereads the closure synchronously inside its transaction, at a cost that grows with the closure.
- 0d2d858: Run receipts now say what Web Off and an access profile actually did on each route, without changing either (#118, #413). Just before dispatching an adapter, the per-spawn gate records a `route_controls` receipt of what was prepared: the route's own web switch (`native`, `tools`, `uncontrolled` or `none`), the access profile, the vendor access arguments the adapter passes (for example Cursor `--force --sandbox enabled --trust --mode ask`, Codex `sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review`) and the access mechanism, where only `fs_sandbox`, the vendor's own sandbox, declares an OS file boundary and `native_settings` (`inherit_native`) leaves it unknown. `native_session_started` reports whether the attempt's native session was reported started, so a pre-spawn refusal or a stop stays distinct from a launch; `false` never proves that no process ran. The gate checks Stop again after recording the receipt, so a stop that lands at the receipt keeps it and never dispatches the adapter. Agent attempts also carry their applied HOME fact, where `false` means the engine did not replace HOME; Ask and Plan record none, so none is claimed. The web evidence states its scope (`observation`: typed web tool calls and engine Browser calls; network traffic not measured), so `attempted: false` no longer reads as "no network". The run summary projects the distinct routes as `routeControls` together with `webEvidence.verification` and `webEvidence.observation`, and `claudexor inspect` prints `access route`, `web route`, `web retrieval` and `web scope` lines. Retrieval strength now says what came back. A verified result carries `verified_content`: Claude's WebFetch and a Browser navigation or snapshot of a loaded http(s) page are a `page`, while Claude's WebSearch is `search_results`, which is not a fetched page; its strength and the required-web gate are unchanged. A Browser page read that got an HTTP error status is `dispatched`, and a Browser call that read no web page (closing, clicking, listing tabs, an `about:blank` or `data:` page) carries no retrieval stamp: it still counts as completed web activity for the unchanged required-web gate, but the strength stays `none`. The Browser rule is checked against recorded replies of the pinned Browser MCP, and a denied or cancelled Claude web call is no longer stamped as a verified retrieval. The macOS run facts show "Web verified" for a verified page, "Web searched" for verified search results, "Web reached" for a web call without a typed result and "Web tools used" when completed web tools retrieved nothing or the engine sent no strength; for Web Off they show "Web tools off" only when a route reported a native session under the off switch, otherwise "Web Off requested"; and they describe access by its native setting and declared boundary instead of "enforced".
- Updated dependencies [b63ceac]
- Updated dependencies [b1320a9]
- Updated dependencies [b1320a9]
- Updated dependencies [43b0491]
- Updated dependencies [0d2d858]
- Updated dependencies [7a6c782]
- Updated dependencies [b9f57d9]
- Updated dependencies [d9e8247]
- Updated dependencies [b9f57d9]
- Updated dependencies [b9f57d9]
- Updated dependencies [b63ceac]
- Updated dependencies [8de1106]
- Updated dependencies [b1320a9]
- Updated dependencies [2be1a9c]
- Updated dependencies [35a2462]
- Updated dependencies [1601fae]
- Updated dependencies [780ec76]
- Updated dependencies [46229c5]
- Updated dependencies [6bce7ce]
- Updated dependencies [6bce7ce]
- Updated dependencies [6bce7ce]
- Updated dependencies [8fb1023]
- Updated dependencies [40b3ce8]
- Updated dependencies [1c2bd56]
- Updated dependencies [780ec76]
- Updated dependencies [8905c72]
- Updated dependencies [2e8b440]
- Updated dependencies [2e8b440]
- Updated dependencies [0d2d858]
- Updated dependencies [d4a8b3c]
  - @claudexor/schema@5.1.0
  - @claudexor/orchestrator@5.1.0
  - @claudexor/control-api@5.1.0
  - @claudexor/harness-agy@5.1.0
  - @claudexor/review@5.1.0
  - @claudexor/util@5.1.0
  - @claudexor/harness-claude@5.1.0
  - @claudexor/harness-codex@5.1.0
  - @claudexor/daemon@5.1.0
  - @claudexor/workspace@5.1.0
  - @claudexor/harness-cursor@5.1.0
  - @claudexor/acp-server@5.1.0
  - @claudexor/harness-raw-api@5.1.0
  - @claudexor/core@5.1.0
  - @claudexor/config@5.1.0
  - @claudexor/mcp-server@5.1.0
  - @claudexor/delivery@5.1.0
  - @claudexor/harness-fake@5.1.0
  - @claudexor/harness-grok@5.1.0
  - @claudexor/gateway@5.1.0
  - @claudexor/harness-acp@5.1.0
  - @claudexor/harness-opencode@5.1.0
  - @claudexor/artifact-store@5.1.0
  - @claudexor/secrets@5.1.0

## 5.0.2

### Patch Changes

- a0f3a0e: `GET /v2/agent-capabilities` (and the MCP `claudexor_capabilities` tool, which reads it) now uses the daemon's existing status-projection cache, the same one default `GET /v2/harnesses` reads use. Concurrent and in-window reads share one harness sweep, so normally one sweep runs at a time, about one per 15 seconds (a config change or invalidation during a sweep starts a fresh one beside it, and only the fresh one's result is cached; a reader that had already joined the older sweep still receives that one's result); the first read after the window still waits for a full sweep. A computed catalog is served for 15 seconds (its `generatedAt` says when it was built), on top of the doctor's own reuse of a report (by default 90 seconds when OK, 15 seconds otherwise), so an out-of-band change such as a vendor CLI login outside the daemon can take about 30 seconds (non-OK to OK) or 105 seconds (OK to broken) to show, plus sweep time. A change to the global config recomputes it at once, and the daemon's credential mutations and setup logins invalidate it. Callers that read the catalog for one static fact, such as a harness row's `liveInput`, no longer pile up concurrent discovery, doctor and model-inventory sweeps or leave several running after they give up. `claudexor capabilities` still composes the catalog in-process.
- d9f50f5: An isolated copy of an ordinary folder (directory mode without `--in-place`) is no longer deleted when the run's final capture refuses, for example on an unreadable file or a FIFO in the copy (#563). The copy with the files the executor wrote is kept for inspection under the same per-attempt custody as a refused isolated Git source: the failure names its path, the next actions say to inspect it and decide yourself, and no exact result, apply or revert is offered. Crash recovery, file GC and command pruning keep it until the run's `discard` decision releases it. If retention setup fails, the failure says which part: the custody record was written but the run's address to it was not (setup incomplete until crash recovery restores the address), or the custody record itself was not written (held by the running process only). A per-try capture that a later capture replaces keeps nothing, and in-place runs are unchanged. In a best-of run, a candidate whose copy could not be retained durably is excluded rather than failing the run: a healthy sibling still wins and can be applied, and the run summary and timeline name the excluded candidate's exact capture cause, kept copy and failed retention stage; the CLI follow line previews that receipt. A one-shot continuation after context exhaustion runs in the same copy: if its final capture refuses, the copy is kept and the run stays interrupted, and the failure message, summary, next actions and the continuation's completion event name its attempt, capture cause and kept copy. When a best-of run holds both such a kept copy and a winner's pending files, `discard` now gives up both instead of leaving the winner applicable. Before the executor starts, a new `workspace.prepared` run event, shown on the run timeline (and in the macOS turn transcript of local and remote SSH runs, live and restored) and in the CLI follow output, and a matching line in the executor's prompt state which folder the copy was prepared from, which paths were selected, how many files, directories and symbolic links were copied, and which selected paths were not found there, naming every path. It is a warning when nothing was copied or a selected path was not found; a selected path that does not exist yet is reported as possible new output, not refused.
- 135f6de: Large stored bodies (over 64 KiB) whose bytes are known before their database commit are now written to disk off the daemon's request thread: an enqueued command's parameters and its acceptance record, a finished run's returned result and its update record, a thread turn's prompt, a deferred draft after its capture, and the command a draft is promoted into, with its acceptance record, after the draft's validation. The same write-through temp file is written on Node's file worker pool and linked into place only if that body is not already stored; the synchronous commit then finds it and only registers its directory for the usual durability barrier. The store creates its body directory, registered like any other new directory, before the first such write, so a new store, or one whose bodies all stayed small, stages too. Nothing about durability, ordering or the stored bytes changes, and if the staged file was cleaned up or staging failed, the commit writes the body itself as before. A body staged for a request that is then refused or held stays on disk, unowned, until the orphan sweep at the next daemon start removes it. HTTP requests, Stop and stream heartbeats no longer wait behind those writes when the disk is slow.
- 51e5250: A run's terminal receipts (`final/run_facts.yaml`, `final/telemetry.yaml`), any rewrite of its event log that the terminal needs, and its large terminal bodies are now written to disk off the daemon's request thread before the terminal commits. The terminal is prepared first, with its outcome and receipt frozen, then its bytes are written as write-through temp files on Node's file worker pool (in the store's body directory, which a new store creates before its first terminal), and the synchronous terminal commit renames them into place right after the database commit instead of writing them there. The stage reads only the end of the run's event log to see that the usual terminal just appends (only a log that ends otherwise is read whole and its rewrite staged), so staging does not repeat the commit's full pass over the log on the request thread; the commit still loads the job record once more itself, which measures 0.009 ms for a 100-byte prompt and 1.1 ms for a 1 MiB one. Durability, the order in which a terminal becomes visible, and the receipt contents are unchanged; anything that could not be staged, or changed meanwhile, is written by the commit as before. A control audit or live-message receipt that arrives during that write is recorded before the terminal, which takes the next sequence number and keeps its prepared outcome and time; a cancel arriving then does not change the outcome. If the daemon stops before the commit, there is no terminal and no receipt, and the leftover temp files and unowned bodies are removed by the existing orphan sweep after the next start. `EventLog.flushDeferredTerminal()` is removed: `await log.commitDeferredTerminal()` commits a held terminal, staging its bytes first when a staging hook is set and committing before its first yield otherwise.
- Updated dependencies [a0f3a0e]
- Updated dependencies [d9f50f5]
- Updated dependencies [6ba9b91]
- Updated dependencies [135f6de]
- Updated dependencies [153b02d]
- Updated dependencies [51e5250]
  - @claudexor/mcp-server@5.0.2
  - @claudexor/schema@5.0.2
  - @claudexor/workspace@5.0.2
  - @claudexor/orchestrator@5.0.2
  - @claudexor/control-api@5.0.2
  - @claudexor/daemon@5.0.2
  - @claudexor/util@5.0.2
  - @claudexor/acp-server@5.0.2
  - @claudexor/config@5.0.2
  - @claudexor/core@5.0.2
  - @claudexor/delivery@5.0.2
  - @claudexor/gateway@5.0.2
  - @claudexor/harness-acp@5.0.2
  - @claudexor/harness-agy@5.0.2
  - @claudexor/harness-claude@5.0.2
  - @claudexor/harness-codex@5.0.2
  - @claudexor/harness-cursor@5.0.2
  - @claudexor/harness-fake@5.0.2
  - @claudexor/harness-grok@5.0.2
  - @claudexor/harness-opencode@5.0.2
  - @claudexor/harness-raw-api@5.0.2
  - @claudexor/review@5.0.2
  - @claudexor/artifact-store@5.0.2
  - @claudexor/secrets@5.0.2

## 5.0.1

### Patch Changes

- @claudexor/acp-server@5.0.1
- @claudexor/artifact-store@5.0.1
- @claudexor/config@5.0.1
- @claudexor/control-api@5.0.1
- @claudexor/core@5.0.1
- @claudexor/daemon@5.0.1
- @claudexor/delivery@5.0.1
- @claudexor/gateway@5.0.1
- @claudexor/harness-acp@5.0.1
- @claudexor/harness-agy@5.0.1
- @claudexor/harness-claude@5.0.1
- @claudexor/harness-codex@5.0.1
- @claudexor/harness-cursor@5.0.1
- @claudexor/harness-fake@5.0.1
- @claudexor/harness-grok@5.0.1
- @claudexor/harness-opencode@5.0.1
- @claudexor/harness-raw-api@5.0.1
- @claudexor/mcp-server@5.0.1
- @claudexor/orchestrator@5.0.1
- @claudexor/review@5.0.1
- @claudexor/schema@5.0.1
- @claudexor/secrets@5.0.1
- @claudexor/util@5.0.1
- @claudexor/workspace@5.0.1

## 5.0.0

### Major Changes

- 8bae6ae: Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062). A review brief, prompt, instruction, output schema, test command, live or deferred message, interaction answer or attachment that contains a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block now reaches the selected harness exactly; the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP. The task contract, command journal, served job params, thread history, events, SSE frames, answers, plans, reports, retained output, saved `patch.diff` copies, reviewer packets, reviewer workspaces, context packs and served artifacts keep the exact bytes, so Exact Retry, Run Again, continuation and later turns read back what was sent, and reviewers judge the same patch apply uses. Files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files for context, review, directory results, uploads and served outputs; Codex approval requests for them are offered instead of declined, and `review --diff` no longer refuses a diff. Claude `AskUserQuestion` text is shown exactly and answered by its native question text. Tool calls keep unmasked targets (command, path, query, URL) within each adapter's existing bounds, and tool results keep unmasked summaries of their output (`content_summary`, and a failed tool's own `error_summary`, within each adapter's existing bound and whitespace normalization) for every adapter, a Cursor shell command whose end is unconfirmed keeps its complete native result (`native_result`) exactly, a failed raw-API completion keeps the model's bounded partial output (`partial_output`) exact in its error event while it stays a failure, never becomes the answer and the provider's error report stays masked, a Copilot ACP answer keeps credential-shaped text exact (only the managed token Claudexor injected is removed), a work report's required inputs stay exact in telemetry and run facts, a planner's own `plans/<harness>.md` copy is its exact text, and the gate argv disclosed to a candidate is the argv the gate runner executes. Images are no longer withheld from `produced/` or from served outputs for their bytes; an image Claudexor did not save (over the per-image or total size cap, unreadable, a link, not a regular file or an unsafe path) is listed in the attempt's `produced_omitted` with its size and reason, and the run summary names it. Credentials Claudexor itself owns stay in their stores, outside every worktree, behind daemon authentication, grants, read-only and trust policy, root and symlink containment and digest checks; engine diagnostics (errors, stderr tails, probe output, vendor failure reports, also inside the run, attempt and reviewer event journals, which all pass through one masking step) are still masked. Claudexor never places its engine credentials into prompts, events or artifacts; a harness process can read the credential the engine hands it, and whatever the harness prints is ordinary output kept exactly in local run records, as in the vendor's own transcript. Importing an arbitrary host file still refuses credential-store paths, and review risk still rates credential-named paths critical. The historical release-attestation sealer no longer refuses a reviewer report or metadata file for credential-shaped text: it still requires strict UTF-8, the digest and exact-key bindings and its other checks, and the attestation carries digests and validated fields, never report text. A real key you put in working content is ordinary task material: it reaches the selected model and stays in local run records. Runs written by earlier versions keep their masked copies; their `persisted_patch: redacted` patches still apply only from the private exact object (`patch_exact_bytes_unavailable` when it is missing), and the MCP read tools still project their `secretLike` disclosure, which is `null` for new runs.

  **Breaking:** `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns; an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until one is provided (below). Before any branch, index or ref changes, the exact outgoing commit, every earlier commit that a URL `git push origin` sends to (its push URL when one is set) does not already advertise, read with `git ls-remote` (a secret added and later deleted included, and a commit only the fetch URL or another remote holds still counts), what each merge in that range itself changed (Git's remerge view, Git 2.36 or newer: a conflict resolution or an "evil" merge, never content its parents already carried; an octopus merge has no such view and is scanned for what it adds over its first parent, which can re-flag content a non-first parent already published), the commit messages of that range, the branch name and the PR title and body are scanned with live validation off; the PR body `gh` reads is the scanned copy, and the push sends exactly the scanned commit object. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text; a file name or label the scanner itself flags is shown as `withheld location (sha256 …)`, and every place is withheld when that check cannot run); a missing or unpinned scanner (`publication_scan_unavailable`) and a scan that fails, times out, writes no valid report or reads a Git history that Git's own trace2 record does not prove complete (every `git log` it ran exited 0 without a signal; a `git log` killed mid-stream otherwise looks clean) (`publication_scan_failed`) also refuse, and local apply, branch and commit stay available. The outgoing repository's own `.gitleaksignore`/`.betterleaksignore`, inline allow comments and scanner environment variables cannot suppress a finding. The macOS app and its update closure now bundle the darwin-arm64 and darwin-x64 builds and each SSH runtime archive bundles its own target's build, with the MIT license and provenance (the SBOMs list them). npm installs, and hosts on other platforms embedding the closure, bundle none for their platform: point `CLAUDEXOR_BETTERLEAKS_PATH` at the pinned build or provision it with `node scripts/provision-betterleaks.mjs`. Delivery never downloads it. Betterleaks skips some binary, archive and lockfile content by design, so a clean scan is not proof that nothing sensitive is present. Repository CI and release use the same adapter in place of the old `git grep` step, over the range's commits, merges and messages and the tracked tree; a release being published also scans its annotated tag's message.

- fe7e2ae: **Breaking:** `claudexor review --delta-scope` is retired (#257). The flag belongs to the stable CLI surface that `claudexor help --json` declares, where it now stays listed only to be refused. It let the Cursor reviewer lane of a sealed release packet review only a sealed delta, a release ceremony the current review protocol no longer uses. A sealed packet review now covers the complete packet on every lane, Cursor included, and a packet that still carries delta evidence remains valid context. An invocation that still passes the flag, with or without a value, stops before any review work with exit code 2 and names both replacements: drop the flag to review the complete packet, or review a chosen delta as an ordinary diff with `git diff <base>..<candidate> > delta.patch` and `claudexor review --diff delta.patch`. Reviewer metadata no longer carries the `review_scope`, `delta_base_sha` and `delta_sha256` fields that only distinguished that lane. Archived signed review attestations are verified as before.

### Minor Changes

- d9e7977: `claudexor project remove <project-id> --purge-trashed-threads` (`DELETE /v2/projects/:id?trashedThreads=purge`) removes a project together with the threads already in its trash, in one action (#333). Without the option, removal is unchanged and still refuses while any non-purged thread remains. The option purges only threads that are in the trash: an active or closed thread must be trashed first. The whole removal is refused, with nothing changed, while any thread is outside the trash (`project_has_threads`) or while any of the project's work is queued or running, including a thread Apply or a run started under a former root (`project_has_active_run`). The purges and the project's retirement are one store transaction. Each purged thread then loses what a thread purge deletes: its isolated worktree and `claudexor/thread-*` branch with any changes never applied, and its lane homes. The project folder, a delegated thread's caller-owned workspace and run artifacts are never deleted; the conversation rows stay in the engine store, while the threads leave every listing and can no longer be restored or resumed. The receipt's new `purgedThreads` lists each purged thread with `cleanup: "completed"`, or `"pending"` with the error; a pending cleanup is retried when the daemon next starts. A repeated or inexact `trashedThreads` value is refused with 400 before anything changes. Other query parameters stay ignored as before, so a misspelled parameter name gets the default removal, which still refuses while any non-purged thread remains.

  Every thread purge (Delete Now, expired trash, the retention retry, daemon startup and this removal) now reports a cleanup as completed only once the thread's worktree with its Git registration and branch and its lane homes are gone. When Git refuses, for example for a worktree locked with `git worktree lock` or a ref lock held by another Git process, the cleanup stays pending with Git's error, nothing Git still records is deleted, and a later attempt finishes it once the cause is gone. Git is asked in the repository that registered the worktree, which the worktree's own `.git` file names; a branch, registration or directory already gone there counts as removed. Without that file, the project folder's repository is asked. Because Git deletes the file with the worktree and a project folder can be replaced, the cleanup records the repository it asks before Git's first change there, so a later attempt or the next daemon start finishes in that same repository, and syncs its Git directories to disk, also when the project folder is gone or another repository is at the project path by then. Git drops a worktree's registration even when it fails to delete the worktree directory, for example a read-only one; the cleanup stays pending with Git's error, and once the directory can be deleted, a later attempt finishes it in that recorded repository. A repository moved without relinking the project, or deleted (the two look the same), keeps the cleanup pending too; after a move, `git worktree repair` in the moved repository lets the next daemon start finish it, and a recorded repository that moves away or is replaced at its path afterwards keeps it pending until it is back. Thread purge, the account lane cleanup and the orphan-lane sweep no longer follow a link inside Claudexor's runtime directory: a link above what they delete is refused with an error and its target is left untouched, and a link in place of what they delete is only unlinked. Before, such a link made the deletion follow it into the linked folder, and a Git refusal was reported as completed and never retried.

### Patch Changes

- f428c0a: An explicitly selected raw API route such as OpenRouter can answer Ask without a project (#133). Answering no longer requires the `read_files` capability, so a route whose doctor enables `explain` keeps it. A project-scoped Ask on a route that cannot read files is refused before dispatch with "cannot read project files: ask without a project or choose a harness that reads files", because that Ask sends a list of paths and expects the harness to open the files itself; deep scan still requires file reading. Harness status now documents its two intent lists: `enabledIntents` is what an explicit selection may run (a degraded harness keeps the intents its doctor still enables, with its reasons) and `routableIntents` is what the Auto pool may choose. `claudexor doctor` labels the second line `auto-routable`. When the Auto pool passes over a degraded preferred primary, `route.primary.diverged` now reports reason `readiness_preferred` with the doctor's degraded detail instead of `auth_unavailable` and "unavailable". The macOS composer now shows such a route under "Manual only — Auto won't pick these" with the doctor's reason, and disables it for a project-scoped Ask with the same reason the engine gives.
- 66d5b6a: A run whose changes cannot be captured no longer ends as `failed / workspace_unavailable` with advice to retry the run. When capture fails, for example for lack of disk space, on a Git process that stalls or is killed, on a file that cannot be read, on a missing object, or on an I/O or scratch fault, the run ends `failed` with the new reason `capture_refused` ("Failed (changes not captured)") and its capture failure keeps the typed cause. The refusal names what was not recorded (the exact result, a revert point for live changes, apply eligibility, and the configured checks and requested review, which did not run) and what is kept (the final answer, which stays the diagnostic primary output, run-produced media, and the changed files in place or in the retained isolated source); its next actions no longer suggest retrying the run. Completed work whose only defect is the capture is no longer published as resumable; a harness error, a cancellation or an unfinished work state still is. Screenshots and other produced media are now kept on a refusal: the run copies them and in-place cleanup leaves the run's artifact directory. When the capture had written its candidate tree, a separate bounded pass records a non-exact `inventory` of the largest changed files (path, change kind, size) on the capture failure; `claudexor inspect` and the run summary print it.
- 0b14e01: `claudexor inspect` now says `no such run` only when a running daemon's run registry answers 404 for the id (`code: "run_not_found"`). Before, a cross-project lookup that could not complete printed the same message, so a run started in another project could look absent while it still existed. Each other outcome returns the standard failure envelope, with its own code whenever the answer is recognized: `invalid_argument` (exit 2) for a malformed id; `daemon_unavailable` when no daemon is reachable, so runs from other projects were not checked, or when the connection drops before the whole answer arrives; the daemon's own problem code, such as `daemon_recovery_only`, a refused handshake or another 404; `invalid_service_response` for an unreadable success body or a recorded run directory outside a run store; `run_not_materialized` with the state for a run the daemon knows that has no run directory yet; and `run_artifacts_unavailable` with the state and recorded path when that directory is missing or unreadable. An error answer that is not a control problem, such as a non-daemon 404 page, has no code and names only its HTTP status. The lookup validates only the run-detail fields it uses, so additive same-major fields elsewhere in the answer are tolerated and a known problem keeps its recovery details when it carries extra fields; a run state value this CLI build does not know is still reported as `invalid_service_response`. The CLI reads exactly the directory the daemon recorded, so a job id the daemon knows now resolves to its run. A local retained run is still shown without the daemon, and the lookup still never starts one. A found run with no summary or output no longer prints that the run may not exist.
- 9a5ef43: `GET /v2/global/events` and `GET /v2/projects/:id/events` now replay and tail the retained journal in bounded pages (at most 256 events and 1 MiB of stored payload each) instead of reading, validating and writing the whole retained history before the first event. Replay stays complete and ordered with the same cursors and the same 409 `resnapshot` refusals; an event larger than a page is sent whole on its own. The daemon waits for a slow reader to drain before writing more, keeps one page read in flight per connection, and stops reading when the client leaves or the daemon stops. A stream whose partition generation is replaced now closes instead of continuing in the new epoch, including a stream that had not received an event yet. Motivation: issue #312, where back-to-back full snapshots of a dense root raised daemon RSS to 4.1 GB.
- 66d5b6a: Large results are now kept exactly, without a size ceiling (#535). Before, a result whose exact patch exceeded 256 MiB failed its capture. Every Git capture's canonical result is now Git objects identified by a typed digest (`git_objects/v1`), kept in a private per-project object store that is never an alternate of your repository; objects are imported into your repository only before an operation needs them. Results of every size are verified in a fresh private clone, applied onto the current state of your project (your unrelated changes are kept; paths changed on both sides follow `git apply` rules, except that an identical change on both sides is accepted outside rename and copy endpoints), committed or branched, and reverted on the actual delivery pair, keeping later edits outside it (a file the delivery added that your ignore rules now hide, or that sits inside a nested Git repository, is removed too, or the revert refuses if you changed it or cannot read it); a rendered result's `pr` passes the same publication scan as any `pr`, on the exact commit it pushes. Operator decisions and the apply gate bind the result's digest instead of the patch text. The patch becomes a view: when an estimate computed from the changed files' blob sizes exceeds the 256 MiB view limit, or the render itself overflows it, `final/patch.diff` is absent with a typed reason and a bounded inventory (never an empty file), `claudexor inspect`, the run summary, MCP results and the macOS Changes tab say so, and `pr` of such a result refuses typed (`pr_unrendered_result`) before any scan; scanning such a result for `pr` is a follow-up. Because that estimate is computed before rendering, a small edit of a very large file (one changed line in a 110 MiB file) also gets no patch view and `pr` refuses it; the result itself stays exact, deliverable and revertable. A delivery refused for a typed reason (`result_objects_missing`, `pr_unrendered_result`, a publication scan refusal, a conflict, a changed target, a store fault) answers that reason as the HTTP 409 problem code on `POST /v2/runs/:id/apply` and `accept_clean_patch` (a refusal with no typed reason answers `delivery_refused` on both), a replay with the same `Idempotency-Key` answers the same, and `apply/check` returns it as `refusal`, a store, Git or filesystem fault included; a run whose result record is there but cannot be read answers 503 `artifact_read_failed` on apply, apply/check and the decisions instead of "no patch artifact". For a Git result, a `commit`, `branch` or `pr` delivery that fails after writing now answers that HTTP 409 problem, where the last release answered such a failure with HTTP 200 `applied:false` (a legacy patch's delivery still does). A delivery that fails after writing is taken back on its retained pair, keeping later edits outside it (restored as Git holds it: a file whose checkout conversion does not round-trip, an LF file under `core.autocrlf` for one, can come back with converted bytes, which the receipt says); only a write that cannot be taken back stays, reported as `treeMutated` with the action that recovers it and recorded `applied_review_blocked` with a revert anchor instead of `not_applied`. A `pr` whose push fails returns the working tree to where HEAD was and keeps the commit on the local branch; when that checkout fails, the receipt says where HEAD stayed and how to return. A delivery never writes over what Git does not track: a file or directory at a path the result adds that your ignore rules hide refuses `delivery_path_occupied`, naming it, with nothing written, and `apply/check` answers the same (a new file in a directory that already exists still delivers, and so does a rename that only changes case; a hard link of a removed file is never taken for one). In a sparse checkout (cone or non-cone), a result that adds, changes or removes a path outside the sparse-checkout patterns refuses `delivery_outside_sparse_checkout`, naming those paths, with nothing written, and `apply/check` answers the same; the last release's `git apply` wrote such an added file, after which every later snapshot of that checkout failed. A revert that must change such a path, because you narrowed the patterns after the apply, refuses the same way. Widen the sparse checkout (`git sparse-checkout add`) to deliver or revert there. Every path a delivery, take-back or revert does not address keeps its bytes, including a clean file outside the patterns that has no skip-worktree mark (Git's own checkout would delete it), and its index mark, except that in a sparse checkout Git itself clears the skip-worktree mark of a file that is present, which sticks once a `branch`, `commit` or `pr` delivery writes the index; such a write also drops the assume-unchanged mark of a path it changes. This check uses `git sparse-checkout check-rules` (Git 2.41 or newer); with an older Git, a sparse checkout's deliveries, `apply/check` and reverts refuse `git_failed` before writing, naming the Git they need. A file you marked skip-worktree and then deleted counts as deleted, not as unchanged (except a file the sparse patterns leave out), so a revert brings back what a delivery deleted, refuses rather than undo your later deletion, and a delivery does not silently recreate it. A `branch`, `commit` or `pr` delivery commits the result onto HEAD and leaves what your assume-unchanged or skip-worktree marks hide (a local edit, a deleted file) on disk and out of the commit, their marks with them (but for the sparse-checkout case above); a result that changes such a file refuses `delivery_conflict`. A checkout that cannot fit refuses `space_insufficient` before its first write, and a store fault on the way there (the import, the snapshot, the composition) answers the same typed 409 instead of HTTP 400 or 500. A path the result changes whose name is not valid UTF-8 refuses `result_path_encoding` with nothing written, and so does its revert; a name only your project changed is never addressed, so it does not stop an unrelated result. Written paths are proven the way `git status` compares them, and every private proof, snapshot and checkout reads the bytes whatever your configuration or index marks say (`core.ignoreStat`, a filesystem monitor, an assume-unchanged mark); apply, its check and revert also read the paths they decide on by content rather than from the index's stat cache, so a file that kept its size and mtime is neither already applied nor called reverted (`branch`, `commit` and `pr` keep that cache for what they write, as `git checkout` does). A committed CRLF blob under `text=auto` or `core.autocrlf` applies and reverts, and a directory that becomes a file or symlink composes and a file that became a directory reverts on an unchanged target. When a patch render fails for a reason other than its size, the capture keeps the result with `patch_view.reason: render_failed`. Review and synthesis of a result with no patch view read a copy of its saved candidate tree, converted only as that tree's own attributes define with Git's defaults, in a private Git directory, never the workspace, so a configured check that rewrites an output, an attribute rule (tracked or in `.git/info/attributes`) or the repository's filter configuration cannot make review read different bytes than apply consumes (a filter driver is configuration the result does not carry, so a filtered file is read as its stored blob, as in the patch view: a Git LFS pointer or an encrypted blob is reviewed as stored, which says nothing about the content it stands for, and no smudged copy is kept); a changed file that copy cannot hold, a disk too full for it included, is named with its typed cause (`space_insufficient` for a full disk) to reviewers and synthesis, and the review cannot pass clean. A copy that fails holds none of the files: reviewers and synthesis get those causes and nothing to read, never what the failed copy left in its directory or a directory that is gone, and a copy that cannot be removed afterwards stays instead of ending the run, with a best-effort `<copy>.cleanup-error.json` saying why (on a disk too full to write that record whole, the leftover stays with its cleanup unconfirmed). After an earlier apply and revert, a later delivery that strands HEAD on its branch clears the old revert anchor, so `revert_run` refuses instead of answering a false success. A `revert_run` refused for anything but a later edit of what the run changed (the sparse patterns, a file it cannot read, a full disk, a Git fault) now answers `reverse_apply_failed` with its typed cause as `context.refusalCode`, instead of saying the revert is no longer available. Runs recorded by earlier releases keep their patch for apply and revert.
- f428c0a: Account resources can now show an OpenRouter key's own spending limit, for the key requests actually use, including the default one (#138). The engine reads OpenRouter's `GET /api/v1/key` (no generation, no account balance) for the default key and each enabled registered OpenRouter API-key account, on an explicit full or exact refresh only. Clients that send `includeApiKeys=true` with a resources view of `GET`/`POST /v2/quota` or the Accounts snapshot receive one row per key: the default key as `target.profile_id: null` (the API-key route, not an account) and each registered key, all bound to a non-secret `credential_fingerprint`. A replaced key never shows the previous key's figures and a removed key has no row. The spending row keeps the provider's decimal `limit` and `remaining`, `capped: false` for a key without a per-key limit (never zero or unlimited money), spend for its UTC `window`, and a reset instant only when OpenRouter reports one. Failed reads keep the last figures as stale with the cause. These rows never affect routing, quota admission or polling; clients that do not ask keep the previous response. `claudexor quota --resources` and the MCP `claudexor_account_resources` tool include them, and the macOS OpenRouter Auth sheet shows them in a Key allowance panel with a Refresh that reads only those keys.
- d807104: An account that hit its limit and moved its work to another account now chooses that next account from the quota it can see at that moment. Before, the continuation reused the quota list read when the attempt started, so an account whose five-hour window had reset in the meantime, or whose newer reading showed an early reset, was still skipped as over its limit, and the run could end with "no eligible replacement" (#457). The list is read once per decision, after the readiness checks, and the same reading explains the choice, the `route.profile.rotation_exhausted` event and the final error. A weekly or other limit that is still spent keeps blocking even when its reading has gone stale; pinned runs still never move, and an account already tried in the attempt is not tried again. When a reset makes the whole reading stale, a weekly reserve set below 100% is still not enforced until the next quota poll; that rule is unchanged.

  Antigravity quota refresh now follows the daemon's refresh plan (#240, wiring only). A refresh of one account no longer starts the vendor's `/quota` and `/model` commands for every Antigravity account, a background poll skips accounts whose reading is still current, an account under a poll pause is reported as `poll_paced` without a vendor call, and each read or skip is written to the daemon log as a `quota.observation` record. Antigravity rate-limit responses are still not recognized as such: they remain ordinary refresh failures.

- 2d83b87: Claude quota families now reach newly released models of that family (#394). A weekly Opus limit, whether read from the usage endpoint, reported during a run or carried by a typed Opus rejection, applies to every `claude-opus-…` id, including ones newer than the built-in model list, and no longer applies to `best`, a run that names no model, or another family. A weekly limit the vendor does not name, and an Antigravity quota group the adapter does not recognize, no longer block the whole account: each such window's id, usage and reset are written to the daemon's `quota.observation` log instead, even when the reading held no other window, while known family and account-wide limits keep blocking. A reading that held only such windows counts as a failed refresh, never as an account with no limits. Quota records written by earlier versions are read back in the new form, so an old Opus limit stops refusing `best` and is replaced by the next reading of the same window; an old reading that held only such unknown windows is read back as unknown, so it is not shown as current and the account is still polled. Other accounts, routes and windows are untouched.

  A short quota window that has reset no longer counts against an account, and no longer hides a weekly limit read at the same time (#457). Run admission judges each window separately at the moment it decides: within the five minutes a reading stays current, a weekly reserve still applies after the five-hour window resets. A reading never becomes fresher than when it was taken, and a reset window is not treated as new free quota. The next-account hint (both the ordinary Accounts read and an explicit refresh) and model operations make the same per-window decision as runs, so the hint never names an account a run would refuse. The quota display and the Accounts cards keep their existing whole-reading freshness.

  A pinned account refused by quota now says why (#318). The refusal keeps the `subscription_window_exhausted` code and adds `quotaRefusal.basis` to the run's failure record, `refusal_basis` to the problem context and `basis` to the `route.profile.headroom_exceeded` event: `owner_reserve` when usage reached your saved `headroom_threshold` while the provider still reports quota left, `provider_window` when the provider reports the window spent, and `provider_cooldown` for a provider rate-limit cooldown or a limit hit by the pinned run itself, in Agent, Ask, `--attempts` and Plan runs. A pinned Plan stopped by a provider limit now ends with the same typed code, reset time and basis instead of a generic harness error; a limit the vendor recovered from, or a Plan that ended for another reason (context exhaustion, an empty plan, an invalid work report, an outdated Claude Code CLI, a Claude API error other than HTTP 429 such as a rejected login, a crash or cancellation), keeps its own cause. A provider limit is never labelled as your reserve, whatever the threshold, including a spent window whose reset time is unknown. The window, usage and reset time reported with a refusal all come from the limit that decided it, and a run whose candidates hit different windows reports only what they share. The saved reserve still applies to a pinned account and a pin still never moves to another account; the default threshold stays 100%. When every account stopped only at its saved reserve, the next-account hint says so. Authentication and billing failures are not quota refusals and are not covered by this change.

- f428c0a: Raw API and OpenRouter requests judge an explicitly chosen model by what the catalog actually answered and send the material the project requires within that model's limits.

  - A model catalog that could not be read is no longer reported as proof that an explicit model does not exist. The read is typed (no credential, a rejected key on 401/403, another HTTP status, network, timeout, a malformed or partial answer, including a `total_count` that does not match the rows) and uses the same key as the run. When the catalog is only unavailable or unusable, the explicitly chosen model is sent unchanged on that same key and every place that admits it says once that it could not be verified: the settings read-back notes, the doctor's readiness detail, the run's status event and the reviewer panel's preflight event. A missing or rejected key still refuses with code `model_catalog_unavailable` (category `auth`): nothing is sent, the run records that typed failure rather than a crashed harness, and the settings write answers HTTP 409 with `cause` and `httpStatus`. A catalog that answered without the model still refuses it. A failed read in the middle of a run does not discard what that run already read with the same credentials, meaning the same account and the same key (a key replaced during the run counts as another credential): the earlier read still decides the model and sizes the request to its known window, and the run says so. `claudexor models`, `claudexor capabilities` and `GET /v2/harnesses/:id/models` report the failure instead of an empty list or a count of zero.
  - OpenRouter's routing variants `:nitro`, `:floor` and `:exacto` of a listed model are accepted in any order OpenRouter documents (`m:free:nitro` and `m:nitro:free` need `m:free` listed) and sent unchanged, with a note that `:nitro` and `:floor` may bill a service-tier rate. Undeclared suffixes still need the exact id listed, and `:online`, which would make OpenRouter search the web, is refused whether or not the catalog can be read. The models listing now carries the declared variants, so the app can find the listed row of a variant id.
  - Model rows now carry the catalog's input modalities and completion limit. An image attached for a model whose catalog lists no image input is still sent, with one note that the provider decides.
  - Raw API patch requests include the project's `context.mandatory_files` complete and honour `include`/`exclude`. Each request is sized from the catalog read that admits its model, made with the key that request uses, and the image note reuses that read; a key replaced while the request is being prepared is used from the next request on. A raw API reviewer, named in the reviewer panel or chosen by the automatic one, likewise sends the key its panel's catalog read checked. An Agent run with `attempts` or `untilClean` now sends a raw API route the same packet, mandatory files and patch protocol as a single attempt, instead of a bare prompt that could never return a patch. The whole request is sized to the selected model's known context window minus instructions, prompt, protocol, attachments and an answer allowance (approximate characters/4 estimates), optional files are omitted deterministically and disclosed, and mandatory content that cannot fit refuses before the request is sent. When the window is unknown the previous 200 000-token selection ceiling still applies and is labelled as an assumption. A patch cut at the provider's output limit is reported as truncated. The sizes are typed for every surface: the run summary's `rawContext` gives the estimate of the request the final attempt last prepared (recorded just before its POST) and the budget its packet honoured, and an over-window refusal's failure record carries `rawContextShortfall` with the window, the request's parts and every mandatory file's estimate, plus next actions. The macOS app shows the estimate and the omitted optional files as run facts, and the refusal with its largest mandatory files.

- 28dfe1a: `claudexor doctor` now ends with the daemon's route health for the terminal runs created in the last seven days: a summary line, then each route (one harness crossed with one effective access profile) that had failures with its failure share and most frequent failure, as facts without thresholds or alarms. The full answer, every route's succeeded, failed, cancelled and other counts with up to three failure groups, is `GET /v2/daemon/route-health` in the control API (listed in the operation catalog; an older engine answers 404, which doctor prints as unavailable) and `route_health` in `doctor --json`. It is computed on demand from the retained run records by a bounded newest-first scan that says when it stopped early (`complete`, `incompleteReason`), and each run contributes only a few small artifacts read once in the shared worker, never its event journal. Motivation: on one install about half of the readonly Antigravity runs failed for two months while claude and codex readonly runs almost never did, and no surface showed failure shares per route.
- Updated dependencies [f428c0a]
- Updated dependencies [66d5b6a]
- Updated dependencies [dabf48c]
- Updated dependencies [fe7e2ae]
- Updated dependencies [30caf39]
- Updated dependencies [d16170f]
- Updated dependencies [f428c0a]
- Updated dependencies [8bae6ae]
- Updated dependencies [9a5ef43]
- Updated dependencies [66d5b6a]
- Updated dependencies [f428c0a]
- Updated dependencies [d9e7977]
- Updated dependencies [d807104]
- Updated dependencies [2d83b87]
- Updated dependencies [f428c0a]
- Updated dependencies [fe7e2ae]
- Updated dependencies [338729e]
- Updated dependencies [28dfe1a]
- Updated dependencies [3ba851e]
  - @claudexor/gateway@5.0.0
  - @claudexor/orchestrator@5.0.0
  - @claudexor/schema@5.0.0
  - @claudexor/workspace@5.0.0
  - @claudexor/harness-codex@5.0.0
  - @claudexor/harness-claude@5.0.0
  - @claudexor/core@5.0.0
  - @claudexor/harness-cursor@5.0.0
  - @claudexor/control-api@5.0.0
  - @claudexor/acp-server@5.0.0
  - @claudexor/util@5.0.0
  - @claudexor/review@5.0.0
  - @claudexor/delivery@5.0.0
  - @claudexor/daemon@5.0.0
  - @claudexor/mcp-server@5.0.0
  - @claudexor/harness-acp@5.0.0
  - @claudexor/harness-agy@5.0.0
  - @claudexor/harness-fake@5.0.0
  - @claudexor/harness-grok@5.0.0
  - @claudexor/harness-opencode@5.0.0
  - @claudexor/harness-raw-api@5.0.0
  - @claudexor/config@5.0.0
  - @claudexor/artifact-store@5.0.0
  - @claudexor/secrets@5.0.0

## 4.8.2

### Patch Changes

- 67b8833: Release old unreferenced artifacts and native sessions after archived project bindings are cleared. Reclaim aged, unnamed revert/exact-patch objects and empty engine containers while preserving surviving runs and recovery holds. Expose a durable last cleanup outcome, counted holds and errors through `claudexor gc --last` and `GET /v2/maintenance/gc`.

  Preserve complete NUL-delimited interaction IDs on Node 24.15 when pruning commands and observing retention changes, so question event groups and bodies are released and questions published during cleanup protect their runs.

  Preserve live workspace, Git checkout and harness-home directories during cleanup. Keep hold history through interrupted inventory, recover unreadable last-pass records with a passive diagnostic, and report unsupported native adapters without false holds.

  Keep foreign Codex session entries informational and preserve unobserved holds through interrupted cleanup. Reclaim empty run-retirement containers and avoid removal attempts on nonempty containers.

- f88a561: Fix multi-run waits and task-group recovery (#513, #514, #515).

  A daemon that stops while `POST /v2/runs/wait-many` (`claudexor_runs_wait`, CLI `runs-wait`) is waiting now answers a retryable `503 daemon_stopping` at once instead of holding the shutdown until a forced exit; a launch whose run has not started yet gets its `202` receipt. `waitMs` bounds the wait between reads, never a read: a read under way at the deadline finishes and its facts and attention are the answer, so a short positive `waitMs` no longer returns every target `not_observed`. A problem row's `null` token can be echoed as `seen: null` to acknowledge that problem, so the wait continues for the healthy targets instead of returning at once; output shapes are unchanged. Observation tokens never match the secret scan that guards MCP input. A request body the daemon refuses keeps its connection until the typed `413` is read, on JSON routes and upload bytes alike, and stop closes only connections still sending such a body.

  Waits wake from the store's post-commit notices for the watched jobs, runs and questions instead of a 250 ms poll that re-read every target, and they re-read only the targets a notice names. Group pages add each member once instead of re-serializing the page per member.

  Task-group membership now ignores the letter case of the group UUID: engine schema 6 stores the canonical lower-case group in a `command.task_group_id` column, backfilled for live and archived rows, and answers keep the caller's spelling. Older engines refuse the upgraded store, and group cursors issued before the upgrade restart with `stale_cursor`. A tagged launch, retry or decision rerun is refused before acceptance when the store identity is unavailable; a decision rerun keeps its group and answers `newJobId` with the group receipt. A CLI wait that fails after acceptance keeps the job receipt in the error context. CLI `--wait-ms` and `--limit` accept only plain decimal integers.

  Changes that controllers and embedders can see: earlier CLI and MCP clients check `seen` locally and refuse `null`, and an earlier daemon refuses a request that carries it, so acknowledging a problem needs both sides upgraded. A token saved from an earlier engine that the MCP secret scan refuses can be dropped from `seen` once to receive its re-derived replacement. A target hidden by pruning, archive or a generation change during a wait shows `not_found` at the deadline's read rather than at once. `GET /v2/task-groups/:id/runs` refuses a `limit` with a leading zero. The CLI's bounded observation reads report a malformed daemon answer as non-retryable `invalid_service_response` and a read timeout as `run_observation_timeout`. Embedders of `DaemonControlApiServer` can pass the new optional `runObservationChanges` feed; without it waits keep the 250 ms poll, and wait-many no longer subscribes to the `bus` option, which still drives the event streams.

- Updated dependencies [bd69a20]
- Updated dependencies [97e2f17]
- Updated dependencies [67b8833]
- Updated dependencies [f88a561]
  - @claudexor/harness-agy@4.8.2
  - @claudexor/control-api@4.8.2
  - @claudexor/schema@4.8.2
  - @claudexor/util@4.8.2
  - @claudexor/daemon@4.8.2
  - @claudexor/workspace@4.8.2
  - @claudexor/delivery@4.8.2
  - @claudexor/mcp-server@4.8.2
  - @claudexor/orchestrator@4.8.2
  - @claudexor/acp-server@4.8.2
  - @claudexor/config@4.8.2
  - @claudexor/core@4.8.2
  - @claudexor/gateway@4.8.2
  - @claudexor/harness-acp@4.8.2
  - @claudexor/harness-claude@4.8.2
  - @claudexor/harness-codex@4.8.2
  - @claudexor/harness-cursor@4.8.2
  - @claudexor/harness-fake@4.8.2
  - @claudexor/harness-grok@4.8.2
  - @claudexor/harness-opencode@4.8.2
  - @claudexor/harness-raw-api@4.8.2
  - @claudexor/review@4.8.2
  - @claudexor/artifact-store@4.8.2
  - @claudexor/secrets@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/acp-server@4.8.1
- @claudexor/artifact-store@4.8.1
- @claudexor/config@4.8.1
- @claudexor/control-api@4.8.1
- @claudexor/core@4.8.1
- @claudexor/daemon@4.8.1
- @claudexor/delivery@4.8.1
- @claudexor/gateway@4.8.1
- @claudexor/harness-acp@4.8.1
- @claudexor/harness-agy@4.8.1
- @claudexor/harness-claude@4.8.1
- @claudexor/harness-codex@4.8.1
- @claudexor/harness-cursor@4.8.1
- @claudexor/harness-fake@4.8.1
- @claudexor/harness-grok@4.8.1
- @claudexor/harness-opencode@4.8.1
- @claudexor/harness-raw-api@4.8.1
- @claudexor/mcp-server@4.8.1
- @claudexor/orchestrator@4.8.1
- @claudexor/review@4.8.1
- @claudexor/schema@4.8.1
- @claudexor/secrets@4.8.1
- @claudexor/util@4.8.1
- @claudexor/workspace@4.8.1

## 4.8.0

### Minor Changes

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

- Updated dependencies
- Updated dependencies
- Updated dependencies [6c31c44]
- Updated dependencies [7dfbc42]
- Updated dependencies
- Updated dependencies [4a028bb]
  - @claudexor/orchestrator@4.8.0
  - @claudexor/schema@4.8.0
  - @claudexor/daemon@4.8.0
  - @claudexor/control-api@4.8.0
  - @claudexor/mcp-server@4.8.0
  - @claudexor/harness-grok@4.8.0
  - @claudexor/core@4.8.0
  - @claudexor/util@4.8.0
  - @claudexor/harness-agy@4.8.0
  - @claudexor/harness-cursor@4.8.0
  - @claudexor/acp-server@4.8.0
  - @claudexor/config@4.8.0
  - @claudexor/delivery@4.8.0
  - @claudexor/gateway@4.8.0
  - @claudexor/harness-acp@4.8.0
  - @claudexor/harness-claude@4.8.0
  - @claudexor/harness-codex@4.8.0
  - @claudexor/harness-fake@4.8.0
  - @claudexor/harness-opencode@4.8.0
  - @claudexor/harness-raw-api@4.8.0
  - @claudexor/review@4.8.0
  - @claudexor/workspace@4.8.0
  - @claudexor/artifact-store@4.8.0
  - @claudexor/secrets@4.8.0

## 4.7.1

### Patch Changes

- 30f8195: Preserve optional caller-generated task group membership in accepted one-shot jobs and their receipts. Tagged receipts identify the accepting store, Exact Retry retains membership, and new continuations join a group only when explicitly requested. Add atomic engine-store schema version 3 expression indexes for retained group membership.

  Recover original queued and bound job handles with the bounded `task-group-runs` CLI, `claudexor_task_group_runs` MCP tool and HTTP group page. Store/view/filter-bound cursors require explicit paging; compact member observations share the multi-run attention contract. Results cover retained rows in currently served generations, not a permanent roster. Discovery adds no launch, retry, resume, answer, permissions or budget authority.

  Document durable caller receipts, exact keyed replay, separate interaction/result reads and storage downgrade precautions. Add deterministic built CLI/MCP/HTTP qualification stories for controller loss, queued binding, replay conflicts, store mismatch, archive visibility and daemon-crash interruption without autoresume. Manual host UI and real-vendor qualification remain separate.

- Updated dependencies [880081d]
- Updated dependencies [30f8195]
- Updated dependencies [8a9c2f6]
  - @claudexor/schema@4.7.1
  - @claudexor/core@4.7.1
  - @claudexor/orchestrator@4.7.1
  - @claudexor/harness-cursor@4.7.1
  - @claudexor/daemon@4.7.1
  - @claudexor/control-api@4.7.1
  - @claudexor/mcp-server@4.7.1
  - @claudexor/harness-claude@4.7.1
  - @claudexor/acp-server@4.7.1
  - @claudexor/config@4.7.1
  - @claudexor/delivery@4.7.1
  - @claudexor/gateway@4.7.1
  - @claudexor/harness-acp@4.7.1
  - @claudexor/harness-agy@4.7.1
  - @claudexor/harness-codex@4.7.1
  - @claudexor/harness-fake@4.7.1
  - @claudexor/harness-opencode@4.7.1
  - @claudexor/harness-raw-api@4.7.1
  - @claudexor/review@4.7.1
  - @claudexor/workspace@4.7.1
  - @claudexor/artifact-store@4.7.1
  - @claudexor/secrets@4.7.1
  - @claudexor/util@4.7.1

## 4.7.0

### Minor Changes

- 74fb275: Add `execution.auxiliaryWritableRoots`: exact caller-created service directories (a shared download cache, outside-Git scratch) an Agent run with effective `workspace_write` may also write. Admission records the canonical list in `TaskContract.access.auxiliary_writable_roots` and refuses unsafe, missing or conflicting grants with typed codes, including any overlap with the execution or source tree. Lanes negotiate it through `capability_profile.access_control.auxiliary_writable_roots` and the catalog's `accessControl.auxiliaryWritableRoots`: Codex applies it per turn through its native sandbox policy; a new turn with no roots drops the earlier grant, while `continueFrom` with no execution group inherits the predecessor's whole group. Other adapters refuse an explicit pool and drop from Auto. The CLI gains repeatable `--auxiliary-writable-root`; MCP run tools, `claudexor_thread_turn` and ACP carry the same member.

### Patch Changes

- Updated dependencies [74fb275]
  - @claudexor/schema@4.7.0
  - @claudexor/core@4.7.0
  - @claudexor/workspace@4.7.0
  - @claudexor/orchestrator@4.7.0
  - @claudexor/control-api@4.7.0
  - @claudexor/mcp-server@4.7.0
  - @claudexor/harness-codex@4.7.0
  - @claudexor/harness-acp@4.7.0
  - @claudexor/harness-agy@4.7.0
  - @claudexor/harness-claude@4.7.0
  - @claudexor/harness-cursor@4.7.0
  - @claudexor/harness-fake@4.7.0
  - @claudexor/harness-opencode@4.7.0
  - @claudexor/harness-raw-api@4.7.0
  - @claudexor/acp-server@4.7.0
  - @claudexor/config@4.7.0
  - @claudexor/daemon@4.7.0
  - @claudexor/delivery@4.7.0
  - @claudexor/gateway@4.7.0
  - @claudexor/review@4.7.0
  - @claudexor/artifact-store@4.7.0
  - @claudexor/secrets@4.7.0
  - @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/acp-server@4.6.2
- @claudexor/artifact-store@4.6.2
- @claudexor/config@4.6.2
- @claudexor/control-api@4.6.2
- @claudexor/core@4.6.2
- @claudexor/daemon@4.6.2
- @claudexor/delivery@4.6.2
- @claudexor/gateway@4.6.2
- @claudexor/harness-acp@4.6.2
- @claudexor/harness-agy@4.6.2
- @claudexor/harness-claude@4.6.2
- @claudexor/harness-codex@4.6.2
- @claudexor/harness-cursor@4.6.2
- @claudexor/harness-fake@4.6.2
- @claudexor/harness-opencode@4.6.2
- @claudexor/harness-raw-api@4.6.2
- @claudexor/mcp-server@4.6.2
- @claudexor/orchestrator@4.6.2
- @claudexor/review@4.6.2
- @claudexor/schema@4.6.2
- @claudexor/secrets@4.6.2
- @claudexor/util@4.6.2
- @claudexor/workspace@4.6.2

## 4.6.1

### Patch Changes

- ed646a5: Attachment and Browser request admission now uses execution's pool projection, candidate membership and profile precedence. An explicit or inherited profile selects its harness even when the default harness home is logged out, a Settings default pool stays strict, and a missing, disabled or wrong-harness pin is refused with a typed `harness_unavailable` 400 instead of being substituted. Admission adds no selected-profile readiness gate; Auto retains host-status discovery for candidate membership. The run checks account readiness, quota and model before any provider starts. An empty Auto candidate pool now returns 400 `harness_unavailable`; static profile ambiguity returns 409 `credential_profile_ambiguous` after incompatible attachment lanes are removed. Browser-only Auto may still reject ambiguous AGY profiles on Windows that execution would have discarded as unready. A direct run that carries `threadId` is refused before admission reads that thread.
- Updated dependencies [ed646a5]
  - @claudexor/orchestrator@4.6.1
  - @claudexor/control-api@4.6.1
  - @claudexor/acp-server@4.6.1
  - @claudexor/artifact-store@4.6.1
  - @claudexor/config@4.6.1
  - @claudexor/core@4.6.1
  - @claudexor/daemon@4.6.1
  - @claudexor/delivery@4.6.1
  - @claudexor/gateway@4.6.1
  - @claudexor/harness-acp@4.6.1
  - @claudexor/harness-agy@4.6.1
  - @claudexor/harness-claude@4.6.1
  - @claudexor/harness-codex@4.6.1
  - @claudexor/harness-cursor@4.6.1
  - @claudexor/harness-fake@4.6.1
  - @claudexor/harness-opencode@4.6.1
  - @claudexor/harness-raw-api@4.6.1
  - @claudexor/mcp-server@4.6.1
  - @claudexor/review@4.6.1
  - @claudexor/schema@4.6.1
  - @claudexor/secrets@4.6.1
  - @claudexor/util@4.6.1
  - @claudexor/workspace@4.6.1

## 4.6.0

### Minor Changes

- a81897c: Choose the native prompt-cache lifetime of Claude Code sessions per run: `POST /v2/runs` and `POST /v2/threads/:id/turns` accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`, including plan answers the same command submits inline), and omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities` projects them as `harnesses[].promptCacheTtls` and lists the key in `runControlKeys`. The value is frozen into the task contract, inherited by a bare `continueFrom` (a successor cannot go back to Default; that takes a new run), re-injected by Exact Retry, and forwarded to task lanes, the continuity summary, reviewers and delegation-belt children on declaring harnesses. Elsewhere it is an `ignored_settings` disclosure, except in best-of synthesis, which emits no `harness.started`: an undeclared synthesis harness runs without the lifetime and without a disclosure. The deep-scan reducer's `harness.started` now discloses every route knob its harness ignores, including `max_turns` and tool lists. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, keeps forcing and disabling controls, and discloses the ones known to govern instead (and a known older CLI). Each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the lifetime routed to its sessions (`requested`), the configured value and the observed split of the reported five-minute and one-hour cache-write tokens; an unreported split stays unknown.

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
  - @claudexor/harness-codex@4.6.0
  - @claudexor/schema@4.6.0
  - @claudexor/util@4.6.0
  - @claudexor/control-api@4.6.0
  - @claudexor/orchestrator@4.6.0
  - @claudexor/review@4.6.0
  - @claudexor/mcp-server@4.6.0
  - @claudexor/harness-claude@4.6.0
  - @claudexor/harness-agy@4.6.0
  - @claudexor/delivery@4.6.0
  - @claudexor/workspace@4.6.0
  - @claudexor/daemon@4.6.0
  - @claudexor/gateway@4.6.0
  - @claudexor/harness-acp@4.6.0
  - @claudexor/harness-cursor@4.6.0
  - @claudexor/harness-fake@4.6.0
  - @claudexor/harness-opencode@4.6.0
  - @claudexor/harness-raw-api@4.6.0
  - @claudexor/acp-server@4.6.0
  - @claudexor/config@4.6.0
  - @claudexor/artifact-store@4.6.0
  - @claudexor/secrets@4.6.0

## 4.5.0

### Minor Changes

- 032b44b: Demote Codex accounts for a model after a pre-generation refusal. A recognized capability refusal (`model_capability_refused`) marks the account at once; any other definite provider HTTP 4xx before generation on an auto operation (outside sign-in, timeouts, conflicts, rate and quota limits, the processing fallback, server failures and typed request faults) offers the same single correlated host retry, which becomes a confirmed mark when another account serves and marks nothing when it refuses too. Both kinds also record the shared pre-progress refusal observation, so Agent runs of that model order the account last as well, and an older in-flight refusal never undoes a newer model operation's service. Auto selection prefers accounts whose live catalog lists the model, then advisory misses, then accounts with only a soft observation (a recent refusal, or a served-model substitution of a non-preferred account), then capability-marked accounts; history bound to an unmarked, unrefused preferred account stays on that account. Refusal problems carry `modelMarks` (each live mark with the start of its episode) and `alternativeRemains` (whether another selectable account without a mark remains). Routing receipts (`captureRoutingEvidence=true` on `POST /v2/model-operations`) and capability rows (`includeCapabilities=true` on `GET /v2/accounts/routing-evidence`) are opt-in over HTTP, so strict 4.4.0 clients keep their shapes; Claudexor's own CLI and MCP readers request the rows. Behavior change: the recognized Codex refusals (an explicit `model_not_found` or `model_not_supported` code, the ChatGPT-account unsupported-model sentence, the narrow missing-model sentences) now return `model_capability_refused` instead of `invalid_request` or `model_unavailable` (an explicit vendor `model_not_found` still records the model-scoped unusable verdict), and `preferredProfileId` no longer wins over a listed account or over its own mark or recent refusal; history bound to that account keeps it first over a catalog miss only while it has neither.

### Patch Changes

- Updated dependencies [032b44b]
- Updated dependencies [85e312d]
  - @claudexor/control-api@4.5.0
  - @claudexor/daemon@4.5.0
  - @claudexor/harness-codex@4.5.0
  - @claudexor/mcp-server@4.5.0
  - @claudexor/schema@4.5.0
  - @claudexor/workspace@4.5.0
  - @claudexor/orchestrator@4.5.0
  - @claudexor/acp-server@4.5.0
  - @claudexor/config@4.5.0
  - @claudexor/core@4.5.0
  - @claudexor/delivery@4.5.0
  - @claudexor/gateway@4.5.0
  - @claudexor/harness-acp@4.5.0
  - @claudexor/harness-agy@4.5.0
  - @claudexor/harness-claude@4.5.0
  - @claudexor/harness-cursor@4.5.0
  - @claudexor/harness-fake@4.5.0
  - @claudexor/harness-opencode@4.5.0
  - @claudexor/harness-raw-api@4.5.0
  - @claudexor/review@4.5.0
  - @claudexor/artifact-store@4.5.0
  - @claudexor/secrets@4.5.0
  - @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Daemon status reports per-route request latency (one count of completed responses or disconnects with p50, p99 and max for the lifetime and the last loop window, keyed by HTTP method and operation-catalog template) and the 32 longest labelled synchronous sections since start (store BEGIN and COMMIT, external writes, run detail and summary projections, scope persistence), plus lifetime COMMIT p50 and p99. A request whose client has already hung up skips its pending heavy read projections; an admitted mutation still completes. `POST /v2/handshake` returns the durable engine store id as `storeId` to a client that sends `X-Claudexor-Store-Identity: 1`, and every other client keeps the earlier response shape. `scripts/daemon-load-bench.mjs` compares an exact base against the working tree in alternating trials inside temporary roots it owns. Moving checkpoints off the request thread was measured and not adopted: it lowered COMMIT tails but not the event-loop tail consistently (`docs/benchmarks/daemon-sync-20261020.md`).
- Engine retention retires unregistered and archived project histories, orphaned run trees and unreferenced native session parts in recurring bounded maintenance and never removes anything still referenced; immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported (#477).
- A fresh managed Codex install resolves npm `latest` once to an exact version, discloses it and installs exactly that version; `--release-tested` uses the release baseline, a latest older than that baseline refuses (`latest_older_than_tested`), and `pinnedVersion` now names the selected install target. Thanks to @josephsteuerjr (#476).
- MCP controllers get idempotent one-shot launches and durable run supervision: `claudexor_run_wait`, `claudexor_run_message`, `claudexor_run_continue` and bounded `claudexor_run_event_read` parts. Thanks to @IlidanNaga (#478).

### Patch Changes

- Updated dependencies
  - @claudexor/control-api@4.4.0
  - @claudexor/daemon@4.4.0
  - @claudexor/util@4.4.0
  - @claudexor/schema@4.4.0
  - @claudexor/acp-server@4.4.0
  - @claudexor/artifact-store@4.4.0
  - @claudexor/config@4.4.0
  - @claudexor/core@4.4.0
  - @claudexor/delivery@4.4.0
  - @claudexor/harness-acp@4.4.0
  - @claudexor/harness-agy@4.4.0
  - @claudexor/harness-claude@4.4.0
  - @claudexor/harness-codex@4.4.0
  - @claudexor/harness-cursor@4.4.0
  - @claudexor/harness-fake@4.4.0
  - @claudexor/harness-opencode@4.4.0
  - @claudexor/harness-raw-api@4.4.0
  - @claudexor/mcp-server@4.4.0
  - @claudexor/orchestrator@4.4.0
  - @claudexor/review@4.4.0
  - @claudexor/secrets@4.4.0
  - @claudexor/workspace@4.4.0
  - @claudexor/gateway@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [64ee7fc]
  - @claudexor/workspace@4.3.1
  - @claudexor/orchestrator@4.3.1
  - @claudexor/control-api@4.3.1
  - @claudexor/daemon@4.3.1
  - @claudexor/delivery@4.3.1
  - @claudexor/review@4.3.1
  - @claudexor/acp-server@4.3.1
  - @claudexor/artifact-store@4.3.1
  - @claudexor/config@4.3.1
  - @claudexor/core@4.3.1
  - @claudexor/gateway@4.3.1
  - @claudexor/harness-acp@4.3.1
  - @claudexor/harness-agy@4.3.1
  - @claudexor/harness-claude@4.3.1
  - @claudexor/harness-codex@4.3.1
  - @claudexor/harness-cursor@4.3.1
  - @claudexor/harness-fake@4.3.1
  - @claudexor/harness-opencode@4.3.1
  - @claudexor/harness-raw-api@4.3.1
  - @claudexor/mcp-server@4.3.1
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
  - @claudexor/control-api@4.3.0
  - @claudexor/core@4.3.0
  - @claudexor/daemon@4.3.0
  - @claudexor/harness-agy@4.3.0
  - @claudexor/harness-codex@4.3.0
  - @claudexor/harness-cursor@4.3.0
  - @claudexor/mcp-server@4.3.0
  - @claudexor/orchestrator@4.3.0
  - @claudexor/review@4.3.0
  - @claudexor/schema@4.3.0
  - @claudexor/acp-server@4.3.0
  - @claudexor/config@4.3.0
  - @claudexor/delivery@4.3.0
  - @claudexor/gateway@4.3.0
  - @claudexor/harness-acp@4.3.0
  - @claudexor/harness-claude@4.3.0
  - @claudexor/harness-fake@4.3.0
  - @claudexor/harness-opencode@4.3.0
  - @claudexor/harness-raw-api@4.3.0
  - @claudexor/workspace@4.3.0
  - @claudexor/artifact-store@4.3.0
  - @claudexor/secrets@4.3.0
  - @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- Updated dependencies
  - @claudexor/daemon@4.2.0
  - @claudexor/acp-server@4.2.0
  - @claudexor/artifact-store@4.2.0
  - @claudexor/config@4.2.0
  - @claudexor/control-api@4.2.0
  - @claudexor/core@4.2.0
  - @claudexor/delivery@4.2.0
  - @claudexor/gateway@4.2.0
  - @claudexor/harness-acp@4.2.0
  - @claudexor/harness-agy@4.2.0
  - @claudexor/harness-claude@4.2.0
  - @claudexor/harness-codex@4.2.0
  - @claudexor/harness-cursor@4.2.0
  - @claudexor/harness-fake@4.2.0
  - @claudexor/harness-opencode@4.2.0
  - @claudexor/harness-raw-api@4.2.0
  - @claudexor/mcp-server@4.2.0
  - @claudexor/orchestrator@4.2.0
  - @claudexor/review@4.2.0
  - @claudexor/schema@4.2.0
  - @claudexor/secrets@4.2.0
  - @claudexor/util@4.2.0
  - @claudexor/workspace@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/acp-server@4.1.1
- @claudexor/artifact-store@4.1.1
- @claudexor/config@4.1.1
- @claudexor/control-api@4.1.1
- @claudexor/core@4.1.1
- @claudexor/daemon@4.1.1
- @claudexor/delivery@4.1.1
- @claudexor/gateway@4.1.1
- @claudexor/harness-acp@4.1.1
- @claudexor/harness-agy@4.1.1
- @claudexor/harness-claude@4.1.1
- @claudexor/harness-codex@4.1.1
- @claudexor/harness-cursor@4.1.1
- @claudexor/harness-fake@4.1.1
- @claudexor/harness-opencode@4.1.1
- @claudexor/harness-raw-api@4.1.1
- @claudexor/mcp-server@4.1.1
- @claudexor/orchestrator@4.1.1
- @claudexor/review@4.1.1
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
  - @claudexor/core@4.1.0
  - @claudexor/daemon@4.1.0
  - @claudexor/control-api@4.1.0
  - @claudexor/harness-codex@4.1.0
  - @claudexor/orchestrator@4.1.0
  - @claudexor/acp-server@4.1.0
  - @claudexor/config@4.1.0
  - @claudexor/delivery@4.1.0
  - @claudexor/gateway@4.1.0
  - @claudexor/harness-acp@4.1.0
  - @claudexor/harness-agy@4.1.0
  - @claudexor/harness-claude@4.1.0
  - @claudexor/harness-cursor@4.1.0
  - @claudexor/harness-fake@4.1.0
  - @claudexor/harness-opencode@4.1.0
  - @claudexor/harness-raw-api@4.1.0
  - @claudexor/mcp-server@4.1.0
  - @claudexor/review@4.1.0
  - @claudexor/workspace@4.1.0
  - @claudexor/artifact-store@4.1.0
  - @claudexor/secrets@4.1.0
  - @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- Updated dependencies
  - @claudexor/daemon@4.0.1
  - @claudexor/acp-server@4.0.1
  - @claudexor/artifact-store@4.0.1
  - @claudexor/config@4.0.1
  - @claudexor/control-api@4.0.1
  - @claudexor/core@4.0.1
  - @claudexor/delivery@4.0.1
  - @claudexor/gateway@4.0.1
  - @claudexor/harness-acp@4.0.1
  - @claudexor/harness-agy@4.0.1
  - @claudexor/harness-claude@4.0.1
  - @claudexor/harness-codex@4.0.1
  - @claudexor/harness-cursor@4.0.1
  - @claudexor/harness-fake@4.0.1
  - @claudexor/harness-opencode@4.0.1
  - @claudexor/harness-raw-api@4.0.1
  - @claudexor/mcp-server@4.0.1
  - @claudexor/orchestrator@4.0.1
  - @claudexor/review@4.0.1
  - @claudexor/schema@4.0.1
  - @claudexor/secrets@4.0.1
  - @claudexor/util@4.0.1
  - @claudexor/workspace@4.0.1

## 4.0.0

### Minor Changes

- 2fbf7c9: Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.

### Patch Changes

- Updated dependencies [2fbf7c9]
- Updated dependencies
  - @claudexor/schema@4.0.0
  - @claudexor/daemon@4.0.0
  - @claudexor/control-api@4.0.0
  - @claudexor/util@4.0.0
  - @claudexor/config@4.0.0
  - @claudexor/harness-codex@4.0.0
  - @claudexor/acp-server@4.0.0
  - @claudexor/core@4.0.0
  - @claudexor/delivery@4.0.0
  - @claudexor/gateway@4.0.0
  - @claudexor/harness-acp@4.0.0
  - @claudexor/harness-agy@4.0.0
  - @claudexor/harness-claude@4.0.0
  - @claudexor/harness-cursor@4.0.0
  - @claudexor/harness-fake@4.0.0
  - @claudexor/harness-opencode@4.0.0
  - @claudexor/harness-raw-api@4.0.0
  - @claudexor/mcp-server@4.0.0
  - @claudexor/orchestrator@4.0.0
  - @claudexor/review@4.0.0
  - @claudexor/workspace@4.0.0
  - @claudexor/artifact-store@4.0.0
  - @claudexor/secrets@4.0.0

## 3.25.1

### Patch Changes

- Carry account resources and explicit reset controls forward from the unpublished 3.25.0 candidate, and use the matching Docker Official Ubuntu image from ECR Public for Linux SSH release verification.
  - @claudexor/acp-server@3.25.1
  - @claudexor/artifact-store@3.25.1
  - @claudexor/config@3.25.1
  - @claudexor/control-api@3.25.1
  - @claudexor/core@3.25.1
  - @claudexor/daemon@3.25.1
  - @claudexor/delivery@3.25.1
  - @claudexor/gateway@3.25.1
  - @claudexor/harness-acp@3.25.1
  - @claudexor/harness-agy@3.25.1
  - @claudexor/harness-claude@3.25.1
  - @claudexor/harness-codex@3.25.1
  - @claudexor/harness-cursor@3.25.1
  - @claudexor/harness-fake@3.25.1
  - @claudexor/harness-opencode@3.25.1
  - @claudexor/harness-raw-api@3.25.1
  - @claudexor/journal@3.25.1
  - @claudexor/mcp-server@3.25.1
  - @claudexor/orchestrator@3.25.1
  - @claudexor/review@3.25.1
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
  - @claudexor/daemon@3.25.0
  - @claudexor/control-api@3.25.0
  - @claudexor/mcp-server@3.25.0
  - @claudexor/harness-codex@3.25.0
  - @claudexor/harness-claude@3.25.0
  - @claudexor/acp-server@3.25.0
  - @claudexor/config@3.25.0
  - @claudexor/core@3.25.0
  - @claudexor/delivery@3.25.0
  - @claudexor/gateway@3.25.0
  - @claudexor/harness-acp@3.25.0
  - @claudexor/harness-agy@3.25.0
  - @claudexor/harness-cursor@3.25.0
  - @claudexor/harness-fake@3.25.0
  - @claudexor/harness-opencode@3.25.0
  - @claudexor/harness-raw-api@3.25.0
  - @claudexor/orchestrator@3.25.0
  - @claudexor/review@3.25.0
  - @claudexor/workspace@3.25.0
  - @claudexor/artifact-store@3.25.0
  - @claudexor/journal@3.25.0
  - @claudexor/secrets@3.25.0
  - @claudexor/util@3.25.0

## 3.24.0

### Minor Changes

- Add shared vendor CLI inspection and maintenance with durable update, cancellation and previous-version evidence. Preserve newer managed installations and support native Cursor and Antigravity updates. Permit explicit Codex models absent from a successful catalog without misreporting account availability as exhausted quota.

### Patch Changes

- Updated dependencies
  - @claudexor/core@3.24.0
  - @claudexor/schema@3.24.0
  - @claudexor/daemon@3.24.0
  - @claudexor/control-api@3.24.0
  - @claudexor/harness-codex@3.24.0
  - @claudexor/delivery@3.24.0
  - @claudexor/gateway@3.24.0
  - @claudexor/harness-acp@3.24.0
  - @claudexor/harness-agy@3.24.0
  - @claudexor/harness-claude@3.24.0
  - @claudexor/harness-cursor@3.24.0
  - @claudexor/harness-fake@3.24.0
  - @claudexor/harness-opencode@3.24.0
  - @claudexor/harness-raw-api@3.24.0
  - @claudexor/orchestrator@3.24.0
  - @claudexor/review@3.24.0
  - @claudexor/workspace@3.24.0
  - @claudexor/acp-server@3.24.0
  - @claudexor/config@3.24.0
  - @claudexor/mcp-server@3.24.0
  - @claudexor/artifact-store@3.24.0
  - @claudexor/journal@3.24.0
  - @claudexor/secrets@3.24.0
  - @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- Updated dependencies
  - @claudexor/control-api@3.23.2
  - @claudexor/acp-server@3.23.2
  - @claudexor/artifact-store@3.23.2
  - @claudexor/config@3.23.2
  - @claudexor/core@3.23.2
  - @claudexor/daemon@3.23.2
  - @claudexor/delivery@3.23.2
  - @claudexor/gateway@3.23.2
  - @claudexor/harness-acp@3.23.2
  - @claudexor/harness-agy@3.23.2
  - @claudexor/harness-claude@3.23.2
  - @claudexor/harness-codex@3.23.2
  - @claudexor/harness-cursor@3.23.2
  - @claudexor/harness-fake@3.23.2
  - @claudexor/harness-opencode@3.23.2
  - @claudexor/harness-raw-api@3.23.2
  - @claudexor/journal@3.23.2
  - @claudexor/mcp-server@3.23.2
  - @claudexor/orchestrator@3.23.2
  - @claudexor/review@3.23.2
  - @claudexor/schema@3.23.2
  - @claudexor/secrets@3.23.2
  - @claudexor/util@3.23.2
  - @claudexor/workspace@3.23.2

## 3.23.1

### Patch Changes

- Updated dependencies [1111845]
  - @claudexor/orchestrator@3.23.1
  - @claudexor/harness-claude@3.23.1
  - @claudexor/acp-server@3.23.1
  - @claudexor/artifact-store@3.23.1
  - @claudexor/config@3.23.1
  - @claudexor/control-api@3.23.1
  - @claudexor/core@3.23.1
  - @claudexor/daemon@3.23.1
  - @claudexor/delivery@3.23.1
  - @claudexor/gateway@3.23.1
  - @claudexor/harness-acp@3.23.1
  - @claudexor/harness-agy@3.23.1
  - @claudexor/harness-codex@3.23.1
  - @claudexor/harness-cursor@3.23.1
  - @claudexor/harness-fake@3.23.1
  - @claudexor/harness-opencode@3.23.1
  - @claudexor/harness-raw-api@3.23.1
  - @claudexor/journal@3.23.1
  - @claudexor/mcp-server@3.23.1
  - @claudexor/review@3.23.1
  - @claudexor/schema@3.23.1
  - @claudexor/secrets@3.23.1
  - @claudexor/util@3.23.1
  - @claudexor/workspace@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/acp-server@3.23.0
- @claudexor/artifact-store@3.23.0
- @claudexor/config@3.23.0
- @claudexor/control-api@3.23.0
- @claudexor/core@3.23.0
- @claudexor/daemon@3.23.0
- @claudexor/delivery@3.23.0
- @claudexor/gateway@3.23.0
- @claudexor/harness-acp@3.23.0
- @claudexor/harness-agy@3.23.0
- @claudexor/harness-claude@3.23.0
- @claudexor/harness-codex@3.23.0
- @claudexor/harness-cursor@3.23.0
- @claudexor/harness-fake@3.23.0
- @claudexor/harness-opencode@3.23.0
- @claudexor/harness-raw-api@3.23.0
- @claudexor/journal@3.23.0
- @claudexor/mcp-server@3.23.0
- @claudexor/orchestrator@3.23.0
- @claudexor/review@3.23.0
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
  - @claudexor/daemon@3.22.1
  - @claudexor/control-api@3.22.1
  - @claudexor/acp-server@3.22.1
  - @claudexor/config@3.22.1
  - @claudexor/core@3.22.1
  - @claudexor/delivery@3.22.1
  - @claudexor/gateway@3.22.1
  - @claudexor/harness-acp@3.22.1
  - @claudexor/harness-agy@3.22.1
  - @claudexor/harness-claude@3.22.1
  - @claudexor/harness-codex@3.22.1
  - @claudexor/harness-cursor@3.22.1
  - @claudexor/harness-fake@3.22.1
  - @claudexor/harness-opencode@3.22.1
  - @claudexor/harness-raw-api@3.22.1
  - @claudexor/mcp-server@3.22.1
  - @claudexor/orchestrator@3.22.1
  - @claudexor/review@3.22.1
  - @claudexor/workspace@3.22.1
  - @claudexor/artifact-store@3.22.1
  - @claudexor/journal@3.22.1
  - @claudexor/secrets@3.22.1

## 3.22.0

### Minor Changes

- 51578d4: Continue a stopped run instead of restarting it: `POST /v2/runs {continueFrom: <runId>, continueCarrier?: "auto" | "packet"}` starts the next run of a continuation chain. Admission is one daemon-atomic rule shared by every ingress (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain `head`): the accepted successor command is the durable claim, so a predecessor has exactly one accepted successor, also across restarts and concurrent requests. Omitted mode, scope, execution, harness and model come from the predecessor, and the prompt is the caller's continuation text (it may be empty). The successor's first try is planned through the in-run continuation planner from the predecessor's session capsule and terminal facts — the same account resumes the vendor session by id, another account resumes the moved session, otherwise a fresh session is briefed with the evidence index — and is disclosed by a `run.continuity` receipt naming the predecessor and whether it runs in the same root. A stopped isolated Agent run now keeps its envelope (tree and scoped home, Claudexor-seeded auth removed) under a durable custody record until a successor adopts it, its result is applied or it is discarded; the crash sweep and disk retention keep it, and a run interrupted by a daemon restart with changes is kept the same way. `GET /v2/runs/:id` projects `resumable` (derived as `host_restart` for runs the daemon found running at its restart), the per-try `continuity` receipts, `retainedEnvelope` (disk use) and `continueFrom`; `continueFrom` is advertised in `runControlKeys`.

### Patch Changes

- Updated dependencies [51578d4]
- Updated dependencies [785bba7]
  - @claudexor/schema@3.22.0
  - @claudexor/daemon@3.22.0
  - @claudexor/control-api@3.22.0
  - @claudexor/orchestrator@3.22.0
  - @claudexor/workspace@3.22.0
  - @claudexor/core@3.22.0
  - @claudexor/harness-claude@3.22.0
  - @claudexor/harness-codex@3.22.0
  - @claudexor/acp-server@3.22.0
  - @claudexor/config@3.22.0
  - @claudexor/delivery@3.22.0
  - @claudexor/gateway@3.22.0
  - @claudexor/harness-acp@3.22.0
  - @claudexor/harness-agy@3.22.0
  - @claudexor/harness-cursor@3.22.0
  - @claudexor/harness-fake@3.22.0
  - @claudexor/harness-opencode@3.22.0
  - @claudexor/harness-raw-api@3.22.0
  - @claudexor/mcp-server@3.22.0
  - @claudexor/review@3.22.0
  - @claudexor/artifact-store@3.22.0
  - @claudexor/journal@3.22.0
  - @claudexor/secrets@3.22.0
  - @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- 7c541ba: One effort word now works on Cursor and Antigravity too, where the level is a token of the compound model id. Given an effort preference, the adapter's preparation selects the listed level variant of the requested model's family from the inventory of the account that will run (`grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh`; `gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`): the family is the id with exactly one shared-order level token removed, `fast` and `thinking` stay in the family key so the choice never crosses fast/standard or thinking/no-thinking, a family exists only when the account lists two or more levels, and the level is placed by the shared preference order alone. One preparation yields the final id (the processing receipt's `submittedNative`, which is the `--model` argument) and the effort receipt (`parameter: --model`, `submitted` = level token), recorded once per spawn and per reviewer dispatch; the requested id stays in the model hint and in `attempts[].requested_model`. Nothing new refuses: an unknown word, an ambiguous id, a family-less id or an empty account list keep the id unchanged with an `omitted` receipt and a note. Antigravity rewrites only from the pinned account's live `agy models` list; the static hint list never authorizes a rewrite. Settings writes accept the preference for these routes, the existing fast-pair and paid policy run after the level choice, and the final telemetry `model_mismatch` compares the observation with the id actually sent.
- f0ab916: Make one effort word work on every route. The vendor's own order still ranks every level it lists; the shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) now places a word a route's ladder does not list, so `ultra` on a Claude binary that stops at `max` resolves downward to `max` and `none`/`minimal` resolve to the known minimum instead of refusing the run. The receipt names that placement and claims neither vendor support nor equal quality across vendors. One resolution result feeds the native flag, the typed receipt and the disclosure on Claude, Codex (sessions and raw model calls) and the ACP client, which now resolves `--effort` through the same resolver and records a receipt. A reviewer whose harness declares no effort controls keeps the preference as omitted with disclosure instead of failing the explicit panel or erasing the automatic panel's request. A word neither order knows is still refused before generation on routes that have a native effort knob.
- 9ccd45d: A secret-like string in agent output no longer rolls back an in-place patch, discards an isolated candidate or drops the answer. The changed files keep the exact bytes; the saved `patch.diff` copies and reviewer packets carry `[redacted]` (a flagged binary payload is withheld), and the run discloses paths and counts in `secret_like` (attempt record, work-product meta, one `summary.md` line, `secretLike` on the MCP read tools), never a matched value. `patch_sha256` stays the digest of the exact patch: Apply, apply/check and the `accept_risk` binding read a private exact patch object and answer 409 `patch_exact_bytes_unavailable` when it is missing. `pr` delivery refuses a secret-like patch before any push while local apply, branch and commit stay allowed; served media and other binaries that match the content policy answer 409 `secret_like_content_withheld`; the raw API no longer refuses a proposal for its content. Only a capture that cannot observe the changes is still a refusal, now named `capture_refusal` in phase `workspace` (the `secret_diff_refusal` attempt field, the `secret_diff_refused` / `secret_recovery` work-product fields and the `artifact_security` phase for patch runs are gone).
- a4ff572: Reconcile older quota refusals with newer account observations, preserve genuine credential rejections without duplicating poller state, and pace quota reads per affected account. Ordinary Accounts and account-catalog reads retain their first observation instead of repeatedly probing vendors. Discover Antigravity models for the selected account, forward explicitly requested unlisted models with disclosure, and preserve known quota-family applicability for new model IDs.
- Updated dependencies [b7439d3]
- Updated dependencies [7c541ba]
- Updated dependencies [f0ab916]
- Updated dependencies [83bc0da]
- Updated dependencies [9ccd45d]
- Updated dependencies [a4ff572]
  - @claudexor/harness-codex@3.21.0
  - @claudexor/core@3.21.0
  - @claudexor/harness-cursor@3.21.0
  - @claudexor/harness-agy@3.21.0
  - @claudexor/orchestrator@3.21.0
  - @claudexor/review@3.21.0
  - @claudexor/schema@3.21.0
  - @claudexor/harness-claude@3.21.0
  - @claudexor/harness-acp@3.21.0
  - @claudexor/util@3.21.0
  - @claudexor/workspace@3.21.0
  - @claudexor/delivery@3.21.0
  - @claudexor/control-api@3.21.0
  - @claudexor/harness-raw-api@3.21.0
  - @claudexor/daemon@3.21.0
  - @claudexor/mcp-server@3.21.0
  - @claudexor/gateway@3.21.0
  - @claudexor/harness-fake@3.21.0
  - @claudexor/harness-opencode@3.21.0
  - @claudexor/acp-server@3.21.0
  - @claudexor/config@3.21.0
  - @claudexor/artifact-store@3.21.0
  - @claudexor/journal@3.21.0
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
  - @claudexor/daemon@3.20.1
  - @claudexor/orchestrator@3.20.1
  - @claudexor/review@3.20.1
  - @claudexor/harness-claude@3.20.1
  - @claudexor/harness-codex@3.20.1
  - @claudexor/harness-cursor@3.20.1
  - @claudexor/control-api@3.20.1
  - @claudexor/acp-server@3.20.1
  - @claudexor/config@3.20.1
  - @claudexor/delivery@3.20.1
  - @claudexor/gateway@3.20.1
  - @claudexor/harness-acp@3.20.1
  - @claudexor/harness-agy@3.20.1
  - @claudexor/harness-fake@3.20.1
  - @claudexor/harness-opencode@3.20.1
  - @claudexor/harness-raw-api@3.20.1
  - @claudexor/mcp-server@3.20.1
  - @claudexor/workspace@3.20.1
  - @claudexor/artifact-store@3.20.1
  - @claudexor/journal@3.20.1
  - @claudexor/secrets@3.20.1
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
  - @claudexor/harness-acp@3.20.0
  - @claudexor/core@3.20.0
  - @claudexor/workspace@3.20.0
  - @claudexor/util@3.20.0
  - @claudexor/daemon@3.20.0
  - @claudexor/delivery@3.20.0
  - @claudexor/gateway@3.20.0
  - @claudexor/harness-agy@3.20.0
  - @claudexor/harness-claude@3.20.0
  - @claudexor/harness-codex@3.20.0
  - @claudexor/harness-cursor@3.20.0
  - @claudexor/harness-fake@3.20.0
  - @claudexor/harness-opencode@3.20.0
  - @claudexor/harness-raw-api@3.20.0
  - @claudexor/orchestrator@3.20.0
  - @claudexor/review@3.20.0
  - @claudexor/control-api@3.20.0
  - @claudexor/acp-server@3.20.0
  - @claudexor/artifact-store@3.20.0
  - @claudexor/config@3.20.0
  - @claudexor/journal@3.20.0
  - @claudexor/mcp-server@3.20.0
  - @claudexor/schema@3.20.0
  - @claudexor/secrets@3.20.0

## 3.19.0

### Minor Changes

- Claudexor ships as portable Claude Code and Cursor packages (`plugins/claude`, `plugins/cursor`) that carry the canonical Skill and the MCP server registration (no runtime, credentials, hooks or status-line collector; those stay with the managed `claudexor plugin install` integration), and the canonical Skill plus the managed-integration text describe `claudexor_accounts` truthfully (the plain call returns the cached listing; `fresh: true` is the expensive atomic snapshot). Production dependencies move to @agentclientprotocol/sdk 1.5.1, @modelcontextprotocol/server 2.2.0, @playwright/mcp 0.0.83, zod 4.6.5 and yaml 2.9.1; the release SBOM test reads the packaged Browser MCP version from packages/core instead of a literal.

### Patch Changes

- Updated dependencies [386bbf1]
- Updated dependencies
  - @claudexor/harness-agy@3.19.0
  - @claudexor/acp-server@3.19.0
  - @claudexor/mcp-server@3.19.0
  - @claudexor/core@3.19.0
  - @claudexor/config@3.19.0
  - @claudexor/schema@3.19.0
  - @claudexor/daemon@3.19.0
  - @claudexor/delivery@3.19.0
  - @claudexor/gateway@3.19.0
  - @claudexor/harness-claude@3.19.0
  - @claudexor/harness-codex@3.19.0
  - @claudexor/harness-cursor@3.19.0
  - @claudexor/harness-fake@3.19.0
  - @claudexor/harness-opencode@3.19.0
  - @claudexor/harness-raw-api@3.19.0
  - @claudexor/orchestrator@3.19.0
  - @claudexor/review@3.19.0
  - @claudexor/workspace@3.19.0
  - @claudexor/control-api@3.19.0
  - @claudexor/artifact-store@3.19.0
  - @claudexor/journal@3.19.0
  - @claudexor/secrets@3.19.0
  - @claudexor/util@3.19.0

## 3.18.0

### Minor Changes

- Release the integrated persistent MCP conversation tools and macOS agent-file previews. Thanks to @IlidanNaga for these contributions, including selected-profile billing repairs, to @Petyok for Cursor launcher discovery, and to @kzmx23 for Windows background-process and reconnect investigations.

### Patch Changes

- fb1fdb4: Discover Cursor installations that expose only the `agent` command, while preserving explicit binary overrides and the existing `cursor-agent` route across runs, probes, and managed login.
- Updated dependencies
- Updated dependencies
- Updated dependencies [fb1fdb4]
- Updated dependencies [09d08fb]
- Updated dependencies [b00408e]
  - @claudexor/harness-codex@3.18.0
  - @claudexor/mcp-server@3.18.0
  - @claudexor/harness-cursor@3.18.0
  - @claudexor/orchestrator@3.18.0
  - @claudexor/core@3.18.0
  - @claudexor/daemon@3.18.0
  - @claudexor/delivery@3.18.0
  - @claudexor/gateway@3.18.0
  - @claudexor/harness-agy@3.18.0
  - @claudexor/harness-claude@3.18.0
  - @claudexor/harness-fake@3.18.0
  - @claudexor/harness-opencode@3.18.0
  - @claudexor/harness-raw-api@3.18.0
  - @claudexor/review@3.18.0
  - @claudexor/workspace@3.18.0
  - @claudexor/control-api@3.18.0
  - @claudexor/acp-server@3.18.0
  - @claudexor/artifact-store@3.18.0
  - @claudexor/config@3.18.0
  - @claudexor/journal@3.18.0
  - @claudexor/schema@3.18.0
  - @claudexor/secrets@3.18.0
  - @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- Preserve native input-size refusals without account retries or unrelated quota resets, publish measured ASK input budgets, distinguish proven undelivered Codex model requests, and move large Claude and AGY inputs off process arguments.
- Updated dependencies
  - @claudexor/harness-codex@3.17.2
  - @claudexor/harness-claude@3.17.2
  - @claudexor/harness-agy@3.17.2
  - @claudexor/orchestrator@3.17.2
  - @claudexor/daemon@3.17.2
  - @claudexor/schema@3.17.2
  - @claudexor/acp-server@3.17.2
  - @claudexor/config@3.17.2
  - @claudexor/control-api@3.17.2
  - @claudexor/core@3.17.2
  - @claudexor/delivery@3.17.2
  - @claudexor/gateway@3.17.2
  - @claudexor/harness-cursor@3.17.2
  - @claudexor/harness-fake@3.17.2
  - @claudexor/harness-opencode@3.17.2
  - @claudexor/harness-raw-api@3.17.2
  - @claudexor/mcp-server@3.17.2
  - @claudexor/review@3.17.2
  - @claudexor/workspace@3.17.2
  - @claudexor/artifact-store@3.17.2
  - @claudexor/journal@3.17.2
  - @claudexor/secrets@3.17.2
  - @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- 72825b9: Resolve effort preferences at the final native route using the strongest supported level at or below a known request, with an explicitly recorded minimum or vendor-default omission when applicable. Preserve advertised future values, original preferences and model identities. Add shared typed effort evidence to model results and final attempt telemetry; keep adaptation disclosures in logs.

  Preserve strict legacy model results unless creation opts into `captureEffortEvidence=true`, binding that choice to idempotency while keeping exact stored bytes and digest acknowledgement. Keep effort verification metadata in negotiated account catalogs only. Refuse unplaceable effort without retrying another route, clean temporary Codex authorization on preparation exit, and describe prepared controls without claiming dispatch.

- Updated dependencies [72825b9]
  - @claudexor/schema@3.17.1
  - @claudexor/core@3.17.1
  - @claudexor/harness-codex@3.17.1
  - @claudexor/harness-claude@3.17.1
  - @claudexor/orchestrator@3.17.1
  - @claudexor/control-api@3.17.1
  - @claudexor/daemon@3.17.1
  - @claudexor/acp-server@3.17.1
  - @claudexor/config@3.17.1
  - @claudexor/delivery@3.17.1
  - @claudexor/gateway@3.17.1
  - @claudexor/harness-agy@3.17.1
  - @claudexor/harness-cursor@3.17.1
  - @claudexor/harness-fake@3.17.1
  - @claudexor/harness-opencode@3.17.1
  - @claudexor/harness-raw-api@3.17.1
  - @claudexor/mcp-server@3.17.1
  - @claudexor/review@3.17.1
  - @claudexor/workspace@3.17.1
  - @claudexor/artifact-store@3.17.1
  - @claudexor/journal@3.17.1
  - @claudexor/secrets@3.17.1
  - @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- Updated dependencies [092ec2b]
- Updated dependencies [951489f]
  - @claudexor/core@3.17.0
  - @claudexor/harness-claude@3.17.0
  - @claudexor/control-api@3.17.0
  - @claudexor/daemon@3.17.0
  - @claudexor/schema@3.17.0
  - @claudexor/delivery@3.17.0
  - @claudexor/gateway@3.17.0
  - @claudexor/harness-agy@3.17.0
  - @claudexor/harness-codex@3.17.0
  - @claudexor/harness-cursor@3.17.0
  - @claudexor/harness-fake@3.17.0
  - @claudexor/harness-opencode@3.17.0
  - @claudexor/harness-raw-api@3.17.0
  - @claudexor/orchestrator@3.17.0
  - @claudexor/review@3.17.0
  - @claudexor/workspace@3.17.0
  - @claudexor/acp-server@3.17.0
  - @claudexor/config@3.17.0
  - @claudexor/mcp-server@3.17.0
  - @claudexor/artifact-store@3.17.0
  - @claudexor/journal@3.17.0
  - @claudexor/secrets@3.17.0
  - @claudexor/util@3.17.0

## 3.16.0

### Minor Changes

- 788ddca: Add `POST /v2/runs/:id/messages`: a live message into a running run's active attempt with journal-first admission, typed outcomes (delivered, accepted, rejected, not_active, unsupported, delivery_unknown) plus reasons, and a key-required idempotent receipt. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in the agent-capability catalog.

### Patch Changes

- Updated dependencies [de234bd]
- Updated dependencies [788ddca]
  - @claudexor/harness-codex@3.16.0
  - @claudexor/schema@3.16.0
  - @claudexor/control-api@3.16.0
  - @claudexor/daemon@3.16.0
  - @claudexor/orchestrator@3.16.0
  - @claudexor/acp-server@3.16.0
  - @claudexor/config@3.16.0
  - @claudexor/core@3.16.0
  - @claudexor/delivery@3.16.0
  - @claudexor/gateway@3.16.0
  - @claudexor/harness-agy@3.16.0
  - @claudexor/harness-claude@3.16.0
  - @claudexor/harness-cursor@3.16.0
  - @claudexor/harness-fake@3.16.0
  - @claudexor/harness-opencode@3.16.0
  - @claudexor/harness-raw-api@3.16.0
  - @claudexor/mcp-server@3.16.0
  - @claudexor/review@3.16.0
  - @claudexor/workspace@3.16.0
  - @claudexor/artifact-store@3.16.0
  - @claudexor/journal@3.16.0
  - @claudexor/secrets@3.16.0
  - @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- On Windows the CLI exits with the status its command returned instead of aborting natively after printing valid output, and the Windows install smoke no longer trusts `claudexor doctor --json` output without checking its exit.

  The shared CLI exit path (`exitAfterOutputFlush` in `cli-io.ts`) still waits for stdout and stderr to drain, so large JSON projections are not truncated. On Windows it then sets `process.exitCode` and lets Node exit naturally: a forced `process.exit()` after `doctor`'s `fetch()` raced isolate teardown on Node 24.16, and libuv aborted with `UV_HANDLE_CLOSING` (0xC0000409, nodejs/node#56645; upstream fix nodejs/node#61999) after the JSON was already written. An unref'd one-second backstop still forces the exit when a stray handle keeps the loop alive. Linux and macOS keep the immediate exit. `scripts/windows-local-install-smoke.mjs` now fails when `doctor --json` exits non-zero or by signal before it reads the JSON, and the Windows CI lane runs the exit-path regression (`packages/cli/src/cli-io.test.ts`).
  - @claudexor/acp-server@3.15.1
  - @claudexor/artifact-store@3.15.1
  - @claudexor/config@3.15.1
  - @claudexor/control-api@3.15.1
  - @claudexor/core@3.15.1
  - @claudexor/daemon@3.15.1
  - @claudexor/delivery@3.15.1
  - @claudexor/gateway@3.15.1
  - @claudexor/harness-agy@3.15.1
  - @claudexor/harness-claude@3.15.1
  - @claudexor/harness-codex@3.15.1
  - @claudexor/harness-cursor@3.15.1
  - @claudexor/harness-fake@3.15.1
  - @claudexor/harness-opencode@3.15.1
  - @claudexor/harness-raw-api@3.15.1
  - @claudexor/journal@3.15.1
  - @claudexor/mcp-server@3.15.1
  - @claudexor/orchestrator@3.15.1
  - @claudexor/review@3.15.1
  - @claudexor/schema@3.15.1
  - @claudexor/secrets@3.15.1
  - @claudexor/util@3.15.1
  - @claudexor/workspace@3.15.1

## 3.15.0

### Minor Changes

- 3bc8af4: `claudexor harness install codex --target local` works on Windows, and doctor, login and runs resolve the image it installs.

  On Windows an npm global prefix holds only `.cmd`/sh/ps1 shims and no executable image, and Claudexor never spawns a harness through a shell (issue #191). The local target is therefore supported exactly where the pinned package yields a verified package-native image: `@openai/codex` resolves its `@openai/codex-win32-<arch>` platform package and executes `vendor/<triple>/bin/codex.exe`. Core's `runtime-env.ts` becomes the one owner of that layout (`npmGlobalPackagesDir`, `embeddedNpmCli`, `windowsNativeImageDir`, `managedWindowsNativeImageDirs`): the installer runs the embedded `node_modules/npm/bin/npm-cli.js` beside `node.exe`, forwards the Windows process-environment keys, anchors the managed root on the same `HOME` the harness PATH producer reads, and proves the image inside the prefix; the normalized harness PATH carries that image dir on win32 so every local surface resolves the same `codex.exe` by bare name. The receipt fields are unchanged. Claude, OpenCode, Cursor and Antigravity keep a typed `unsupported_platform` refusal on the Windows local target, now naming the exact reason; an unsupported architecture refuses the same way. The Windows CI lane installs the real pinned package on the exact embedded Node with no ambient node/npm and an isolated profile, then checks the receipt, direct and by-name `--version`, the idempotent recheck and `doctor --json` (`scripts/windows-local-install-smoke.mjs`). Linux and macOS behaviour is unchanged.

  Invariants: INV-067 (the same scoped env that spawns a run resolves the binary), INV-121/INV-122 (one layout owner reused by proof and PATH), INV-044 (typed refusals, no silent shim). No Bible change.

### Patch Changes

- Updated dependencies [3bc8af4]
  - @claudexor/core@3.15.0
  - @claudexor/daemon@3.15.0
  - @claudexor/delivery@3.15.0
  - @claudexor/gateway@3.15.0
  - @claudexor/harness-agy@3.15.0
  - @claudexor/harness-claude@3.15.0
  - @claudexor/harness-codex@3.15.0
  - @claudexor/harness-cursor@3.15.0
  - @claudexor/harness-fake@3.15.0
  - @claudexor/harness-opencode@3.15.0
  - @claudexor/harness-raw-api@3.15.0
  - @claudexor/orchestrator@3.15.0
  - @claudexor/review@3.15.0
  - @claudexor/workspace@3.15.0
  - @claudexor/control-api@3.15.0
  - @claudexor/acp-server@3.15.0
  - @claudexor/artifact-store@3.15.0
  - @claudexor/config@3.15.0
  - @claudexor/journal@3.15.0
  - @claudexor/mcp-server@3.15.0
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

- 2c024ac: Claude models are discovered from the installed binary instead of a shipped list (#338, #340).

  The claude adapter gains a live `models()`: the prompt-free `initialize` handshake of the installed `claude` binary (one stdin frame, exit on EOF, never `--model`, `--setting-sources ""`, `--strict-mcp-config`, model-override env scrubbed) answers the picker's selectors with their vendor-reported resolutions; the rows travel as `origin: live` with `resolved_model`, followed by the frozen `CLAUDE_KNOWN_MODELS` ids as `origin: hint` so presence never shrinks below the manifest. A `config_dir_login` profile is probed under its own config dir and keychain bridge, an `api_key`/`oauth_token` profile with its own credential in the env var its runs use under a scratch HOME (the account's own rows in `?view=accounts`, cache keyed by profile id, never by a secret); the unscoped listing is a credential-free binary probe under a scratch HOME with non-essential traffic off. The answer is total: a missing or failing binary yields the hint rows and the registry reports `source: manifest` with the frozen `verifiedAgainst` stamp rather than a live claim. One cached single-flight capture per (scope, binary identity) lives an hour (a minute for failures); `harnessBinaryIdentity` in core keys it and the `--help` effort memo by realpath, inode, size and mtime, so an in-place CLI update is re-read without a daemon restart; a run whose env patch carries a PATH has its effort ladder, readonly flag set and `--version` read from the binary that PATH selects. The manifest declares `model_inventory_absence: "advisory"` and freezes `known_models_verified_against` at the literal 2.1.261. `HarnessModel` gains optional `origin` and `resolved_model` (absent = live; producers that predate the field need no change); `claudexor models` prints resolutions and hint marks.

  Invariants: INV-104 governs the declaration (amended in the sibling commit); INV-020/INV-022 hold (both new fields have a producer and readers).

- 7e615b6: The Codex HTTP model transport declares its own verified client version when it reads an account's model catalog, instead of the managed-installer pin.

  The Codex backend filters `GET /backend-api/codex/models` by the `client_version` the caller declares: a model is listed only for clients at or above that model's minimum version. Claudexor's raw model transport sent the installer pin (`CODEX_VENDOR_CLI_VERSION`, 0.153.3), so a newly floored model such as `gpt-6-sol` was absent from the catalog and refused as `model_unavailable`, while the same account and the same request shape generated with it (issue #339). A release that only moved the installer therefore decided which models an account could see through this route.

  `CODEX_HTTP_CLIENT_VERSION` (0.156.1) is the version this release's catalog parser and Responses projection were verified against; it is raised to the installed Codex CLI's version when that is newer, never lowered, and an unparseable version falls back to the constant because the parameter is required. The value is memoised per binary identity, so an in-place CLI upgrade is seen on the next catalog read. The negotiated account view (`?view=accounts`) carries `clientVersion` and `clientVersionSource` per catalog (`verified_transport` or `installed_cli`; null for catalogs from an older engine) while the legacy `GET /model-sources/:id/models` keeps its pre-existing shape, and both membership refusals — account selection and invocation — name the declared version so a miss is not read as an account or login problem. The catalog stays strict: its rows are the request contract (efforts, service tiers, windows). A recorded fixture pair (`fixtures/models-http-0.153.3.json`, `models-http-0.156.1.json`) pins that every row present at both versions is identical and only `gpt-6-sol`/`gpt-6-luna` were added, with the default unchanged; bumping the constant re-records the pair.

  Invariants: INV-104 is unchanged (HTTP model operations stay strict against the account catalog, now read at a named client version). INV-020/INV-022 hold: the two schema fields are produced by the transport, read by both membership refusals (`describeCodexClientVersion`) and returned on the account-view wire. The managed installer pin keeps its two other meanings (install target, fixture/effort-snapshot stamp).

- Updated dependencies [2c024ac]
- Updated dependencies [7e615b6]
- Updated dependencies [fb42a94]
- Updated dependencies [7ab3c95]
  - @claudexor/harness-claude@3.14.0
  - @claudexor/core@3.14.0
  - @claudexor/schema@3.14.0
  - @claudexor/harness-codex@3.14.0
  - @claudexor/gateway@3.14.0
  - @claudexor/orchestrator@3.14.0
  - @claudexor/harness-cursor@3.14.0
  - @claudexor/daemon@3.14.0
  - @claudexor/delivery@3.14.0
  - @claudexor/harness-agy@3.14.0
  - @claudexor/harness-fake@3.14.0
  - @claudexor/harness-opencode@3.14.0
  - @claudexor/harness-raw-api@3.14.0
  - @claudexor/review@3.14.0
  - @claudexor/workspace@3.14.0
  - @claudexor/acp-server@3.14.0
  - @claudexor/config@3.14.0
  - @claudexor/control-api@3.14.0
  - @claudexor/mcp-server@3.14.0
  - @claudexor/artifact-store@3.14.0
  - @claudexor/journal@3.14.0
  - @claudexor/secrets@3.14.0
  - @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/acp-server@3.13.0
- @claudexor/artifact-store@3.13.0
- @claudexor/config@3.13.0
- @claudexor/control-api@3.13.0
- @claudexor/core@3.13.0
- @claudexor/daemon@3.13.0
- @claudexor/delivery@3.13.0
- @claudexor/gateway@3.13.0
- @claudexor/harness-agy@3.13.0
- @claudexor/harness-claude@3.13.0
- @claudexor/harness-codex@3.13.0
- @claudexor/harness-cursor@3.13.0
- @claudexor/harness-fake@3.13.0
- @claudexor/harness-opencode@3.13.0
- @claudexor/harness-raw-api@3.13.0
- @claudexor/journal@3.13.0
- @claudexor/mcp-server@3.13.0
- @claudexor/orchestrator@3.13.0
- @claudexor/review@3.13.0
- @claudexor/schema@3.13.0
- @claudexor/secrets@3.13.0
- @claudexor/util@3.13.0
- @claudexor/workspace@3.13.0

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
  - @claudexor/orchestrator@3.12.10
  - @claudexor/harness-codex@3.12.10
  - @claudexor/acp-server@3.12.10
  - @claudexor/config@3.12.10
  - @claudexor/control-api@3.12.10
  - @claudexor/daemon@3.12.10
  - @claudexor/delivery@3.12.10
  - @claudexor/gateway@3.12.10
  - @claudexor/harness-agy@3.12.10
  - @claudexor/harness-claude@3.12.10
  - @claudexor/harness-cursor@3.12.10
  - @claudexor/harness-fake@3.12.10
  - @claudexor/harness-opencode@3.12.10
  - @claudexor/harness-raw-api@3.12.10
  - @claudexor/mcp-server@3.12.10
  - @claudexor/review@3.12.10
  - @claudexor/workspace@3.12.10
  - @claudexor/artifact-store@3.12.10
  - @claudexor/journal@3.12.10
  - @claudexor/secrets@3.12.10
  - @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- Updated dependencies [125aea9]
  - @claudexor/schema@3.12.9
  - @claudexor/core@3.12.9
  - @claudexor/orchestrator@3.12.9
  - @claudexor/harness-codex@3.12.9
  - @claudexor/acp-server@3.12.9
  - @claudexor/config@3.12.9
  - @claudexor/control-api@3.12.9
  - @claudexor/daemon@3.12.9
  - @claudexor/delivery@3.12.9
  - @claudexor/gateway@3.12.9
  - @claudexor/harness-agy@3.12.9
  - @claudexor/harness-claude@3.12.9
  - @claudexor/harness-cursor@3.12.9
  - @claudexor/harness-fake@3.12.9
  - @claudexor/harness-opencode@3.12.9
  - @claudexor/harness-raw-api@3.12.9
  - @claudexor/mcp-server@3.12.9
  - @claudexor/review@3.12.9
  - @claudexor/workspace@3.12.9
  - @claudexor/artifact-store@3.12.9
  - @claudexor/journal@3.12.9
  - @claudexor/secrets@3.12.9
  - @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- Updated dependencies
  - @claudexor/harness-codex@3.12.8
  - @claudexor/acp-server@3.12.8
  - @claudexor/artifact-store@3.12.8
  - @claudexor/config@3.12.8
  - @claudexor/control-api@3.12.8
  - @claudexor/core@3.12.8
  - @claudexor/daemon@3.12.8
  - @claudexor/delivery@3.12.8
  - @claudexor/gateway@3.12.8
  - @claudexor/harness-agy@3.12.8
  - @claudexor/harness-claude@3.12.8
  - @claudexor/harness-cursor@3.12.8
  - @claudexor/harness-fake@3.12.8
  - @claudexor/harness-opencode@3.12.8
  - @claudexor/harness-raw-api@3.12.8
  - @claudexor/journal@3.12.8
  - @claudexor/mcp-server@3.12.8
  - @claudexor/orchestrator@3.12.8
  - @claudexor/review@3.12.8
  - @claudexor/schema@3.12.8
  - @claudexor/secrets@3.12.8
  - @claudexor/util@3.12.8
  - @claudexor/workspace@3.12.8

## 3.12.7

### Patch Changes

- Restore adapter-created nulls for optional review fields before original-schema validation, preserving the caller contract and substantive findings. Codex Responses failure evidence now records monotonic chunk timing and deterministic interrupted-stream diagnostics without adding automatic retries.
- Updated dependencies
  - @claudexor/harness-codex@3.12.7
  - @claudexor/orchestrator@3.12.7
  - @claudexor/schema@3.12.7
  - @claudexor/acp-server@3.12.7
  - @claudexor/config@3.12.7
  - @claudexor/control-api@3.12.7
  - @claudexor/core@3.12.7
  - @claudexor/daemon@3.12.7
  - @claudexor/delivery@3.12.7
  - @claudexor/gateway@3.12.7
  - @claudexor/harness-agy@3.12.7
  - @claudexor/harness-claude@3.12.7
  - @claudexor/harness-cursor@3.12.7
  - @claudexor/harness-fake@3.12.7
  - @claudexor/harness-opencode@3.12.7
  - @claudexor/harness-raw-api@3.12.7
  - @claudexor/mcp-server@3.12.7
  - @claudexor/review@3.12.7
  - @claudexor/workspace@3.12.7
  - @claudexor/artifact-store@3.12.7
  - @claudexor/journal@3.12.7
  - @claudexor/secrets@3.12.7
  - @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- Updated dependencies
  - @claudexor/harness-codex@3.12.6
  - @claudexor/acp-server@3.12.6
  - @claudexor/artifact-store@3.12.6
  - @claudexor/config@3.12.6
  - @claudexor/control-api@3.12.6
  - @claudexor/core@3.12.6
  - @claudexor/daemon@3.12.6
  - @claudexor/delivery@3.12.6
  - @claudexor/gateway@3.12.6
  - @claudexor/harness-agy@3.12.6
  - @claudexor/harness-claude@3.12.6
  - @claudexor/harness-cursor@3.12.6
  - @claudexor/harness-fake@3.12.6
  - @claudexor/harness-opencode@3.12.6
  - @claudexor/harness-raw-api@3.12.6
  - @claudexor/journal@3.12.6
  - @claudexor/mcp-server@3.12.6
  - @claudexor/orchestrator@3.12.6
  - @claudexor/review@3.12.6
  - @claudexor/schema@3.12.6
  - @claudexor/secrets@3.12.6
  - @claudexor/util@3.12.6
  - @claudexor/workspace@3.12.6

## 3.12.5

### Patch Changes

- State a served-model mismatch on a model operation as the typed `modelMismatch` result fact without changing its outcome, rank an account that recently answered a model's request with a different model after the other selectable accounts for later Auto selections (a 30-minute in-memory observation that never excludes an account, a pin or a preferred account), and send a turn the same account served with another model through its canonical content and tool calls instead of refusing the next request with `invalid_continuation`.
- Updated dependencies
  - @claudexor/schema@3.12.5
  - @claudexor/harness-codex@3.12.5
  - @claudexor/daemon@3.12.5
  - @claudexor/orchestrator@3.12.5
  - @claudexor/acp-server@3.12.5
  - @claudexor/config@3.12.5
  - @claudexor/control-api@3.12.5
  - @claudexor/core@3.12.5
  - @claudexor/delivery@3.12.5
  - @claudexor/gateway@3.12.5
  - @claudexor/harness-agy@3.12.5
  - @claudexor/harness-claude@3.12.5
  - @claudexor/harness-cursor@3.12.5
  - @claudexor/harness-fake@3.12.5
  - @claudexor/harness-opencode@3.12.5
  - @claudexor/harness-raw-api@3.12.5
  - @claudexor/mcp-server@3.12.5
  - @claudexor/review@3.12.5
  - @claudexor/workspace@3.12.5
  - @claudexor/artifact-store@3.12.5
  - @claudexor/journal@3.12.5
  - @claudexor/secrets@3.12.5
  - @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- 67c7a71: Use the shared harness environment for Codex model discovery and quota probes so GUI-launched installs can find the same CLI and Node runtime as sign-in and agent execution.
- Updated dependencies [67c7a71]
  - @claudexor/harness-codex@3.12.4
  - @claudexor/acp-server@3.12.4
  - @claudexor/artifact-store@3.12.4
  - @claudexor/config@3.12.4
  - @claudexor/control-api@3.12.4
  - @claudexor/core@3.12.4
  - @claudexor/daemon@3.12.4
  - @claudexor/delivery@3.12.4
  - @claudexor/gateway@3.12.4
  - @claudexor/harness-agy@3.12.4
  - @claudexor/harness-claude@3.12.4
  - @claudexor/harness-cursor@3.12.4
  - @claudexor/harness-fake@3.12.4
  - @claudexor/harness-opencode@3.12.4
  - @claudexor/harness-raw-api@3.12.4
  - @claudexor/journal@3.12.4
  - @claudexor/mcp-server@3.12.4
  - @claudexor/orchestrator@3.12.4
  - @claudexor/review@3.12.4
  - @claudexor/schema@3.12.4
  - @claudexor/secrets@3.12.4
  - @claudexor/util@3.12.4
  - @claudexor/workspace@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/acp-server@3.12.3
- @claudexor/artifact-store@3.12.3
- @claudexor/config@3.12.3
- @claudexor/control-api@3.12.3
- @claudexor/core@3.12.3
- @claudexor/daemon@3.12.3
- @claudexor/delivery@3.12.3
- @claudexor/gateway@3.12.3
- @claudexor/harness-agy@3.12.3
- @claudexor/harness-claude@3.12.3
- @claudexor/harness-codex@3.12.3
- @claudexor/harness-cursor@3.12.3
- @claudexor/harness-fake@3.12.3
- @claudexor/harness-opencode@3.12.3
- @claudexor/harness-raw-api@3.12.3
- @claudexor/journal@3.12.3
- @claudexor/mcp-server@3.12.3
- @claudexor/orchestrator@3.12.3
- @claudexor/review@3.12.3
- @claudexor/schema@3.12.3
- @claudexor/secrets@3.12.3
- @claudexor/util@3.12.3
- @claudexor/workspace@3.12.3

## 3.12.2

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.12.2
  - @claudexor/acp-server@3.12.2
  - @claudexor/config@3.12.2
  - @claudexor/control-api@3.12.2
  - @claudexor/core@3.12.2
  - @claudexor/daemon@3.12.2
  - @claudexor/delivery@3.12.2
  - @claudexor/gateway@3.12.2
  - @claudexor/harness-agy@3.12.2
  - @claudexor/harness-claude@3.12.2
  - @claudexor/harness-codex@3.12.2
  - @claudexor/harness-cursor@3.12.2
  - @claudexor/harness-fake@3.12.2
  - @claudexor/harness-opencode@3.12.2
  - @claudexor/harness-raw-api@3.12.2
  - @claudexor/mcp-server@3.12.2
  - @claudexor/orchestrator@3.12.2
  - @claudexor/review@3.12.2
  - @claudexor/workspace@3.12.2
  - @claudexor/artifact-store@3.12.2
  - @claudexor/journal@3.12.2
  - @claudexor/secrets@3.12.2
  - @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- Updated dependencies
  - @claudexor/daemon@3.12.1
  - @claudexor/control-api@3.12.1
  - @claudexor/schema@3.12.1
  - @claudexor/acp-server@3.12.1
  - @claudexor/config@3.12.1
  - @claudexor/core@3.12.1
  - @claudexor/delivery@3.12.1
  - @claudexor/gateway@3.12.1
  - @claudexor/harness-agy@3.12.1
  - @claudexor/harness-claude@3.12.1
  - @claudexor/harness-codex@3.12.1
  - @claudexor/harness-cursor@3.12.1
  - @claudexor/harness-fake@3.12.1
  - @claudexor/harness-opencode@3.12.1
  - @claudexor/harness-raw-api@3.12.1
  - @claudexor/mcp-server@3.12.1
  - @claudexor/orchestrator@3.12.1
  - @claudexor/review@3.12.1
  - @claudexor/workspace@3.12.1
  - @claudexor/artifact-store@3.12.1
  - @claudexor/journal@3.12.1
  - @claudexor/secrets@3.12.1
  - @claudexor/util@3.12.1

## 3.12.0

### Minor Changes

- 217d53f: The daemon stops writing dead history into its journal and forgets it on replay. Per-token harness deltas no longer reach the journal (the per-run event log and the live stream keep them), the journaled `run.created` carries the prompt's digest instead of its text, `command.updated` frames omit the immutable params, quota snapshots are journaled only when their evidence changes and the projection marker carries a digest, and the retained params of terminal commands are capped by a code constant. Every partition replays and compacts through the daemon's fold policy, so startup memory follows the retained state rather than the file (a resolved question and its request are forgotten together, so answering an already-resolved question after a restart reports `not_found` rather than `already_resolved` — both non-delivery statuses; within one process life `already_resolved` is unchanged); crash-GC reads project roots from the already prepared command projection instead of replaying the journal a second time, journaled run events are validated once per generation, and journal maintenance re-requests itself when the file crosses the threshold again while logging typed declines and `journal.records_retired` receipts. An engine from before this change refuses a served root loudly. A restart on an already-compacted partition no longer rewrites it to reclaim nothing, and the daemon reports its own memory (rss, heap, external) on the normal-admission line and on every maintenance receipt. Legacy `command.pruned` tombstones carry no run ids, so terminals of runs pruned before this release stay retained (none on the acceptance root); runs that never received a journaled terminal keep their pre-release progress frames until their command is pruned (then the tombstone's run_ids retire them — bounded by the 500 / 30-day / 256 MiB rule); two such runs hold about 3.1k `harness.event` frames on the acceptance root.

### Patch Changes

- Updated dependencies [217d53f]
- Updated dependencies [1b1476c]
  - @claudexor/daemon@3.12.0
  - @claudexor/schema@3.12.0
  - @claudexor/journal@3.12.0
  - @claudexor/acp-server@3.12.0
  - @claudexor/config@3.12.0
  - @claudexor/control-api@3.12.0
  - @claudexor/core@3.12.0
  - @claudexor/delivery@3.12.0
  - @claudexor/gateway@3.12.0
  - @claudexor/harness-agy@3.12.0
  - @claudexor/harness-claude@3.12.0
  - @claudexor/harness-codex@3.12.0
  - @claudexor/harness-cursor@3.12.0
  - @claudexor/harness-fake@3.12.0
  - @claudexor/harness-opencode@3.12.0
  - @claudexor/harness-raw-api@3.12.0
  - @claudexor/mcp-server@3.12.0
  - @claudexor/orchestrator@3.12.0
  - @claudexor/review@3.12.0
  - @claudexor/workspace@3.12.0
  - @claudexor/artifact-store@3.12.0
  - @claudexor/secrets@3.12.0
  - @claudexor/util@3.12.0

## 3.11.0

### Minor Changes

- Add advisory Standard, Fast and Economy processing with exact native precedence, account-scoped catalogs and honest observed service and cost evidence. Support ordinary folders through direct work or complete selected copies, retained binary file results, conflict-aware application and explicit discard.

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.11.0
  - @claudexor/acp-server@3.11.0
  - @claudexor/config@3.11.0
  - @claudexor/control-api@3.11.0
  - @claudexor/core@3.11.0
  - @claudexor/daemon@3.11.0
  - @claudexor/delivery@3.11.0
  - @claudexor/gateway@3.11.0
  - @claudexor/harness-agy@3.11.0
  - @claudexor/harness-claude@3.11.0
  - @claudexor/harness-codex@3.11.0
  - @claudexor/harness-cursor@3.11.0
  - @claudexor/harness-fake@3.11.0
  - @claudexor/harness-opencode@3.11.0
  - @claudexor/harness-raw-api@3.11.0
  - @claudexor/mcp-server@3.11.0
  - @claudexor/orchestrator@3.11.0
  - @claudexor/review@3.11.0
  - @claudexor/workspace@3.11.0
  - @claudexor/artifact-store@3.11.0
  - @claudexor/journal@3.11.0
  - @claudexor/secrets@3.11.0
  - @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- Model account selection now moves on to the next available account after any typed refusal from an account's model catalog, instead of ending the whole attempt unless the refusal was one of two named ones; an explicitly pinned account still refuses instead of rotating, and each account is tried at most once per attempt. When no account can serve the request, the reported reason is the one the accounts actually gave, so a request that failed because the catalogs were unreachable no longer says every account is out of subscription quota, and it reports no reset time. An account is recorded as busy until a given time only when the vendor itself named that reset time or retry delay.
  - @claudexor/acp-server@3.10.5
  - @claudexor/artifact-store@3.10.5
  - @claudexor/config@3.10.5
  - @claudexor/control-api@3.10.5
  - @claudexor/core@3.10.5
  - @claudexor/daemon@3.10.5
  - @claudexor/delivery@3.10.5
  - @claudexor/gateway@3.10.5
  - @claudexor/harness-agy@3.10.5
  - @claudexor/harness-claude@3.10.5
  - @claudexor/harness-codex@3.10.5
  - @claudexor/harness-cursor@3.10.5
  - @claudexor/harness-fake@3.10.5
  - @claudexor/harness-opencode@3.10.5
  - @claudexor/harness-raw-api@3.10.5
  - @claudexor/journal@3.10.5
  - @claudexor/mcp-server@3.10.5
  - @claudexor/orchestrator@3.10.5
  - @claudexor/review@3.10.5
  - @claudexor/schema@3.10.5
  - @claudexor/secrets@3.10.5
  - @claudexor/util@3.10.5
  - @claudexor/workspace@3.10.5

## 3.10.4

### Patch Changes

- Updated dependencies
  - @claudexor/schema@3.10.4
  - @claudexor/harness-codex@3.10.4
  - @claudexor/harness-claude@3.10.4
  - @claudexor/harness-cursor@3.10.4
  - @claudexor/orchestrator@3.10.4
  - @claudexor/control-api@3.10.4
  - @claudexor/acp-server@3.10.4
  - @claudexor/config@3.10.4
  - @claudexor/core@3.10.4
  - @claudexor/daemon@3.10.4
  - @claudexor/delivery@3.10.4
  - @claudexor/gateway@3.10.4
  - @claudexor/harness-agy@3.10.4
  - @claudexor/harness-fake@3.10.4
  - @claudexor/harness-opencode@3.10.4
  - @claudexor/harness-raw-api@3.10.4
  - @claudexor/mcp-server@3.10.4
  - @claudexor/review@3.10.4
  - @claudexor/workspace@3.10.4
  - @claudexor/artifact-store@3.10.4
  - @claudexor/journal@3.10.4
  - @claudexor/secrets@3.10.4
  - @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- Updated dependencies
  - @claudexor/harness-codex@3.10.3
  - @claudexor/acp-server@3.10.3
  - @claudexor/artifact-store@3.10.3
  - @claudexor/config@3.10.3
  - @claudexor/control-api@3.10.3
  - @claudexor/core@3.10.3
  - @claudexor/daemon@3.10.3
  - @claudexor/delivery@3.10.3
  - @claudexor/gateway@3.10.3
  - @claudexor/harness-agy@3.10.3
  - @claudexor/harness-claude@3.10.3
  - @claudexor/harness-cursor@3.10.3
  - @claudexor/harness-fake@3.10.3
  - @claudexor/harness-opencode@3.10.3
  - @claudexor/harness-raw-api@3.10.3
  - @claudexor/journal@3.10.3
  - @claudexor/mcp-server@3.10.3
  - @claudexor/orchestrator@3.10.3
  - @claudexor/review@3.10.3
  - @claudexor/schema@3.10.3
  - @claudexor/secrets@3.10.3
  - @claudexor/util@3.10.3
  - @claudexor/workspace@3.10.3

## 3.10.2

### Patch Changes

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
- Updated dependencies
  - @claudexor/journal@3.10.2
  - @claudexor/daemon@3.10.2
  - @claudexor/orchestrator@3.10.2
  - @claudexor/control-api@3.10.2
  - @claudexor/schema@3.10.2
  - @claudexor/acp-server@3.10.2
  - @claudexor/config@3.10.2
  - @claudexor/core@3.10.2
  - @claudexor/delivery@3.10.2
  - @claudexor/gateway@3.10.2
  - @claudexor/harness-agy@3.10.2
  - @claudexor/harness-claude@3.10.2
  - @claudexor/harness-codex@3.10.2
  - @claudexor/harness-cursor@3.10.2
  - @claudexor/harness-fake@3.10.2
  - @claudexor/harness-opencode@3.10.2
  - @claudexor/harness-raw-api@3.10.2
  - @claudexor/mcp-server@3.10.2
  - @claudexor/review@3.10.2
  - @claudexor/workspace@3.10.2
  - @claudexor/artifact-store@3.10.2
  - @claudexor/secrets@3.10.2
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- Keep Antigravity model and quota checks non-interactive by closing piped input instead of using a null device. Preserve ambiguous authentication timeouts as probe failures and expose failed refreshes alongside stale quota data.
- Updated dependencies
  - @claudexor/harness-agy@3.10.1
  - @claudexor/schema@3.10.1
  - @claudexor/acp-server@3.10.1
  - @claudexor/config@3.10.1
  - @claudexor/control-api@3.10.1
  - @claudexor/core@3.10.1
  - @claudexor/daemon@3.10.1
  - @claudexor/delivery@3.10.1
  - @claudexor/gateway@3.10.1
  - @claudexor/harness-claude@3.10.1
  - @claudexor/harness-codex@3.10.1
  - @claudexor/harness-cursor@3.10.1
  - @claudexor/harness-fake@3.10.1
  - @claudexor/harness-opencode@3.10.1
  - @claudexor/harness-raw-api@3.10.1
  - @claudexor/mcp-server@3.10.1
  - @claudexor/orchestrator@3.10.1
  - @claudexor/review@3.10.1
  - @claudexor/workspace@3.10.1
  - @claudexor/artifact-store@3.10.1
  - @claudexor/journal@3.10.1
  - @claudexor/secrets@3.10.1
  - @claudexor/util@3.10.1

## 3.10.0

### Minor Changes

- Add caller-owned Codex model operations through managed accounts shared with Agents, with exact model payloads, durable single-generation identity, result acknowledgement and typed outcome/cost evidence. Keep system prompts, conversation history and tool execution with the caller. Preserve unconfirmed setup termination during runtime replacement; a pre-permit failure without recorded process evidence remains unreconcilable and is disclosed rather than introducing a new journal format. Simplify contributor release review while retaining signed runtime manifests and exact candidate promotion.

### Patch Changes

- Updated dependencies
- Updated dependencies [dd518f0]
  - @claudexor/control-api@3.10.0
  - @claudexor/core@3.10.0
  - @claudexor/daemon@3.10.0
  - @claudexor/harness-codex@3.10.0
  - @claudexor/schema@3.10.0
  - @claudexor/journal@3.10.0
  - @claudexor/delivery@3.10.0
  - @claudexor/gateway@3.10.0
  - @claudexor/harness-agy@3.10.0
  - @claudexor/harness-claude@3.10.0
  - @claudexor/harness-cursor@3.10.0
  - @claudexor/harness-fake@3.10.0
  - @claudexor/harness-opencode@3.10.0
  - @claudexor/harness-raw-api@3.10.0
  - @claudexor/orchestrator@3.10.0
  - @claudexor/review@3.10.0
  - @claudexor/workspace@3.10.0
  - @claudexor/acp-server@3.10.0
  - @claudexor/config@3.10.0
  - @claudexor/mcp-server@3.10.0
  - @claudexor/artifact-store@3.10.0
  - @claudexor/secrets@3.10.0
  - @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- Make internal model review opt-in for ordinary Agent work, independently of executor selection. Preserve explicit panels, Best-of, and requested review cycles; persist intent separately from results and retain historical behavior on replay. Deliberately unreviewed changes remain normally applicable with honest Not reviewed status while required checks and patch integrity remain enforced. Expose the same choice through API, CLI, MCP, ACP, and the native composer.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [069c6e3]
  - @claudexor/schema@3.9.8
  - @claudexor/orchestrator@3.9.8
  - @claudexor/delivery@3.9.8
  - @claudexor/mcp-server@3.9.8
  - @claudexor/acp-server@3.9.8
  - @claudexor/harness-codex@3.9.8
  - @claudexor/harness-claude@3.9.8
  - @claudexor/config@3.9.8
  - @claudexor/control-api@3.9.8
  - @claudexor/core@3.9.8
  - @claudexor/daemon@3.9.8
  - @claudexor/gateway@3.9.8
  - @claudexor/harness-agy@3.9.8
  - @claudexor/harness-cursor@3.9.8
  - @claudexor/harness-fake@3.9.8
  - @claudexor/harness-opencode@3.9.8
  - @claudexor/harness-raw-api@3.9.8
  - @claudexor/review@3.9.8
  - @claudexor/workspace@3.9.8
  - @claudexor/artifact-store@3.9.8
  - @claudexor/journal@3.9.8
  - @claudexor/secrets@3.9.8
  - @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/acp-server@3.9.7
- @claudexor/artifact-store@3.9.7
- @claudexor/config@3.9.7
- @claudexor/control-api@3.9.7
- @claudexor/core@3.9.7
- @claudexor/daemon@3.9.7
- @claudexor/delivery@3.9.7
- @claudexor/gateway@3.9.7
- @claudexor/harness-agy@3.9.7
- @claudexor/harness-claude@3.9.7
- @claudexor/harness-codex@3.9.7
- @claudexor/harness-cursor@3.9.7
- @claudexor/harness-fake@3.9.7
- @claudexor/harness-opencode@3.9.7
- @claudexor/harness-raw-api@3.9.7
- @claudexor/journal@3.9.7
- @claudexor/mcp-server@3.9.7
- @claudexor/orchestrator@3.9.7
- @claudexor/review@3.9.7
- @claudexor/schema@3.9.7
- @claudexor/secrets@3.9.7
- @claudexor/util@3.9.7
- @claudexor/workspace@3.9.7

## 3.9.6

### Patch Changes

- 7e1269c: Background quota polling no longer lets one revoked, never-logged-in, or failing profile pin its vendor's healthy profiles to the 15-minute retry ceiling: a lane whose fresh evidence is about to expire renews on schedule even mid-ladder. The Claude OAuth source also remembers a proven vendor rejection per presented token and stops re-presenting it on background cycles — until the token changes, a login or profile change, an explicit refresh, or six hours, after which one remembered token is re-verified per cycle — so a rejected token reaches the vendor at most once per six hours instead of every cycle, removing the 401 storm behind the one-hour vendor 429 that blacked out every healthy sibling.
- Updated dependencies [dd02e0a]
- Updated dependencies [7e1269c]
  - @claudexor/workspace@3.9.6
  - @claudexor/daemon@3.9.6
  - @claudexor/delivery@3.9.6
  - @claudexor/orchestrator@3.9.6
  - @claudexor/review@3.9.6
  - @claudexor/control-api@3.9.6
  - @claudexor/acp-server@3.9.6
  - @claudexor/artifact-store@3.9.6
  - @claudexor/config@3.9.6
  - @claudexor/core@3.9.6
  - @claudexor/gateway@3.9.6
  - @claudexor/harness-agy@3.9.6
  - @claudexor/harness-claude@3.9.6
  - @claudexor/harness-codex@3.9.6
  - @claudexor/harness-cursor@3.9.6
  - @claudexor/harness-fake@3.9.6
  - @claudexor/harness-opencode@3.9.6
  - @claudexor/harness-raw-api@3.9.6
  - @claudexor/journal@3.9.6
  - @claudexor/mcp-server@3.9.6
  - @claudexor/schema@3.9.6
  - @claudexor/secrets@3.9.6
  - @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- 6e54444: Request background quota renewal on the last existing poll tick before primary evidence would become stale, while preserving current-time freshness and existing vendor pacing.
- Updated dependencies [6e54444]
  - @claudexor/daemon@3.9.5
  - @claudexor/acp-server@3.9.5
  - @claudexor/artifact-store@3.9.5
  - @claudexor/config@3.9.5
  - @claudexor/control-api@3.9.5
  - @claudexor/core@3.9.5
  - @claudexor/delivery@3.9.5
  - @claudexor/gateway@3.9.5
  - @claudexor/harness-agy@3.9.5
  - @claudexor/harness-claude@3.9.5
  - @claudexor/harness-codex@3.9.5
  - @claudexor/harness-cursor@3.9.5
  - @claudexor/harness-fake@3.9.5
  - @claudexor/harness-opencode@3.9.5
  - @claudexor/harness-raw-api@3.9.5
  - @claudexor/journal@3.9.5
  - @claudexor/mcp-server@3.9.5
  - @claudexor/orchestrator@3.9.5
  - @claudexor/review@3.9.5
  - @claudexor/schema@3.9.5
  - @claudexor/secrets@3.9.5
  - @claudexor/util@3.9.5
  - @claudexor/workspace@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/acp-server@3.9.4
- @claudexor/artifact-store@3.9.4
- @claudexor/config@3.9.4
- @claudexor/control-api@3.9.4
- @claudexor/core@3.9.4
- @claudexor/daemon@3.9.4
- @claudexor/delivery@3.9.4
- @claudexor/gateway@3.9.4
- @claudexor/harness-agy@3.9.4
- @claudexor/harness-claude@3.9.4
- @claudexor/harness-codex@3.9.4
- @claudexor/harness-cursor@3.9.4
- @claudexor/harness-fake@3.9.4
- @claudexor/harness-opencode@3.9.4
- @claudexor/harness-raw-api@3.9.4
- @claudexor/journal@3.9.4
- @claudexor/mcp-server@3.9.4
- @claudexor/orchestrator@3.9.4
- @claudexor/review@3.9.4
- @claudexor/schema@3.9.4
- @claudexor/secrets@3.9.4
- @claudexor/util@3.9.4
- @claudexor/workspace@3.9.4

## 3.9.3

### Patch Changes

- Preserve typed text-fragment metadata in delegated run timelines so hosts can join streamed words and whitespace without inserting event separators. Keep complete messages, tool events, final answers, and omission disclosures distinct.

  Allow release review by any two distinct approved model families on any harness, recording the actual model and harness while retaining exact-candidate evidence, independent reports, and signed attestation checks.

- Updated dependencies
  - @claudexor/schema@3.9.3
  - @claudexor/control-api@3.9.3
  - @claudexor/harness-cursor@3.9.3
  - @claudexor/acp-server@3.9.3
  - @claudexor/config@3.9.3
  - @claudexor/core@3.9.3
  - @claudexor/daemon@3.9.3
  - @claudexor/delivery@3.9.3
  - @claudexor/gateway@3.9.3
  - @claudexor/harness-agy@3.9.3
  - @claudexor/harness-claude@3.9.3
  - @claudexor/harness-codex@3.9.3
  - @claudexor/harness-fake@3.9.3
  - @claudexor/harness-opencode@3.9.3
  - @claudexor/harness-raw-api@3.9.3
  - @claudexor/mcp-server@3.9.3
  - @claudexor/orchestrator@3.9.3
  - @claudexor/review@3.9.3
  - @claudexor/workspace@3.9.3
  - @claudexor/artifact-store@3.9.3
  - @claudexor/journal@3.9.3
  - @claudexor/secrets@3.9.3
  - @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- 14e1dd3: Refresh expired Claude subscription credentials through Claude Code before reading quota, without sending a model prompt or taking custody of refresh tokens.
- Updated dependencies [14e1dd3]
  - @claudexor/harness-claude@3.9.2
  - @claudexor/acp-server@3.9.2
  - @claudexor/artifact-store@3.9.2
  - @claudexor/config@3.9.2
  - @claudexor/control-api@3.9.2
  - @claudexor/core@3.9.2
  - @claudexor/daemon@3.9.2
  - @claudexor/delivery@3.9.2
  - @claudexor/gateway@3.9.2
  - @claudexor/harness-agy@3.9.2
  - @claudexor/harness-codex@3.9.2
  - @claudexor/harness-cursor@3.9.2
  - @claudexor/harness-fake@3.9.2
  - @claudexor/harness-opencode@3.9.2
  - @claudexor/harness-raw-api@3.9.2
  - @claudexor/journal@3.9.2
  - @claudexor/mcp-server@3.9.2
  - @claudexor/orchestrator@3.9.2
  - @claudexor/review@3.9.2
  - @claudexor/schema@3.9.2
  - @claudexor/secrets@3.9.2
  - @claudexor/util@3.9.2
  - @claudexor/workspace@3.9.2

## 3.9.1

### Patch Changes

- 574711f: Keep refreshable Claude Code profiles signed in when an idle quota probe cannot prove their vendor-owned access token was fresh.
  - @claudexor/acp-server@3.9.1
  - @claudexor/artifact-store@3.9.1
  - @claudexor/config@3.9.1
  - @claudexor/control-api@3.9.1
  - @claudexor/core@3.9.1
  - @claudexor/daemon@3.9.1
  - @claudexor/delivery@3.9.1
  - @claudexor/gateway@3.9.1
  - @claudexor/harness-agy@3.9.1
  - @claudexor/harness-claude@3.9.1
  - @claudexor/harness-codex@3.9.1
  - @claudexor/harness-cursor@3.9.1
  - @claudexor/harness-fake@3.9.1
  - @claudexor/harness-opencode@3.9.1
  - @claudexor/harness-raw-api@3.9.1
  - @claudexor/journal@3.9.1
  - @claudexor/mcp-server@3.9.1
  - @claudexor/orchestrator@3.9.1
  - @claudexor/review@3.9.1
  - @claudexor/schema@3.9.1
  - @claudexor/secrets@3.9.1
  - @claudexor/util@3.9.1
  - @claudexor/workspace@3.9.1

## 3.9.0

### Minor Changes

- 69500f8: Foreground quota refreshes (POST /v2/quota and the atomic Accounts snapshot) now honor each vendor's poll rate-limit cooldown: a vendor that recently answered 429 is served from last-known registry data instead of a fresh fan-out, disclosed additively as `refresh_skipped` rows on the quota response.
- 11a785c: The `claudexor_accounts` MCP tool defaults to the server's cached credential-profiles listing instead of hardcoding the atomic snapshot; `fresh: true` opts into the expensive snapshot form (which itself now honors per-vendor rate-limit cooldowns). The tool description states the cost honestly and the output schema is the union of both forms.
- fd623ff: Parse Retry-After on oauth/usage 429 into a typed `rate_limited` quota absence carrying `retry_after_ms`, so poll pacing can honor the vendor floor instead of recording an undiagnosed refresh failure.
- 48ae659: Quota poll pacing is now per vendor lane: each vendor's refreshers own an independent completion-anchored backoff, a typed rate_limited absence arms a persisted vendor Retry-After floor in daemon-private pacer state (never the quota journal), and a daemon restart or credential change no longer resets the vendor cooldown into a 429 amplifier.
- 278e436: The claude oauth-usage candidate loop short-circuits after the first 429 (unprobed siblings get the honest distinct `probe_skipped_rate_limited` absence, never a fabricated `rate_limited`), and the agy profile fan-out is bounded to 3 concurrent vendor probes; the same short-circuit seam is in place for agy and arms once its vendor classifier learns to type 429s (today the live agy win is the concurrency bound).

### Patch Changes

- Updated dependencies [d9cccac]
- Updated dependencies [69500f8]
- Updated dependencies [e39c57b]
- Updated dependencies [11a785c]
- Updated dependencies [fd623ff]
- Updated dependencies [48ae659]
- Updated dependencies [278e436]
  - @claudexor/harness-cursor@3.9.0
  - @claudexor/schema@3.9.0
  - @claudexor/daemon@3.9.0
  - @claudexor/mcp-server@3.9.0
  - @claudexor/acp-server@3.9.0
  - @claudexor/config@3.9.0
  - @claudexor/control-api@3.9.0
  - @claudexor/core@3.9.0
  - @claudexor/delivery@3.9.0
  - @claudexor/gateway@3.9.0
  - @claudexor/harness-agy@3.9.0
  - @claudexor/harness-claude@3.9.0
  - @claudexor/harness-codex@3.9.0
  - @claudexor/harness-fake@3.9.0
  - @claudexor/harness-opencode@3.9.0
  - @claudexor/harness-raw-api@3.9.0
  - @claudexor/orchestrator@3.9.0
  - @claudexor/review@3.9.0
  - @claudexor/workspace@3.9.0
  - @claudexor/artifact-store@3.9.0
  - @claudexor/journal@3.9.0
  - @claudexor/secrets@3.9.0
  - @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- Updated dependencies
  - @claudexor/orchestrator@3.8.4
  - @claudexor/acp-server@3.8.4
  - @claudexor/artifact-store@3.8.4
  - @claudexor/config@3.8.4
  - @claudexor/control-api@3.8.4
  - @claudexor/core@3.8.4
  - @claudexor/daemon@3.8.4
  - @claudexor/delivery@3.8.4
  - @claudexor/gateway@3.8.4
  - @claudexor/harness-agy@3.8.4
  - @claudexor/harness-claude@3.8.4
  - @claudexor/harness-codex@3.8.4
  - @claudexor/harness-cursor@3.8.4
  - @claudexor/harness-fake@3.8.4
  - @claudexor/harness-opencode@3.8.4
  - @claudexor/harness-raw-api@3.8.4
  - @claudexor/journal@3.8.4
  - @claudexor/mcp-server@3.8.4
  - @claudexor/review@3.8.4
  - @claudexor/schema@3.8.4
  - @claudexor/secrets@3.8.4
  - @claudexor/util@3.8.4
  - @claudexor/workspace@3.8.4

## 3.8.3

### Patch Changes

- Updated dependencies [16f0c27]
  - @claudexor/journal@3.8.3
  - @claudexor/daemon@3.8.3
  - @claudexor/acp-server@3.8.3
  - @claudexor/artifact-store@3.8.3
  - @claudexor/config@3.8.3
  - @claudexor/control-api@3.8.3
  - @claudexor/core@3.8.3
  - @claudexor/delivery@3.8.3
  - @claudexor/gateway@3.8.3
  - @claudexor/harness-agy@3.8.3
  - @claudexor/harness-claude@3.8.3
  - @claudexor/harness-codex@3.8.3
  - @claudexor/harness-cursor@3.8.3
  - @claudexor/harness-fake@3.8.3
  - @claudexor/harness-opencode@3.8.3
  - @claudexor/harness-raw-api@3.8.3
  - @claudexor/mcp-server@3.8.3
  - @claudexor/orchestrator@3.8.3
  - @claudexor/review@3.8.3
  - @claudexor/schema@3.8.3
  - @claudexor/secrets@3.8.3
  - @claudexor/util@3.8.3
  - @claudexor/workspace@3.8.3

## 3.8.2

### Patch Changes

- fc15ea8: Keep transient Claude native auth-status transport failures typed as unknown,
  with bounded retry and last-known-good disclosure instead of a false logout.
- Updated dependencies [fc15ea8]
  - @claudexor/harness-claude@3.8.2
  - @claudexor/acp-server@3.8.2
  - @claudexor/artifact-store@3.8.2
  - @claudexor/config@3.8.2
  - @claudexor/control-api@3.8.2
  - @claudexor/core@3.8.2
  - @claudexor/daemon@3.8.2
  - @claudexor/delivery@3.8.2
  - @claudexor/gateway@3.8.2
  - @claudexor/harness-agy@3.8.2
  - @claudexor/harness-codex@3.8.2
  - @claudexor/harness-cursor@3.8.2
  - @claudexor/harness-fake@3.8.2
  - @claudexor/harness-opencode@3.8.2
  - @claudexor/harness-raw-api@3.8.2
  - @claudexor/journal@3.8.2
  - @claudexor/mcp-server@3.8.2
  - @claudexor/orchestrator@3.8.2
  - @claudexor/review@3.8.2
  - @claudexor/schema@3.8.2
  - @claudexor/secrets@3.8.2
  - @claudexor/util@3.8.2
  - @claudexor/workspace@3.8.2

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
- Updated dependencies [39dae8d]
- Updated dependencies [2794ec7]
  - @claudexor/harness-agy@3.8.1
  - @claudexor/core@3.8.1
  - @claudexor/schema@3.8.1
  - @claudexor/util@3.8.1
  - @claudexor/daemon@3.8.1
  - @claudexor/orchestrator@3.8.1
  - @claudexor/control-api@3.8.1
  - @claudexor/workspace@3.8.1
  - @claudexor/mcp-server@3.8.1
  - @claudexor/harness-claude@3.8.1
  - @claudexor/harness-codex@3.8.1
  - @claudexor/harness-cursor@3.8.1
  - @claudexor/harness-opencode@3.8.1
  - @claudexor/delivery@3.8.1
  - @claudexor/gateway@3.8.1
  - @claudexor/harness-fake@3.8.1
  - @claudexor/harness-raw-api@3.8.1
  - @claudexor/review@3.8.1
  - @claudexor/acp-server@3.8.1
  - @claudexor/config@3.8.1
  - @claudexor/artifact-store@3.8.1
  - @claudexor/journal@3.8.1
  - @claudexor/secrets@3.8.1

## 3.8.0

### Patch Changes

- 6054b7d: Make credential-profile custody and managed setup login platform-aware, with an exact Windows Antigravity one-binding policy, vendor-proven doctor/quota results, durable ambiguity handling, and host-resolved terminal capability projection.
- Updated dependencies [6054b7d]
  - @claudexor/schema@3.8.0
  - @claudexor/core@3.8.0
  - @claudexor/daemon@3.8.0
  - @claudexor/orchestrator@3.8.0
  - @claudexor/harness-agy@3.8.0
  - @claudexor/harness-claude@3.8.0
  - @claudexor/harness-codex@3.8.0
  - @claudexor/harness-cursor@3.8.0
  - @claudexor/acp-server@3.8.0
  - @claudexor/config@3.8.0
  - @claudexor/control-api@3.8.0
  - @claudexor/delivery@3.8.0
  - @claudexor/gateway@3.8.0
  - @claudexor/harness-fake@3.8.0
  - @claudexor/harness-opencode@3.8.0
  - @claudexor/harness-raw-api@3.8.0
  - @claudexor/mcp-server@3.8.0
  - @claudexor/review@3.8.0
  - @claudexor/workspace@3.8.0
  - @claudexor/artifact-store@3.8.0
  - @claudexor/journal@3.8.0
  - @claudexor/secrets@3.8.0
  - @claudexor/util@3.8.0

## 3.7.0

### Minor Changes

- `claudexor harness install` gains an explicit `--target local`: the vendor CLI
  is installed into the managed toolchain root that local binary resolution and
  confinement already read, serialized by a cross-process install lease, and
  proved afterwards by resolving the launcher and executing its `--version`. The
  watched remote flow is unchanged. The signed runtime closure now also carries
  `claudexor.bundle.cjs`, so an embedding host can invoke that exact reviewed CLI.

### Patch Changes

- @claudexor/acp-server@3.7.0
- @claudexor/artifact-store@3.7.0
- @claudexor/config@3.7.0
- @claudexor/control-api@3.7.0
- @claudexor/core@3.7.0
- @claudexor/daemon@3.7.0
- @claudexor/delivery@3.7.0
- @claudexor/gateway@3.7.0
- @claudexor/harness-agy@3.7.0
- @claudexor/harness-claude@3.7.0
- @claudexor/harness-codex@3.7.0
- @claudexor/harness-cursor@3.7.0
- @claudexor/harness-fake@3.7.0
- @claudexor/harness-opencode@3.7.0
- @claudexor/harness-raw-api@3.7.0
- @claudexor/journal@3.7.0
- @claudexor/mcp-server@3.7.0
- @claudexor/orchestrator@3.7.0
- @claudexor/review@3.7.0
- @claudexor/schema@3.7.0
- @claudexor/secrets@3.7.0
- @claudexor/util@3.7.0
- @claudexor/workspace@3.7.0

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
  - @claudexor/orchestrator@3.6.0
  - @claudexor/daemon@3.6.0
  - @claudexor/control-api@3.6.0
  - @claudexor/workspace@3.6.0
  - @claudexor/harness-claude@3.6.0
  - @claudexor/harness-codex@3.6.0
  - @claudexor/harness-cursor@3.6.0
  - @claudexor/acp-server@3.6.0
  - @claudexor/config@3.6.0
  - @claudexor/core@3.6.0
  - @claudexor/delivery@3.6.0
  - @claudexor/gateway@3.6.0
  - @claudexor/harness-agy@3.6.0
  - @claudexor/harness-fake@3.6.0
  - @claudexor/harness-opencode@3.6.0
  - @claudexor/harness-raw-api@3.6.0
  - @claudexor/mcp-server@3.6.0
  - @claudexor/review@3.6.0
  - @claudexor/artifact-store@3.6.0
  - @claudexor/journal@3.6.0
  - @claudexor/secrets@3.6.0
  - @claudexor/util@3.6.0

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

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/harness-agy@3.5.0
  - @claudexor/util@3.5.0
  - @claudexor/acp-server@3.5.0
  - @claudexor/artifact-store@3.5.0
  - @claudexor/config@3.5.0
  - @claudexor/control-api@3.5.0
  - @claudexor/core@3.5.0
  - @claudexor/daemon@3.5.0
  - @claudexor/delivery@3.5.0
  - @claudexor/harness-claude@3.5.0
  - @claudexor/harness-codex@3.5.0
  - @claudexor/harness-cursor@3.5.0
  - @claudexor/harness-fake@3.5.0
  - @claudexor/harness-opencode@3.5.0
  - @claudexor/harness-raw-api@3.5.0
  - @claudexor/journal@3.5.0
  - @claudexor/mcp-server@3.5.0
  - @claudexor/orchestrator@3.5.0
  - @claudexor/review@3.5.0
  - @claudexor/schema@3.5.0
  - @claudexor/secrets@3.5.0
  - @claudexor/workspace@3.5.0
  - @claudexor/gateway@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/acp-server@3.4.2
- @claudexor/artifact-store@3.4.2
- @claudexor/config@3.4.2
- @claudexor/control-api@3.4.2
- @claudexor/core@3.4.2
- @claudexor/daemon@3.4.2
- @claudexor/delivery@3.4.2
- @claudexor/gateway@3.4.2
- @claudexor/harness-claude@3.4.2
- @claudexor/harness-codex@3.4.2
- @claudexor/harness-cursor@3.4.2
- @claudexor/harness-fake@3.4.2
- @claudexor/harness-opencode@3.4.2
- @claudexor/harness-raw-api@3.4.2
- @claudexor/journal@3.4.2
- @claudexor/mcp-server@3.4.2
- @claudexor/orchestrator@3.4.2
- @claudexor/review@3.4.2
- @claudexor/schema@3.4.2
- @claudexor/secrets@3.4.2
- @claudexor/util@3.4.2
- @claudexor/workspace@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/acp-server@3.4.1
- @claudexor/artifact-store@3.4.1
- @claudexor/config@3.4.1
- @claudexor/control-api@3.4.1
- @claudexor/core@3.4.1
- @claudexor/daemon@3.4.1
- @claudexor/delivery@3.4.1
- @claudexor/gateway@3.4.1
- @claudexor/harness-claude@3.4.1
- @claudexor/harness-codex@3.4.1
- @claudexor/harness-cursor@3.4.1
- @claudexor/harness-fake@3.4.1
- @claudexor/harness-opencode@3.4.1
- @claudexor/harness-raw-api@3.4.1
- @claudexor/journal@3.4.1
- @claudexor/mcp-server@3.4.1
- @claudexor/orchestrator@3.4.1
- @claudexor/review@3.4.1
- @claudexor/schema@3.4.1
- @claudexor/secrets@3.4.1
- @claudexor/util@3.4.1
- @claudexor/workspace@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/acp-server@3.4.0
- @claudexor/artifact-store@3.4.0
- @claudexor/config@3.4.0
- @claudexor/control-api@3.4.0
- @claudexor/core@3.4.0
- @claudexor/daemon@3.4.0
- @claudexor/delivery@3.4.0
- @claudexor/gateway@3.4.0
- @claudexor/harness-claude@3.4.0
- @claudexor/harness-codex@3.4.0
- @claudexor/harness-cursor@3.4.0
- @claudexor/harness-fake@3.4.0
- @claudexor/harness-opencode@3.4.0
- @claudexor/harness-raw-api@3.4.0
- @claudexor/journal@3.4.0
- @claudexor/mcp-server@3.4.0
- @claudexor/orchestrator@3.4.0
- @claudexor/review@3.4.0
- @claudexor/schema@3.4.0
- @claudexor/secrets@3.4.0
- @claudexor/util@3.4.0
- @claudexor/workspace@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/acp-server@3.3.16
- @claudexor/artifact-store@3.3.16
- @claudexor/config@3.3.16
- @claudexor/control-api@3.3.16
- @claudexor/core@3.3.16
- @claudexor/daemon@3.3.16
- @claudexor/delivery@3.3.16
- @claudexor/gateway@3.3.16
- @claudexor/harness-claude@3.3.16
- @claudexor/harness-codex@3.3.16
- @claudexor/harness-cursor@3.3.16
- @claudexor/harness-fake@3.3.16
- @claudexor/harness-opencode@3.3.16
- @claudexor/harness-raw-api@3.3.16
- @claudexor/journal@3.3.16
- @claudexor/mcp-server@3.3.16
- @claudexor/orchestrator@3.3.16
- @claudexor/review@3.3.16
- @claudexor/schema@3.3.16
- @claudexor/secrets@3.3.16
- @claudexor/util@3.3.16
- @claudexor/workspace@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/acp-server@3.3.15
- @claudexor/artifact-store@3.3.15
- @claudexor/config@3.3.15
- @claudexor/control-api@3.3.15
- @claudexor/core@3.3.15
- @claudexor/daemon@3.3.15
- @claudexor/delivery@3.3.15
- @claudexor/gateway@3.3.15
- @claudexor/harness-claude@3.3.15
- @claudexor/harness-codex@3.3.15
- @claudexor/harness-cursor@3.3.15
- @claudexor/harness-fake@3.3.15
- @claudexor/harness-opencode@3.3.15
- @claudexor/harness-raw-api@3.3.15
- @claudexor/journal@3.3.15
- @claudexor/mcp-server@3.3.15
- @claudexor/orchestrator@3.3.15
- @claudexor/review@3.3.15
- @claudexor/schema@3.3.15
- @claudexor/secrets@3.3.15
- @claudexor/util@3.3.15
- @claudexor/workspace@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/acp-server@3.3.14
- @claudexor/artifact-store@3.3.14
- @claudexor/config@3.3.14
- @claudexor/control-api@3.3.14
- @claudexor/core@3.3.14
- @claudexor/daemon@3.3.14
- @claudexor/delivery@3.3.14
- @claudexor/gateway@3.3.14
- @claudexor/harness-claude@3.3.14
- @claudexor/harness-codex@3.3.14
- @claudexor/harness-cursor@3.3.14
- @claudexor/harness-fake@3.3.14
- @claudexor/harness-opencode@3.3.14
- @claudexor/harness-raw-api@3.3.14
- @claudexor/journal@3.3.14
- @claudexor/mcp-server@3.3.14
- @claudexor/orchestrator@3.3.14
- @claudexor/review@3.3.14
- @claudexor/schema@3.3.14
- @claudexor/secrets@3.3.14
- @claudexor/util@3.3.14
- @claudexor/workspace@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/acp-server@3.3.13
- @claudexor/artifact-store@3.3.13
- @claudexor/config@3.3.13
- @claudexor/control-api@3.3.13
- @claudexor/core@3.3.13
- @claudexor/daemon@3.3.13
- @claudexor/delivery@3.3.13
- @claudexor/gateway@3.3.13
- @claudexor/harness-claude@3.3.13
- @claudexor/harness-codex@3.3.13
- @claudexor/harness-cursor@3.3.13
- @claudexor/harness-fake@3.3.13
- @claudexor/harness-opencode@3.3.13
- @claudexor/harness-raw-api@3.3.13
- @claudexor/journal@3.3.13
- @claudexor/mcp-server@3.3.13
- @claudexor/orchestrator@3.3.13
- @claudexor/review@3.3.13
- @claudexor/schema@3.3.13
- @claudexor/secrets@3.3.13
- @claudexor/util@3.3.13
- @claudexor/workspace@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/acp-server@3.3.12
- @claudexor/artifact-store@3.3.12
- @claudexor/config@3.3.12
- @claudexor/control-api@3.3.12
- @claudexor/core@3.3.12
- @claudexor/daemon@3.3.12
- @claudexor/delivery@3.3.12
- @claudexor/gateway@3.3.12
- @claudexor/harness-claude@3.3.12
- @claudexor/harness-codex@3.3.12
- @claudexor/harness-cursor@3.3.12
- @claudexor/harness-fake@3.3.12
- @claudexor/harness-opencode@3.3.12
- @claudexor/harness-raw-api@3.3.12
- @claudexor/journal@3.3.12
- @claudexor/mcp-server@3.3.12
- @claudexor/orchestrator@3.3.12
- @claudexor/review@3.3.12
- @claudexor/schema@3.3.12
- @claudexor/secrets@3.3.12
- @claudexor/util@3.3.12
- @claudexor/workspace@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/acp-server@3.3.0
- @claudexor/artifact-store@3.3.0
- @claudexor/config@3.3.0
- @claudexor/control-api@3.3.0
- @claudexor/core@3.3.0
- @claudexor/daemon@3.3.0
- @claudexor/delivery@3.3.0
- @claudexor/gateway@3.3.0
- @claudexor/harness-claude@3.3.0
- @claudexor/harness-codex@3.3.0
- @claudexor/harness-cursor@3.3.0
- @claudexor/harness-fake@3.3.0
- @claudexor/harness-opencode@3.3.0
- @claudexor/harness-raw-api@3.3.0
- @claudexor/journal@3.3.0
- @claudexor/mcp-server@3.3.0
- @claudexor/orchestrator@3.3.0
- @claudexor/review@3.3.0
- @claudexor/schema@3.3.0
- @claudexor/secrets@3.3.0
- @claudexor/util@3.3.0
- @claudexor/workspace@3.3.0

## 3.2.1

### Patch Changes

- Preserve known Claude OAuth model scope in quota snapshots, keep unknown scope account-wide, and project native-default account routing without treating one scoped model limit as global.
- @claudexor/acp-server@3.2.1
- @claudexor/artifact-store@3.2.1
- @claudexor/config@3.2.1
- @claudexor/control-api@3.2.1
- @claudexor/core@3.2.1
- @claudexor/daemon@3.2.1
- @claudexor/delivery@3.2.1
- @claudexor/gateway@3.2.1
- @claudexor/harness-claude@3.2.1
- @claudexor/harness-codex@3.2.1
- @claudexor/harness-cursor@3.2.1
- @claudexor/harness-fake@3.2.1
- @claudexor/harness-opencode@3.2.1
- @claudexor/harness-raw-api@3.2.1
- @claudexor/journal@3.2.1
- @claudexor/mcp-server@3.2.1
- @claudexor/orchestrator@3.2.1
- @claudexor/review@3.2.1
- @claudexor/schema@3.2.1
- @claudexor/secrets@3.2.1
- @claudexor/util@3.2.1
- @claudexor/workspace@3.2.1

## 3.2.0

### Patch Changes

- Make local and remote runtime activation and rollback use daemon-owned atomic
  run/setup admission fencing while preserving explicit operator shutdown
  semantics.
- Keep an extended remote client-PTY login attachable after its original
  deadline without rewriting its sealed authorization; the daemon-owned job
  deadline remains the permit authority.
- Align Plan attachments, per-command flag ownership, location-scoped settings and accounts, durable refused-turn retry, Git applicability, canonical terminal output, and Settings validation envelopes with the control-plane contracts.
- Parse TTY Plan and interaction choices with one exact numeric grammar, keeping
  numeric-prefixed prose and invalid multi-picks as the user's full text.
- Validate successful run-detail responses, redact degraded MCP/ACP diagnostics,
  scrub vendor-installer child environments, and keep the machine-actionable
  Codex login fallback bound to the server-owned credential profile.
- @claudexor/acp-server@3.2.0
- @claudexor/artifact-store@3.2.0
- @claudexor/config@3.2.0
- @claudexor/control-api@3.2.0
- @claudexor/core@3.2.0
- @claudexor/daemon@3.2.0
- @claudexor/delivery@3.2.0
- @claudexor/gateway@3.2.0
- @claudexor/harness-claude@3.2.0
- @claudexor/harness-codex@3.2.0
- @claudexor/harness-cursor@3.2.0
- @claudexor/harness-fake@3.2.0
- @claudexor/harness-opencode@3.2.0
- @claudexor/harness-raw-api@3.2.0
- @claudexor/journal@3.2.0
- @claudexor/mcp-server@3.2.0
- @claudexor/orchestrator@3.2.0
- @claudexor/review@3.2.0
- @claudexor/schema@3.2.0
- @claudexor/secrets@3.2.0
- @claudexor/util@3.2.0
- @claudexor/workspace@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Make delegated child questions answerable in the macOS conversation, show the exact requested/effective/used/reason receipt and lineage in run details, and keep the packaged daemon entry executable through canonical macOS temporary-path aliases used by candidate verification.
- Updated dependencies
  - @claudexor/control-api@3.1.2
  - @claudexor/core@3.1.2
  - @claudexor/daemon@3.1.2
  - @claudexor/harness-claude@3.1.2
  - @claudexor/harness-codex@3.1.2
  - @claudexor/mcp-server@3.1.2
  - @claudexor/orchestrator@3.1.2
  - @claudexor/schema@3.1.2
  - @claudexor/delivery@3.1.2
  - @claudexor/gateway@3.1.2
  - @claudexor/harness-cursor@3.1.2
  - @claudexor/harness-fake@3.1.2
  - @claudexor/harness-opencode@3.1.2
  - @claudexor/harness-raw-api@3.1.2
  - @claudexor/review@3.1.2
  - @claudexor/workspace@3.1.2
  - @claudexor/acp-server@3.1.2
  - @claudexor/config@3.1.2
  - @claudexor/artifact-store@3.1.2
  - @claudexor/journal@3.1.2
  - @claudexor/secrets@3.1.2
  - @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- Exact retry on a pre-start terminal run answers with its typed refusal (a 403,
  not a 202 handle), and the CLI retry and run-again paths read the refusal's
  actual problem message instead of an `error` field the daemon never serves.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @claudexor/core@3.1.1
  - @claudexor/orchestrator@3.1.1
  - @claudexor/review@3.1.1
  - @claudexor/control-api@3.1.1
  - @claudexor/harness-claude@3.1.1
  - @claudexor/harness-codex@3.1.1
  - @claudexor/schema@3.1.1
  - @claudexor/mcp-server@3.1.1
  - @claudexor/daemon@3.1.1
  - @claudexor/delivery@3.1.1
  - @claudexor/gateway@3.1.1
  - @claudexor/harness-cursor@3.1.1
  - @claudexor/harness-fake@3.1.1
  - @claudexor/harness-opencode@3.1.1
  - @claudexor/harness-raw-api@3.1.1
  - @claudexor/workspace@3.1.1
  - @claudexor/acp-server@3.1.1
  - @claudexor/config@3.1.1
  - @claudexor/artifact-store@3.1.1
  - @claudexor/journal@3.1.1
  - @claudexor/secrets@3.1.1
  - @claudexor/util@3.1.1

## 3.1.0

### Minor Changes

- c3b7ece: Support declared JSON Schema draft-07 and draft 2020-12 output contracts, publish the supported dialect catalog, and record the selected dialect plus stable schema hash in structured-output receipts. Local JSON Pointer references are inlined only for native provider transport while the original schema remains the validation authority.

### Patch Changes

- Updated dependencies [c3b7ece]
- Updated dependencies [6e36993]
  - @claudexor/schema@3.1.0
  - @claudexor/orchestrator@3.1.0
  - @claudexor/control-api@3.1.0
  - @claudexor/core@3.1.0
  - @claudexor/harness-codex@3.1.0
  - @claudexor/acp-server@3.1.0
  - @claudexor/config@3.1.0
  - @claudexor/daemon@3.1.0
  - @claudexor/delivery@3.1.0
  - @claudexor/gateway@3.1.0
  - @claudexor/harness-claude@3.1.0
  - @claudexor/harness-cursor@3.1.0
  - @claudexor/harness-fake@3.1.0
  - @claudexor/harness-opencode@3.1.0
  - @claudexor/harness-raw-api@3.1.0
  - @claudexor/mcp-server@3.1.0
  - @claudexor/review@3.1.0
  - @claudexor/workspace@3.1.0
  - @claudexor/artifact-store@3.1.0
  - @claudexor/journal@3.1.0
  - @claudexor/secrets@3.1.0
  - @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/acp-server@3.0.3
- @claudexor/artifact-store@3.0.3
- @claudexor/config@3.0.3
- @claudexor/control-api@3.0.3
- @claudexor/core@3.0.3
- @claudexor/daemon@3.0.3
- @claudexor/delivery@3.0.3
- @claudexor/gateway@3.0.3
- @claudexor/harness-claude@3.0.3
- @claudexor/harness-codex@3.0.3
- @claudexor/harness-cursor@3.0.3
- @claudexor/harness-fake@3.0.3
- @claudexor/harness-opencode@3.0.3
- @claudexor/harness-raw-api@3.0.3
- @claudexor/journal@3.0.3
- @claudexor/mcp-server@3.0.3
- @claudexor/orchestrator@3.0.3
- @claudexor/review@3.0.3
- @claudexor/schema@3.0.3
- @claudexor/secrets@3.0.3
- @claudexor/util@3.0.3
- @claudexor/workspace@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/acp-server@3.0.0
- @claudexor/artifact-store@3.0.0
- @claudexor/config@3.0.0
- @claudexor/control-api@3.0.0
- @claudexor/core@3.0.0
- @claudexor/daemon@3.0.0
- @claudexor/delivery@3.0.0
- @claudexor/gateway@3.0.0
- @claudexor/harness-claude@3.0.0
- @claudexor/harness-codex@3.0.0
- @claudexor/harness-cursor@3.0.0
- @claudexor/harness-fake@3.0.0
- @claudexor/harness-opencode@3.0.0
- @claudexor/harness-raw-api@3.0.0
- @claudexor/journal@3.0.0
- @claudexor/mcp-server@3.0.0
- @claudexor/orchestrator@3.0.0
- @claudexor/review@3.0.0
- @claudexor/schema@3.0.0
- @claudexor/secrets@3.0.0
- @claudexor/util@3.0.0
- @claudexor/workspace@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/acp-server@2.1.3
- @claudexor/artifact-store@2.1.3
- @claudexor/config@2.1.3
- @claudexor/control-api@2.1.3
- @claudexor/core@2.1.3
- @claudexor/daemon@2.1.3
- @claudexor/delivery@2.1.3
- @claudexor/gateway@2.1.3
- @claudexor/harness-claude@2.1.3
- @claudexor/harness-codex@2.1.3
- @claudexor/harness-cursor@2.1.3
- @claudexor/harness-fake@2.1.3
- @claudexor/harness-opencode@2.1.3
- @claudexor/harness-raw-api@2.1.3
- @claudexor/interview@2.1.3
- @claudexor/journal@2.1.3
- @claudexor/mcp-server@2.1.3
- @claudexor/orchestrator@2.1.3
- @claudexor/review@2.1.3
- @claudexor/schema@2.1.3
- @claudexor/secrets@2.1.3
- @claudexor/util@2.1.3
- @claudexor/workspace@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/acp-server@2.1.2
- @claudexor/artifact-store@2.1.2
- @claudexor/config@2.1.2
- @claudexor/control-api@2.1.2
- @claudexor/core@2.1.2
- @claudexor/daemon@2.1.2
- @claudexor/delivery@2.1.2
- @claudexor/gateway@2.1.2
- @claudexor/harness-claude@2.1.2
- @claudexor/harness-codex@2.1.2
- @claudexor/harness-cursor@2.1.2
- @claudexor/harness-fake@2.1.2
- @claudexor/harness-opencode@2.1.2
- @claudexor/harness-raw-api@2.1.2
- @claudexor/interview@2.1.2
- @claudexor/journal@2.1.2
- @claudexor/mcp-server@2.1.2
- @claudexor/orchestrator@2.1.2
- @claudexor/review@2.1.2
- @claudexor/schema@2.1.2
- @claudexor/secrets@2.1.2
- @claudexor/util@2.1.2
- @claudexor/workspace@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/acp-server@2.1.1
- @claudexor/artifact-store@2.1.1
- @claudexor/config@2.1.1
- @claudexor/control-api@2.1.1
- @claudexor/core@2.1.1
- @claudexor/daemon@2.1.1
- @claudexor/delivery@2.1.1
- @claudexor/gateway@2.1.1
- @claudexor/harness-claude@2.1.1
- @claudexor/harness-codex@2.1.1
- @claudexor/harness-cursor@2.1.1
- @claudexor/harness-fake@2.1.1
- @claudexor/harness-opencode@2.1.1
- @claudexor/harness-raw-api@2.1.1
- @claudexor/interview@2.1.1
- @claudexor/journal@2.1.1
- @claudexor/mcp-server@2.1.1
- @claudexor/orchestrator@2.1.1
- @claudexor/review@2.1.1
- @claudexor/schema@2.1.1
- @claudexor/secrets@2.1.1
- @claudexor/util@2.1.1
- @claudexor/workspace@2.1.1

## 2.1.0

### Patch Changes

- Updated dependencies
- Updated dependencies [0fc050b]
  - @claudexor/schema@2.1.0
  - @claudexor/core@2.1.0
  - @claudexor/config@2.1.0
  - @claudexor/secrets@2.1.0
  - @claudexor/orchestrator@2.1.0
  - @claudexor/daemon@2.1.0
  - @claudexor/control-api@2.1.0
  - @claudexor/gateway@2.1.0
  - @claudexor/harness-claude@2.1.0
  - @claudexor/harness-codex@2.1.0
  - @claudexor/harness-cursor@2.1.0
  - @claudexor/harness-opencode@2.1.0
  - @claudexor/harness-raw-api@2.1.0
  - @claudexor/acp-server@2.1.0
  - @claudexor/delivery@2.1.0
  - @claudexor/harness-fake@2.1.0
  - @claudexor/interview@2.1.0
  - @claudexor/mcp-server@2.1.0
  - @claudexor/review@2.1.0
  - @claudexor/workspace@2.1.0
  - @claudexor/artifact-store@2.1.0
  - @claudexor/journal@2.1.0
  - @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/acp-server@2.0.2
- @claudexor/artifact-store@2.0.2
- @claudexor/config@2.0.2
- @claudexor/control-api@2.0.2
- @claudexor/core@2.0.2
- @claudexor/daemon@2.0.2
- @claudexor/delivery@2.0.2
- @claudexor/gateway@2.0.2
- @claudexor/harness-claude@2.0.2
- @claudexor/harness-codex@2.0.2
- @claudexor/harness-cursor@2.0.2
- @claudexor/harness-fake@2.0.2
- @claudexor/harness-opencode@2.0.2
- @claudexor/harness-raw-api@2.0.2
- @claudexor/interview@2.0.2
- @claudexor/journal@2.0.2
- @claudexor/mcp-server@2.0.2
- @claudexor/orchestrator@2.0.2
- @claudexor/review@2.0.2
- @claudexor/schema@2.0.2
- @claudexor/secrets@2.0.2
- @claudexor/util@2.0.2
- @claudexor/workspace@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/acp-server@2.0.1
- @claudexor/artifact-store@2.0.1
- @claudexor/config@2.0.1
- @claudexor/control-api@2.0.1
- @claudexor/core@2.0.1
- @claudexor/daemon@2.0.1
- @claudexor/delivery@2.0.1
- @claudexor/gateway@2.0.1
- @claudexor/harness-claude@2.0.1
- @claudexor/harness-codex@2.0.1
- @claudexor/harness-cursor@2.0.1
- @claudexor/harness-fake@2.0.1
- @claudexor/harness-opencode@2.0.1
- @claudexor/harness-raw-api@2.0.1
- @claudexor/interview@2.0.1
- @claudexor/journal@2.0.1
- @claudexor/mcp-server@2.0.1
- @claudexor/orchestrator@2.0.1
- @claudexor/review@2.0.1
- @claudexor/schema@2.0.1
- @claudexor/secrets@2.0.1
- @claudexor/util@2.0.1
- @claudexor/workspace@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/acp-server@2.0.0
- @claudexor/artifact-store@2.0.0
- @claudexor/config@2.0.0
- @claudexor/control-api@2.0.0
- @claudexor/core@2.0.0
- @claudexor/daemon@2.0.0
- @claudexor/delivery@2.0.0
- @claudexor/gateway@2.0.0
- @claudexor/harness-claude@2.0.0
- @claudexor/harness-codex@2.0.0
- @claudexor/harness-cursor@2.0.0
- @claudexor/harness-fake@2.0.0
- @claudexor/harness-opencode@2.0.0
- @claudexor/harness-raw-api@2.0.0
- @claudexor/interview@2.0.0
- @claudexor/journal@2.0.0
- @claudexor/mcp-server@2.0.0
- @claudexor/orchestrator@2.0.0
- @claudexor/review@2.0.0
- @claudexor/schema@2.0.0
- @claudexor/secrets@2.0.0
- @claudexor/util@2.0.0
- @claudexor/workspace@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- Stabilize the checkpoint release with explicit reviewer-panel hardening, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack gate
  merging, protected-path approvals, and thin control/macOS projection parity.
- Preserve repeated/comma-separated `--harness`, `--attach`, and `--image` values
  on run commands, and keep MCP/ACP runner passthrough aligned for reviewer panel,
  gate, budget, and access fields.
- Updated dependencies
  - @claudexor/control-api@0.14.1
  - @claudexor/core@0.14.1
  - @claudexor/harness-cursor@0.14.1
  - @claudexor/interview@0.14.1
  - @claudexor/orchestrator@0.14.1
  - @claudexor/schema@0.14.1
  - @claudexor/delivery@0.14.1
  - @claudexor/gateway@0.14.1
  - @claudexor/harness-claude@0.14.1
  - @claudexor/harness-codex@0.14.1
  - @claudexor/harness-fake@0.14.1
  - @claudexor/harness-opencode@0.14.1
  - @claudexor/harness-raw-api@0.14.1
  - @claudexor/workspace@0.14.1
  - @claudexor/config@0.14.1
  - @claudexor/daemon@0.14.1
  - @claudexor/acp-server@0.14.1
  - @claudexor/artifact-store@0.14.1
  - @claudexor/mcp-server@0.14.1
  - @claudexor/secrets@0.14.1
  - @claudexor/util@0.14.1

## 0.14.0

### Minor Changes

- Ship battery-driven harness hardening: typed transient retry signals, configurable reviewer timeouts with stronger route-proof capture, convergence no-progress diagnostics, deterministic protected-path tamper blocking, and a stricter real-harness battery.

### Patch Changes

- @claudexor/acp-server@0.14.0
- @claudexor/artifact-store@0.14.0
- @claudexor/config@0.14.0
- @claudexor/control-api@0.14.0
- @claudexor/core@0.14.0
- @claudexor/daemon@0.14.0
- @claudexor/delivery@0.14.0
- @claudexor/gateway@0.14.0
- @claudexor/harness-claude@0.14.0
- @claudexor/harness-codex@0.14.0
- @claudexor/harness-cursor@0.14.0
- @claudexor/harness-fake@0.14.0
- @claudexor/harness-opencode@0.14.0
- @claudexor/harness-raw-api@0.14.0
- @claudexor/interview@0.14.0
- @claudexor/mcp-server@0.14.0
- @claudexor/orchestrator@0.14.0
- @claudexor/schema@0.14.0
- @claudexor/secrets@0.14.0
- @claudexor/util@0.14.0
- @claudexor/workspace@0.14.0

## 0.13.3

### Patch Changes

- Harness-agnostic CLI flow hardening: uniform mandatory-context preflight across
  all modes and sandbox-safe secret storage,
  deterministic `fake-implement` fixture (offline create/apply/orchestrate coverage),
  one honest CLI machine surface (JSON failure reason on both run paths; `--json` on
  inspect/apply error+gate paths), read-only run lookups that never auto-start the
  daemon, daemon-start readiness wait, scoped doctor/auth probes, `models --all`, and
  fail-loud validation for unknown harnesses / reviewer-model / secrets backend.
  - @claudexor/acp-server@0.13.3
  - @claudexor/artifact-store@0.13.3
  - @claudexor/config@0.13.3
  - @claudexor/control-api@0.13.3
  - @claudexor/core@0.13.3
  - @claudexor/daemon@0.13.3
  - @claudexor/delivery@0.13.3
  - @claudexor/gateway@0.13.3
  - @claudexor/harness-claude@0.13.3
  - @claudexor/harness-codex@0.13.3
  - @claudexor/harness-cursor@0.13.3
  - @claudexor/harness-fake@0.13.3
  - @claudexor/harness-opencode@0.13.3
  - @claudexor/harness-raw-api@0.13.3
  - @claudexor/interview@0.13.3
  - @claudexor/mcp-server@0.13.3
  - @claudexor/orchestrator@0.13.3
  - @claudexor/schema@0.13.3
  - @claudexor/secrets@0.13.3
  - @claudexor/util@0.13.3
  - @claudexor/workspace@0.13.3

## 0.12.1

### Patch Changes

- Fix macOS release packaging so the app embeds the SwiftPM resource bundle required by `Bundle.module`, and make the release workflow verify the packaged ZIP contains it.
  - @claudexor/acp-server@0.12.1
  - @claudexor/artifact-store@0.12.1
  - @claudexor/config@0.12.1
  - @claudexor/control-api@0.12.1
  - @claudexor/core@0.12.1
  - @claudexor/daemon@0.12.1
  - @claudexor/delivery@0.12.1
  - @claudexor/gateway@0.12.1
  - @claudexor/harness-claude@0.12.1
  - @claudexor/harness-codex@0.12.1
  - @claudexor/harness-cursor@0.12.1
  - @claudexor/harness-fake@0.12.1
  - @claudexor/harness-opencode@0.12.1
  - @claudexor/harness-raw-api@0.12.1
  - @claudexor/interview@0.12.1
  - @claudexor/mcp-server@0.12.1
  - @claudexor/orchestrator@0.12.1
  - @claudexor/schema@0.12.1
  - @claudexor/secrets@0.12.1
  - @claudexor/util@0.12.1
  - @claudexor/workspace@0.12.1
