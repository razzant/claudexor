# Changelog

Release and candidate history for Claudexor. The current version is declared
in the root `package.json` (the version SSOT); published versions are available
on GitHub Releases.

- **v5.0.0** (2026-10-31): **Breaking:** (1) `pr` delivery now needs the pinned open-source scanner Betterleaks 1.9.0 and checks what would leave the machine with it instead of Claudexor's own patterns (#555); an npm-installed CLI bundles no scanner, so its `pr` refuses with `publication_scan_unavailable` until `CLAUDEXOR_BETTERLEAKS_PATH` points at the pinned build or `node scripts/provision-betterleaks.mjs` provisions it, while the macOS app, its update closure and each SSH runtime archive bundle their own target's build. A finding refuses typed (`publication_scan_findings`, rule and place only, never the matched text) and a scan that cannot run or complete refuses `publication_scan_unavailable` or `publication_scan_failed`; local apply, branch and commit stay available. (2) Credential-shaped text in your own work is no longer refused or masked (#555, INV-146 retires INV-062): a bearer header, an `sk-`/`ghp_`/`AKIA` key, a JWT or a PEM block in a brief, prompt, instruction, answer or attachment reaches the selected harness exactly and is kept exactly in local run records, and the typed `inline_secret_rejected` error is gone from the CLI, `POST /v2/runs`, thread turns, MCP and ACP; files named `.env`, `credentials.json`, `*.pem`, `*.key`, `secrets/…`, `.ssh/…` or `.claude/…` inside the project are ordinary project files; credentials Claudexor itself owns stay in their stores and engine diagnostics are still masked. (3) `claudexor review --delta-scope` is retired (#257): an invocation that passes it stops with exit code 2 and names both replacements, and a sealed packet review now covers the complete packet on every lane, Cursor included. (4) For a Git result, a `commit`, `branch` or `pr` delivery that fails after writing now answers an HTTP 409 problem with a typed code on `POST /v2/runs/:id/apply` and `accept_clean_patch`, where 4.8.2 answered HTTP 200 `applied:false`. **Highlights:** large results are kept exactly, without a size ceiling (#535): every Git capture's canonical result is Git objects identified by a typed digest in a private per-project store, delivery and revert work on that exact pair and keep later edits outside it, the patch becomes a view that is absent with a typed reason past 256 MiB, a delivery refuses `delivery_path_occupied` or `delivery_outside_sparse_checkout` before writing, and a run whose changes cannot be captured ends `failed` with the new reason `capture_refused` instead of `workspace_unavailable`; `claudexor project remove --purge-trashed-threads` removes a project with the threads already in its trash (#333) and a thread purge reports completed only once Git has removed the worktree and branch; `claudexor doctor` and `GET /v2/daemon/route-health` report route health for the last seven days; account resources show an OpenRouter key's own spending limit (#138); an explicit raw API or OpenRouter route can answer Ask without a project (#133), and an explicit model is judged by what the catalog actually answered; a pinned account refusal by quota says why through `quotaRefusal.basis` (#318), Claude quota families reach newly released models (#394), and a moved run chooses its next account from the quota visible at that moment (#457); a Cursor shell command that is still running is no longer reported as a finished success (razzant/claudexor#450), and a Cursor-pinned run waits up to 120 seconds for the sign-in check (#532); Codex rollout reads are bounded, MCP tool results and native warnings reach the run's evidence, and `claudexor inspect` separates a missing run from a lookup that could not complete; the global and project event streams replay in bounded pages (#312) and repeated run detail reads reuse the folded event prefix; the macOS packaging boot smoke runs in an empty environment; the baseline commit Claudexor makes in a reviewer's workspace no longer reads your global Git configuration or attributes file, so a filter or monitor you configured (git-lfs's among them) no longer runs there and a required filter that cannot run or a line-ending setting of yours no longer keeps review from starting. **Compatibility:** the control protocol major stays 3, the engine store schema stays 6 and the minimum app version stays 4.0.0; runs recorded by earlier versions keep their masked copies and their patch for apply and revert, and their `persisted_patch: redacted` patches still apply only from the private exact object.
- **v4.8.2** (2026-10-28): **Upgrade:** opening an existing engine store migrates it from schema 5 to 6 in one transaction that adds a lower-case `command.task_group_id` column and backfills it for live and archived rows; a store last served by 4.7.0 first passes the steps described under v4.8.0. Migrations are one-way, and older engines, including 4.8.1, refuse a data root that 4.8.2 has served, so stop every writer and take a complete backup before upgrading, as described in "Upgrade backup and restore" in `docs/ARCHITECTURE.md`; replacing only the executable is no rollback. Task-group cursors issued before the upgrade restart with `stale_cursor`. Multi-run waits (`POST /v2/runs/wait-many`, MCP `claudexor_runs_wait`, CLI `runs-wait`) are fixed (#513, #514 and #515 through #523): a daemon that stops during a wait answers a retryable `503 daemon_stopping` at once instead of holding its shutdown, `waitMs` bounds the wait between reads rather than a read, so a short positive `waitMs` no longer returns every target `not_observed`, a problem row's `null` token can be echoed as `seen: null` to acknowledge that problem (the client and the daemon both need 4.8.2 for this), waits wake from the store's post-commit notices for the targets they watch instead of a 250 ms poll, and task-group membership ignores the letter case of the group UUID while answers keep the caller's spelling. Retention releases old unreferenced artifacts and native sessions once archived project bindings are cleared, reclaims aged unnamed revert and exact-patch objects and empty engine containers, keeps surviving runs, recovery holds and live workspace, checkout and harness-home directories, and records the last cleanup outcome with its holds and errors, readable through `claudexor gc --last` and `GET /v2/maintenance/gc` (#524). Reading retained run history no longer stalls the control plane (#516 through #526): run detail, summaries, artifact reads and finite event replay run on one lazy bulk worker off the event loop, inbox attention stays independent of that queue, sequenced streams resume from the tail and keep legacy cursors, daemon status reports route outcomes and the worker's queue and projection timing, and an event replay of a running run that reaches a stopping daemon answers `503 daemon_stopping`. Antigravity readonly runs can read files outside their workspace: before each run the adapter makes the profile's own `settings.json` allow `read_file(*)` and keeps every other setting, so a headless plan-mode run no longer ends empty on a refused read; write confinement is unchanged, a `read_file` deny rule and `toolPermission: "strict"` still apply, and readonly instructions now say that shell commands are unavailable (#525). Claude text blocks carry an opaque `speech.key` with a `fragment`, `complete` or `abandoned` operation in the run journal and timeline, so a consumer can replace a streamed draft with its complete text without merging unrelated messages that contain the same words; joined or ambiguous snapshots and the terminal result stay unlinked (#518, for razzant/ouroboros#1698). Protocol 3 and the app floor 4.0.0 are unchanged.
- **v4.8.1** (2026-10-28): **Upgrade:** opening an existing engine store migrates it to schema 5 in one transaction, as described under v4.8.0. Migrations are one-way, and older engines, including 4.7.0, any 4.7.1 build and the unpublished 4.8.0, refuse a data root that 4.8.1 has served, so stop every writer and take a complete backup before upgrading, as described in "Upgrade backup and restore" in `docs/ARCHITECTURE.md`; replacing only the executable is no rollback. This is the first published release since 4.7.0: v4.7.1 and v4.8.0 were tagged, but their publication stopped before npm and the GitHub Release (v4.7.1 when the Linux SSH release smoke could not pull its Ubuntu image, v4.8.0 when the Windows release smoke asked a just-started daemon to stop before the daemon could read its own records), so everything listed under v4.8.0 and v4.7.1 in `CHANGELOG.md` ships here with the limits stated there. That includes the bounded macOS conversation feed and engine history reads (#504), MCP and CLI document uploads (#505), Grok Build (#500), editable next messages (#507), Browser lane choice for Auto runs (#508), the bounded run timeline (#517), task-group recovery and multi-run waits with their two disclosed limits (#498), the Windows refusal to start a `.exe` or `.com` without the minimal PE shape (#506) and the Cursor observed-model catalog proof (#509). The Windows release smoke now retries the graceful runtime stop while the daemon answers with a retryable refusal, until a 30-second deadline passes, and still fails on any other answer; the daemon's refusal itself is unchanged (#521). Protocol major 3 and the app compatibility floor of 4.0.0 are unchanged.
- **v4.8.0** (2026-10-28, tagged but not published; shipped as v4.8.1): **Upgrade:** opening an existing engine store migrates it to schema 5 in one transaction. Migrations are one-way, and as after every release, older engines, including 4.7.0, any 4.7.1 build and unpublished schema-4 builds, refuse a data root that 4.8.0 has served, so stop every writer and take a complete backup before upgrading, as described in "Upgrade backup and restore" in `docs/ARCHITECTURE.md`; replacing only the executable is no rollback. A store at schema 2 (last served by published 4.7.0) first gains the two task-group indexes of #498, whose build scans existing rows; every store below schema 4 then gains the `deferred_message` table and its indexes for editable next messages (#507); and every store below schema 5, including one already at schema 4, gains the `turn_plan_answer` index for bounded thread history (#504), whose build scans existing turns once without rewriting them. Stores upgraded by earlier unpublished schema-3 builds keep their broader task-group indexes, which 4.8.0 can still query. v4.7.1 was tagged, but its publication stopped before npm and the GitHub Release when the Linux SSH release smoke could not pull its Ubuntu image from ECR Public, so everything listed under v4.7.1 in `CHANGELOG.md` is part of this release with the limits stated there: task-group recovery and multi-run waits (#498), the Windows refusal to start a `.exe` or `.com` without the minimal PE shape (#506) and the Cursor observed-model catalog proof (#509). Two #498 limits reported after v4.7.1 was tagged remain in this release. An open multi-run wait (`claudexor_runs_wait`, CLI `runs-wait` or `POST /v2/runs/wait-many`, 25 seconds by default) delays a daemon stop, including the stop for an engine update, and after 15 seconds the daemon forces exit code 1 before closing its journal and store; keep `waitMs` (CLI `--wait-ms`) at or below 10000, or end pending waits before stopping or updating the engine. `taskGroupId` matching is case-sensitive while macOS `uuidgen` prints uppercase UUIDs, so a recovery read that spells the id in another case returns an empty page, which never proves that nothing was launched; use the identical string at launch and recovery, preferably lowercase. Grok Build is a new subscription CLI harness (`@claudexor/harness-grok`) with named accounts in isolated profile homes, device login, account model lists, shared effort placement, stream parsing and reactive quota cooldowns for pools and rotation. Readiness comes from `grok models` in the profile environment, an inconclusive probe stays unknown instead of marking the account dead, and run failure text is never read as an authentication verdict. Session login is confirmed from Grok's init frame; a contradicting credential source fails the attempt as the new typed request refusal `credential_source_unconfirmed`, without a retry or account rotation. Claudexor never selects an API key, but a key in Grok's own configuration can send a paid request before that check, as the adapter README discloses, and subscription cash is reported as unknown, never as zero. Scoped access modes use Grok's native tool policies, which disable shell, MCP and subagents but are no OS sandbox; explicit `full` approves the vendor's full toolset. Grok joins the macOS Add Account picker and the shared credential-store path rules, so a directory run never copies or publishes a selected `.grok/` directory. An app built before this release cannot decode an active Grok login job, and its engine-update check reports busy until that login finishes or is cancelled. Applied attempt facts now name the HOME a Grok, Antigravity or Cursor profile child actually received (#500). Grok evidence is offline fixtures plus the contributor's Windows checks with Grok 1.0.67; live macOS and Linux permission rules, multiple accounts and app login remain unqualified. Daemon-owned one-shot Agent and Ask runs accept one operator-only editable next message through `claudexor_next_message` and `claudexor_next_message_read`, CLI `next-message` and `next-message-read`, and HTTP `/v2/runs/next-message`. One revisioned draft reserves the predecessor's single successor claim. An eligible settled success sends it once as an ordinary continuation through the existing admission and queue; failure, unknown process custody, Stop, restart or admission refusal holds it without retry. Controls and Settings execution preferences are captured at creation and shown by origin on the bounded read, while permissions, trust, accounts and quota stay current at dispatch. Public Stop (`POST /v2/runs/:id/control`, `claudexor_run_cancel`) holds a waiting draft whatever the predecessor's lifecycle and reports an already accepted successor as `next_message_dispatched` without cancelling it; if the hold cannot be saved, the run still stops, the draft is not sent and Stop answers 503 `next_message_hold_failed`. `claudexor_run_cancel` failures now keep the control API's typed problem: their text starts with the code (for example `http_409: run is succeeded; cancel has nothing to stop`), and the structured failure carries the code, required actions and context. On Windows, run-scope process custody is never proven, so every draft holds as `settlement_unknown` and no next message is sent automatically; Delegate child targets and delegation-belt callers are refused with `delegation_forbidden` (#507). MCP and CLI controllers can hand runs ordinary documents through the existing upload owner. MCP gains the upload stage tools `claudexor_upload_create`, `claudexor_upload_import_local`, `claudexor_upload_status`, `claudexor_upload_finalize` and `claudexor_upload_cancel` with matching CLI verbs, and public runs, thread turns and continuations accept strict `attachments: [{resourceId}]` refs, which CLI runs pass with `--attach-resource`. A keyed import binds one source to one immutable resource under a saved store id and caller key (`claudexor_store_identity` and `claudexor_upload_import`, CLI `store-identity` and `upload-import`, HTTP `POST /v2/uploads/imports`). A completed import replays its original resource even after the source changed or was deleted; different arguments or bytes under the same key are refused without effects, another store is refused before any effect, and verified bytes received before a lost reply or a daemon restart are published on replay. Codex carries verified references for TXT, Markdown, JSON, PDF and DOCX, at most 20 files of 20 MiB each; this is byte access with no parsing or OCR promise. Existing callers see three behavior changes: CLI `--attach` now labels `.pdf` and `.docx` files `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document` instead of `application/octet-stream`, so lane admission matches those types; Codex now declares these five file types, so Auto routing keeps Codex for runs that carry them where it used to drop it, explicit pools that include Codex admit them, and Auto and pool choices for such runs can change; and the Delegate belt's run tools accept `attachments: [{resourceId}]` refs while the belt still exposes no upload controls (#505). Built MCP and CLI stories with fake harnesses cover upload replay, keyed-import conflicts, store mismatch, source deletion and daemon restart, and the contributor reports a live read-only Codex app-server smoke that read markers from all five types; live Codex legacy-exec consumption, GUI and remote-host client workflows and cross-platform native readability remain unqualified. Ordinary single-candidate Auto Agent runs that request Browser choose a compatible lane before account quota, processing and ranking, without widening access or web policy. Explicit pools, pins, explicit or inherited primaries, multi-candidate and convergence runs keep their existing behavior, and a configured primary excluded from this Auto path reports `capability_incompatible` with the exact cause in its event detail (#508). The macOS conversation feed now mounts at most 20 turns, with Show earlier turns, Show later turns and Jump to latest, in place of the lazy feed whose layout could hang the app when a long chat was reopened; the reader's place holds while new turns arrive, message text renders in native read-only `NSTextView`s, and long prompts and answers fold to previews. Thread history gains bounded engine reads: `GET /v2/threads/:id/history` returns one page of at most 20 turns with prompt and answer previews and receipt facts, chosen by a cursor or a before, after or around turn id, and `GET /v2/threads/:id/turns/:turnId/prompt` returns a bounded UTF-8 part of a turn's complete stored prompt, refused turns included, with its total size and SHA-256. CLI `thread history` and `thread prompt`, MCP `claudexor_thread_history` and `claudexor_thread_prompt` and ClaudexorKit `GatewayClient.threadHistory` and `threadPromptPart` expose the same reads; the CLI and MCP reads require an existing daemon and never start one, and the existing thread detail read remains available. The app loads conversations only through this history read. Against an older engine, such as one the app keeps while that engine's work runs (a deferred local refresh, or a remote runtime whose update is offered after its tasks), the pane shows no turns; it says that the engine is older than the app and that Claudexor updates it, or offers an update, once its current work finishes, and offers Retry. Scrolling up with a wheel, trackpad, scroller or navigation key stops following the newest turn, but a scroll made only through Accessibility actions, without such input, does not (#504). Engine, CLI and MCP tests, a built canary story, store upgrade tests and the app and ClaudexorKit suites cover these reads and the feed, and the final #504 head `d8655b412` passed all six CI jobs, with 340 ClaudexorKit and 1,053 app tests on macOS 26.6.2. Following also survives an upward input that cannot move a short document while that document later grows, and a message no longer scrolls the feed when its size changes, which on macOS 26.6 moved a followed feed back to the first line of a growing answer. One native observation remains: manually scrolling back to the apparent bottom can leave a small inset gap and keep following paused; use Jump to latest to explicitly resume it. macOS 26.5 stress acceptance, input-method (IME) composition and conversations with live vendors remain unqualified. Run detail selects its newest 500 displayable timeline rows before redaction and validation, avoiding projection work for omitted rows while preserving canonical row order, omission counts, budget, plan and cursor facts (#517). Parsing the event log and the other projections remain unchanged. A malformed payload whose projection would throw now fails detail only while displayed; off-window it is counted as omitted. An unprintable event type still fails anywhere. Linux SSH release verification now pulls the same digest-pinned Docker Official Ubuntu 24.04 amd64 image from Microsoft's Docker Hub mirror at `mcr.microsoft.com` instead of ECR Public; the smoke's assertions and cleanup are unchanged. Protocol major 3 and the app compatibility floor of 4.0.0 are unchanged. Thanks to @vaskers5 for #500, to @Dalackhan for the original bounded-history contribution (#504) and to @IlidanNaga for #498, #505, #507 and #508.
- **v4.7.1** (2026-10-26, tagged but not published; shipped as v4.8.1): **Upgrade:** opening an existing engine store migrates it from schema 2 to 3 in one transaction that adds two task-group indexes without a backfill (building them scans existing rows). Migrations are one-way, and as after every release 4.7.0 refuses a data root that 4.7.1 has served, so stop every writer and take a complete backup before upgrading, as described in "Upgrade backup and restore" in `docs/ARCHITECTURE.md`; replacing only the executable is no rollback. Stores upgraded by earlier unpublished schema-3 builds keep broader indexes that 4.7.1 can still query, but those builds cannot use the narrower ones, so do not alternate them with 4.7.1 on one store. Public one-shot launches accept an optional caller-generated UUID `taskGroupId` (CLI `--task-group-id`); accepted receipts, including queued job-only ones, carry it with the accepting `storeId`, Exact Retry keeps it, and a new continuation joins a group only when it supplies one. A controller that kept the group id and the accepting `storeId` but lost its job handles recovers them one bounded page at a time with `claudexor task-group-runs`, the `claudexor_task_group_runs` MCP tool or `GET /v2/task-groups/:id/runs`; a queued member's `runId` stays null until it binds, and the caller requests each next page explicitly with a cursor bound to the store, served view, group and filter. Pages cover retained rows in the currently served generations, so an empty page does not prove that work was never accepted and never authorizes resubmission. `claudexor_runs_wait`, CLI `runs-wait` and `POST /v2/runs/wait-many` report lifecycle and pending-question attention for 1 to 1000 existing handles in one read, with per-target `seen` tokens and problems; question bodies and output stay separate reads. Group reads and waits never launch, retry, resume, answer or cancel work (#498). Built CLI, MCP and HTTP stories with fake harnesses cover controller loss, queued binding, keyed replay conflicts, store mismatch, archive visibility and daemon-crash interruption without automatic resume; manual Codex-host UI reconnection or cancellation and real-vendor permission delivery remain unqualified. On Windows, a `.exe` or `.com` without the minimal PE shape (`MZ`, then `PE\0\0`) is never started: the resolver passes over such a PATH candidate, npm launcher target or Node interpreter for a later healthy one, and a bare-name spawn is refused with `EFTYPE` before any process starts when the install is proven broken or the spawn's own search (cwd first, then PATH) would reach such a file. This covers the placeholder `claude.exe` an npm install leaves when the package's postinstall did not run; Claude doctor and discovery name that file instead of reporting a missing CLI, and the Claude auth-status probe makes one attempt for it without retry or last-known-good fallback. Windows PATH is read as libuv reads it, and on every platform relative PATH entries resolve at the daemon's cwd for runs and probes alike (#506). Injected-platform tests and 26 isolated Windows Server 2022 x64 scenarios cover the refusal and healthy launches; the absence of error dialogs or whole-machine freezes, vendor login and full loader or architecture validity are not proven. Cursor names its model by display label (`init.model`, for example `GPT-5.5 High`) while runs request the listed id. Attempts keep the raw string in `observed_model` and add `observed_model_catalog_match` (`label`, `id`, `source: account_catalog`, `profile_id`) to `final/telemetry.yaml` only when the account catalog read by the same spawn's preparation lists exactly one live row with that exact label, with no collision against a different row ID. The proof comes only from the event that set `observed_model`, never from a later try, a normalized or alias match or the requested model, and it is dropped when the Agent or Ask/report loop starts another native try or a later event names another model. A missing, empty, unmatched or ambiguous catalog leaves the field null, which only means that no proof exists; internal reviewer and continuity-summary spawns carry none. No vendor call is added, and admission, routing and `auth_route.model_mismatch` are unchanged (#509). Only synthetic Cursor-style catalogs and init frames test the proof; no recorded live account yet shows that Cursor's catalog labels and `init.model` share bytes, so real runs may stay unproven. Protocol major 3 and the app compatibility floor of 4.0.0 are unchanged. Thanks to @IlidanNaga for #498.
- **v4.7.0** (2026-10-22): Native workspace-write runs can use exact caller-created external download-cache and verification-scratch directories through `execution.auxiliaryWritableRoots` (CLI `--auxiliary-writable-root`). The negotiated `accessControl.auxiliaryWritableRoots` capability currently identifies Codex support; unsupported explicit selections refuse, while Auto filters incompatible lanes before profile checks. Admission rejects overlap with source/execution trees and protected engine/profile state, including macOS directory aliases. Grants apply per native turn without changing thread configuration, network policy, native temporary-directory defaults or readonly access. A new turn without roots revokes the prior grant; `continueFrom` inherits an omitted whole execution group, so HTTP callers clear it with a complete execution replacement containing `auxiliaryWritableRoots: []`. MCP Continue names that HTTP/new-run remedy. The engine neither provisions service directories nor captures, applies or reverts their contents (#495). Native grant/revocation and offline environment bootstrap were exercised with Codex 0.162.1 on macOS and locally scripted model responses; native Windows/Linux auxiliary-root behavior remains unqualified. File-write grants do not add socket or process-enumeration rights. Protocol major 3, store schema 2 and the app compatibility floor of 4.0.0 are unchanged; there is no schema migration.
- **v4.6.2** (2026-10-22): The first published release of the 4.6 line on GitHub. v4.6.1 reached npm, but #485 reached `main` while its publish ran, so its GitHub Release was refused; everything listed under v4.6.1 and v4.6.0 ships here. Also new: local macOS app bundles are ad-hoc signed and strictly verified before a ZIP or DMG is made (#485). Thanks to @IlidanNaga for #485.
- **v4.6.1** (2026-10-22): The first published release of the 4.6 line. v4.6.0 was tagged, but three changes reached `main` while its candidate was building, so it was never published; everything listed under v4.6.0 ships here. Also new: Attachment and Browser request admission uses execution's pool projection, candidate membership and profile precedence. An explicit or inherited profile selects its harness even when the default harness home is logged out, a missing, disabled or wrong-harness pin is refused with a typed `harness_unavailable` 400 instead of being substituted, an empty Auto candidate pool returns 400 `harness_unavailable`, and static profile ambiguity returns 409 `credential_profile_ambiguous` (#488). On macOS, compatible newer daemons and alternate builds of the same version keep running when another app copy connects; Settings gains an explicit idle-only same-version build switch, app lifecycle transactions are coordinated across copies sharing a service root, and Install refuses before any stop when a newer engine or another build of the same version already serves (#487). Recent project folders are told apart by their shortest distinguishing parent suffix, and the project chip's hover and VoiceOver text say whether the folder is a primary Git checkout or a linked worktree (#489). Thanks to @IlidanNaga for #487, #488 and #489.
- **v4.6.0** (2026-10-22): Claude Code sessions take a chosen native prompt-cache lifetime per run: `POST /v2/runs` and thread turns accept `promptCacheTtl: "5m" | "1h"` (CLI `--prompt-cache-ttl`); omission keeps native defaults, profile settings and the inherited environment. Adapters declare the values they translate (`capability_profile.prompt_cache_ttls`, projected as `harnesses[].promptCacheTtls` with the key in `runControlKeys`); the value is frozen into the task contract, inherited by a bare `continueFrom`, re-injected by Exact Retry and forwarded to task lanes, reviewers and delegation-belt children on declaring harnesses, and is an `ignored_settings` disclosure elsewhere. The Claude adapter sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and its subagent twin, and each Claude attempt records `prompt_cache_ttl` in `final/telemetry.yaml` with the routed lifetime and the observed split of five-minute and one-hour cache writes (#490). On Windows, background harness runs and captures start the vendor with an invisible console instead of none, so the shells, `git`, MCP servers and other console programs a run starts inherit it instead of opening windows of their own; agy keeps the console-less start because its print mode treats an openable console input as interactive, and Claudexor's own `git` calls keep the console-less start they always had. Cancellation still stops the whole tree with `taskkill /T`, and a background child now also ends when the daemon process dies. The no-Terminal sign-in children (URL disclosure and the device-code app-server) open no console window, and Codex quota and model discovery, the install version proof and the `login --help` probe start their direct child hidden; the Node preload of #482 is replaced by the inherited console. Thanks to @josephsteuerjr for #482 and the report behind it (#491). Codex run-adapter app-server JSON-RPC messages keep U+2028 and U+2029 inside their payloads: protocol stdout is framed on LF and each chunk is scanned once. Thanks to @IlidanNaga (#484). Relative to published 4.5.0, protocol major 3, engine store schema 2 and the app compatibility floor of 4.0.0 are unchanged; this release adds no schema migration.
- **v4.5.0** (2026-10-21): An account that cannot serve a requested Codex model no longer absorbs every request for that model. Auto model operations prefer accounts whose live catalog lists the model. A recognized pre-generation refusal (`model_capability_refused`: an explicit model-not-found or not-supported code, the ChatGPT-account unsupported-model sentence, the narrow missing-model sentences) gives that account a temporary capability mark for that model (four hours, then one probe; cleared by service there or by a catalog or credential change). Any other definite provider HTTP 4xx before generation on an auto operation keeps its code and gains the same retry context; sign-in, timeouts, conflicts, rate and quota limits, the processing fallback, server failures and typed request faults (a named parameter, an exceeded context) keep their own handling. Both kinds record the shared pre-progress refusal observation, so the account orders after clean accounts for that model for an hour, Agent runs included, and an older in-flight refusal never undoes a newer model operation's service. A mark never disables an account or excludes the last one, and pins stay exact without marks. The refusal offers the host one correlated retry on another account (`retryOnOtherAccount`, `retryOfOperationId`), still one dispatch per operation: service there confirms the first account's mark (or creates it for an unrecognized refusal), an equivalent recognized refusal keeps both accounts' provisional marks so a third account can serve, and an unrecognized refusal that the other account repeats marks nothing, because the request itself may be at fault. In the fallback order (after accounts that list the model and then advisory misses) an account with only a soft observation (a recent refusal, or a served-model substitution of a non-preferred account) comes before a capability-marked one, so one refused request on a working account does not hand the traffic to an account that cannot serve the model. Each such refusal lists the model's live marks with the start of their episode (`modelMarks`) and says whether another selectable account without a mark remains (`alternativeRemains`). History whose native continuation is bound to an unmarked, unrefused preferred account stays on it even when its catalog omits the model. Routing receipts (`captureRoutingEvidence=true` on `POST /v2/model-operations`, bound to the idempotency key) and the marks in Accounts (`includeCapabilities=true` on `GET /v2/accounts/routing-evidence`) are opt-in over HTTP, so strict 4.4.0 clients keep their response shapes; `claudexor profiles`, `claudexor accounts --json` and the MCP accounts tool request the marks and read again without the query on an older engine's 400. **Behavior change:** the recognized Codex refusals listed above now return `model_capability_refused` instead of `invalid_request` or `model_unavailable` (an explicit vendor `model_not_found` still records the model-scoped unusable verdict), and `preferredProfileId` no longer wins over a listed account or over its own mark or recent refusal; history bound to that account keeps it first over a catalog miss only while it has neither; see `docs/MODEL_CAPABILITY_ROUTING.md`. Marks and retry correlations live in daemon memory, so a restart forgets them. Readonly live-directory Agents skip write-oriented baseline inventory and output capture, so broad source scopes containing sockets no longer block startup and source files are not copied into attempt artifacts; readonly answers no longer fail capture because a selected path resembles a credential file, and empty answers and readonly `noChanges` follow the Git readonly convention. Thanks to @IlidanNaga (#481). Relative to published 4.4.0, protocol major 3, engine store schema 2 and the app compatibility floor of 4.0.0 are unchanged; this release adds no schema migration.

- **v4.4.0** (2026-10-20): The engine retires what it owns on long-running installs without deleting anything still referenced: retention visits unregistered and archived project histories (keep-last protects active registrations, archived ones while their root exists and the no-project scope), continuation, Exact Retry and plan dependencies protect their whole ancestor chain, immutable attempt, final and anchor patches share one content-addressed object per project where hard links are supported, and Codex prunes old rollout parts that no session, capsule or resumable record references, never credentials, configuration or databases. Maintenance, which already began a minute after startup in capped batches, now also recurs hourly, yields to admission and resumes after a stop; an Exact Retry of a run whose files were retired is refused with Run Again as the next action (#477). MCP controllers get idempotent one-shot launches (`idempotencyKey`), `claudexor_run_wait` (bounded event replay with lifecycle and pending-interaction snapshots; stopping observation never cancels the run), `claudexor_run_message` and `claudexor_run_continue`, and an oversized event is read in bounded `claudexor_run_event_read` parts with its exact redacted bytes and hash; `claudexor_run_continue` resolves omitted controls, access included, to new-run defaults. Thanks to @IlidanNaga (#478). A fresh managed Codex install resolves npm `latest` once to an exact version, discloses it and installs exactly that version; with `--target local` a runnable managed copy at or above the release-tested baseline is kept, `--release-tested` uses the baseline, a registry failure or a latest older than the baseline (`latest_older_than_tested`) refuses instead of falling back, and native evidence stays at 0.162.1 (other versions are `deterministic_only`). `pinnedVersion` now names the selected install target; `harness inspect --json` still reports the baseline as `releaseTested.version`. Thanks to @josephsteuerjr (#476). After a SQL miss, an addressed legacy upload binding that cannot be read or parsed answers HTTP 503 `legacy_upload_binding_unavailable` instead of minting a new upload (while the legacy directory itself is unreadable, every SQL miss is refused, new keys included), and internal model results publish without a historical lookup. Thanks to @josephsteuerjr (#474). Daemon status reports per-route request latency (one count of completed responses or disconnects with p50, p99 and max for the lifetime and the last loop window, keyed by HTTP method and operation-catalog template; raw URLs, query values and identifiers are never retained) and the 32 longest labelled synchronous sections since start (store BEGIN and COMMIT, external writes, run detail and summary projections, scope persistence) with their duration and time, plus lifetime COMMIT p50 and p99. A label is not proof of a delay's cause, and nothing acts on these facts. A request whose client has already hung up skips its pending heavy read projections; an admitted mutation still completes. `POST /v2/handshake` returns the durable engine store id as `storeId` to a client that sends `X-Claudexor-Store-Identity: 1`, which the operation catalog lists; every other client keeps the earlier response shape, so strict same-major clients are unaffected. `scripts/daemon-load-bench.mjs` compares an exact base against the working tree in alternating trials inside temporary roots it owns and stops only its own PIDs. Moving checkpoints off the request thread was measured and not adopted: in twelve-trial comparisons every candidate lowered COMMIT tails but none lowered the event-loop tail consistently, because a WAL reuse still needs a writer-excluded window for its full syncs (`docs/benchmarks/daemon-sync-20261020.md`). Relative to published 4.3.1, protocol major 3, engine store schema 2 and the app compatibility floor of 4.0.0 are unchanged; this release adds no schema migration.

- **v4.3.1** (2026-10-18): A run's candidate capture no longer fails when the working copy holds an untracked folder that is itself a Git repository. Such a folder (for example a reviewer's copy of a repository under `.review-evidence/`) made `git add` refuse the whole capture when it had no commit, or was staged as a commit link a patch cannot carry, so a finished agent-mode run lost its work product. Untracked nested repositories that the worktree's `.gitmodules` does not declare are now left out of the patch and named, top-relative and redacted, as `excluded_nested_repositories` in the attempt record and in the final work product's meta. A declared submodule is still captured as its commit link, the names stay correct when the project root is a subdirectory of the worktree, and an in-place thread's turn snapshot leaves the same folders out, so the next turn no longer fails on one an earlier turn left behind. An isolated envelope is not kept for an excluded folder: its bytes go with the envelope. Relative to published 4.3.0, protocol major 3, engine store schema 2 and the app compatibility floor of 4.0.0 are unchanged; this release adds no schema migration.

- **v4.3.0** (2026-10-17): **Behavior changes:** Codex subscription cash is unknown, not zero. Codex workspace-write now uses native auto-review, which may approve individual actions outside the base sandbox; unanswered denial handbacks wait up to 15 minutes by default. Verified Codex subscription work (Standard and Fast) now reports its cash as unknown instead of exact `$0`, because no Codex transport reports an actual cash or purchased-credit debit. Its cost basis declares `debit: "unobserved"`; the run budget's `spendUsd` and the decision record's `budget_summary.spend_usd`/`cash_usd` are null, while the new `controllableSpendUsd` and `budget_summary.controllable_cash_usd` carry the cash a finite cap governs and `remainingUsd` is computed from it. That work still completes under unlimited, positive and `finite(0)` caps; a cap never promises a provider-credit limit. `claudexor inspect` prints `budget: spend=unknown controllable=<usd>`, the Delegate belt commits a child's controllable spend against its parent's draw when the child's total is unknown, and the macOS turn receipt reads `Cash unknown · $c of $cap cap`. Ordinary Codex Fast (`fast`/`priority`) on a verified ChatGPT subscription now counts as included subscription service and stays eligible under `paid_fallback: never` and `finite(0)`; `ultrafast`, other premium or unknown tiers, API credentials and unknown routes keep the existing paid policy, and advisory Fast requires the selected model and account to advertise it; inherited native Fast retains the first account's choice without that advertisement requirement. Without a speed preference, retries, Exact Retry, account rotation and in-run continuation keep the speed the first Codex account chose, frozen per routed lane in `context/processing_intent.yaml`, instead of adopting another account's setting; a new command or thread turn chooses its own. Live vendor debit behavior is unobserved. Thanks to @IlidanNaga (#468). Codex model catalogs keep the provider's declared `inputModalities` only as a whole valid, non-empty list; a missing, empty or partly invalid declaration reads as unknown (`[]`) rather than a filtered subset. The field is declared metadata: it gates no request, image-bearing or not, and does not prove that a model understood an image. Thanks to @josephsteuerjr for the original contribution (#435). The new opt-in `GET /v2/quota?view=resources_freshness` combines per-constraint freshness, typed account resources and a required `availability_scope` echo (`basis: "quota_block"`, the exact supplied model and the effective request kind). The basis names the existing quota-blocking projection, not every dispatch or admission check; the view's Codex `reset_credits` label and typed reset offer are one count, not additive; the legacy shape and the three earlier views are unchanged. Pinned-account and exhausted-pool quota refusals keep their known subject, model and request kind in typed context. Cursor accounts now report independently dated personal and team monetary resources (balances and spending with optional `scope`, `usage_kind`, `period` and `fee_included`) from Cursor's internal dashboard `usage-summary` through the existing refresh demand and pacing. Claudexor sends only the account's bound file-store token, as a `WorkosCursorSessionToken` cookie to cursor.com; it never refreshes OAuth or writes credentials, and the amounts are display-only, never execution quota, admission or spending authority. That dashboard is not a stable public API: mapping and refresh are covered with synthetic amounts and credentials, credential-store locations follow vendor source rather than native-platform proof, and a live Cursor refresh is not qualified. `no_source` still means no quota-window source, not an absence of account resources. In the macOS app, Accounts shows these amounts in USD, its resource summary names the one source-ordered balance it shows instead of an aggregate or a chosen personal/team amount, and the summary wraps instead of truncating. Antigravity recognizes the native headless permission auto-denial on stderr as typed `permission_denial` evidence (`capability_refused`/`permission_denied`, resumable cause `permission_denied`) and ends the attempt without retrying or elevating access: narration never becomes the final answer, a nonempty typed final is kept with a warning, an empty `SUCCESS` is a cause-unknown error, and a finished tool step without reported output is diagnostic, not success (#467). **Behavior change:** Codex workspace-write runs use native `on-request` with `auto_review` by default. A controller can inspect a denied single action and explicitly authorize one same-session retry within the user's mandate; this is neither a session-wide grant nor a readonly/full-access fallback. The vendor's automatic reviewer can approve individual actions outside the base workspace-write sandbox without a controller; this is not a promise that every approved action stays inside that sandbox. The settled answer is retained before handback. An unanswered denial handback waits for the interaction timeout (default 15 minutes), then benignly declines; an internal Delegate parent has no approval-answer tool, so the child needs an ordinary external controller response or expiry. Unanswered requests are revoked on cancellation or disconnect, and authorization already submitted cannot be recalled. HTTP/MCP controllers can read, set, extend or disable the existing live run's soft/hard timer with revision checks; soft expiry informs without cancelling, hard time includes waits, and `set` preserves the current mode unless a mode is supplied. Omitted `maxSeconds` adds no deadline; explicit limits remain hard by default. Configuration can set the inactivity watchdog to null without adding a second per-run idle policy. Timers do not survive daemon restart; there is no new macOS timer editor, and the existing ACP stale-permission-prompt limitation remains. The verified Codex CLI pin is 0.162.1, not an automatic installed-CLI update. Thanks to @IlidanNaga (#466). Claude `workspace_write` runs now pre-approve `Read`, `Glob` and `Grep` outside their working folder, as `readonly` already does (#469). File-tool edits still follow `acceptEdits`; the default pre-approved shell was already unconfined. Narrowing or denying `Bash`, or denying only one bare read tool, does not confine the remaining read tools: use explicit path-scoped `Read(...)` rules or the vendor's working-directory read block when that boundary is required. Explicit read allow patterns keep all three bare tools out, deny rules remain effective, and other access profiles are unchanged. Corrected read flags have source and deterministic-test evidence, not a qualified live vendor run. Relative to published 4.2.0, protocol major 3, engine store schema 2 and the app compatibility floor of 4.0.0 are unchanged; this release adds no schema migration. Upgrades from 4.1.x retain the one-way 4.2.0 migration and full independent-backup requirement below. The existing version floor still prevents an in-place executable downgrade after the newer engine serves the data. Native interactive and live-provider qualification remain limited as recorded in the feature ledger.

- **v4.2.0** (2026-10-15): **Upgrade:** store schema 1 → 2 is one-way. Before upgrading, stop all writers and take a full independent backup; rolling back the executable does not restore data. See "Upgrade backup and restore" in `docs/ARCHITECTURE.md`. Account selection remembers successful service across restarts and uses it only to break otherwise equal unknown-headroom candidates; explicit pins, eligibility and known quota evidence keep priority. Agent and Ask runs record successful service, while raw model calls consume the same ordering evidence. Already-settled physical account refusals survive later failures and reach API, CLI, MCP and macOS diagnostics. Run and thread lists select addressed records before materializing them. Oversized Git capture keeps the answer, known monetary facts and original source work under existing custody, with an explicit capture limitation instead of an empty successful patch; terminal and retention paths preserve access to that work. Directory file-manifest capture keeps its separate refusal contract. Path-prefix trimming is linear on long slash sequences. **Upgrade:** the engine store migrates one-way from schema 1 to schema 2. An older engine refuses startup before binding any transport with `root_authority_floor_regression` after the version floor advances. If startup stopped after migration but before that advance, `store_schema_unsupported` can leave the older engine serving recovery only. Before upgrading, stop the daemon and its writers and make an independent, owner/mode-preserving copy without hard links: for the default layout all of `~/.claudexor` and `~/.cache/claudexor`; for an explicit `CLAUDEXOR_CONFIG_DIR`, the complete config root, `~/.cache/claudexor`, any externally referenced Claudexor-owned stores and, for the desktop app, `~/.claudexor/runtime`. Recovery preserves the newer state separately, restores the full backup to its original paths with private permissions and singly linked files, and selects the matching pre-upgrade engine compatible with the backup's recorded floor. It does not include work created after the backup; restored credentials may require sign-in again. There is no in-place downgrade, and an executable-pointer rollback alone does not restore data. See "Upgrade backup and restore" in `docs/ARCHITECTURE.md`. The macOS app now reports an engine update as successful only when the exact new engine also accepts normal work, and a rollback only when the previous engine does; an exact engine observed only in recovery mode during the update check stays selected with normal readiness unconfirmed, even if it later stops answering, and a failed or rolled-back attempt stays visible above its retained Install offer instead of being hidden by it. Already-installed older apps check identity only and can report an update or rollback over a recovery-only engine; they can still install this engine. Protocol major 3 and the app compatibility floor of 4.0.0 are unchanged. Native interactive and live-provider qualification remain limited as recorded in the feature ledger.

- **v4.1.1** (2026-10-12): A finished run now triggers scoped cleanup of leftover OS processes (#449). Each run carries a scope marker in every harness environment and in every deterministic gate it launches (candidate gates, its final verification and adoption; it survives `clean` inheritance, which also forwards an enclosing host's markers); the daemon records the harness root's process group the moment it registers, captures descendants on its existing pids tick and, at every terminal (success, failure, cancel, timeout) and at the next start after a crash, ends the scope's members by measured identity: marker members, recorded process groups under the pgid-reuse rule and recorded descendants (a member that moves to another process group is still the same process). On macOS the census reads only processes no older than the run (a cheap elapsed-time listing first, then the environments of the young ones), so a settlement no longer pays for a full environment dump of the host. Survivors, unreadable members and reused groups are recorded in `final/process_scope.yaml` instead of declaring the run clean; the terminal event is published only after the settlement and the attempt to record it (a record that cannot be written never changes the verdict), `GET /v2/runs/:id` always carries `summary.processScope` (the compact record once the run is terminal and the record is readable and valid, otherwise an explicit `null` that means unknown, never clean; the run list always reports `null`, so read the detail), and `daemon/run-scopes.json` (`{ "schema_version": 1, "entries": [...] }`) is a documented contract a host's emergency stop can read while the daemon is dead. One absolute settlement budget (5 s by default) starts when the daemon's custodian enters settlement for the run, bounds its own seed refinement, census, identity and table reads and signals, and never waits for another run; no read starts after it, what it cuts is disclosed as `incomplete`, never signalled late and never a verdict, and a cancel arriving during settlement does not turn a completed run into a cancelled one. A leftover holding the harness's stdout/stderr can no longer keep a run from finishing, and the bounded post-exit drain hands every frame already read to the consumer before it closes; Codex, the shared CLI loop (Claude, Cursor, Antigravity, OpenCode) and ACP disclose that closure as `output_drain: "truncated"` on their completed event, a gate's stored output as `output_truncated`, and only that closure is tolerated: a frame that breaks the bounded protocol, or any other stream error, is still a failure after it. Scoped-home sessions are told so (`CLAUDEXOR_HOME_SCOPED`, `CLAUDEXOR_OPERATOR_HOME`) and pointed at the operator's existing Playwright browser cache (an explicit `PLAYWRIGHT_BROWSERS_PATH`, including `0`, wins). Windows Codex preserves an explicitly completed answer when cleanup uncertainty is proof-only, but not after cancellation, a late root error, a failed or interrupted completion, a new root turn, or observed survivors; the `termination_unconfirmed` record remains (#454). Daemon status exposes native-COMMIT counts and durations since the engine store opened, without a durability or admission-policy change (#455). Disclosed limits: `completeness` is `complete` only on Linux with a readable census; on macOS it is `not_provable`, because SIP hides Apple platform-binary environments and a system binary that a shell started in the background and moved out of the root's group with `setsid` before any capture cannot be attributed; Windows coverage is `tree_only`; `claudexor review --diff` reviewers carry no run marker. The lifecycle changes were exercised with real processes and fixture harnesses on macOS; their complete native Windows matrix, real vendor-session acceptance and a real daemon crash-and-restart remain unverified. The separate Codex completed-answer repair has credential-free native Windows qualification; that does not certify the combined lifecycle implementation or installed vendor sessions.
- **v4.1.0** (2026-10-12): Create and edit images through a connected ChatGPT/Codex account using the existing caller-owned model-operation lifecycle. Exact edit bytes, usable partial images, requested versus observed model and unknown cost remain explicit; SQL dispatch barriers, recovery without another generation and whole-result acknowledgement preserve custody. Image-only quota windows stay visible without blocking text work. Unrecognised Codex full-read/rollout buckets are no longer quota constraints; notification payloads retain diagnostics without guessing applicability. Request-kind availability selection is HTTP-only; CLI/MCP retain text-default availability. Large image payloads can delay the daemon thread. This includes the 4.0.1 indexed-import fix and retains the forward-only SQL migration. Real adapter generation/editing was tested on one managed account before SQL; current real SQL/core tests use a synthetic provider, not a released live end-to-end proof. Thanks to @josephsteuerjr for the original image-operations contribution (#428).

- **v4.0.1** (2026-10-11): Fold verdicts now delete the previous rows of a slot or group through the `event_slot` and `event_group` indexes. Without planner statistics, 4.0.0 walked the whole partition for every such delete. On an install whose journal had one large partition (197,530 retained records in `global`), the first-start import spent about 40 minutes in that partition before it was stopped, with one to two hours projected in `recovery_only`, and one slot delete on the imported partition took about 150 ms of the request thread. The fixed import completed the same journal in about a minute. There is no schema or data change: stores that 4.0.0 already imported need no migration, and an interrupted 4.0.0 import resumes from its verified partitions with the fixed statements. As after every release, a data root served by 4.0.1 is refused by 4.0.0.

- **v4.0.0** (2026-10-11): The engine now stores commands, conversations, resource metadata and retained events in one SQLite database. Startup imports legacy journals once, reports its progress, and preserves their original bytes, run artifacts and accounts. Addressed reads and in-process control calls keep historical payloads out of normal polling; status exposes storage, event-loop and admission facts. Model calls and long sessions share one queue with optional separate caps; omission means unlimited, an existing explicit global cap stays global, and thread ordering, Delegate overflow and strategy widths remain unchanged. Cancellation before provider dispatch reports that no request was sent. Managed plugin repair preserves the selected command, root and lifecycle owner. Breaking requirements: Node 24.15 or newer and Claudexor.app 4.0 for desktop engine updates; an older app keeps its working engine and asks for an app update. Committed acknowledgements survive engine crashes, while power loss can lose commits after the last completed flush barrier; paid model dispatch and native account-reset effects wait for that barrier. Logical recovery isolates a project, physical corruption uses whole-store recovery, and earlier generations remain evidence. The migrated format is forward-only: downgrading to 3.x is unsupported. Live event streams expose retained rows, so a superseded row may not be delivered.

- **v3.25.1** (2026-10-10): Accounts exposes independently dated balances, spending and reset inventory alongside included quota, exact-account refresh, and explicit Codex and Claude resets through the control API, CLI, MCP and native interface. Claude granted resets and five-hour session refill remain distinct; original request identity survives uncertain replies, provider outcome stays separate from readback, and unknown values remain unknown. This carries forward the account-resources feature from 3.25.0, which remained an unpublished candidate. Linux SSH release verification now uses the identical Docker Official Ubuntu 24.04 amd64 image from ECR Public, pinned by digest, to avoid shared Docker Hub anonymous pull quotas. All smoke assertions and cleanup remain unchanged, as do routing and paid-usage policy.

- **v3.25.0** (2026-10-09): Accounts now exposes independently dated balances, spending facts and reset inventory alongside included quota, with exact-account refresh and explicit Codex and Claude resets through the control API, CLI, MCP and native interface. Claude granted resets and five-hour session refill remain distinct. Original request identity survives uncertain replies, provider outcome stays separate from readback, and unknown values remain unknown. Existing routing and paid-usage policy are unchanged.

- **v3.24.0** (2026-10-09): Inspect and maintain vendor programs through one CLI/control operation. Managed npm installations support explicit updates beyond the bundled baseline and return by reinstalling a known prior version; Connect preserves runnable newer installations. Cursor and Antigravity use their native latest-version updater on supported POSIX installations. Durable operation identity, cancellation and before/after evidence retain partial and uncertain effects without automatic retry or rollback. Explicit Codex models absent from a successful catalog can be attempted with their original ordinary effort, while discovery, authentication and quota failures keep distinct causes. Catalog admission is opt-in and legacy response shapes are preserved.

- **v3.23.2** (2026-10-09): Run-start replay preserves canonical key conflicts and invalid-key refusals, while unavailable idempotency lookups keep same-key recovery and expose the safe underlying cause and lookup stage. A failed second lookup also retains the preceding preflight refusal. Canary fixtures always launch their built candidate on an isolated endpoint; uncertain stop or a live successor keeps the fixture and its cleanup diagnostic instead of deleting evidence.

- **v3.23.1** (2026-10-09): Session continuation resolves history by both harness and profile, so matching account names across Claude Code, Codex and other harnesses no longer redirect transcripts into the wrong store. Disabled source accounts remain readable for history transfer while target admission stays unchanged. Claude's failed terminal missing-session diagnostic now selects the existing evidence-packet continuation instead of repeating an unavailable native resume. Mixed-harness regression coverage exercises Agent, Ask, explicit continuation, capsule relocation and real Claude/Codex filesystem transfers. Previously misplaced transcripts are preserved but are not automatically relocated.

- **v3.23.0** (2026-10-09): External orchestrators can keep a multi-round checking conversation in a caller-owned working copy with `POST /v2/threads {workspace: "delegated", workspaceRoot}`. The thread durably binds its execution root and keeps one scoped lane home per thread, harness and resolved account; Agent, Ask and Plan turns follow that root instead of the author's project. The caller owns exact staged-subject and named-evidence preparation, refreshing only after it establishes quiescence. Run summaries expose `executionRoot`; file galleries, retained output, artifact previews, remote images and manual directory-result application resolve the bound execution root, and project file reads correlate `runId` to that project. The caller's workspace is never silently applied, promoted or deleted by thread purge. Accepted creation replay and restart/runless-turn recovery keep their existing command identities; missing workspaces refuse with a recorded retryable cause. INV-034 and INV-073 are amended; protocol major and app compatibility floor are unchanged. Controlled production HTTP/fake-harness stories exercise staged subjects A/B, ignored evidence, native-resume receipts, persistent lane homes, replay, recovery, Apply/Purge and crash-custody boundaries. Native writable Claude/Codex/Cursor/OpenCode/Antigravity continuity on this version is NOT_RUN under the owner's explicit native-login qualification waiver. Live SSH and rendered-app checks are also NOT_RUN; controlled HTTP and Swift tests are not substitutes for those flows. A private checking copy is not an OS sandbox, vendor state retention is route-specific, and restart-terminality does not prove process quiescence: the caller must reconcile before refresh. Existing startup ghost-project retirement can remove a missing project from replay lookup; the app can continue but not create delegated threads. Detailed caveats remain in docs/FEATURES.md. The large orchestrator test suite's temporary-directory cleanup now uses the same 30-second hang detector as its test bodies, without changing product checks.

- **v3.22.1** (2026-10-08): The engine no longer runs out of memory by reading its whole history. Every read of retained runs now names what it needs (one run or turn, a continuation chain, a delegated subtree that stays uncapped, a thread, the active commands, or one keyset page selected inside the daemon), and collection answers carry short summaries with the existing 240-character prompt preview instead of every stored prompt (new invariant INV-142); on 7 October an un-addressed list copied hundreds of megabytes through the daemon's own heap and exhausted Node's default ceiling of about 4 GB. Project removal and startup retention read an in-process projection instead of calling the daemon over its own socket. A local RPC timeout or a dropped daemon socket now answers a retryable 503 (`daemon_busy`, `daemon_unavailable`) instead of `400 invalid_request`, typed refusals keep their `context.head` and required actions, and a thread turn whose enqueue answer was lost stays retryable so its retry finds the accepted job instead of enqueueing it twice; an untyped enqueue failure on `POST /v2/runs` now reports `internal_error`. The engine names its own heap ceiling in `claudexord --probe` (`launch.nodeArgs`: half of the machine's memory, or of a container limit below it, at most 16 GiB and never below Node's default); the CLI and the macOS app pass it, and an explicit `--max-old-space-size` in `NODE_OPTIONS` still wins. `GET /v2/daemon/status` reports current and admission-time heap and RSS. An admitted continuation whose source run vanished is refused with `continuation_predecessor_unavailable` instead of silently starting fresh work, and project removal checks activity in the same synchronous step. Resident journal growth itself (thread-entity folding, prompts by reference, lazy partitions) and continuation from archived projects belong to the next minor release.

- **v3.22.0** (2026-10-07): Work that stopped in the middle now continues from where it stopped instead of failing or starting over. Inside one attempt, a try that already acted continues after a typed vendor limit on the next eligible account: the Claude Code or Codex session file is moved into that account's store and resumed there (`native_moved`), or, when it cannot be moved, a new session of the same model is re-briefed by a mechanical evidence index of the interrupted work (`packet`); a process death resumes the same session on the same account (`native`), a death after progress without a reported session continues with a same-account packet, and both are bounded by `transient_retry.max_retries`; a partially acted attempt never replays its original prompt, and the continued process gets one constant notice instead of the work order (#398). A stopped run can be continued as a new run with `POST /v2/runs {continueFrom: <runId>, prompt}`: one accepted successor per run with typed refusals (`predecessor_unknown`, `predecessor_live`, `continue_from_with_thread`, `continue_from_unsupported`, `continuation_superseded` with the chain head), mode, scope, execution, harness and model inherited as groups, the same carrier ladder for the first try, and `continueCarrier: "packet"` to force a re-brief. A stopped isolated Agent run keeps its envelope until a successor adopts it, its result is applied or it is discarded, and `GET /v2/runs/:id` projects `resumable`, the per-try `continuity` receipts, `retainedEnvelope` and `continueFrom` (#399). Every continued try is disclosed by a `run.continuity` receipt (carrier, cause, accounts, memory, the try's attested model, identity check, input delivery); input whose delivery is not proven, including an admitted steering message, travels with the notice as a reference to reconcile and is never replayed. The engine compares a resumed session id only on adapters with the new optional `continuity` capability (Claude Code and Codex, which keep the id on resume); other harnesses record a new id as before. Verification: deterministic tests on a scripted harness cover the carrier ladder, moves, identity, packets, custody and admission; session moves between two real accounts were exercised by hand for Claude Code and Codex before implementation; the engine's own continuation on the real vendor processes is verified in operation after this release (every continued try leaves a `run.continuity` receipt), so a defect found there ships as a patch release. Disclosed residuals: Plan runs and thread turns keep their own continuation paths; Cursor, Antigravity and opencode continue with a packet after progress (no cross-account move); credential profiles that alias one vendor account are not deduplicated; a continued run that inherits a multi-harness pool continues only its first candidate with the notice; a source session copy that cannot be retired after a move leaves a stale copy without a receipt field. INV-046, INV-135 and INV-137 are amended. The app compatibility floor is unchanged.

- **v3.21.0** (2026-10-05): One effort word now works on every route instead of failing a run. The vendor's own ladder still ranks every level it lists; a shared preference order (`none < minimal < low < medium < high < xhigh < max < ultra`) places a word a route does not list, so `ultra` on a Claude binary that stops at `max` runs at `max` and `none`/`minimal` run at the route's minimum, with the placement named in the effort receipt; a ladder that also lists unfamiliar words still places by the levels the two orders share, a word neither order knows is still refused on routes with a native effort knob, and a reviewer whose harness has no effort control keeps the preference as omitted instead of failing the panel. On Cursor and Antigravity, where the level is part of the model id, an effort preference selects the listed level variant of the same model family from the running account's own list (`grok-4.7-high` with `max` runs `grok-4.7-xhigh`; fast and thinking variants never cross); the processing receipt records the id actually sent and the timeline names the change. Codex app-server runs bind the final answer, the terminal turn and root failures to the root thread, including frames that arrive before the thread is named, so a native sub-agent can no longer replace the root's answer or fail it; sub-agent tokens stay counted. Where the WorkReport footer is only requested in text (Cursor, Antigravity, ACP), a missing or broken footer leaves the run succeeded with `work_state: unverified`, its reason shown in the outcome and the whole answer kept; valid `needs_input`/`incomplete` reports still veto, and the native Codex and Claude envelopes stay strict. A secret-like string in agent output no longer rolls back a patch, discards an isolated candidate or drops the answer: the changed files keep their exact bytes, saved and served copies are masked line by line and disclose counts (read-only answers included), Apply reads a private exact patch object bound by `patch_sha256`, `pr` delivery refuses a secret-like patch before any push, and the raw API's sensitive-content refusal code is retired (INV-030, INV-041, INV-062, INV-104 and INV-105 amended). Also included: quota observations from #392 (older refusals reconciled with newer observations, per-account pacing, Antigravity model discovery for the selected account).

- **v3.20.1** (2026-10-04): The first published release of the 3.20 line: a generic ACP v1 client harness with GitHub Copilot CLI first, durable thread folders and a thread trash lifecycle, plus three fixes that landed after v3.20.0 was tagged. v3.20.0 was tagged and built but never published (main moved before its publish run finished). Managed CLI and remote sign-in flows now complete, actionable Claude CLI version failures are preserved, and native and standard npm Node entrypoints resolve consistently across launch, probes and login (#388). Received assistant text and cancelled Git effects are preserved without changing completion authority or starting another generation: retained Markdown is shown beneath the real failure or cancellation cause, interrupted output is recovered from its existing event log, and manual Revert is bound to the captured execution tree (#387). Account refusal and recovery evidence stays consistent across execution, account selection and Accounts, with managed credential generations protecting newer state from late results; independently measured Claude Code and Codex quota windows from running sessions are preserved without treating partial observations as a complete refresh, and safe native refusal and refresh diagnostics are retained (#389). Disclosed residuals of these fixes: the Windows npm entrypoint path now also admits a local Claude Code install (`claudexor harness install claude --target local`), with x64 CI install, doctor and launch evidence only; native Windows login and Agent runs and win32-arm64 remain unverified. Account refusal evidence stays in daemon memory (a restart forgets it), the standalone `claudexor review` and library embedders without an injected authority do not write daemon account state, and account changes made outside the managed lifecycle stay unknown until vendor evidence or expiry. The 3.20 line itself: a generic Agent Client Protocol (ACP v1) client harness, `packages/harness-acp`, with GitHub Copilot CLI as its first vendor row: token-first through the managed secret `copilot` (handed to the CLI as `COPILOT_GITHUB_TOKEN` in an isolated environment with scoped `HOME` and `COPILOT_HOME`; ambient GitHub tokens are not picked up), access profiles mapped to Copilot's tool flags with an explicit deny subtracted from the allowlist, typed translation of ACP events (a typed tool error survives split `tool_call_update` frames), process-tree cancellation, a free session doctor whose checks carry the shared readiness ids `installed` and `api_key`, advisory model discovery, an explicit paid adapter-API conformance probe, the macOS Copilot card that stores its managed token and re-checks readiness, Copilot in the remote harness install menu with the credential step as its next step, and `claudexor harness install copilot` with the secrets namespace. Threads gain durable folders and a trash lifecycle in the daemon and the macOS app: one optional `folder` label per thread, journaled and returned on every projection, set through `POST /v2/threads` or `PATCH /v2/threads/:id` without reordering thread lists; the sidebar groups active threads by folder (plain list while no thread has one) with Move to Folder, New Folder, Rename and Remove Folder; Delete moves a thread to a collapsed Trash section, Restore brings it back for 30 days, Delete Now purges after a confirmation that states exactly what is removed and what stays and never promises to erase the conversation; a failed or unanswered Delete Now re-reads the list and calls the thread deleted only when that list skipped no project and dropped no row; Archived threads sit in their own collapsed section; purge answers 409 `thread_busy` while any turn of the thread runs; the retention pass purges expired trash, finishes purges whose directory cleanup failed after being journaled (`purged_threads` and `purge_leftovers` in the receipt, `claudexor gc --dry-run` lists them), and ACP `session/list` hides trashed threads. Thanks to @IlidanNaga for both thread features, and to Róger Valderrama (@germago119) whose razzant/ouroboros#769 is the source of the Copilot permission policy, environment allowlist, launch flags, event translation and lifecycle semantics (the Q00 MIT notice ships in `packages/harness-acp/NOTICE`). Disclosed residuals: Copilot ACP is a preview, the doctor never reports `ok` (a working install reports `degraded`, even after the paid conformance probe, which is adapter-API-only: no CLI, daemon or app surface invokes it yet), so an unpinned reviewer slot refuses Copilot and only an explicit `copilot:<profile>` profile is routed; live input, native login and MCP injection are not included; `--no-remote` is passed but unverified on an account without the remote-sessions feature, and `--no-remote-export` is not passed; the Copilot environment on Windows lacks `APPDATA`, `LOCALAPPDATA` and `USERNAME`; live Copilot was not exercised on the release machine (stage 2 is tracked in #383); a thread whose project partition is in journal recovery is skipped by the list without a `problems` entry, so the Delete Now classification does not see that gap. The app compatibility floor is unchanged.

- **v3.20.0** (2026-10-04, tagged but not published; shipped as v3.20.1): A generic Agent Client Protocol (ACP v1) client harness, `packages/harness-acp`, with GitHub Copilot CLI as its first vendor row: token-first through the managed secret `copilot` (handed to the CLI as `COPILOT_GITHUB_TOKEN` in an isolated environment with scoped `HOME` and `COPILOT_HOME`; ambient GitHub tokens are not picked up), access profiles mapped to Copilot's tool flags with an explicit deny subtracted from the allowlist, typed translation of ACP events (a typed tool error survives split `tool_call_update` frames), process-tree cancellation, a free session doctor whose checks carry the shared readiness ids `installed` and `api_key`, advisory model discovery, an explicit paid adapter-API conformance probe, the macOS Copilot card that stores its managed token and re-checks readiness, Copilot in the remote harness install menu with the credential step as its next step, and `claudexor harness install copilot` with the secrets namespace. Threads gain durable folders and a trash lifecycle in the daemon and the macOS app: one optional `folder` label per thread, journaled and returned on every projection, set through `POST /v2/threads` or `PATCH /v2/threads/:id` without reordering thread lists; the sidebar groups active threads by folder (plain list while no thread has one) with Move to Folder, New Folder, Rename and Remove Folder; Delete moves a thread to a collapsed Trash section, Restore brings it back for 30 days, Delete Now purges after a confirmation that states exactly what is removed and what stays and never promises to erase the conversation; a failed or unanswered Delete Now re-reads the list and calls the thread deleted only when that list skipped no project and dropped no row; Archived threads sit in their own collapsed section; purge answers 409 `thread_busy` while any turn of the thread runs; the retention pass purges expired trash, finishes purges whose directory cleanup failed after being journaled (`purged_threads` and `purge_leftovers` in the receipt, `claudexor gc --dry-run` lists them), and ACP `session/list` hides trashed threads. Thanks to @IlidanNaga for both thread features, and to Róger Valderrama (@germago119) whose razzant/ouroboros#769 is the source of the Copilot permission policy, environment allowlist, launch flags, event translation and lifecycle semantics (the Q00 MIT notice ships in `packages/harness-acp/NOTICE`). Disclosed residuals: Copilot ACP is a preview, the doctor never reports `ok` (a working install reports `degraded`, even after the paid conformance probe, which is adapter-API-only: no CLI, daemon or app surface invokes it yet), so an unpinned reviewer slot refuses Copilot and only an explicit `copilot:<profile>` profile is routed; live input, native login and MCP injection are not included; `--no-remote` is passed but unverified on an account without the remote-sessions feature, and `--no-remote-export` is not passed; the Copilot environment on Windows lacks `APPDATA`, `LOCALAPPDATA` and `USERNAME`; live Copilot was not exercised on the release machine (stage 2 is tracked in #383); a thread whose project partition is in journal recovery is skipped by the list without a `problems` entry, so the Delete Now classification does not see that gap. The app compatibility floor is unchanged.

- **v3.19.0** (2026-10-03): Claudexor ships as portable Claude Code and Cursor packages. `plugins/claude` and `plugins/cursor` carry the canonical Skill and the MCP server registration (no runtime, credentials, hooks or status-line collector; those stay with the managed `claudexor plugin install` integration), so a host adds this repository as a Claude Code marketplace (`claude plugin marketplace add razzant/claudexor`, then `claude plugin install claudexor@claudexor`) or loads `plugins/cursor` as a local Cursor plugin; the packages start `claudexor mcp serve` from a preinstalled `claudexor` CLI on the host PATH and need an existing daemon/account setup (macOS/Linux, Node.js 20.19+), and only one Claudexor integration per host should be enabled, because a second copy registers a duplicate MCP server. The canonical Skill and the managed-integration text now describe `claudexor_accounts` truthfully: the plain call returns the cached listing and `fresh: true` requests the expensive atomic snapshot. The Antigravity adapter declares the Gemini 3.8 Flash model ids (`gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`), which Ouroboros onboarding asks agy for; the verified CLI version stays 1.1.13, the version the recorded fixtures were captured against, and the ids were confirmed live on 2026-10-03. Production dependencies move to @agentclientprotocol/sdk 1.5.1 (message-size and per-connection memory limits), @modelcontextprotocol/server 2.2.0, @playwright/mcp 0.0.83, zod 4.6.5 and yaml 2.9.1, and the release SBOM test reads the packaged Browser MCP version from packages/core instead of a literal. Thanks to @skalsin for the Gemini model definitions, a first contribution. Disclosed residuals: a live install of the portable packages into a Claude Code or Cursor host was not exercised on the release machine, which already runs the managed integration; the agy fixtures remain recorded against CLI 1.1.13 while the host CLI self-updated to 1.2.16 during the id check; the Antigravity third-party model block still lacks the Claude 5.5 ids and lists two stale 4.6 ids (#374). The app compatibility floor is unchanged.

- **v3.18.0** (2026-10-02): Persistent MCP conversation tools can create, continue and inspect threads through the daemon, preserving thread mode and exact replay after a lost response. The macOS app previews agent-produced Markdown with a source toggle and keeps HTML/SVG passive. Selected native profiles retain their own billing evidence through dispatch and rotation. Cursor discovery also finds installations named `agent`, and background children on Windows request hidden consoles while interactive terminals stay available. Native Codex app-server retry notices now remain visible as nonterminal activity without changing final success, failure, account routing or retry policy. Thanks to @IlidanNaga for the thread, preview and profile contributions, @Petyok for Cursor discovery, and @kzmx23 for the Windows work and reconnect investigation that motivated the retry repair. The original Windows incident was not replayed; the repair was verified with recorded, credential-free Codex 0.156.1 traffic and isolated outcome controls.

- **v3.17.2** (2026-09-30): Native input-size refusals retain their cause and measurements without futile account retries or unrelated quota resets. Clients can discover verified Unicode-scalar ASK budgets, including thread framing. Codex model requests preserve the existing network client while streaming exact bodies and recording proven non-delivery separately from unknown outcomes. Claude and AGY move large prompts off process arguments, with Claude system additions kept in their native role. Adapt Codex raw-model Ultra preferences to the strongest supported generation effort in the vendor order, preserve explicit effort evidence, and keep native Ultra delegation unchanged (#368). Login cancellation and timeout keep checking process-group death through transient exit-time probe errors within the existing grace period.

- **v3.17.1** (2026-09-28): Reasoning effort is resolved as a route-owned preference, with separate requested, prepared native and provider-observed values. Exact supported values pass through; verified comparable ladders allow a disclosed adaptation without inventing a universal vendor scale. Missing or malformed capability evidence stays unknown, and a prepared setting is never labelled as sent or observed. Model-operation clients may opt into `captureEffortEvidence: true` at creation; the choice is bound to idempotency and immutable results, while legacy clients keep their result and catalogue shapes. Agent attempts retain typed effort facts in telemetry and silent diagnostic events rather than assistant speech. Effort refusals do not trigger runtime account, model or harness fallback; temporary Codex credential homes are cleaned up even when preparation refuses or the iterator closes early. Authentication smoke verification accepts only a validated, non-generative effort-preparation event before the ordinary started lifecycle, retaining its route and challenge checks. Disclosed residuals: CLI-wide capability evidence is not model-specific, absent provider echoes remain unknown, incomparable ladders remain conservative, and a generic status row may still appear in the diagnostic timeline. Real vendor generations are not a claim of the deterministic release tests. The app compatibility floor is unchanged.
- **v3.17.0** (2026-09-26): Claude Code runs accept live messages too. The Claude adapter declares `live_input: next_tool_boundary`: a message sent to `POST /v2/runs/:id/messages` is written to the running session's stdin as a native stream-json user frame with the message id as its `uuid`, which Claude Code queues at once and folds into the running turn right after the current tool batch (recorded on Claude Code 2.1.283 with `--replay-user-messages`). Receipts are typed from the CLI's own frames: `accepted` when the `command_lifecycle` frame reports the message queued, `delivered` when the replay echo, the `started` lifecycle frame or `result.user_message_uuids` shows it was consumed (one `live_input_delivered` status event per message), `rejected`/`rpc_refused` when the CLI cancels, discards or refuses it, `delivery_unknown` when no queue receipt arrives within two seconds or the transport is lost. A message that arrives while the model is already writing its final text runs as the next native turn of the same process: the run loop now lets an adapter hold stdin open past a terminal frame (`session.onIo` seam, a holdable `closeStdinOn`), the Claude adapter keeps the session open while a message is queued or started or a run-owned background task is open, the parser reports the cost DELTA between results (`total_cost_usd` is cumulative across turns), emits one `started` per run and a typed `native_turn_started` status for each later turn, and the `--replay-user-messages` echoes and `command_lifecycle` frames are recognized plumbing. Two recorded fixtures pin both shapes. `POST /v2/runs` for a project root that is not registered now answers the typed `404 project_not_registered` (retryable: false, with the one remedy: register the root with `POST /v2/projects` or declare `scope.ephemeral`) instead of a retryable `503 idempotency_status_unavailable`; Exact Retry shares the fix and a root unregistered between the idempotency lookup and enqueue gets the same answer. Disclosed residuals: delivery waits for the current tool batch (a long tool call delays it), and `command_lifecycle` frames are marked internal by Claude Code (the documented replay echo and `user_message_uuids` are the authoritative receipts). The app compatibility floor is unchanged.
- **v3.16.0** (2026-09-26): A message can be placed into a run that is already executing. `POST /v2/runs/:id/messages` hands `{text, expectedAttemptId?}` to the run's active agent attempt with journal-first admission (a `message.accepted` row is appended through a failure-propagating append before any native dispatch; when that append fails the receipt is `rejected`/`admission_persist_failed` and nothing is sent), typed outcomes `delivered | accepted | rejected | not_active | unsupported | delivery_unknown` with a typed `reason`, and a key-required idempotent receipt (the `Idempotency-Key` is the message id; a replay returns the stored receipt, a different body under the same key is `409 idempotency_conflict`). Every typed outcome is HTTP 200 so clients read `outcome`, never the status. Each harness declares its live-input channel as `capability_profile.live_input`, projected as `liveInput` in `GET /v2/agent-capabilities`: Codex is `mid_turn` through the app-server `turn/steer` request (`accepted` = the `{turnId}` reply; `delivered` = the `userMessage` echo whose `clientId` equals the message id, recorded on codex-cli 0.156.1; a refusal on a still-active turn is `rejected`/`rpc_refused`, a turn that already moved is `not_active`, transport loss or a 30 s silence is `delivery_unknown`, and a steer never cancels the run); Claude Code declares `none` (recorded on 2.1.282: a user frame written mid-turn is consumed only as the next turn, after the first `result` frame at which the adapter closes stdin); Cursor, Antigravity, OpenCode and raw-api declare `none`. Only agent runs register a live target: Ask and Plan runs, thread turns and runs with several live attempts but no `expectedAttemptId` answer typed refusals, a pending interaction answers `not_active`/`interaction_pending` without a vendor write, and steering is attempt-local (a native transient retry follows the new session, a convergence attempt or rerun never re-injects earlier messages). Timeline rows carry `messageId` and `outcome`, the message text lives only in the run's own `events.jsonl` (the journal copy keeps the digest), and the deterministic `fake-steerable` harness kind drives the canary story. This release lands on the community app-server lifecycle work from PR #355 (runs stay active for native background work; the Codex adapter runs `codex app-server` over stdio JSON-RPC). Disclosed residuals: a receipt landing after the run's terminal commit is durable in `events.jsonl` but misses the live SSE push; a consumed steer is not inactivity-watchdog progress until the model's next output; no CLI verb or MCP tool yet (`claudexor follow` is the later surface). The app compatibility floor is unchanged.
- **v3.15.1** (2026-09-25): On Windows the CLI exits with its command's own status instead of aborting natively after printing valid output, so a successful `claudexor doctor --json` no longer ends in a libuv crash (#356). After stdout and stderr drain, the Windows CLI sets its exit code and lets Node exit naturally; the forced `process.exit()` it used before raced isolate teardown after `doctor`'s `fetch()` and, on Node 24.16, aborted with `UV_HANDLE_CLOSING` (0xC0000409, nodejs/node#56645; upstream fix nodejs/node#61999 shipped in Node 24.20.0) after the JSON was complete. An unref'd one-second backstop still forces the exit when a stray handle keeps the loop alive, output still drains first so large JSON projections are not truncated, and Linux and macOS keep the immediate exit. The Windows local-install smoke (`scripts/windows-local-install-smoke.mjs`) now fails when `doctor --json` exits non-zero or by signal before it trusts the JSON, and both Windows CI lanes (Node 20 and 24) run the exit-path regression (`packages/cli/src/cli-io.test.ts`). Published v3.15.0 is affected on Windows: its `doctor --json` could print valid JSON and then abort on Node 24.16, and its install smoke did not check that exit. Disclosed residuals: a future persistent stray handle still reaches the forced one-second backstop; a live Windows ChatGPT login and a real Codex task are not exercised by CI; win32-arm64 has no CI runner proof; issue #191 stays open for Claude/OpenCode and an operator's ambient npm install. The app compatibility floor is unchanged.
- **v3.15.0** (2026-09-25): Codex installs locally on Windows through the managed toolchain, and doctor, login and runs resolve the image it installs. `claudexor harness install codex --target local` no longer refuses on Windows: a Windows npm global prefix holds only `.cmd`/sh/ps1 shims and Claudexor never spawns a harness through a shell, so the installer runs the toolchain's own npm (`node_modules\npm\bin\npm-cli.js` beside `node.exe`, never an ambient `npm`) against the exact pin and proves the vendor's `codex.exe` inside the pinned `@openai/codex-win32-<arch>` platform package. The harness PATH carries that image directory on win32, so every local surface resolves the same `codex.exe` by bare name; one core layout owner serves both the install proof and the PATH producer, and the receipt fields are unchanged. Claude, OpenCode, Cursor and Antigravity keep a typed `unsupported_platform` refusal on the Windows local target, now naming the exact reason, and an unsupported architecture refuses the same way. Both x64 Windows CI lanes install the real pinned package on the exact embedded Node with no ambient node/npm and an isolated profile, then check the receipt, direct and by-name `--version`, the idempotent recheck and `doctor --json` (`scripts/windows-local-install-smoke.mjs`). Disclosed residuals: win32-arm64 has no CI runner proof; a live Windows ChatGPT login and Agent run are not exercised by CI; an operator's own ambient npm install of Codex, and Claude/OpenCode on Windows, still meet issue #191, which stays open. Linux and macOS behaviour is unchanged. The app compatibility floor is unchanged.
- **v3.14.0** (2026-09-24): New vendor models become usable without a Claudexor release per model (#338, #339, #340). Whether a model list may refuse an explicit model is now each harness's own declaration (`model_inventory_absence`), honoured on live and manifest lists alike: Claude, Codex and Cursor declare `advisory`, so an id their list lacks is persisted or forwarded byte-identical and the vendor decides, with the admission said once (the settings read-back carries `notes`, printed by the CLI; the doctor readiness row carries the note in its detail; the per-spawn gate keeps its status event); raw-api, agy and opencode stay authoritative, the automatic reviewer panel keeps its zero-cost skip, HTTP model operations stay strict, and refusals state observations instead of guessing a cause (INV-104 amended, CONCEPT-CHANGE). Claude models are discovered from the installed binary: the adapter's `models()` runs the prompt-free `initialize` handshake (a `config_dir_login` profile under its own config dir, an `api_key`/`oauth_token` profile with its own credential, the unscoped listing credential-free) and returns the picker's selectors with their resolutions as pinnable exact ids (`origin: live`, `resolved_model`) plus the frozen hints (`origin: hint`); a failing binary yields the hints and the listing reports `source: manifest`; the probe, the `--help` effort memo, the readonly-flag probe and the `--version` read all follow the binary a run's PATH patch selects, keyed by the binary's identity so an in-place CLI update is re-read without a daemon restart. The Codex HTTP catalog declares its own verified client version (`CODEX_HTTP_CLIENT_VERSION`, raised to a newer installed CLI, memoised by binary identity, never lowered), so floored models such as `gpt-6-sol` no longer hide behind the installer pin; the negotiated account view carries `clientVersion`/`clientVersionSource` and both membership refusals name the declared version. Managed vendor pins catch up to Claude Code 2.1.281 and Codex 0.156.1 with snapshots and credential-free recordings re-captured from the real binaries (`known_models` gains `gpt-6-sol`/`gpt-6-luna`; the Claude hint stamp stays at its last verification, 2.1.261; an already-installed CLI is not replaced, and on a kept older CLI a run whose live effort probe fails proceeds at the vendor default with the ignored-settings disclosure). Disclosed residuals: a mistyped explicit model on an advisory harness costs one spawn and returns the vendor's own text; the explicit reviewer panel forwards without the run-event disclosure; the agent capability catalog's `configuredModelValid` stays a boolean without the note; the `--help` memo is one slot and relative PATH-patch entries resolve as the daemon sees them. The app compatibility floor is unchanged.
- **v3.13.0** — Configure daemon and strategy capacity in user-global YAML or environment: regular jobs now default to 24; candidate/scout parallelism, deep-scan width and Council membership keep their prior defaults with configurable upper bounds. Changes take effect on the next daemon start, with configured/effective/restart-required diagnostics. Council's macOS picker follows effective capacity. Nested Delegate limits and same-thread serialization remain unchanged. Explicit new YAML keys must be removed before rollback to an older strict-config engine.
- **v3.12.10** (2026-09-21): A run's failure record now carries the vendor's own failure code beside its words. `codex exec --json` drops the machine-readable code that Codex's rollout record keeps (a capacity refusal is `server_overloaded`), so `RunFailure` gains an optional, nullable `vendorFailure: { code, message, source }` read fail-soft from that record after the process exited, bound to the current turn and `null` on any doubt or for any harness without such a channel; the code is opaque evidence that nothing branches on. A harness that voiced its own error and then exited non-zero is an `unknown_harness_error` with an explicit `retryable: false` instead of a process crash, `route.transient.exhausted` reports the observed retries beside the configured maximum, and retry, rotation, cooldown and credential verdicts read exactly the inputs they read before. The app compatibility floor is unchanged.
- **v3.12.9** (2026-09-21): A Codex model list that omits a model no longer makes Claudexor refuse a run that asks for it. The Codex CLI serves a bundled default list when its remote fetch times out and nothing on the wire says which list answered, so a harness now declares what its live inventory proves (`model_inventory_absence`, default `authoritative`): Codex declares `advisory`, and an explicit model its list lacks — or an empty list — is forwarded to the vendor unchanged and disclosed once in the run's events, in both run gates and the explicit reviewer panel. Manifest truth, settings writes, the doctor, automatic reviewer selection, authenticated model operations, pinned accounts and the probe cache are unchanged. A vendor refusal on the CLI run path arrives as an ordinary error carrying the vendor's text, and a mistyped model on such a harness now costs one spawn. The app compatibility floor is unchanged.
- **v3.12.8** (2026-09-20): Codex interrupted-stream diagnostics now record the last parsed SSE event and its silence separately from byte-chunk timing, so a later heartbeat or unfinished frame cannot make an old event look recent. Unknown outcomes and the no-retry policy are unchanged.
- **v3.12.7** (2026-09-20): structured review outputs preserve caller-optional fields when strict vendor transport emits `null`, while required and caller-nullable fields retain their original validation. Codex Responses failure evidence now records monotonic chunk timing and deterministic interrupted-stream diagnostics without enabling automatic retries or changing unknown-outcome custody.
- **v3.12.6** (2026-09-20): A Codex response that names no model, such as a refused or torn body, now leaves the live turn continuation exactly as the caller sent it, so an ordinary mid-turn error no longer starts a fresh conversation with the vendor. The app compatibility floor is unchanged.
- **v3.12.5** (2026-09-20): A subscription account can answer a request for one model with a different model, without an error and without anything in its quota. Such a response now carries a typed mismatch fact, the account is ranked after the others for that model for half an hour without being excluded, and a conversation turn it answered is sent on through its own content and tool calls instead of refusing the next request. The app compatibility floor is unchanged.
- **v3.12.4** (2026-09-19): Codex model discovery and quota checks now find the same CLI and Node runtime as sign-in and agent runs on GUI installations, while preserving scoped account homes and credential isolation.

- **v3.12.3** (2026-09-18): a run marked `execution.delegated`, driven by an external orchestrator that owns the workspace, may request `access: full` without a user-level trust record. Runs an operator starts at a surface are unchanged: they still require the one-time grant and still receive the same typed 403 refusal with its retry remedy, and the effective profile of an admitted delegated run is still recorded as `full` rather than downgraded. Two surfaces can set the marker and the exemption costs something different on each. A control-API client holds the daemon token and can already grant itself the allow through `POST /v2/trust`, so the second ceremony bought nothing there. An MCP tool caller is the host's model, holds no token and has no trust-writing tool: for it this is a real widening, because one call with `execution.delegated: true` and `access: "full"` now runs unsandboxed native `full` on any `repoPath` without the grant, where before it was refused, and the only remaining control is the host's own MCP tool-approval policy. The macOS app cannot originate the marker, though Retry Exact and Run Again carry a recorded one forward, as do `claudexor retry` and `claudexor run-again`; belt sub-runs and public thread turns cannot set it. The Claudexor.app compatibility floor stays at 3.11.0 (no new wire contract the app must decode).

- **v3.12.2** (2026-09-18): accounts remain eligible by default until quota usage reaches 100%, so the final 10% stays available for routing and rotation. Explicitly configured lower thresholds remain effective; vendor cooldowns and exhausted windows still block selection.

- **v3.12.1** (2026-09-16): reading ONE run no longer serializes every retained run. The daemon's retained-command list RPC now takes an optional query addressing a single subject — one run id, or one parent's direct Delegate children — and selects before it redacts, so `GET /v2/runs/:id` (the status poll every embedding host makes) stops recursively projecting the prompts of unrelated runs. A measured install carried 1,627 retained records over 150.3 MB, 98.6% of it params. The honest cost is a reference and metadata scan over the retained records plus a sort over the matching children: not constant time, not constant memory, and unrelated to journal cold-replay memory or historical timeouts. The unqualified read, the global `GET /v2/runs` page, and the uncapped transitive cancellation cascade are unchanged; an engine older than the query ignores it and answers in full, so callers keep applying their own selection. The engine update keeps the Claudexor.app 3.11.0 compatibility floor (no new wire contract the app must decode).

- **v3.12.0** (2026-09-14): the daemon's journal now replays frame by frame and forgets dead history through a fixed fold policy (per-token harness deltas, superseded quota snapshots, immutable params on updates, terminals of pruned commands), so startup memory follows the retained state rather than the journal size: on a 1.6 GB root, normal admission in about 20–30 s depending on host load, at the default heap, instead of an out-of-memory crash, and the root compacts to about 0.3 GB. Sequence numbers, the epoch and live cursors survive compaction, snapshots may span several frames, and maintenance re-arms on growth since the last pass (a restart no longer rewrites an already-compacted partition; a failed pass settles the baseline too). Typed compaction declines, `journal.records_retired` receipts and the daemon's own memory are logged on admission and on every maintenance pass; retained params of terminal commands are capped at 256 MiB; crash-GC reuses the prepared command projection. Compatibility: an engine from before 3.12.0 refuses a root served by 3.12.0 loudly (rollback = keep the journal, recover with 3.12.0 or newer); the app compatibility floor stays at Claudexor.app 3.11.0 (no new wire contract the app must decode). One-time residue: legacy prune tombstones carry no run ids, so terminals of runs pruned before 3.12.0 stay retained (none on the acceptance root); runs that never received a journaled terminal keep their pre-release progress frames until their command is pruned, when the tombstone retires them (two such runs hold about 3.1k frames on the acceptance root).

- **v3.11.0** (2026-09-13): adds advisory Standard/Fast/Economy processing while preserving the selected model, reasoning effort and context. Native controls, account catalogs, actual service observations and monetary evidence remain separate; retries and account rotation recheck the actual service against the existing budget. Ordinary folders support direct work or complete selected copies without creating Git, with retained binary results, conflict-aware selected application and explicit discard. New state remains readable by this and later compatible runtimes; after a directory result is recorded, returning that state to 3.10.5 is not supported. Keep journals/results and recover with a compatible newer reader. The engine update requires Claudexor.app 3.11.0.

- **v3.10.5** (2026-09-12): a model request whose account cannot hand over its model list now moves on to the next available account instead of ending the whole attempt, unless the account was pinned explicitly, and each account is tried at most once per request. When no account can serve the request, the reason given is the one the accounts actually gave: a request that failed because the model lists were unreachable no longer reports that every account ran out of subscription quota, and reports no reset time. An account is marked busy until a stated time only when the vendor itself named that time or delay.

- **v3.10.4** (2026-09-12): Codex model operations can carry the caller's live `x-codex-turn-state` continuation on the existing route-bound opaque envelope (opt-in per request, captured once before the body, replayed only on the matching account and model, no separate daemon turn-state store; retained only in the existing private request/result custody); attempt/run telemetry and run summaries gain an additive normalized input measurement (`inputTokenUsage`: complete input total, cache reads, cache writes, unknown stays null) folded strictly across contributions, while legacy token fields keep their harness-specific meanings.

- **v3.10.3** (2026-09-11): exposes successful upstream Codex catalog contact through the existing provenance and observation-time fields. Reused catalogs retain their original observation time, failed reads produce no fresh proof, and the response stays compatible with strict older clients.

- **v3.10.2** (2026-09-09): preserves useful Council drafts whose completion report contradicts its required inputs as explicitly unverified merger inputs, while keeping the original attempt failed and inspectable. Automatic journal compaction now runs after normal admission with full acknowledged history, cursor continuity, and cancellable single-writer installation; Windows pending-tail recovery uses a verified temporary descriptor while ordinary append behavior stays unchanged.

- **v3.10.1** (2026-09-08): Antigravity model and quota checks use closed pipe
  input so a failed silent-auth check cannot open interactive sign-in. Explicit
  login retains its terminal. Ambiguous authentication timeouts remain probe
  failures, and failed quota refreshes remain visible alongside stale data.
  Existing freshness windows, account routing and polling cadence are unchanged.
  Windows interactive login now binds child standard streams to the pseudoconsole
  instead of inherited parent pipes; native fixtures require the exact submitted
  input before reporting success.
- **v3.10.0** (2026-09-07): adds caller-owned Codex model operations using the
  same managed accounts as Agents. Applications retain their system prompts,
  conversation history and tool execution; the engine preserves exact payloads,
  one-generation operation identity, recoverable results and explicit ACK.
  Codex is the implemented Models source; Claude, Cursor and other harnesses
  remain available for Agents. Explicit output caps and temperature are not
  supported by this route, and cash cost stays unknown without a provider
  receipt. Model catalogs remain account-specific and required before dispatch;
  retained compact receipts preserve idempotency and still grow with history.
  Reduces redundant journal startup copying and validation without deleting
  history or disabling compaction. Runtime replacement now respects unconfirmed
  setup termination. A setup failure recorded before process-group evidence can
  leave replacement and further login for that harness deferred indefinitely:
  Reconcile, Cancel and restart cannot clear that historical record, and automatic
  recovery of this case is deferred. Contributor release review no longer
  requires named model brands, overlapping runs or signed review attestations;
  runtime signatures, platform CI and exact candidate-byte promotion remain.
  Thanks to Praxis Relay and CLIProxyAPI for the model-transport research and
  design references; neither is embedded as another relay service.
- **v3.9.8** (2026-09-05): ordinary Agent work now defaults to no internal
  model review, independently of executor selection. Explicit panels and
  review opt-in, Best-of, and requested review cycles remain available;
  deliberately unreviewed work can be applied normally with an honest status
  while required checks and patch integrity remain enforced. Recorded intent
  preserves historical run/retry behavior. Adds GPT-6 Astra through Ultra and
  Claude Fable 5.1 (#259), with Codex CLI 0.153.3 and Claude Code 2.1.261.
  Refreshed native protocol evidence preserves SSE retries and historical MCP
  startup handling. Unpriced Codex usage and incompatible saved cost averages
  stay unknown instead of inheriting generic tariffs.
- **v3.9.7** (2026-09-04): the published release of the 3.9.6 code below,
  shipped under an owner-authorized publication exception (no custom Ed25519
  review attestation or runtime manifests, so in-place engine update and
  first-time remote bootstrap are unavailable for this version; signed and
  notarized app artifacts, npm provenance, and SBOMs are unchanged). 3.9.6 was
  prepared and tagged but never published.
- **v3.9.6** (2026-09-03): background quota polling no longer lets one revoked,
  never-logged-in, or failing profile pin its vendor's healthy profiles to the
  15-minute retry ceiling — renewals, evidence installed mid-ladder by a
  foreground refresh or a harness event, and vendor window resets are never
  postponed by a sibling's retry ladder; the Claude OAuth source remembers a
  proven vendor rejection per token instead of re-presenting it every cycle
  (#263). Captured workspace diffs relativize GNU diff 3.8 bare binary records
  (#252). The vendor 429 floor, typed absence semantics, and the five-minute
  freshness contract are unchanged.
- **v3.9.5** (2026-09-01): background quota renewal now starts on the last
  existing poll tick before primary evidence would become stale. The
  five-minute display and routing freshness contract, single poller, vendor
  pacing, Retry-After handling, and typed absence semantics remain unchanged.
- **v3.9.4** (2026-08-31): includes the typed delegation text and whitespace
  preservation prepared for 3.9.3, together with harness-independent release
  review by two distinct approved model families. Claude read-only runs retain
  AskUserQuestion; workspace-write command execution honors caller denies and
  scoped Bash permissions, with enforcement strength exposed by the typed
  `write_mechanism` capability. Interactive runs support structured output;
  runs without configured gates report that absence without inventing passed
  or failed checks. Cancellation reasons retain their typed user/host/owner
  provenance across the control boundary.
- **v3.9.3** (2026-08-30, unpublished candidate, superseded by 3.9.4):
  delegated run timelines preserve typed text-fragment
  metadata and original whitespace so hosts can join streamed words without
  inserting event separators into model prose. Complete messages, tool events,
  final answers, and omission disclosures retain their distinct semantics.
  Release review accepts any two distinct approved model families on any
  harness, recording the actual model and harness while preserving independent
  full-context reports, exact-candidate evidence, and signed attestation checks.
- **v3.9.2** (2026-08-30): Claude subscription quota refresh now wakes Claude
  Code's own prompt-free OAuth lifecycle before probing an expired or
  near-expiry access token. Claude Code retains refresh-token custody, locking,
  rotation, and store writes; Claudexor sends no MCP frame or model prompt and
  only re-reads the fresh access token after expiry metadata advances.
  Publication uses the owner-approved one-release `waive_cursor_review`
  exception to accelerate the live quota hotfix after its correctness, scope,
  security, exact-vendor acceptance, and full release gates completed; both
  owner-signed runtime manifests and every other release, notarization, and
  provenance gate remain required, and no formal Cursor attestation is claimed.
- **v3.9.1** (2026-08-30): refreshable Claude Code profiles remain signed in
  when an idle `oauth/usage` probe cannot prove the vendor-owned access token
  is fresh. Known-expired refreshable tokens skip the usage request, while an
  unknown-expiry 401/403 is reported as the typed `refresh_failed` quota
  absence instead of falsely downgrading the account to `auth_revoked`.
  Publication uses the owner-approved one-release `waive_cursor_review`
  exception after the required Fable subagent tier disappeared from the live
  Cursor catalog; both owner-signed runtime manifests and every other release,
  notarization, and provenance gate remain required, and no formal Cursor
  attestation is claimed.
- **v3.9.0** (2026-08-29): quota polling is paced per vendor lane with a
  persisted Retry-After floor (a 429 or restart no longer amplifies vendor
  traffic); foreground quota refreshes honor vendor cooldowns and disclose
  skipped vendors additively; suppressed polls stay stated through typed gap
  absences (`rate_limited`, `probe_skipped_rate_limited`, `poll_paced`); the
  claude probe loop short-circuits after the first 429 and the agy fan-out is
  bounded; the `claudexor_accounts` MCP tool defaults to the cached listing
  with `fresh: true` opting into the snapshot; and the cursor adapter can
  host the delegation belt via reconciled lane `mcp.json` injection
  (CONCEPT-CHANGE(INV-030); its owner-set live E2E was executed — see
  docs/FEATURES.md for the bounded-proof record and remaining caveats).
  Ships under the owner-authorized version-scoped Ed25519 waiver: the release
  omits the review attestation and both signed runtime manifests, so in-app
  engine update and first-time remote bootstrap are unavailable for 3.9.0
  (client verifiers stay fail-closed); DMG/npm/provenance are unchanged.
- **v3.8.4** (2026-08-28): implicit profile pools now drop only the typed
  quota-exhausted lane when a sibling harness can continue, while explicit
  pools remain strict and an exhausted primary preserves its typed terminal
  failure when no fallback survives admission.
- **v3.8.3** (2026-08-26): large compacted journal snapshots now replay
  record-by-record without materializing one whole-array JavaScript string,
  while decompression and opportunistic compaction remain bounded and fail
  back to the existing journal instead of entering recovery-only mode.
- **v3.8.2** (2026-08-24): reviewer routing now preserves the selected
  credential profile through every reviewer surface, exposes a read-only
  accounts view, and discloses unavailable reviewer families instead of
  silently dropping them. Transient Claude native auth-status transport
  failures stay typed as unknown with bounded retry and last-known-good
  disclosure rather than appearing as a logout. Startup recovery now keeps
  the frozen pre-admission verdict as its fail-closed fallback until a live
  post-quarantine re-verdict succeeds, and a delayed startup completion can no
  longer overwrite that newer recovery state or duplicate normal-plane work.
  Release verification now treats Codex model and effort catalogs as
  account-scoped: every live ladder and default must match the recorded union,
  while models advertised only by another account no longer create false
  drift; `gpt-5.2` is admitted when the pinned CLI advertises it. The
  Git-heavy orchestration and raw-patch regressions are split into independent
  tests so their combined work cannot exhaust one composite timeout; every
  scenario keeps its original production call and assertion. Codex and Cursor
  one-shot prompts now use their native stdin contracts instead of process argv,
  so large agent-first review packets no longer fail before model startup with
  `spawn E2BIG`. Publication uses the owner-approved one-release
  `waive_cursor_review` exception to avoid repeating the full-context review
  already completed during release work in a different execution setup; both
  signed runtime manifests and every other release and provenance gate remain
  required, and no schema-v6 review attestation is claimed.
- **v3.8.1** (2026-08-22): profile-scoped Antigravity runs now create and use
  a private macOS keychain under each profile HOME before the vendor touches
  Keychain Services. This removes the recurring “Keychain not found” dialog
  without changing the host default keychain, native-HOME behavior, or
  multi-account separation. The release also carries the pending daemon
  concurrency and native delegated-access changes already merged on `main`.
  Publication uses the owner-approved one-release `waive_cursor_review`
  exception because the required Cursor review lanes were unavailable; both
  signed runtime manifests and all other release and provenance gates remain
  required, and no formal Cursor attestation is claimed.
- **v3.8.0** (2026-08-20): a host embedding Claudexor can finish `Connect` for
  a vendor CLI that is not installed yet. `claudexor harness install` gains an
  explicit `--target local`: npm-pinned vendors install into the managed
  toolchain root (`~/.claudexor/node`) that local binary resolution and
  confinement already read, instead of the SSH-host prefix the historical
  `remote` target owns; the script vendors (cursor, agy) keep choosing their
  own destination (`~/.local/bin` / `~/.cursor/bin`) — the receipt discloses
  where, and the resolver reads both.
  The watched remote flow keeps its prefix, its disclosure and its exit-code
  contract, and neither the install lease, the post-install proof, nor the
  empty-download refusal applies to it. Two deliberate differences remain and
  are the whole list: a refused install no longer creates an empty vendor root
  before refusing, and — because the resolver now reads Cursor's own
  `~/.cursor/bin` — vendor children resolve executables through one more
  user-owned directory of the same trust class as the `~/.local/bin` they
  already searched. The lease also does not serialize a local install against
  a concurrent remote one writing the same vendor-chosen launcher; upstream
  had no serialization anywhere, so that is the inherited baseline, disclosed
  rather than claimed away. What the unattended local path
  has instead of a human at the terminal is proof: concurrent
  installs into one prefix serialize on a cross-process lease (a lease whose
  owner died fails closed with a typed `install_lock_stale` and its exact
  cleanup path, never an ABA-prone auto-reclaim), and success requires
  resolving the installed launcher and executing its `--version` — a child
  exiting zero without that postcondition is a typed
  `install_verification_failed`, so `ok:true` always carries `installedBinary`
  and `installedVersion`. A script vendor installed this way is disclosed as
  `unattended_unpinned` and records the downloaded installer's size and
  sha256; it never claims the `human_observed` verification the watched path
  earns. The signed runtime closure now also ships `claudexor.bundle.cjs`
  stamped with the same build sha as the daemon, so the host invokes that
  exact reviewed CLI rather than anything it found on PATH. Three model-gate
  defects found by the release review are fixed with it: a cursor account
  pinned by a credential profile now answers its OWN model inventory through
  the same route resolver its run uses (previously the gate consulted the
  engine-default ladder, got an empty list, and refused a model the pinned
  account genuinely offers); the pre-run gate no
  longer replays an admitted credential route as an auth preference for every
  adapter (a non-Cursor `auto` run was enumerated against an inventory its own
  spawn would not use), and no spawned spec is rewritten any more, so Cursor's
  `auth_switched`/`readiness_preferred` disclosure survives an explicit-model
  `auto` run. The Cursor model inventory now also runs in the run's `cwd`.
  This publish uses the owner-approved one-release `skip_custom_ed25519`
  waiver: Apple codesigning/notarization, GitHub provenance and npm provenance
  are unchanged, and the three custom Ed25519 documents are simply absent
  rather than unsigned — no client signature check is weakened.
  The release also carries the Windows Antigravity work merged from PR #207:
  credential-profile custody and managed setup login become platform-aware,
  with an exact Windows Antigravity one-binding policy, vendor-proven
  doctor/quota results, durable ambiguity handling, and host-resolved terminal
  capability projection.
- **v3.6.0** (2026-08-18): the unified account model (INV-135 rewrite,
  owner-approved). Every account is a named registry row; the separate
  "default"/"CLI login" account type is gone. A detected legacy claude/codex
  default-store login auto-registers at daemon start as the ordinary
  `<harness>-default` row through a crash-recoverable migration: while it is
  incomplete the affected harness refuses runs with a typed error, and
  `POST /v2/accounts-migration/rollback` is the supported downgrade path.
  Unpinned runs route through a quota-aware pool of enabled+ready rows with
  sticky, disclosed thread bindings; explicit pins stay strict (typed
  `subscription_window_exhausted` refusal, no silent rotation); pool
  exhaustion is a typed `credential_pool_exhausted` terminal carrying the
  pool's earliest known reset, and the paid API-key route serves it only under
  the explicit `api_key` preference, never silently under `auto` (owner Q3=A).
  New wire surface is additive: the `accountPools` pool authority plus
  `GET /v2/account-pools` (the feature marker) and the migration rollback
  endpoint; `harnessAccounts` stays on the wire as `[]` for legacy strict
  clients. Cursor host-Keychain logins are retired — every cursor account
  lives in an isolated vendor file-store row, and `auth login` becomes
  bootstrap sugar into the `<harness>-default` row. Deleting a row is provable
  (typed retryable error on partial cleanup) and retires migrated legacy
  aliases in the same operation. See PR #206 for the full story.
- **v3.5.0** (2026-08-17): Google's Antigravity CLI (`agy`) becomes a
  Claudexor harness, with the thing the vendor itself does not offer — several
  Google AI Pro/Ultra subscriptions signed in side by side and rotated on
  quota. Accounts are named profiles, each a Claudexor-owned home directory
  where the vendor keeps its own token file, so the operator's real home and
  login keychain stay untouched (live-proven across three Google accounts on
  macOS). Sign-in works from the app card: the vendor prints a link and waits
  sixty seconds for a pasted code, reads that code only from a real terminal
  (the daemon-hosted runner interposes `expect(1)` and propagates the vendor's
  own exit status), and the job's deadline IS the vendor's window — published
  as fixed, refused on extend, with a bounded exchange grace after the paste
  so the clock cannot cancel a sign-in that succeeded. `claudexor quota` reads
  each account's own `/quota`; every Antigravity window is model-scoped, so an
  exhausted Gemini budget does not block the account's Claude/GPT slugs, and a
  run naming no model is governed by whichever budget the profile's selected
  model actually spends. `claudexor harness install agy` downloads Google's
  official installer in full (PowerShell one on Windows), prints its size and
  sha256, and runs the file it showed — never a piped script. Disclosed
  honestly rather than hidden: the vendor exposes no config-dir variable, so
  one profile home also holds its conversation state and threads are not
  isolated from each other; no machine-readable account identity exists;
  platform isolation is proven on macOS only and doctor says so elsewhere.
  Also in this release: the Windows process-identity reader no longer times
  out on a cold PowerShell, silently degrading Windows runs. Development ran
  as five parallel reviewed phases plus an integration wave; the closing
  triad+scope wave ran through Claudexor's own agentic flow and its sol slot
  caught the resident-TUI login defect none of seven prior waves saw.
- **v3.4.2** (2026-08-16): every mutating delegated cursor run on macOS
  crashed within seconds — `RetriableError: [internal] unable to open database
  file` (SQLITE_CANTOPEN). cursor-agent keeps its chat store in SQLite under
  the scoped HOME, SQLite canonicalizes the database path on open
  (`realpath(3)` lstat/readlinks every intermediate component), and the
  Seatbelt profile's runtime-root read deny covered the components between the
  runtime root and the allowed scoped home. This is the same class the 3.3.15
  CODEX_HOME fix closed for the native state root — and the residual its
  review predicted for the scoped home — so the metadata traversal carve-out
  now covers the union of EVERY own root's denied ancestors (scoped home,
  worktree, native state root): literal, metadata-only, placed after the deny
  it punches through. Nothing else is re-opened — file data under the runtime
  root, sibling projects, and directory listings stay denied, and the boundary
  probe semantics are unchanged. Two-sided `sandbox-exec` regressions pin the
  class (canonicalize of each own root, a cursor-shaped SQLite open+WAL write,
  and both pre-fix reproductions with the carve-out stripped), and the
  real-harness battery's delegated-confinement phase grows a cursor case
  beside codex, capability-checked against the real repo mutation and its
  green test gate rather than exit status alone.
- **v3.4.1** (2026-08-15): the Windows native-login groundwork, grown from
  community PR #189 (Renat, @dead9111) and reworked with the contributor's
  three commits preserved. Windows could not reach the login lane at all: the
  sealed manifest rejected `C:\...` paths and process identity answered
  `unsupported_platform`, so no execution permit was ever issued. The
  absolute-path contract is now a REGEX covering POSIX, drive-rooted, and UNC
  spellings — chosen over a `node:path` refinement because only a regex
  survives `schema:gen` as a JSON Schema `pattern` (the refinement silently
  relaxed the generated wire contract to `minLength: 1`) — with drive-relative
  `C:x` and root-relative `\x` refused and the Swift decoder mirroring the
  same rule. Process identity gains an OPT-IN win32 reader that takes the
  kernel's own process creation time (`GetProcessTimes` via the absolute
  System32 PowerShell) as the birth token, so a recycled PID compares
  DIFFERENT exactly as on POSIX; the default service still answers
  `unsupported_platform`, so run capture, the orphan reaper, and the daemon
  writer lease keep their fail-closed Windows behavior. Windows has no process
  groups and no cooperative TERM, so on the login lane both escalation steps
  are one identity-gated `taskkill /T /F` of the recorded leader's tree — the
  terminator this repo already owns — and emptiness is the leader's identity
  being gone, disclosed in ARCHITECTURE as a leader-death proof rather than
  the POSIX group-ESRCH proof. The vendor binary is still executed without a
  shell: on win32 the harness resolver offers only executable images
  (`.exe`/`.com`, the v3.3.9 `git.exe` rule), and an npm `.cmd`/shell shim is
  refused with an advisory naming the real cause (issue #191 tracks spawning
  shims through their JS entry). Login env allowlists forward the Windows
  process-environment keys and match them case-insensitively on win32 only
  (`SystemRoot` vs `SYSTEMROOT`; on POSIX `http_proxy` and `HTTP_PROXY` stay
  distinct) through one shared picker that also repairs the pre-existing
  `SYSTEMROOT` hole in clean-env spawns. The journal partition walker now
  addresses entries with `join`, fixing a real 3.4.0 Windows regression where
  the second daemon start read its own journal as missing and demanded
  recovery (the contributor's own find). The detached login runner passes
  `windowsHide` so "no Terminal" also means no console window, and a failed
  codex login no longer recommends the macOS-only `--browser-redirect`
  Terminal handoff off macOS. A `windows-latest` CI lane is REQUIRED through
  the `build-test` aggregate and earned its place on its first run: it caught
  8.3-short-path temp fixtures, live-proved the PowerShell identity reader,
  and surfaced that journal compaction cannot rename over its own open handle
  on Windows (issue #190; those four cases are skipped there with the cause
  named). Ordinary codex runs on Windows with an npm install remain
  non-functional (the shim class, issue #191) — this release makes the
  refusal typed and honest rather than ENOENT.
- **v3.4.0** (2026-08-15) — Shared data roots are now protected by a
  persistent root-authority barrier: the daemon records a writer epoch and a
  proven serving-version floor, refuses grants from released or foreign
  leases, and rejects malformed version candidates even on a fresh floor.
  Startup runs in two stages — a strictly read-only preparation that inspects
  the writer lease and journal partitions, then, only after the authority is
  won and the preparation revalidates, the floor advance, crash garbage
  collection, and journal activation. A stale flat-layout root from an older
  daemon migrates in place with no window where the anchor file is absent,
  and staleness is only concluded from a proven-dead writer. When a partition
  needs recovery the daemon serves recovery-only: product routes answer a
  typed error while recovery routes stay available, and a successful
  quarantine reopens the journals and completes normal admission in the same
  process, so repair needs no restart. The serving mode is reported honestly
  across the control handshake, CLI start report, remote commands, the macOS
  app, and the harness battery. Quarantining one partition can no longer
  disturb a healthy sibling's preparation identity, and the setup supervisor
  cannot be started twice after an in-process reopen. The daemon also
  recovers automatically from Linux zombie writer leases while keeping live
  or uncertain owners fail-closed, survives disconnected RPC followers
  instead of crashing, and treats web access as optional for every non-off
  policy with native Cursor web approvals for managed read-only runs. CLI
  readiness waits through the transient recovery-only startup window: acting
  commands and `daemon start` keep re-handshaking until normal admission
  opens or the start budget expires, so a healthy journal-heavy startup is
  never misreported as a recovery-blocked daemon.

- **v3.3.16** (2026-08-15) — The macOS packager now removes the exact
  pre-3.3.13 `dist/Claudexor.app` only after a successful Swift build produces
  the release executable; failed or incomplete builds preserve both app paths,
  and unrelated `dist` content survives. Data-root ownership is now explicit by
  mode: the default root recognizes archived `v2` and active `v3`, while `v1`
  remains unrecognized because v1-era bytes lived directly under
  `~/.claudexor`; an explicit `CLAUDEXOR_CONFIG_DIR` treats `v1`, `v2`, and
  `v3` children as ordinary unrecognized entries. Reporting remains advisory
  and never deletes these paths. The Cursor adapter follows the current stream
  contract by dropping strict user prompt echoes, preserving nested token usage
  without inventing a dollar cost, and classifying permission-denied tool
  results as denied. The built-in OpenRouter route now preserves finite
  non-negative `usage.cost`, including zero, as an exact USD receipt; explicit
  terminal provider-error completions fail with safe typed evidence, while
  ordinary stop and length completions remain successful. Cold daemon starts
  now wait up to 90 seconds for large journals instead of reporting failure
  after 15 seconds while initialization continues in the background.

- **v3.3.15** (2026-08-10) — Mutating delegated codex runs work again on
  macOS. Codex canonicalizes its `CODEX_HOME` at startup, and the Seatbelt
  profile's runtime-root read deny covered the intermediate path components
  between the runtime root and the allowed native state root, so every
  confined `workspace_write` codex run died in seconds with `failed to
  canonicalize CODEX_HOME … Operation not permitted`
  (`route.transient.exhausted: process_crash`). The profile now grants a
  literal, metadata-only (`file-read-metadata`) allowance for exactly that
  ancestor chain, placed after the deny it traverses. File data under the
  runtime root — including the daemon token — and directory listings (readdir
  is a data read) stay denied, and the boundary-probe semantics are unchanged.
  The profile also grants read+exec on the managed toolchain subtree
  (`~/.claudexor/node` — subpath, derived from the launcher's own
  `managedNodeRoot` helper, emitted only when it lies inside the runtime
  root): in the default layout the harness binaries live inside the denied
  tree, and the VM battery's phase 13 proved exec of
  `<runtime root>/node/bin/codex` died with `sandbox-exec: execvp() …
  Operation not permitted` (exit 71); toolchain writes and everything else
  under the runtime root stay denied.
  Two-sided `sandbox-exec` tests pin both directions, and the real-harness
  battery gains phase 13: a live delegated mutating codex run under the OS
  boundary with per-candidate confinement evidence.

- **v3.3.14** (2026-08-09) — Accounts and quota reliability. The macOS
  Accounts popover now keeps its header fixed above a screen-bounded scroller,
  labels the implicit vendor identity `CLI login`, and carries Cursor emails
  from the existing typed status probe without another subprocess. Opening or
  connecting hydrates the cacheable account registry instead of launching a
  full provider cycle; expensive readiness/quota refresh is explicit, while
  live quota markers coalesce into a display-only read with at most one
  trailing request. Last-known figures remain visible with a stale/error
  disclosure, and a failed refresh no longer erases account rows or presents
  old readiness as current. Model-scoped windows and the server-owned quota
  availability projection now reach Swift, so a Fable-only exhausted window is
  labelled as scoped and cannot become an unqualified account-wide 100%.
  Daemon polling now derives demand only from each enabled subject's primary
  refreshable source, ignores stale reactive evidence as a trigger, runs the
  three top-level refreshers concurrently, and applies completion-anchored
  single-flight exponential pacing after partial or absent observations. A
  credential-generation fence retires an older provider cycle before it can
  restore a removed account or satisfy a post-login refresh with the old
  credential; post-change callers coalesce into one current-generation cycle.
  Large compacted journals reopen and compact iteratively instead of passing
  roughly 176,000 records as JavaScript call arguments, fixing the 3.3.13
  machine-wide startup failure. Browser media uses a marker-owned per-run child
  so a pre-existing `.claudexor-artifacts` root and unrelated same-basename
  paths are captured and preserved. Crash recovery persists the envelope id and
  workspace mode, so startup cleanup removes that same marked child from an
  in-place project without touching the shared root or user siblings. The
  release also pins the ACP/daemon typed
  inline-secret refusals and removes wall-clock timing from the reported macOS
  replay-order test.
- **v3.3.13** (2026-08-08) — dev-hygiene follow-up. The packaged macOS app
  bundle and the DMG staging directory now build into
  `apps/macos/dist/bundle.noindex/`, which Spotlight does not index, so local
  release builds across many worktrees no longer flood Launchpad and search
  with duplicate Claudexor icons; the DMG/ZIP outputs and the release
  byte-promotion contract remain on their existing `apps/macos/dist/` paths.
  A source-built dev app (version "dev") no longer presents the automatic
  "Update available" chip it used to recompute from the shared
  `~/.claudexor/runtime/current.json` pointer; it shows an honest dev-build
  status instead, and the manual Check for Updates flow is unchanged.
  `claudexor gc` can now report top-level entries of the Claudexor data root
  that the engine does not own, as an opt-in advisory on the receipt
  (`data_root_unrecognized`): the CLI requests it only from a same-version
  daemon, so both skew directions keep their exact pre-3.3.13 shapes; the
  scan flags wrong-kind/symlink anomalies, never deletes anything, and scan
  failures land in the existing `errors[]`. Confinement policy-shape
  contradictions (a carve-out that would swallow a denied path) are now
  refused before the platform-availability probe, identically on every OS —
  this was latent on Linux since v3.3.7 and kept CI red; the fix restored the
  green matrix.
- **v3.3.12** (2026-08-08) — an eight-issue fix batch on top of 3.3.11.
  Harness stderr is no longer discarded on clean exits: the shared CLI run
  loop attaches a bounded, redacted `stderr_tail` to the terminal completed
  payload on every exit path (zero exit and abort included; previously
  nonzero-exit only), reaching the raw attempt-event channel (events.jsonl /
  SSE / `--json-stream`) whenever the stream is drained to completion; an
  orchestrator-side abort that stops consuming before the terminal event does
  not persist the tail (bounded residue, ledgered). Raw diagnostics only: no
  timeline/CLI surfacing, no severity classification, no schema field (#120).
  Artifact listings and the review-findings projection now tolerate
  concurrent tree mutation (a vanished entry/directory yields a partial
  snapshot instead of a 500), and `.git` entries are never enumerated in
  listings — they remain fetchable by explicit path (#128). The harness
  inactivity watchdog default (`runtime.harness_inactivity_timeout_ms`) is
  raised from 20 to 60 minutes: long silent reasoning stretches (codex exec
  has no delta transport; racing/agent claude lanes are delta-free by design)
  were killed as false-positive hangs. The issue asked to raise the default
  for reasoning tiers; what ships is a flat bump for every tier — per-effort
  scaling was investigated and rejected because explicit-vs-default
  provenance is lost at config parse. Tradeoff: a genuinely wedged CLI now
  parks up to 60 minutes before its typed timeout. The new default applies
  only to configs without an explicit value — an existing persisted `1200000`
  is never migrated; to adopt the new value, edit
  `runtime.harness_inactivity_timeout_ms` in `~/.claudexor/v3/config.yaml` or
  set `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` (#129). A daemon that refuses
  the control-protocol handshake now surfaces the server's typed
  `incompatible_protocol_major` problem with the `claudexor daemon stop`
  remedy instead of the misleading "control API is not reachable
  (CLAUDEXOR_NO_CONTROL_API=1)" timeout — and the remedy shows on the
  terminal, not only in the machine envelope; read-only lookups no longer
  report a live incompatible daemon as "not running"/"no such run";
  `claudexor follow` reports typed daemon problems through the canonical
  failure envelope instead of a flattened one-liner; a corrupt
  `control-api.json` pointer is reported loudly with its path instead of
  reading as "daemon not running"; and when a same-major daemon/CLI version
  skew was observed on the connection, every typed daemon failure
  (`config_invalid` included) additionally carries `context.engineSkew`
  {daemonVersion, daemonSha?, cliVersion} plus the stop remedy in
  requiredActions (#93). Write-mode Git auto-initialization refuses
  implausible roots (INV-075 exception): a root equal to the user home
  directory or a filesystem root — or one that cannot be classified (no safe
  home resolves, or the root itself does not physically resolve; both fail
  closed) — is refused with the typed `git_boundary_root_refused` error
  before any mutation, carrying cause-specific required actions: the home
  and filesystem-root refusals offer a project subfolder or a self-run
  `git init` plus a first commit, while an unclassifiable root names its
  classification failure and its own remedy; both operands are classified
  on their physical resolution, so a symlinked spelling of the home cannot
  slip past the guard and a home that fails to resolve physically refuses
  fail-closed; a home that is already a healthy repository (dotfiles
  users) is respected untouched, and ordinary non-git roots keep the
  announced auto-init (#130). Route classification consumes the frozen
  admission route first and the RESOLVED per-harness auth preference after
  it, instead of the raw request field, so the documented config-level
  `auth_preference: api_key` workaround is reliable (the reporter's
  degraded-key + native-cooldown pool survives and spawns with the api_key
  preference). Deliberate visibility change: a config-level API key with a
  passing smoke now honestly classifies as metered billing, so
  `paid_fallback: never` excludes that lane — matching run-level
  `--auth api_key` semantics (#121, part 1). macOS: storing an OpenRouter key
  works end-to-end — the auth sheet maps openrouter to its managed secret
  slot and both API-key readiness mappings — and the Store-key control for
  every key family (opencode, raw, openrouter) visibly disables with a
  cause-specific hover (engine offline / action in flight / empty key field)
  instead of silently doing nothing. After storing an API key the harness
  honestly reports degraded — key present but route unproven — because the
  raw-api doctor never spends paid calls to verify it; the harness card now
  reflects that state immediately after the store, and the sheet's footer
  offers Retry check (not Done) to run a real fresh probe (#132). The agent
  convergence-preflight refusal's remediation is honest: it now says
  "Configure reviewers from a second provider family and check
  `claudexor doctor` for reviewer readiness" instead of advising a
  nonexistent knob; the machine-matched first sentence is unchanged
  (#133, part c).
- **v3.3.11** (2026-08-07): typed model-aware availability on `/v2/quota`.
  A downstream consumer buried a whole healthy claude route because a
  `claude_oauth_usage` snapshot carried a spent model-scoped window
  (`weekly_scoped:Fable`, `applies_to_models: ["fable","claude-fable-5",
  "best"]`, `used_ratio: 1.0`) and the consumer's own aggregation read "any
  spent constraint" as "profile dead". Each snapshot in the `/v2/quota`
  response now carries a derived `availability` projection — `state`
  (`available`/`exhausted`/`cooldown`), `blocking_constraints`, earliest
  known `resets_at`, and `model_scoped_exhaustions` — so consumers no longer
  invent constraint aggregation. Only windows applying to EVERY model can
  set `exhausted`/`cooldown`; a model-scoped spent window keeps the subject
  available and is disclosed separately. `POST /v2/quota` accepts an
  optional `{"model": …}` body (case-insensitive alias containment in either
  direction) to compute `state` against the model the caller intends to
  spend; blocking semantics mirror the router's `BudgetLedger` (a spent
  ratio whose reset elapsed or is unknown is stale data, not a live block).
  Purely additive: the projection is applied at the response boundary, so
  journals, projection signatures, raw embedded snapshots, and absences are
  byte-identical.
- **v3.3.10** (2026-08-07): Windows secret-store durability fix, discovered
  by both live API-key lanes in the downstream 3-OS Ouroboros gate against
  public 3.3.9. The Windows fixture lane passed runtime installation, daemon
  boot, and the `git.exe` capability probe because it does not set a secret;
  each live lane instead failed immediately after `claudexor secrets set`
  with `EPERM: operation not permitted, fsync`. `SecretStore.writeFileStore`
  kept its own direct directory-handle open/fsync/close sequence, bypassing
  the shared `fsyncDirectory` durability owner whose win32-only tolerance
  already handles that directory-handle refusal. The store now delegates its
  post-rename directory flush to the shared helper. The temporary file's
  descriptor-level fsync before rename, atomic replacement, 0600 file mode,
  and non-win32 error behavior are unchanged. A package audit found no other
  direct directory-fd fsync duplicate outside `@claudexor/util`. The same
  bounded Windows live-path review found two regular-file durability checks
  reopening an already-written temp read-only (`runFacts`, `ResourceStore`);
  those handles are now opened read/write because Windows FlushFileBuffers
  rejects read-only file handles, without changing file content or POSIX
  ordering.
- **v3.3.9** (2026-08-06): the next Windows-parity layer, one deeper than
  3.3.8. With the daemon booting on Windows, the downstream 3-OS platform
  gate's fixture lane died at the Git capability probe with `git_missing`:
  `resolveGitExecutable` walked the engine PATH probing `<dir>/git` with no
  extension, and Windows has no extensionless `git` — every real
  distribution (Git for Windows, Scoop/Chocolatey shims) ships `git.exe` —
  so the probe could never succeed there. The resolver now probes
  platform-shaped candidate names (`git.exe` on win32, the bare name
  elsewhere; deliberately not a general PATHEXT walk — `git.cmd` died with
  msysgit 1.x and Node's execFile refuses `.cmd` without a shell), with the
  platform injectable so both branches are unit-proven without a Windows
  host. This repairs every consumer of the shared probe at its single root:
  request preflight, run applicability, readiness/doctor capabilities,
  control services, and accounts services. An audit of the rest of the
  code the fixture lane reaches (handshake, project registration, fake-run
  lifecycle, artifact read, identity-bound `--stop`) found no further
  win32-fatal pattern of the 3.3.7/3.3.8 classes: the harness binary
  resolver already carries PATHEXT candidates, direct `git` spawns resolve
  `git.exe` through libuv's own PATH search, the directory
  fchmod/fsync tolerance from 3.3.8 owns both directory-handle mutations,
  path-prefix guards on this lane use `path.sep`, and the `ps`-based
  envelope-owner start-time identity degrades to a declared bounded
  freshness keep rather than a failure.
- **v3.3.8** (2026-08-06): Windows daemon boot fix. Establishing a
  daemon-owned private directory (`ensureCanonicalPrivateDirectory`) applied
  `fchmod(fd, 0o700)` unconditionally, and win32 has no POSIX mode bits on
  directories (directory access there is governed by ACLs; the READONLY
  attribute that fchmod maps onto is not honored on directories), so the
  descriptor-level chmod failed with `EPERM: operation not permitted, fchmod`
  and `claudexord` could not boot on Windows — found by the downstream 3-OS
  platform gate against the published 3.3.7 bytes. The directory chmod now
  carries the same attempt-first win32 tolerance as the directory-handle
  flush in the same module (injectable `platform`, refusal forgiven only on
  win32); the inode/pathname identity proofs before the mutation are
  unchanged on every platform, and the file-level `fchmod(fd, 0o600)` writers
  (daemon token, journal, recovery files, login sidecars) are untouched —
  on win32 those map to clearing the READONLY attribute on a file handle,
  which succeeds.
- **v3.3.7** (2026-08-06): the Ouroboros-integration line, rebased onto the
  3.2.1 release. The `CLAUDEXOR_CLAUDE_NATIVE_DIR`/`CLAUDEXOR_CODEX_NATIVE_HOME`
  override guards now confine to the Claudexor-owned root (`~/.claudexor`)
  instead of the narrower config root, so pointing a run at a registered
  credential-profile store under `~/.claudexor/profiles/…` works instead of
  hard-erroring. Durable idempotency digests are now computed over a
  wire-stable projection: the parse-injected `execution.delegated: false` /
  project `scope.ephemeral: false` defaults (both new in this line) are elided
  before hashing, so replaying an accepted request's Idempotency-Key across an
  upgrade from 3.2.1 or 3.3.7-rc.0 returns the original handle instead of a
  spurious `idempotency_conflict`. A failed terminal login's durable failure
  tail now also drops every URL query string before persisting (host+path
  stay): an OAuth authorization URL's `state`/`code_challenge`/`user_code`
  values ride only the transient disclosure sidecar, never runner-result.json
  or the journaled job message. The `auth_revoked` snapshot retirement
  appends its durable REMOVED record before mutating the live projection
  (matching the upsert and explicit-removal paths), so an append failure can
  no longer leave a restart resurrecting a vendor-revoked window. The release
  now ships a relocatable managed runtime closure
  (`claudexor-runtime-<version>.tar.gz`): the same single engine closure the
  in-app updater installs also materializes internal package links into a
  regular-file/directory-only archive, so a host application can embed the
  exact-pinned runtime without a second payload or trust root. Credential
  profiles gained named Cursor accounts: a cursor `config_dir_login` profile
  selects the CLI's vendor file credential store inside a Claudexor-owned
  profile HOME, the default login keeps the OS Keychain untouched, and a
  logged-out or out-of-tree profile is a typed refusal before any child
  spawns. The owner-review release gate moved to transport v6 (protocol
  `cursor-operator-fable-sol-v1`, owner decision 2026-08-06): the formal
  reviewer pair executes as Cursor operator subagents (one `fable` and one
  `sol` slot, each restricted to its owner-approved tier set, both on the
  full context), each slot sealing a markdown report plus exact-shape
  operator-attested metadata (model slug, genuinely overlapping ISO
  intervals, `pass|warn` verdict, mandatory `review_scope: "full"`, report
  SHA-256); the native-harness schema-v5 sol-delta protocol
  (`native-fable-full-sol-delta-v2`) joined v2-v4 as
  archive-signature-only. Claude and cursor logins no longer
  open a Terminal window: both run as daemon-hosted detached runners
  (`url_disclosure` for cursor with `NO_OPEN_BROWSER=1` — its login
  self-completes by server-side polling from any browser; `url_disclosure_with_input`
  for claude — the card shows the captured sign-in link plus a one-shot paste
  field delivered to the vendor CLI's stdin via the new
  `POST /v2/setup/jobs/:id/input` route and a transient never-journaled
  `runner-input.json` sidecar), which also makes claude/cursor login work on
  Linux for the first time; the legacy Terminal handoff remains only for the
  codex `browser_redirect` fallback. Login verification gained a bounded
  post-deadline grace re-probe: a vendor credential flush landing moments
  after the 30s deadline now verifies as the success it is instead of
  reporting "Login failed" against a completed sign-in, and the timeout
  message now says the sign-in itself may have succeeded. Claudexor's control endpoint now resolves on Windows:
  `defaultSocketPath()` gained a `win32` branch returning the named pipe
  `\\.\pipe\claudexord-<digest16>` that Node IPC actually requires there,
  where it previously always built a Unix-style `.sock` path that could not be
  bound — the digest of the daemon dir keeps concurrent daemons with distinct
  `CLAUDEXOR_CONFIG_DIR`s on distinct endpoints, and the `CLAUDEXOR_DAEMON_SOCK`
  override is unchanged. Downstream platform gates that assert a per-platform
  endpoint depend on this branch existing. Alongside it the cancel path stops
  lying on Windows: `resolveKillTreeStrategy` names its mechanism once
  (`posix_process_group` everywhere, `windows_taskkill` on win32), the win32 leg
  issues one pinned `taskkill /T /F` while the root still probes alive, and
  because no group probe can prove whole-tree death there the outcome is the
  typed unconfirmed reason rather than a false CONFIRMED. A readonly cursor run
  is now genuinely read-only — it dispatches onto `--mode ask`, the only mode
  that CLI documents as withholding the write tools (under the previous argv a
  readonly agent created a file on instruction), and the manifest stops claiming
  `fs_sandbox` for a mechanism that is really a tool allowlist. Disclosed with
  it, because it is a real narrowing and not only a fix: ask mode withholds
  COMMAND EXECUTION as well as edits. The vendor's own mode roster in the pinned
  CLI build calls it "Q&A mode - no edits or command execution", so a readonly
  cursor run can no longer run a shell command it could run before — it now
  matches the claude adapter, whose readonly allowlist has always excluded
  `Bash`, while a readonly codex run still gets commands under a read-only
  filesystem. Confinement proof
  gained the control it was missing: `proveConfinementDenial` credited nearly
  every nonzero exit as a proven denial, so a Seatbelt profile that failed to
  apply or failed to compile recorded a `verified_denied_path` that proved
  nothing; a positive control (an allow-listed own root must stay readable under
  the sandbox) plus launch-fault discrimination on stderr now separate a real
  deny from a launcher failure. Delegated mutating runs became routable on the
  cursor and opencode adapters, which refused `external_sandbox_full` — the
  profile that tells the adapter to stand its weaker sandbox down; the engine
  applies and proves its own OS boundary on the delegated path (requested
  directly the profile carries no engine boundary and runs unrestricted) —
  while bare `full`, which claims no boundary at all, is still refused. The release itself now reaches the channel
  it is consumed on: publishing moved only `latest`, and nothing in the repo had
  ever moved `next`, so `claudexor@next` stayed stranded on 3.3.7-rc.0 while
  stable releases came and went; the publisher now moves `next` to the published
  version after the signature audit, and the workflow gate fails if that move is
  ever dropped. An attempt that died before its harness HOME was decided no
  longer reports `harness_home_isolated: false` — a positive claim that the
  engine ran the child in the operator's own home — and instead omits the field,
  so a gap in the record reads as a gap. Finally, a claude/cursor terminal login
  discloses its OAuth URL as a structural field on the login job instead of only
  printing it into the PTY, so a surface without a terminal has something to
  render.

- **v3.3.6** (2026-08-03): a delegated MUTATING run now works on Linux and
  Windows instead of failing closed there. 3.3.2 could only complete such a run
  on macOS: `applyConfinement` threw on every other platform and the terminal
  evidence gate refused any attempt that carried no proven boundary, so
  `execution.delegated` was a macOS-only feature wearing a general name. macOS
  keeps its Seatbelt boundary, applied and PROVEN against a path it denies before
  the harness spawns. Every other platform gets, by decision, no kernel boundary
  at all — the scoped harness `HOME` as before, no mechanism recorded, and the
  absence disclosed in three places: the attempt record
  (`confinement_unavailable_reason`), the child's own prompt, and the caller's
  run detail (`candidates[].confinement`). A mechanism is never named without the
  path it was proven to deny: the schema makes the pair inseparable, one owner
  answers "is there really a boundary", the mechanism identifier is opaque, and
  nothing branches on the platform. The terminal gate now separates MISSING
  evidence (still a refusal — an attempt that cannot say what it ran under is
  unauditable) from evidence that honestly states there was no boundary
  (complete, terminalizes normally). Finally, a delegated lane is told to stand
  its own sandbox down only where Claudexor will actually replace it — the
  `external_sandbox_full` escalation was unconditional and would have stripped a
  harness's native sandbox on hosts that got nothing in return.

- **v3.3.2** (2026-08-03): a delegated MUTATING run is now confined by an
  OS-enforced filesystem boundary, not by a convention. The scoped harness
  `HOME` 3.3.0 introduced redirects `~`-relative lookups and nothing else — a
  live `workspace_write` agent run read `~/.claudexor/v3/daemon/token`, a bearer
  for the whole control API, straight off its absolute path. Such an attempt now
  starts inside a macOS Seatbelt profile that denies the Claudexor runtime tree
  and the operator's credential stores (derived from the sensitive-resource
  owner, never re-listed), applied at the ONE shared CLI spawn seam so no adapter
  can forget it, and PROVEN against a path it denies before the harness runs.
  Because macOS refuses a nested sandbox, the engine states the existing
  `external_sandbox_full` access profile so the harness stands its own down — an
  access profile, never a harness-name branch. Every attempt records what it
  actually ran under (HOME, access, credential profile, boundary digest and
  verified denied path) on the success AND failure paths, a delegated mutating
  terminal without that proof refuses, and the three confinement refusals are
  typed `RunFailureCode`s instead of being flattened to `code: null`. What the
  boundary does not cover is written down in `docs/DELEGATED_CONFINEMENT.md`.

- **v3.3.1** (2026-08-03): three surfaces that the 3.3.0 batch changed on one
  branch and left untouched on its twin. Thread worktree recovery deregisters
  only the one lost registration instead of running the repo-wide
  `git worktree prune` against the user's project — the exact harm
  `worktreePrune` was gated for, from the one caller that still bypassed it.
  The vendor-verification overlay now runs at RUN ADMISSION and rotation
  readiness, not only in the Accounts listing, so a profile the vendor already
  rejected (`auth_revoked`) is refused before spawn instead of being dispatched
  into while the Accounts card calls it revoked. And `scope.ephemeral` is
  honored on `POST /threads` as it already was on `POST /runs`: a declared
  one-shot root is no longer silently entered into the durable project
  registry, which is what the field's own description promises.

- **v3.3.0** (2026-08-03): preconditions for an external orchestrator driving
  Claudexor runs. `RunScope.ephemeral` declares a one-shot project root — it
  anchors a single run, never enters the durable project registry, and its
  commands and run events live in the global no-project partition, so a host
  that hands Claudexor a disposable worktree per subagent stops filling the
  registry with entries that are dead on arrival. `RunExecution.delegated`
  marks a run driven by a machine orchestrator rather than an operator at a
  surface: every attempt is confined to a scoped harness HOME even under
  `isolation: "live"`, the run refuses rather than degrades when that home is
  absent, and the applied isolation is recorded on the attempt so the caller
  verifies confinement instead of trusting it. Credential-profile readiness
  discloses `verification_source`, separating "this profile's material is
  present locally" from "the vendor answered a request made with this
  profile's credential"; a vendor 401/403 on a subject's own token becomes the
  typed quota absence `auth_revoked` instead of an undiagnosed refresh
  failure. A spent subscription window is refused typed end to end —
  `subscription_window_exhausted` with a structural `RunFailure.resetsAt`,
  carried out of a candidate attempt's catch onto the run terminal only when
  every candidate died of the same refusal — so a scheduler reads a field
  instead of parsing the message. `worktreePrune` no longer deregisters
  worktrees Claudexor does not own. Internally, `RunFailure` moves to
  `control-run-failure.ts` and the thread continuity-context builder to
  `thread-continuity-context.ts`, keeping both tracked files under the
  readability ratchet and putting the continuity filters under test.

- **v3.2.1** (2026-08-03): a focused macOS plan-answer and diagnostics repair,
  based on reports from Walter Siamruk (#102–#108). Composer-selected models,
  effort, and auth route now reach turns started from plan cards; Implement plan
  names and binds its Agent write scope; multi-harness non-race runs no longer
  claim a Best-of result; and an unpinned account has one stable Automatic
  identity. Plan option chips are suggestions, including on saved 3.2.0 runs;
  every required answer has visible state, card text is selectable, and a
  durable typed relation restores the exact submitted receipt after reload
  while preventing duplicate turns. Diagnostics can copy the full run id or a
  directly runnable bundled/remote inspect command. CI now executes the
  ClaudexorApp tests (#91). GitHub Actions move to checkout 7.0.1,
  pnpm/action-setup 6.0.9, and download-artifact 8.0.1; the one Node 20 timer
  fixture exposed during refresh now uses deterministic fake time. The repaired
  real-harness battery (#94) can use existing authenticated sessions in a
  disposable VM without relocating or copying credentials, refuses a live
  daemon, forces and digests the exact source build, binds cleanup to the daemon
  it started, leaves the default config byte-identical, revokes temporary trust,
  scans every durable route interval, and fails acceptance on any FAIL, ENV, or
  SKIP. API fallback disclosure before process start no longer creates a
  fictitious unpaid interval and incorrectly ends an exact paid run as
  `cost_unverifiable`. The macOS app now treats the terminal review axis as the
  decision authority, so advisory findings cannot show `Needs you` controls
  beside an approved, already-applied winner; failed final checks retain their
  server-authorized risk-decision path, and remote sync times stay English under
  non-English host locales. Claude advisory quota warnings no longer cool a
  healthy account, model-scoped Fable limits no longer block explicit Opus
  routes or a viable vendor-native default, typed Opus/Sonnet rejections retain
  their model scope, fallback and budget-downgrade attempts preflight the model
  they actually run, and opt-in account rotation selects a ready profile before
  the exhausted default can be filtered out. Model-scoped quota stays durable
  across current-engine restarts without breaking the supported updater
  rollback: 3.2.0 can replay the compatible base record while current engines
  restore the exact typed scope from its atomically journaled prepare/base pair.
  The real-harness battery now proves its expected convergence refusal from the
  canonical failure instead of incidental review fields.

- **v3.2.0** (2026-07-29) — an eight-pull-request batch: remote execution, a
  canonical run receipt, and the toolchain moved forward. Remote SSH
  execution (#82, kazzand): a thread can bind to a concrete `~/.ssh/config`
  host, where the app delegates transport and auth to the system
  `/usr/bin/ssh` (interactive auth runs in an ephemeral SwiftTerm PTY and
  nothing is persisted) and installs a signed remote runtime — an Ed25519
  `kind`-separated manifest binds four platform archives with pinned Node
  digests, atomic activate/rollback, no sudo — then drives the complete
  engine through a loopback SSH forward with location-tagged threads, remote
  setup and login, log tails, and preview forwarding. Remote browsing lists
  only visible home-contained directories and refuses every other path with
  one constant answer; remote markdown images ride a registered-project
  endpoint that identifies raster images by magic bytes and refuses anything
  else before reading its content; both remote endpoints are wired only into
  the remote runtime, so a local daemon answers 501. The release pipeline
  builds, attests, SBOMs, and publishes the four remote-runtime archives, the
  signed remote manifest, and the remote SBOM as first-class assets (inside the
  12-asset candidate allowlist; publish adds the review attestation as the
  thirteenth final asset, with provenance verified before any use). Runtime
  activation is admission-safe across local install, steady
  reconciliation, remote install, and rollback: the daemon atomically proves
  run/setup idleness and fences every ingress before stopping, while a late
  busy or unknown result leaves the serving process and runtime pointer intact.
  Canonical RunFacts receipt (GH #29, Alex Basis): every terminal run seals its
  outcome into one immutable, invariant-validated object built once from
  canonical artifacts, embedded in the terminal journal event, persisted as
  `final/run_facts.yaml`, and served verbatim by the control API, terminal
  CLI JSON/NDJSON, and `claudexor inspect` through one shared validation
  owner. Fail-loud throughout: a present-but-invalid receipt is a typed
  `run_facts_invalid` failure on every surface, a corrupted canonical
  artifact or malformed review finding fails the terminal instead of
  projecting "not configured", and restart reconciliation neither re-reads
  evidence for settled terminals nor poisons a partition whose run directory
  retention legitimately reclaimed. The checks axis now covers ALL
  deterministic checks, so a refused delivery or failed fresh verify blocks a
  zero-gate run exactly like a gated one; the reviewer NEEDS_HUMAN gate is
  winner-only and fail-closed; a zero-byte deliverable is never reported
  present. Cursor model pickers are bounded by a shared layout token and one
  truncated-label owner, so a long vendor catalog can no longer widen the
  composer or Settings menus (GH #53, Alex Basis). The Claude manifest pins
  `claude-opus-5` and `claude-opus-4-5` against the verified CLI (#54,
  ndrew1337). The release also ships a carried-over changeset: portable Agent
  Skill and GitHub Copilot plugin artifacts, official MCP Registry
  distribution metadata, experimental ACP Terminal Auth for Codex, and
  repository-configured protected path gates.
  Settings → Connections can create an SSH host without leaving the app: a
  `New SSH Host…` sheet (replacing the short-lived disclosure whose label was
  inert — only the chevron toggled) with live field-local validation, a
  writer-rendered "Will append to ~/.ssh/config" preview that is byte-identical
  to the actual append, and a one-step `Create & Add` that writes the block,
  rescans, and adds the connection, leaving a dismissible receipt naming the
  config and backup paths (a freshly created config honestly reports that no
  backup existed) and surfacing a written-but-not-added partial outcome. The
  config scan is typed — missing config, no concrete aliases, all aliases
  already added, and scan failed each get their own picker copy instead of one
  silent empty list. The dead-label disclosure class is fixed app-wide by a
  shared `DisclosureRow` (whole-header button, rotating chevron, hover and
  keyboard/VoiceOver support) adopted by every Advanced disclosure, the
  Workspace Evidence rows, and the diff file headers; Connections also adopts
  the shared `SettingsGroup` shell, `AlignedListRow` row headers, and the
  documented status ladder (Connecting/Installing accent, Needs authentication
  caution, Failed danger).
  The remote harness installer returns from the PR #82 cut as a disclosed,
  exact-pinned flow (issue #89): a `claudexor harness install
  <claude|codex|cursor|opencode>` CLI verb plus a Settings → Harnesses entry
  point for connected hosts. Claude, Codex, and OpenCode install one exact
  npm version aliased from each harness package's vendor-version SSOT (never
  `@latest`; npm verifies the registry integrity checksum; the OpenCode pin
  is a deterministic install target with no recorded verification fixture).
  Cursor cannot be pinned and is not pretended to be: its vendor script is
  downloaded in full (never piped to a shell), its size and SHA-256 print,
  and it runs in the visible embedded terminal where the operator watches
  it. Nothing executes before disclosure — the CLI prints the exact command
  and destination and requires a TTY confirmation or `--yes`, and the macOS
  dialog shows the remote CLI's own `--dry-run --json` disclosure verbatim
  before opening the terminal sheet; Harness Doctor verifies the result
  afterward.
  Dogfood hardening closes the shared contract gaps found across Plan, Agent,
  Settings, long-running research, terminal output, and refused turns. Plan can
  receive read-only attachments but never Agent-only reviewer or protected-path
  controls; engine-side attachment admission now has one pool resolver, while
  Swift composer strategy and pool mirrors are parity-checked against an
  engine-generated fixture. Settings autosave is location- and
  lane-scoped, failed initial loads never become editable defaults, and the
  interaction wait offers either a positive duration or no automatic expiry.
  Extended remote login jobs remain attachable after their original deadline:
  the mutable journal deadline authorizes a fresh, bounded client-PTY permit
  without rewriting the sealed runner manifest. Setup continuations stay bound
  to the server-owned account even when opened from another account's sheet,
  and transient device codes disappear as soon as an authoritative frame or
  terminal connection state withdraws them.
  Deep Research resets inactivity only for genuine agent progress, while typed
  refusals, Git readiness, retry remedies, terminal output, and final RunFacts
  retain the same durable reason across UI, CLI, API, MCP, and ACP. Successful
  run-detail responses are schema-checked, degraded MCP/ACP errors are redacted,
  and auth-route summaries retain the deciding credential profile.
  Concurrency and upgrade paths are hardened at their owning boundaries. Remote
  setup, install, project, preview, directory, and terminal actions carry exact
  generation-scoped leases; runtime activation commits only after the tunneled
  handshake identifies the lease-owned candidate and exact pointer, while every
  reconnect binds bootstrap, tunneled engine, and final pointer identity before
  publication. Failed activation still rolls back through the same opaque lease.
  The packaged app probes the selected local daemon closure and reconciles exact
  version plus build identity before hydrating state, deferring safely while
  work is active. A failed or unreachable post-swap relaunch now restores and
  proves the prior exact runtime through the same admission-safe stop instead of
  leaving an unverified candidate pointer active. Idempotent thread recovery
  returns an already accepted command, but refuses a historical runless orphan
  after the conversation advances; Exact Retry also preserves the implemented
  plan hash and readiness override, and recorded risk-decision replays precede a
  later turn's idle gate.
  Both local-update and remote-runtime manifests reject unsigned extension
  fields in every JS, TypeScript, and Swift verifier;
  installer children receive no provider secrets, and offline signing keys are
  read only from same-user, non-symlinked 0600 files.
  Accounts and Settings share explicit location-scoped loading truth. File and
  screenshot attachments are admitted from an opened regular-file descriptor
  before a bounded read, reject same-size replacement or in-place mutation,
  revalidate on publication, and retire on an explicit conversation switch.
  TTY choice prompts accept only the complete numeric grammar they advertise,
  so numeric-prefixed prose and multiple picks for a single-choice question are
  preserved as prose. Native reviewer workspaces now project only Git-visible
  candidate files plus exact diff postimages; unrelated ignored local state
  stays outside the separately copied evidence plane. Formal release review is
  now one native full-context pair on the complete frozen repository: Claude
  Code Fable/max and Codex sol/xhigh share the same manifest-bound evidence,
  owner dialogue, complete diff, tests, and internet access. Schema-v5 sealing
  derives both verdicts from candidate-built Claudexor artifacts and binds their
  observed routes, prompts, transcripts, normalized events, and runtime
  identity to the exact full-gate receipt. Frozen reviewers now force live web
  context, run without hidden transient retries, record distinct overlapping
  sessions, and seal transcripts re-derived from normalized events. Sealed
  completions accept exactly one JSON value, with no surrounding prose or
  duplicate envelope. The full gate emits a small candidate verifier plus the
  packaged CLI, binds both byte digests and its real stdout/stderr logs into the
  receipt, and the sealer revalidates those receipt-owned bytes. The packet-split OpenRouter panel, coverage
  checker, and old broad runtime bundle are deleted rather than kept as
  competing or fallback release paths; schemas 2-4 remain archive-verifiable
  but cannot publish a new release.
  These dogfood repairs landed after the lockstep 3.2.0 versioning commit but
  before the first public 3.2.0 publication. The affected package changelogs
  therefore absorb them into their existing 3.2.0 sections; there is no second
  changeset or semver bump.
  Toolchain: `@modelcontextprotocol/server` 2.0.0 GA with the
  2026-07-28 discover envelope pinned by regression, TypeScript 7.0.2 with a
  sidecar for the one compiler-API consumer, and zod 4.4.3 with the schema
  package bridged through the `zod/v3` subpath so all generated JSON Schema
  stays byte-identical.

- **v3.1.2** (2026-07-26) — Delegate recovery patch. Packaged macOS and npm
  installs now expose the six-tool delegation belt through the exact daemon
  self-entry instead of failing because a neighboring `cli.js` is absent.
  Claude Code and Codex treat the injected MCP server as required: a known
  pre-start incompatibility continues as ordinary Agent only with a durable,
  visible requested/effective/used/reason/remediation receipt, while failure
  after injection is terminal. Parent and child runs share one daemon-owned
  budget, depth/count admission, cancellation, and drain barrier; late child
  spend can no longer escape the parent's terminal decision. Control API, CLI,
  and macOS preserve typed Delegate lineage, degradation warnings, failure
  reasons, child ordering, and reconnect/reload truth without confusing native
  vendor subagents for Claudexor children. Child questions stay answerable
  inline through their canonical run id, and signed candidate probes tolerate
  macOS canonical temporary-path aliases without weakening the entry fence.
  Cursor Plan uses the native read-only Ask final-message channel so its
  model-authored WorkReport cannot be lost behind the native `createPlan`
  terminal tool.

- **v3.1.1** (2026-07-25) — patch release: engine honesty, per-model effort
  ladders, and control-plane fixes on top of v3.1.0. Engine: a DELIVERED plan
  now survives an unrecovered tool error — the planner no longer escalates a
  finished deliverable to a harness error before the finalizer runs, so one
  failing shell command cannot throw away a good plan; an empty thrown message
  no longer reads as "no error", so a harness that threw can never terminalize
  as a clean success; the grep-family exit-1 carve-out and secret-redaction
  mirroring keep tool-error accounting truthful; and the automatic
  economy-ranking pass reads ONE pinned clock instead of a fresh `Date.now()`
  per candidate, so ranking is stable within a pass. Effort: the ladder is per
  (harness, model) and follows the vendor-advertised order — the static rank
  table is gone, levels are discovered live from each CLI (Claude `--effort`
  help parsing reads the whole block and anchors on the enumerating
  parenthesis; Codex discovery is keyed by the resolved `CODEX_HOME`, bounded,
  refuses malformed model/list values, and settles its probe on close) with a
  version-matched snapshot fallback; the full official vocabularies are
  supported (+minimal/+ultra in the schema vocabulary, codex +max/+ultra,
  claude +xhigh); a level the run cannot honor is disclosed instead of
  silently clamped, a profile-scoped run is no longer held to the DEFAULT
  account's ladder, hint-less runs resolve against the default model's own
  ladder, and the macOS composer's effort menu narrows to the per-turn (or
  persisted default) model's actual surface. Control plane: exact retry on a
  run that never started answers with its typed refusal (a 403, not a 202
  handle), and CLI retry/run-again read the refusal's real problem message
  instead of an `error` field the daemon never serves. Review: both loop
  prompts pin the finding contract explicitly, and a reviewer effort the
  selected reviewer does not advertise is refused rather than silently
  remapped. Portable discovery and distribution (#75): project protected
  paths are back as canonical repo-relative globs in the versioned
  `.claudexor/config.yaml` — a mutating turn on a live project thread with
  configured protected paths first promotes the thread ONE-WAY to its
  persistent isolated worktree, so the run and patch complete without
  touching the project tree and only the typed thread Apply decision can
  deliver the change (`--allow-protected-path` cannot suppress project
  rules; direct one-shot `--in-place` agent runs refuse and name the
  isolation remedy); a portable GitHub Copilot plugin ships in-repo
  (`plugins/copilot`: one Agent Skill plus `.mcp.json` wiring over the
  preinstalled `claudexor` CLI) — Copilot owns its install/update lifecycle
  (it is NOT a fifth managed host), macOS/Linux with Node 20.19+ only (no
  Windows), the Skill starts doctor-backed and read-only, and MCP still
  never exposes patch application; official MCP Registry publication
  metadata lands (`server.json` bound to the executable npm package and its
  exact version, release-parity checked) with publication only via the
  separate manual tag-bound `publish-mcp.yml` OIDC workflow after the npm
  package and public stable GitHub Release exist; and ACP Terminal Auth is
  added as an EXPERIMENTAL surface — only when a client explicitly
  advertises the experimental terminal-auth capability does Claudexor offer
  Codex subscription login through the client's own terminal (the exact
  allowlisted `claudexor acp serve auth login codex` suffix routed to the
  existing durable device-code login, macOS/Linux); Claude and Cursor are
  not advertised yet, the surface is proactive-only (no `auth_required`
  emission or legacy authenticate request), and cancellation or an
  unsupported device flow exits non-zero without spawning a second
  Terminal. Maintenance: CI publishes the required `build-test` check context
  from the matrix job (PRs no longer sit BLOCKED waiting for a context that
  never arrives), the fast-uri floor is pinned at 3.1.4
  (GHSA-v2hh-gcrm-f6hx), major bumps stay out of the dependabot groups, and
  routine dependency/actions updates landed (knip 6.29.0, prettier 3.9.6,
  turbo 2.10.6, @agentclientprotocol/sdk 1.3.0, attest/pages/artifact
  actions).

- **v3.1.0** (2026-07-24) — a five-phase release: engine truth, machine
  contracts, the macOS app, platform (engine-runtime auto-install + Codex
  login), and release/meta. Engine: a shared typed attempt-finalizer replaces
  the three divergent deliverable predicates (D-16, QA-031) — a clean process
  whose model-authored, schema-validated WorkReport says `needs_input` or
  `incomplete` stays a completed lifecycle with a typed outcome VETO (never
  applyable, never a green "succeeded" banner; CLI exit follows the outcome),
  while a real context-window death is `interrupted/context_capacity_exhausted`
  and can never launder a partial diff into review, adoption, synthesis,
  convergence, plan delivery, or an applyable product. Typed context signals
  ride each adapter (Claude `terminal_reason`/`prompt_too_long` +
  `compact_boundary` + rate-limit events, also fixing QA-015; Codex
  `ContextWindowExceeded` only behind a recorded exec fixture; Cursor stays
  honestly generic), with one-shot automatic continuation for the proven
  Claude refill-exhaustion case (fresh session, count = 1, disclosed as a typed
  `run.continuation` event, denial disclosed too). Deep scan gains a real
  bounded synthesis reducer (a failed merge is honestly labelled a raw scout
  bundle with `synthesisStatus=failed`, #27); a typed transient-failure
  taxonomy at the adapter→orchestrator boundary feeds `transient_failures`,
  retry policy, and `requiredActions`, with auth guidance only on real typed
  auth failures (#31). Delivery is server truth end to end: replaying apply on
  an already-delivered run is a typed idempotent no-op with an `already_applied`
  receipt (#26), accept-risk on a final-verify-null blocked run actually
  unlocks the gate, cancel reaps the descendant process tree with
  kernel-identity proof before the terminal receipt (QA-027), and wall-clock
  deadline / `stuck_no_progress` reasons survive to terminal artifacts
  (QA-041). Routing and budget stop lying: subscription-entitlement billing
  evidence, one traced economy-ranking comparator, a shared budget-denial
  classifier across all modes (QA-050), deep-scan scout admission under
  estimate floors with denied scouts disclosed (QA-019), and
  quality-routing-without-tiers as a typed `config_error` at settings write AND
  preflight (#22 server half). Isolated runs' produced outputs read the run's
  own worktree, never the live project (QA-038); blocked Ask can no longer read
  green (QA-036); malformed `events.jsonl` lines surface a typed incompleteness
  marker (QA-074). AGENTS.md unification (D-14): Codex falls back to CLAUDE.md
  via a stateless config override, and run prep can create a thin
  Claudexor-owned CLAUDE.md importing `@AGENTS.md` (typed event, never
  overwriting a hand-written file — a new enumerated live-tree mutation path,
  CONCEPT-CHANGE INV-113); the generated bridge is excluded from `patch.diff`
  only on byte-equality AND a created-this-run fact, so a candidate editing
  CLAUDE.md is never dropped from the diff. Machine contracts: one central CLI
  result/error projector emits exactly one JSON envelope per command path in
  `--json` mode with a single category→exit-code table, typed codes surviving
  projection, and structured field errors (#28); dropped-on-the-wire
  projections are restored (plan hash + readiness audit, council roster +
  valuation, ignored settings, session profile binding, `nesting[]`,
  `problems[]`, `requiredActions` derived from real blocking findings, #29
  partial); `--harness X` on a singleton pool infers the primary (#34) while a
  multi-harness pool missing its configured primary returns a structured
  ambiguity error (#25); `GET /v2/runs` honors limit/state/cursor, run SSE
  re-checks the cursor before ending, titles truncate grapheme-safe, bodies
  decode strict UTF-8, malformed percent escapes are a typed 400, the operation
  catalog is honest (params, applicability, single-shot uploads,
  idempotency), sensitive dotfile-class artifacts are refused typed before
  bytes are read, and the semantic-text policy covers code/config/text
  extensions with redaction gate-pinned to the Swift set; ACP session load
  replays real history and no-project sessions get a loadable cwd (QA-020/068);
  minimal project remove ships (CLI + DELETE route, typed fences,
  archive-first partition handling); and a new `claudexor about` command (text
  + `--json`) carries author/license/links. macOS: a transcript scroll
  overhaul (D-13 A/B/C/E) removes the nested lazy stack — also closing the
  tool-receipt layout loop that could grow memory into the gigabytes (#23),
  with a bounded-memory regression guard, scoped text selection, and granular
  invalidation (owner-dogfooded PASS without a List migration); theme switching
  no longer jumps the toolbar (#21); GFM tables render as real tables via a
  typed lookahead parser and a bounded non-lazy grid (#24); zero-tier quality
  routing cannot be saved (macOS guard atop the daemon refusal, #22);
  bubbles use a calibrated translucent material with AA-verified contrast in
  both themes and a Reduce Transparency fallback (D-12); an About section +
  standard panel show author, MIT license, links, and real app + engine
  identity including the engine sha (D-11, QA-002); plus an honest-UI cluster
  (running runs never show a terminal "No changes", no duplicated Activity
  answer, per-harness Auto-pool model rows, real model-route queries, absent
  optional API keys are not red failures, draft/project-switch resets, honest
  gallery partial-failure disclosure with Retry, strict UTF-8 artifact
  decoding, path-named diff failures, disclosed offline/lost-engine states) and
  a tracked, hardened external-open handoff directory with a startup sweep
  (QA-062). Codex login (D-17): the primary flow is the app-server typed device
  code — a native AuthSheet shows the one-time code with Copy, Cancel, and
  "Open private sign-in" via an ephemeral browser session (honest wording:
  privacy is requested, not guaranteed by every browser), completion feeds the
  existing doctor/smoke proof, and "Add & log in" is one action; an opt-in
  browser-callback flow and a typed legacy Terminal fallback that the CLI
  actually offers round it out, both CLI entries ride the durable setup job
  with inline code display, and the code is never journaled or logged. Engine
  runtime auto-install (D-2): the app can download, verify, and install an
  engine-runtime update — sha256 + offline Ed25519 signed-manifest verification
  against a dedicated runtime-update key pinned in app + CLI (fail-closed on
  unsigned/unknown-key/tampered), full unpack + re-verify into
  `runtime/versions/<v>`, probe handshake, a busy-gate that refuses while any
  work is active, identity-proven daemon stop, atomic `current.json` swap,
  relaunch + handshake verify, rollback to last-known-good on any failure, and
  a lock-file around the critical section, with the bundled runtime as the
  final fallback; the release side promotes the exact candidate artifact bytes
  (gh attestation verify + byte identity, never a rebuild), binds the archive
  URL into the signed manifest, and stamps a deterministic build-sha for
  bundled and downloaded closures (QA-002's real gap). Review harness and
  release tooling: deterministic full-text reviewer coverage via packet-split
  sub-waves and a coverage checker that BLOCKS the seal unless every
  hand-written changed file's complete bytes reached a reviewer; attestation
  schema v4 (per-sub-wave full triad+scope panels, typed `--slot-record`
  sealing with verdicts re-derived from digest-bound raw report bytes, a
  sealer-verified packet manifest, and a signature-bound coverage receipt,
  CONCEPT-CHANGE INV-125); and machine-derived packet narratives that
  structurally close the stale-narrative failure class. Ships the merged
  community PRs: doctor diagnoses broken installs behind "not found on PATH"
  (#32, Andrei Gritsaev), declared JSON Schema dialects incl. draft 2020-12 in
  structured output (#33, Alex Basis, closes #30), singleton-pool primary
  inference (#34, Alex Basis), and truthful producer telemetry outcomes (#35,
  Alex Basis). Meta: README author links, a daily SHA-pinned repo-metrics
  workflow with honest "total downloads" (npm + an app DMG/ZIP asset allowlist)
  and star-history charts from our own CSV ledger (D-15, a shared collector
  reused by the CLI's release stats — no duplicate fetcher), a GitHub Pages
  landing site + npm discovery improvements (#36/#37), package.json author
  metadata, and `about --json` asserted in the npm install smoke. Deferred to
  `docs/BACKLOG.md`: the full RunFacts projection layer (#29 remainder), the
  visual quality-tier editor (#22 remainder), instruction-transcript hash
  binding (QA-030), real resumable uploads (QA-039 — catalog wording is now
  honestly single-shot), auto-continuation beyond the proven Claude case, the
  transcript List migration for pathologically long threads, and settings
  revision/etag (W-j).

- **v3.0.4** (2026-07-22) — fixes GitHub #20: saving Per-Harness Defaults from
  the macOS app reported "Could not save settings: DecodingError.keyNotFound
  ('path')" even though the daemon had already written the config. The Swift
  client still decoded the v0.x `{path}` receipt from POST /settings; the
  daemon has answered with the effective settings snapshot (GET's shape) since
  v2.1.2, and the mismatch was unmasked when v3.0.3 fixed the request-side
  400 (#18). The app now decodes the snapshot, applies it directly (no
  follow-up GET), and reports success honestly. The TS→Swift wire-fixture
  gate gains a maximal `ControlSettingsSnapshot` fixture so the POST
  /settings response contract is pinned the same way #18 pinned the request.
- **v3.0.3** (2026-07-21) — hardening from the 2026-07-21 "codex chats
  disappeared" incident forensics (local data was never touched; the trigger
  was an OpenAI server-side session invalidation from a shared-browser account
  switch) plus GitHub issue triage. Config: a schema-parse failure is now a
  typed `config_invalid` (422) with a path-specific inspect-or-restore remedy
  instead of a generic 500; the retired-key registry gained the pre-registry
  v1 removals that broke strict parse (`default_portfolio`,
  `routing.default_policy`, `budget.max_usd_per_run`, `harnesses.*.max_usd`);
  the startup sweep now rewrites the GLOBAL config only on this generation's
  own default root — never a foreign root reached via `CLAUDEXOR_CONFIG_DIR` —
  and writes a byte-identical backup before it mutates. Plugins: a version
  skew or an unmarked non-default frozen root is a hard `mcp serve` refusal
  (`plugin_artifact_skew`, remedy `claudexor plugin repair all`) rather than an
  ignorable stderr warning; default-root installs no longer freeze
  `CLAUDEXOR_CONFIG_DIR`, and an explicit override carries a
  `CLAUDEXOR_ROOT_MODE=explicit` provenance marker. Setup: an interactive login
  survives an ordinary daemon restart (a bounce no longer kills the operator's
  own pending login), reconciling only identity-proven live runners; codex
  login defaults to device-auth (safe for sibling OpenAI sessions when
  completed in an isolated browser window) with `--browser-redirect` as the
  explicit opt-in and a typed `not_supported` outcome on older codex CLIs;
  claude login drops the version-varying `--claudeai` flag (#17); a device-auth
  login that fails after starting carries the ChatGPT "Allow device code
  login" toggle remedy; the CLI discloses daemon/CLI engine-version skew from the
  control handshake. Quota: a
  logged-out codex home reports a typed `not_logged_in` absence WITHOUT
  booting `codex app-server` (ending the every-60s scoped-home spawn loop),
  absence-only refresh cycles back off exponentially, and a claude
  `oauth/usage` HTTP 200 with no parseable windows is a typed
  `refresh_failed` absence (BACKLOG Q-a); codex transcript readers no longer
  fall back to the operator's real `~/.codex`. macOS: the
  dead per-harness `maxUsd` field that 400'd Per-Harness Defaults is removed
  (#18), and the onboarding window scrolls (#15). Build: `build-app.sh` hard-
  fails on a non-self-contained (libnode-linked) Node instead of silently
  bundling a dead binary (#14); a new `retired-key-check` gate asserts every
  key removed from the persisted config schemas lands in the retired-key
  registry. Also ships the packaged-.app launch fix from #13 (thanks
  @robert-platov): the executable no longer traps on `Bundle.module` at
  startup. Docs: a new agent Install And Login guide in
  `docs/AGENT_ONBOARDING.md` and a reproducible GitHub social preview (#19).

- **v3.0.2** (2026-07-21) — Linux subscription-quota parity for Claude. The
  per-profile quota reader (`oauth/usage` source) read the access token only
  from the macOS keychain item, so on Linux `quota --refresh` returned a
  misleading `not_logged_in` absence for every logged-in claude account while
  runs and doctor were green. Off macOS the reader now uses the vendor's own
  store — `.credentials.json` (mode 0600) inside the profile's config dir —
  with the same transient-token discipline (one usage request, never
  persisted/logged/in errors). A missing file stays an honest
  `not_logged_in`; an unreadable or unparseable file is a typed
  `refresh_failed` naming only the error class. macOS behavior is unchanged;
  Codex quota was already file-store-portable. Also: README badges and an
  author section.

- **v3.0.1** (2026-07-20) — hotfix: every browser-downloaded 3.0.0 DMG crashed
  at launch (EXC_BREAKPOINT in `applicationDidFinishLaunching`). The SwiftPM
  `Bundle.module` accessor fatalErrors when the resource bundle fails to load,
  and a quarantined process refuses the plist-less bundle `swift build` emits.
  Fixed twice over: the Dock-icon override (essential for the bare dev
  executable, harmlessly re-applied by the packaged app) is now resolved by
  plain file path (no `Bundle.module`, cosmetic degrade instead of crash),
  and `build-app.sh` writes a minimal `Info.plist` into the resource bundle.
  If you downloaded 3.0.0: upgrade to this DMG — that is the fix. Only if
  you must stay on 3.0.0, first verify you have an intact app signed by the
  official Claudexor Developer ID:
  `spctl -a -vv /Applications/Claudexor.app` must report `Notarized
  Developer ID` AND `origin=Developer ID Application: Andrei Kaznacheev
  (N7RDVVZ7LA)` — a generic notarization line alone proves only that
  *some* notarized app sits at that path. (Signer identity proves an intact
  official build, not byte-identity with the published artifact; for that,
  check the downloaded DMG against `SHA256SUMS` on the release page.) Only
  then drop the quarantine flag:
  `xattr -d com.apple.quarantine /Applications/Claudexor.app`.

- **v3.0.0** (2026-07-20) — the chat-first control plane, rebuilt on honest
  server truth. This is a breaking major: a fresh `~/.claudexor/v3/` data root
  (the old `~/.claudexor/v2/` root is left untouched as the archive; no
  migration), wire protocol major 3, and a single chat-first macOS app.
  Modes collapse to Ask / Plan / Agent — Orchestrate is gone and delegation is
  `agent --delegate` with a scoped six-tool MCP belt (isolated sub-runs, depth
  1, count and budget caps enforced server-side). Plan absorbs Spec: native
  vendor plan modes, typed open questions, answer turns, freeze-on-implement
  with a hashed ExecutionBrief, and the Council strategy. Continuity is the
  flagship: durable per-lane native sessions keyed by (thread, harness,
  profile), lane checkpoints, bounded continuation packets with cached LLM
  summaries, and a visible typed disclosure when a lane switch carries thread
  context. Status is independent axes (lifecycle / checks / review / no-changes
  / typed reason) rendered as Working / Done / Done · not verified / Needs
  review / Failed / Cancelled / Interrupted, with a server-owned outcome banner
  that model prose can never outrank; unknown cost renders "—", never $0.
  Accounts are fully symmetric — every row has an Enabled toggle (participates
  in pickers and auto-rotation), the next-up account among the enabled ones is
  computed and shown, threads keep their account and access sticky with a
  per-thread pin/override, and native CLI login is just a row. The engine
  owns every fact; macOS, MCP, and ACP are thin clients that decode, not
  derive: a thread-scoped Changes / Artifacts / Evidence workspace with typed
  LoadState, a shared ChipMenu, global
  text selection, code-first route descriptors feeding the generated operation
  catalog, and TS↔Swift fixture round-trips. A runtime-closure update CHECK reads
  the release manifest (`{version, sha256, minAppVersion, notes}`; the signature
  field is reserved) and surfaces a newer engine as a bottom-left chip
  that links to the GitHub release for a manual download (one-click in-app
  auto-install of the engine runtime is deferred to 3.1); a zero-telemetry
  install counter reads public npm and GitHub stats.
  The immune system guards all of it: staged-field v3, the INV→verify link
  gate, the concept gate, reviewer liveness with a typed blocker contract, and
  a cumulative findings ledger. The review protocol is a single canonical
  cycle (internal critics + the exact triad plus scope reviewer, one
  adjudication, one batched fix, one confirmation wave). Upgrade note: v3 boots
  on its own data root, so the first launch starts clean; existing v2 state and
  run history remain readable only under the archived `~/.claudexor/v2/` path.

- **v2.1.3** (2026-07-18) — account and large-run reliability finish.
  Accounts now have one shared Manage surface with Back/Done navigation,
  manual thread pinning, auto-balance, and safe deletion. Claude native
  subscription auth works in scoped runs without mutating `~/.claude`.
  Large run details are single-flight and progressive: bounded primary output,
  metadata-only diagnostics, tab-demand diffs, bounded transcripts, and
  restart-safe Spec interviews. Best-of-N now uses file-backed synthesis,
  preserves winner screenshots, reports honest candidate/tool failures, and
  separates native subscription valuation from API-key cash (including mixed
  reviewer panels). Plan review is typed as plan review; exhausted account
  rotation, zero configured gates, and candidate errors are explicit evidence.
  Upgrade note: Claude's default native store moved from ordinary `~/.claude`
  to Claudexor-owned state, so existing users complete Login once in Accounts
  (or Settings → Harnesses → Claude → Manage); ordinary Claude Code remains
  untouched.

- **v2.1.2** (2026-07-18) — the credential-profiles release, published as
  2.1.2 after two npm-infrastructure burns: the v2.1.0 flight died on npm's
  post-publish indexing lag (the publisher's exposure window was too small),
  and the v2.1.1 flight on two more npm realities — the attestation endpoint
  lags like the version listing, and package builds are not byte-reproducible
  across CI runs, so retries demanding local byte-identity could never pass.
  Both partial version sets are orphaned on the registry (npm forbids
  re-publishing a version); nothing user-visible shipped as 2.1.0 or 2.1.1.
  The publisher now waits out both npm endpoints (bounded 10-minute polls)
  and anchors retry skips on npm's signed SLSA provenance (same repo/
  workflow/tag/candidate commit + published-bytes digest) instead of
  impossible byte-identity. On top of the 2.1.0 scope below, this release
  adds account deletion
  end-to-end (`DELETE /v2/credential-profiles/:harness/:id` with a
  delete-grade confinement fence and disclosed cleanup, `claudexor profiles
  remove`, delete on account rows) and ONE shared accounts surface
  (`AccountsSurface`) reused by the bottom-left popover and the Settings
  Harness Doctor's Manage sheet, plus the owner-review release protocol
  constitutionalized as INV-125.

  The 2.1.0 scope: credential profiles (INV-135) and the honest-UI
  finish of the 2.x cycle. Multiple subscriptions per harness: durable
  non-secret `credential_profiles` registry, isolated vendor config dirs
  (`claudexor profiles login`), namespaced secret slots, strict per-turn /
  thread-sticky selection, profile-isolated native-session resume, and
  per-profile doctor probes (`GET /v2/credential-profiles`). Subscription
  quota is now read proactively per profile from the vendor `oauth/usage`
  endpoint (token transient-only, never persisted or logged) with per-profile
  chips in the quota footer, plus the live-verified codex
  `rateLimitResetCredits` balance. One typed `profile_policy` per harness
  (`fail|ask|rotate`): preflight headroom breaches and typed vendor-limit
  rejections rotate with full provenance — never on plain network errors,
  never mid-spawn, each profile at most once per attempt. Also in 2.0.1/2.0.2
  (unpublished patch steps folded into this release): the honest-engine pass
  (shutdown state-machine with an uncancellable drain sweep, daemon-owned
  retention with tombstones, typed final-answer assembly, harness-stream
  reference + manifest-declared stream conformance) and the simple-UI pass
  (messenger chat cards, flat one-row-per-tool transcripts, RunFacts SSOT,
  daemon-normalized readiness rows, cause-driven single-CTA auth sheet,
  typed budget.cash disclosure; INV-134 presentation discipline). Claude
  api_retry error prose now classifies onto the documented retry categories.

- **v2.0.0** (2026-07-15; **unpublished** — superseded by v2.1.0 before any
  tag, GitHub Release, or npm publish; kept here as the contract baseline) —
  clean breaking reset. Claudexor now exposes one
  versioned `/v2` daemon authority over a checksummed durable journal, typed
  commands and scoped event streams; v1 project, trust, secret, run, and thread
  state is neither imported nor mutated. Delivery is preimage-bound and always
  runs the same fresh FinalVerifier before manual apply, thread apply, race
  adoption, or orchestration delivery. Capability truth is split into static
  manifest, live doctor, and request preflight; attachments are immutable
  streamed resources, Browser is a pinned offline-capable runtime with
  per-lane receipts, and Raw implement returns a scoped hash-bound Git patch.
  Outcome reduction no longer launders incomplete required work into success;
  budgets use explicit finite/unlimited semantics and one root ledger, while
  routing is reduced to `auto`, `quality`, and `economy` over durable
  multi-window quota evidence. The macOS app, CLI, MCP, and ACP are thin live
  projections of those contracts, with honest offline/review/retry/spec/setup
  states. Release publication is now fail-closed: exact-SHA review attestation,
  signed and separately notarized/stapled app + DMG, SBOM, checksums, GitHub
  provenance, collision refusal, and npm provenance are mandatory; published
  tags, releases, and assets are never edited by the workflow.

- **v1.0.1** (2026-07-09) — the macOS app is now SIGNED (Developer ID +
  hardened runtime), NOTARIZED, and stapled: no Gatekeeper bypass needed.
  Fixed the v1.0.0 app's self-contained daemon, which crashed at load in
  the single-file bundle (`createRequire(import.meta.url)` is undefined in
  CJS bundles; the generated-schema loads are now static JSON imports and
  the build runs a boot smoke on the freshly built bundle, so a load-crash
  can never ship again). The bundled Node runtime is signed with the JIT
  entitlements hardened runtime requires. Release automation: signing is
  data-driven off repository secrets (secret-less builds still produce
  honest `-unsigned` artifacts), re-packaging a published release no
  longer demotes it to draft, and npm publishing completes the package
  set. CLI: `spec --answers` now refuses grounding-only flags
  (`--harness/--n/--web/--effort/--max-usd/--reviewer-*`) instead of
  silently ignoring them, and the spec grounding run honors
  `--effort`/`--max-usd` cost controls.

- **v1.0.0** (2026-07-09) — the first public release. Three programs land
  on top of v0.15: PUBLICATION HYGIENE — provenance sweep of the whole tree
  (private paths, internal codenames, decision-register markers), sanitized
  recorded fixtures with enforced provenance, a community trust pack
  (SECURITY.md, issue/PR templates, Dependabot, no-telemetry Privacy and
  uninstall/data maps), and supply-chain pinning (pnpm `allowBuilds`, no
  dependency install scripts). AGENT CONTRACT — the CLI surface has ONE
  typed owner (`command-registry.ts`) that renders `claudexor help`, the
  machine-readable `help --json`, plugin instruction texts, and the
  docs/parity gates; a derived AgentCapabilityCatalog answers "what can
  this install do right now" identically over `claudexor capabilities
  --json`, `GET /agent-capabilities`, and the MCP `claudexor_capabilities`
  tool; MCP tools declare outputSchema + structuredContent + behavior
  annotations and gained read-only recovery tools (`claudexor_runs`,
  `claudexor_inspect`, `claudexor_apply_check`); every run result carries a
  derived `applyEligibility` verdict (one producer: the delivery gate);
  every Zod schema ships field-level `.describe()` docs and
  `docs/reference/endpoints.json` maps the control API with schema refs;
  `docs/AGENT_ONBOARDING.md` orients external agents. NAMING AND SAFETY —
  BREAKING: the `run` verb is now `agent` and `race` is `best-of`
  (old spellings hard-error with the new name; the MCP race tool is
  `claudexor_best_of`); secret-like values inside prompts are HARD-BLOCKED
  at every ingress (CLI, control API, thread turns, MCP, ACP, daemon
  socket, and the engine boundary itself) with a typed
  `inline_secret_rejected` error and no bypass; the feature-status ledger
  was emptied (26 fixes landed; deliberate boundaries moved to Design
  constraints in ARCHITECTURE/INTEGRATIONS); strictness upgrades:
  out-of-scope flags now hard-error per verb (e.g. `explore --swarm`,
  `spec --model`), `--access-default` requires a value, and unknown verbs
  return the `{ok:false}` JSON envelope under `--json`. npm packages are
  published from the tag with provenance (`claudexor` is the bin wrapper
  over `@claudexor/cli`).
- **v0.15.0** (2026-07-05) — the stabilization release: concept freeze
  (numbered-invariant Bible + concept gate), model governance
  (harness-scoped models, strict truth-source validation at settings-write
  and run preflight), run honesty (terminal events on every path, an
  inactivity watchdog, crash GC with live-owner proof, CRLF/binary diff
  fidelity, and a fresh-envelope FinalVerifier before apply/adopt),
  routing/output reality (typed quota -> headroom-aware routing, portfolio
  metrics with real producers, structured output on both real CLIs, live
  plan checklists, per-candidate evidence cards), a per-commit multi-model
  review gate with audited bypasses, and the MCP/ACP surface upgrade +
  integration suite below. Refused turns are honest end-to-end: a run
  refused before it starts persists a typed `enqueue_error` on its turn
  (INV-093), every surface renders it inline,
  `POST /threads/:id/turns/:turnId/retry` replays the same turn
  (non-retryable refusals 409), and the macOS trust refusal carries a
  one-click "Allow full access & Retry" backed by the narrow user-level
  GET/POST /trust surface (provenance-stamped, locked writes; Settings
  audit + revoke). UI performance without touching glass/transparency:
  per-run render granularity (one card repaints, not the app), adaptive
  SSE coalescing, bounded feeds with honest truncation markers, a lazy
  newest-first Timeline, and off-screen terminal-run eviction. Phase
  entries below preserve the detailed history.
- **v0.15 program, phase 5** — MCP/ACP surface
  upgrade: the MCP server rides the official TypeScript SDK v2
  (`@modelcontextprotocol/server` 2.0.0-beta.1) — concurrent dispatch
  (ping/tools/list answer during a long race; the hand-rolled loop was
  strictly sequential), protocol-era negotiation (2025-11-25 down to
  2024-10-07), SDK-validated arguments over the same JSON Schemas (semantic
  checks stay as handler preflight; argument failures are `isError` tool
  results per the SDK contract, not -32602). MCP MUTATING verbs
  (run/race/create) are DAEMON-TRACKED via the control API (auto-start):
  `GET /runs` lists MCP runs, cancel/decision work, and every result carries
  a runId/artifacts/status trailer (live-verified). Read-only verbs stay
  in-process (CLI doctrine). Engine questions bridge to MCP ELICITATION when
  the host declares the capability (pendingInteractions polling + typed
  answer endpoint); timeout-decline stays the fallback. `mcp serve` warns on
  stderr when `CLAUDEXOR_PLUGIN_VERSION` (installed artifacts) differs from
  the CLI (the env var's first reader). ACP: initialize carries
  `authMethods: []`, the protocol `_meta` envelope is tolerated (unknown
  Claudexor knobs still fail loudly), and permission requests announce their
  tool_call first (no orphan ids). Host plugins regenerated + repaired.
  Host CANCELLATION: MCP notifications/cancelled aborts the run — the SDK's
  per-request signal rides the runner hooks; on daemon-tracked runs it
  becomes the same typed cancel control as CLI Ctrl-C (posted once, on the
  poll tick, after the run is bound).
  Integration test suite: surface canaries in CI (MCP daemon-tracked run
  E2E over stdio, plugin lifecycle in a scratch HOME, ACP conformance
  smoke), the MCP<->CLI capability parity gate
  (`scripts/mcp-cli-parity-check.mjs`, CI — pins the stale-tool-schema
  class), `scripts/cursor-itest.mjs` (Cursor chain phases A/C/D + failure
  modes scripted; manual B/E in CHECKLISTS), and real-harness battery
  phases 10-12 (`mcp serve` / `acp serve` smokes + plugin lifecycle;
  `CLAUDEXOR_BATTERY_PHASES` filter) — live-run green on codex. Fixture
  provenance manifests (`packages/harness-*/fixtures/manifest.yaml`:
  synthetic vs recorded + the vendor CLI version a recording proves) with
  a CI coverage gate and a release-grade freshness check
  (`scripts/fixture-freshness-check.mjs --strict`); the mandatory
  pre-release IMMUNE SCAN (whole-tree audit against the Bible) is now a
  Release checklist step.
- **v0.15 program, phase 4** — routing/output reality: typed
  quota events (codex rollout rate-window -> used_percent observations ->
  headroom-aware pool ordering + `budget.quota_pressure` disclosure; claude
  fail-honest), portfolio metrics with real producers (per-harness EMA
  cost/latency under the config dir + operator `routing.quality_priors`),
  structured output live on both CLIs (codex `--output-schema`, claude
  `--json-schema`; strictified inline OrchestratePlan schema; structured-first
  plan parsing), live plan checklists (`plan.progress` from codex todo_list /
  claude TaskCreate+TaskUpdate) and per-candidate evidence cards projected on
  run detail (macOS Candidates/Plan tabs live), and the per-commit review
  gate (`claudexor review` + `scripts/commit-review.mjs` with audited
  bypasses; opt-in hooks).
- **v0.15 program, phase 3** — run honesty: every announced run
  now ends with a terminal event on every path (throw/cancel/daemon restart);
  a silent harness stream is killed by an inactivity watchdog
  (`runtime.harness_inactivity_timeout_ms`, default 20 min; waiting on a user
  question does not count as silence); diffs are captured byte-faithfully
  (CRLF/binary survive; payload-less binary stubs are typed refusals); race
  winners must additionally survive a FINAL VERIFY (fresh worktree at the
  winner's base + deterministic gates; failures AND verifier errors block the
  run fail-closed); apply/adopt ride a protected path (check-first, restore
  on failure). BREAKING surface changes: `POST /runs` rejects client-supplied
  `turnId` and `planRunId` (400); unknown CLI commands exit 2 (was: help with
  exit 0); thread apply 409s while the head run is blocked/failed without a
  typed operator decision (or its record was pruned); `--max-tool-calls` /
  `maxToolCalls` is refused outside orchestrate; orchestrate sub-runs share
  ONE aggregate budget (each sequential step gets the remaining headroom).
- **v0.15 program, phases 1-2** — BREAKING config strictness: YAML configs
  (`~/.claudexor/config.yaml`, project `.claudexor/config.yaml`, trust files)
  are now parsed against STRICT schemas — an unknown/typo'd key is a loud
  `ConfigParseError` naming it, never a silent no-op. Keys that OLDER
  Claudexor versions legitimately wrote (`secrets`, `budget.max_usd_per_day`,
  `routing.default_model`, `harnesses.*.auth_ref`, `harnesses.*.native_options`,
  project `project/delivery/review` blocks and retired context flags) are
  auto-stripped by a migration registry and disappear on the next config
  write; any OTHER unknown key must be removed by hand. Model choice is now
  harness-scoped end-to-end (`routing.default_model` is gone — use
  `harnesses.<id>.default_model`), and every explicit model must pass the
  harness's model truth source. The intents `compare`/`arbitrate` and the
  `scope.context: deep` tier were retired.
- **v0.14.1** (2026-07-01) — checkpoint hardening for explicit reviewer panels, mandatory
  review evidence preflight, scoped Cursor reviewer readiness, frozen SpecPack
  gate merging, protected-path approvals, and thin control/macOS projection
  parity.
- **v0.14.0** (2026-06-29) — battery-driven hardening: typed transient retry evidence,
  configurable reviewer timeouts with stronger route-proof capture,
  `stuck_no_progress` convergence diagnostics, deterministic protected-path
  tamper blocking, and a stricter real-harness battery with ENV quarantine.
- **v0.13.3** (2026-06-28) — harness-agnostic hardening: a contract-level attempt outcome
  model, unified runtime PATH handling, adapter-declared credential/isolation
  capabilities, uniform mandatory-context behavior across harnesses,
  sandbox-safe secrets, deterministic fakes, and an honest CLI surface.
- **v0.13.2** (2026-06-27) — Canvas + node_repl fix: the Canvas Artifacts panel now shows the
  PROJECT's produced outputs (the repo `artifacts/` dir, served via
  `GET /runs/:id/produced`, images inline, the Browser tab auto-renders the
  project `index.html`) — distinct from Run Detail's run-internal artifact tree;
  and Codex.app's inherited `node_repl` MCP, which can't run headless and failed
  otherwise-clean runs, is now disabled config-aware (only when it is actually
  defined in the config codex loads — never on a scoped home, which avoids an
  "invalid transport" config-load break).
- **v0.13.1** (2026-06-26) — attachment fix: user-attached images now reach the model
  (orchestrator forwards attachments in every run path; the codex adapter
  terminates the variadic `-i` with `--` so the prompt survives), an image-bearing
  run only routes to vision-capable harnesses (or fails loudly), and large
  agent-produced images render in the gallery.
- **v0.13.0** (2026-06-26) — interactive workbench: composer attachments + in-app screenshots,
  an artifacts gallery + mini-browser in a Canvas/Workbench, a deeper multi-tier
  spec interview, a multi-harness planning relay, and an agent-driven browser
  (Playwright MCP).
- **v0.12.1** (2026-06-18) — fix release after v0.12.0: embed the SwiftPM-generated resource
  bundle in the release macOS app so the packaged app works outside the build
  checkout.
- **v0.12.0** (2026-06-17) — restored the write/apply path (codex transcript route-proof,
  scoped homes) and honesty fixes.
- **v0.11.0** (2026-06-17) — host plugin lifecycle: `claudexor plugin` now manages
  user-global Claude Code, Codex, Cursor, and OpenCode integrations with
  generated skill/MCP artifacts plus command artifacts where the host supports
  them, ownership state, dry-run/status/doctor/repair/uninstall flows, Codex
  personal-marketplace registration, OpenCode skill/command/experimental
  JS-plugin/MCP wiring, and install-health checks that keep host integration
  readiness separate from harness doctor readiness.
- **v0.10.2** (2026-06-15) — real interactive spec quiz (multiple-choice interview) and the
  frosted-glass backdrop refinement.
- **v0.10.1** (2026-06-15) — macOS UX fixes and the first interactive spec flow.
- **v0.10.0** (2026-06-15) — chat-first macOS beta: one-screen thread list, conversation,
  and inspector; in-place thread turns; honest run outcomes; static
  behind-window glass replacing the old animated mesh.
- **v0.9.0** (2026-06-12) — chat/session-first + harness-agnostic truth: modes collapse 9→5
  (`ask`/`plan`/`audit`/`agent`/`orchestrate`; strategies are flags); threads
  with native session resume across read-only turns (codex `exec resume`,
  claude `--resume`; write turns run fresh envelopes with a typed
  `session.rebound` disclosure) plus a no-args CLI REPL; subscription auth pass-through into
  envelopes (native codex/claude sessions work with NO API key) with both auth
  routes and auto-fallback; typed operator decisions unblock NEEDS_HUMAN runs
  through the apply gate (patch-hash-bound, audited); the `orchestrate` brain
  intent (routed like reviewers, typed tool-belt plan); survival fixes (diff vs
  base_sha so committed harness work is never lost, untracked-inclusive
  snapshots, branch GC, process-group kills, mid-flight budget caps, reviewer
  timeout spend, codex cached-token cost, honest acceptance/tie evidence,
  expanded secret redaction); doctor probe TTL cache; MCP protocol bump with
  doctor-honest status + repo-path input; ACP editor-cwd + free-text answers;
  cursor/opencode resume + unified provider env scrub; OpenRouter raw-api
  instance; macOS ThreadsScreen (chat-first) with decision/apply actions on
  turns and a lifted dark card recipe.
- **v0.8.0** (2026-06-11) — live truth pass: event-sourced streaming with a monotonic
  per-run `seq` and snapshot-then-subscribe SSE (gap-free reconnects, byte-level
  parser in the macOS app), interactive runs (`waiting_on_user`) with Claude's
  bidirectional control protocol live-verified (`AskUserQuestion` answered from
  the app, CLI `claudexor follow`, ACP), automatic git initialization for
  write-mode runs on non-git folders (seeded `.gitignore` + announced baseline
  commit), orchestrator honesty fixes (no corpse review/synthesis spend,
  root-cause `failure.yaml`, `output.ready` before terminal events, no vacuous
  `tests=100%`), in-process setup doctor (exit-127 class removed), observed-model
  route proof, global `GET /events` multiplex, configurable interaction timeout,
  and the frosted floating-card design doctrine across both themes.
- **v0.7.0** (2026-06-10) — engine truth pass: typed `tool_call`/`tool_result` events with a
  shared adapter run loop, engine-owned `final/telemetry.yaml` evidence, web
  policy as a manifest capability with disclosed upgrades, parallel
  race/explore, user-level trust gating for full access, per-harness settings
  enforced engine-wide (enabled/model/effort/web in the macOS editor; budget,
  turn/round caps, and tool lists via config and the settings API), typed
  risk/protected-path review gates, honest control-api/daemon lifecycles,
  macOS live streams + diff tab + per-harness settings editor,
  knip/docs-truth/conformance CI gates,
  dead subsystem deletions (ExecutionEngine, legacy in-proc control server,
  `/runs/:id/input` stub).
- **v0.6.0** (2026-06-09) — first public beta: canonical modes, daemon + control API, macOS
  app, review/arbitration pipeline, secret store, release automation.

Tags before v0.6.0 (v0.1.0–v0.5.0) were internal pre-beta milestones and are
not documented here.
