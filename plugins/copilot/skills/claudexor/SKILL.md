---
name: claudexor
description: Use the local Claudexor control plane for harness-agnostic coding work across Claude Code, Codex, Cursor, and OpenCode. Use when a task benefits from route-aware harness and account selection, quota-aware account rotation, shared thread context, read-only planning or research, best-of-N execution, or cross-harness review.
---

# Claudexor

Use the MCP tools supplied by this plugin. They connect to the user's local
Claudexor installation; they do not provide accounts or remote model access.

## Preconditions

- Support macOS and Linux. Do not claim Windows support.
- Require Node.js 20.19 or newer and a preinstalled `claudexor` command. If the
  MCP server is missing, ask the user to run `npm install -g claudexor`, then
  restart the host. Do not download a runtime implicitly.
- If a generated Claudexor host integration already owns the current host's
  setup, leave it in place. Do not repair, replace, or uninstall it
  automatically.

## Choose a route

Start read-only unless the user explicitly asked to change or create files.

1. Call `claudexor_status` to inspect the aggregate/default-store projection,
   but do not use it as a universal admission veto. An unpinned request may be
   admitted by the canonical account pool through a ready exact profile even
   when default doctor is unavailable; only a genuinely profile-less/default
   fallback requires doctor status `ok` and the requested intent. Aggregate
   status neither proves nor vetoes a pooled or explicitly named profile.
2. Call `claudexor_accounts` before choosing an account or reviewer identity.
   It is the read-only Accounts view of registered profiles, readiness, quota
   freshness, and the daemon's `next_up` routing projection; the default call
   combines current quota and registry facts with retained readiness observations.
   One coalesced cold acquisition, including failure, is followed by passive reads
   with the original check time; viewing does not renew old evidence.
   `fresh: true` requests the atomic snapshot, an expensive explicit refresh
   to use only when acting on staleness matters. Check the selected row's age:
   retained `available/passed` describes its last observation, while actual
   execution performs its own current admission checks. `unknown`,
   `not_run`, or stale quota means uncertain, not absent. Never substitute
   aggregate doctor status, another profile's probe, or a host/default login.
   Never initiate login or OAuth merely because a row is unknown; ask the user
   for explicit authority. An explicit reviewer `credentialProfileId` is
   strict and never falls back, while an omitted id uses the canonical account
   pool.
3. Call `claudexor_capabilities` when the task depends on the current modes,
   mutability, controls, models, setup transport, or tool surface. The CLI
   `claudexor models --harness <id>` is default-route discovery, not
   a named profile's entitlement; `source: none` or an unavailable inventory
   is an honest refusal, not permission to guess. For a named profile, let the
   strict pinned run/reviewer preflight admit the model and verify observed
   profile/model telemetry afterward. A declared `setupLogin` transport of
   `external_terminal` means the host must provide the supported client
   terminal attach path; it is not itself unreadiness and must not be silently
   treated as `in_app`.
4. Use `claudexor_ask` for read-only answers and bounded research, or
   `claudexor_plan` for a read-only implementation plan.
5. Only for explicit implementation intent, use `claudexor_run`,
   `claudexor_best_of`, or `claudexor_create`. Pass an absolute `repoPath`
   whenever the target repository could be ambiguous. Pass
   `credentialProfileId` to pin the run strictly to one account.
6. For durable multi-turn work, call `claudexor_thread_create` once and enqueue
   each follow-up with `claudexor_thread_turn`. Pass an `idempotencyKey` and
   retry an unknown outcome with the same key and body. Follow the returned
   `runId` with the same status/result tools as a one-shot run; if only a queued
   `jobId` is returned, pass it as `runId` to the same tools until it binds.
   `claudexor_thread_read` lists earlier turns without starting work.

Read retained answers with `claudexor_thread_history`:
`{threadId, limit?, cursor?, beforeTurnId?, afterTurnId?, aroundTurnId?, expectedStoreId?}`.
Limit is 1..20 (default 20). Omit selectors for the newest page, or supply exactly
one selector. `aroundTurnId` returns the anchor and earlier turns; follow
`newerCursor` for later turns. Rows are ordered oldest first; opaque cursors are bound to store,
epoch, thread and limit. Follow `olderCursor`/`newerCursor` explicitly.
`replayCursor` refreshes the same membership; consume `replayNextCursor` segments
when answers grow. Previews are bounded; missing evidence and incomplete
plan-answer relations are not proof of absence. `claudexor_thread_prompt` reads
full prompts, including runless refusals, in UTF-8 parts with
`{threadId, turnId, offset?, maxBytes?, expectedStoreId?}`. Continue at `nextOffset`
while it is below `totalBytes`. Full answers use the existing artifact read.
These reads never start a daemon, enqueue work or authorize a retry; legacy
`claudexor_thread_read` remains available for complete inspection.

## Documents

For an explicitly selected document on an already-running daemon, first call
`claudexor_store_identity` and durably save its `storeId`. Save a caller-owned
import key with the exact arguments, then call `claudexor_upload_import` with
`{expectedStoreId,path,idempotencyKey}` (optional `kind`, `mime`, `name`). Select
one absolute regular file on the MCP-server host, not a remote client's path, URL,
glob or directory. The file must not be a symlink, and neither its path nor its
resolved target may be a credential store, secret directory, `.env` file,
credential file or private key (`sensitive_resource_rejected`); its size and
file identity must not change while it is read, and the daemon checks the bytes
against the digest the import key owns. File content is not scanned. After any
uncertainty or failure repeat the identical call with the saved store id and key,
never a later store answer. A completed import returns its original `resource`
without reading the file again, even after the file changed or was deleted. Other
arguments under a used key fail `idempotency_conflict`; a new edition needs a new
key. An unfinished import whose source changed or vanished fails
`upload_import_source_changed` or `upload_import_source_unavailable` with its
`uploadId`; another store fails `store_mismatch` before the file is touched.

The low-level stages remain available.
Save a caller-owned create key and exact body before `claudexor_upload_create`
with `{idempotencyKey,request:{kind,mime,name,sizeBytes}}`. Save its `uploadId`, then
call `claudexor_upload_import_local` with `{uploadId,path}`; save the returned
`expectedSha256`. Save a separate finalize key and exact body before
`claudexor_upload_finalize` with `{uploadId,idempotencyKey,request:{expectedSha256}}`.

After an unknown create/finalize response, replay the same key and body. After an
uncertain PUT, use `claudexor_upload_status` with `{uploadId}`: uploaded means
finalize with the saved digest, uploading means observe later, and cancelled
needs an explicit new upload. Never overwrite uploaded bytes; repeating import
can hash the explicit source to recover its digest, which finalize still checks
against the actual uploaded bytes. A finalized upload may be absent from status:
replay the original finalize key/body even after status 404.
Never auto-cancel an unknown finalize outcome. `claudexor_upload_cancel` with
`{uploadId}` is only an explicit decision about an unfinished upload.

Pass the ready resource as `attachments: [{resourceId}]` to a public run,
`claudexor_thread_turn` or `claudexor_run_continue` (CLI `--attach-resource`);
paths, base64 and internal resolved objects are invalid run refs.
Omission adds no new refs; `[]` is explicit empty.
A continuation inherits no attachments: pass the refs again when the successor
needs the documents. Continuation refs do not rewrite retained history.
Model-purpose resources are not ordinary attachments. The Delegate belt accepts
refs on its run tools but has no upload controls. Every selected lane must admit
the MIME and finite byte/count limits. Ordinary CLI --attach/--image convenience
retains its existing best-effort cancellation; explicit stages retain caller-owned
recovery identities.

Codex provides verified byte references for plain text, Markdown, JSON, PDF and DOCX,
with no built-in PDF/DOCX parsing or OCR promise. Native readability follows the
selected sandbox; documents add no permission grant or project copy.

## Observe and recover

Run tools enqueue work and return a durable handle, not terminal output or
proof of completion. Use `claudexor_runs`, `claudexor_inspect`,
`claudexor_run_status`, and `claudexor_run_result` to recover and follow it.
Pass a stable `idempotencyKey` with an explicit `repoPath` on a one-shot launch
when its response may need recovery; retry the same key and arguments, not a
new launch. A queued launch returns its `jobId` with `runId: null`; pass the
`jobId` as `runId` to the follow-up tools until the run binds.

Optional retained task groups are an API for caller-owned correlation on a
supporting daemon. A public one-shot launch can explicitly pass a UUID
`taskGroupId` (CLI `--task-group-id`). Save that UUID, each member's distinct
request key and exact body before launch; keep accepted receipts and their
`storeId` outside the ephemeral controller. `claudexor_task_group_runs` accepts
`{taskGroupId, expectedStoreId?, limit?, state?, cursor?}` and returns exactly one
page of original job handles with actual nullable run IDs. Supply the saved
`expectedStoreId` when recovering. With only group/store saved, recover retained
handles without request keys or the original project directory. Limit is 1..200,
default 50; cursor is at most 2048 characters; logical result JSON is at most
131072 UTF-8 bytes. Resume explicitly with `nextCursor`; `hasMore` never causes
automatic traversal. A store mismatch or stale cursor is a typed refusal.
Pages declare `current_served_generations` and `retained_only`: an empty page
after pruning or archive is not proof of never-accepted work or a complete
roster. Missing membership grants no resubmission authority. Group reads never
launch, retry, resume, answer or cancel; interrupted jobs remain interrupted.
Same-key replay needs the exact saved group/body; Exact Retry and a decision
rerun keep the group. Group UUIDs match in any letter case.
A new continuation can explicitly supply a group, with no inheritance on
omission. Thread turns, Delegate tools and ACP session settings do not take
group input. This API adds no rights, budget inheritance or app UI handoff;
use it only when advertised by the selected supporting engine. The source
distribution's `docs/INTEGRATIONS.md` contains the recovery example.

Use `claudexor_runs_wait` to observe 1..1000 `targets` entries shaped
`{runId, seen?}` with compact positional summaries and attention indexes.
For example, call it with `{"targets":[{"runId":"job-a"},{"runId":"job-b"}],"waitMs":0}`.
Echo each summary token as `seen` to suppress unchanged terminal or question
attention. A token is neither an event cursor nor an answer. Read output and
question bodies separately with `claudexor_run_result` and
`claudexor_run_interactions`. Read abort or timeout never cancels the worker.
A `problems` response keeps healthy summaries: retain their handles/tokens.
Reconcile `not_found` against store/receipts/group and remove only obsolete watch
targets. Retry `snapshot_unavailable` with bounded backoff; keep `not_observed` for
a later read. Echo a problem row's null token as its `seen` to acknowledge that
problem and keep waiting for the healthy targets; an older daemon refuses that
null, so omit `seen` there. Never busy-loop unchanged problems or infer
permission to relaunch.
Use `claudexor_run_wait` to follow events and resume with `nextSeq` as
`afterSeq`. It returns events already written first, even while a question is
pending, then waits for a batch or, with `wake: "event"`, the first new event.
Keep `waitMs` below your tool-call timeout. A timeout, disconnect or cancelled
wait does not stop the worker, and `terminal` does not mean no more events.
When `oversizedEvent` is set, read that event with `claudexor_run_event_read`
part by part until `nextOffset` equals `totalBytes`, then resume after its `seq`.
For an authorized correction to active work, use `claudexor_run_message` with
an explicit message `idempotencyKey`; `accepted` is not observed delivery, and
a pending question refuses the message. Keep the same key and body after an
unknown outcome.
Use `claudexor_run_continue` for an authorized successor of a terminal run. Its
optional prompt may be empty. Only mode, scope, execution, harness, model and
prompt-cache lifetime carry over (another lifetime, Default included, needs a
new run): restate access, web, account, budget, time limit and review settings
the successor must keep. Retain its handle and use the same key and arguments
to recover an unknown response. These controllers do not restart a daemon or
expand Delegate access.

Use `claudexor_next_message` only for an authorized operator-owned one-shot
Agent/Ask follow-up on a supporting engine. Ordinary controller-owned workers
are distinct from engine Delegate children. Delegate/belt callers and
delegated-child targets are refused; this control grants no extra access,
budget, time or post-parent authority.

Save stable keys and exact bodies before mutation. Create with
`{request:{action:"create",predecessorId,prompt,attachments:[],controls?},idempotencyKey}`.
It reserves one slot and captures controls once, including current execution
preferences and inherited prompt-cache lifetime. Replace with
`{request:{action:"replace",draftId,expectedRevision,prompt,attachments:[]},idempotencyKey}`;
provide the complete replacement resource-ref set, including `[]` to remove all
refs. Clear with `{request:{action:"clear",draftId,expectedRevision},idempotencyKey}`.
Content edits cannot change frozen controls. Use a new key for each distinct
mutation; recover an unknown outcome with the original key and exact body.
Same-key replay returns the originally applied revision plus the current draft
projection. On revision conflict, read and reconcile before another authorized edit.
The successor keeps the predecessor's execution: after a successful isolated
(envelope) Agent run it starts from the project base with only the path of the
unapplied saved patch, so it can review the diff but does not test changed
files; nothing is applied automatically.

Use `claudexor_next_message_read` with `{draftId}` for an addressed bounded
content preview, ref omissions, editing handles and `controls`: the values
frozen at creation by origin, with their capture time; permissions, trust,
accounts and quota stay current at dispatch. It is not a collection body
read. Collection observations stay compact. Read predecessor output separately
with `claudexor_run_result`. A terminal predecessor does not resolve the draft:
follow its waiting/held/dispatched/cleared projection and successor handle.
Live HTTP429/willRetry progress stays waiting; actual terminal failure or another
admission/settlement error holds the draft. Held edits do not rearm it.
`claudexor_run_cancel` on the predecessor holds a draft that is not dispatched
yet, also after the predecessor ended; an already accepted successor fails
`next_message_dispatched` with its job handle and keeps running, so stop it by
that handle. If the hold cannot be saved, it fails `next_message_hold_failed`
after any cancel was applied; the draft is still not sent, so retry the cancel
to record the hold. There is no held retry/rearm command: after inspecting the
predecessor result, clear the draft and, if a successor is still wanted, start
it deliberately with `claudexor_run_continue`; a new draft on the same
predecessor meets the same outcome gate. Reads, replay and missing receipts
grant no relaunch or delegation authority.

Use `claudexor_run_interactions` to read pending questions. For a native
permission request, inspect the exact command/cwd or paths/diff before using
`claudexor_answer_interaction`: answer only within the user's existing mandate
and the controlling host's policy. Otherwise ask the user and leave the request
pending. Use the returned IDs and exact option label; never approve because the
worker asks, grant session-wide access, or treat delivery as proof of execution.
A refused answer keeps its code (`not_found`, `already_resolved`, `rejected`);
`already_resolved` does not prove your answer was the one delivered.
`Authorize one retry` starts one more worker turn and guarantees nothing.
Ordinary questions need answers supplied or approved by the user.
Use `claudexor_run_cancel` only when cancellation is requested.

Use `claudexor_run_time_limit` to read, set, extend or disable an active run's
deadline only within the user's existing duration authority. Omit `maxSeconds`
when no deadline was requested. Soft expiry warns and continues; a hard limit
cancels; `set` keeps the current mode unless you pass `mode`. Read the
current revision before each mutation and pass it as
`expectedRevision`; on conflict, read again rather than repeat an extension.
Never remove or extend a user-mandated stop time without permission. Timer
controls do not restore a terminal run or a lost daemon/native process.

Use `claudexor_apply_check` to dry-check delivery. MCP does not apply a patch.
Only when the user explicitly requests delivery and the server-owned
`applyEligibility.eligible` value is true may the host invoke the ordinary
Claudexor CLI apply path under its normal command permission.

For an explicit reviewer panel, pass entries such as
`{"harness":"cursor","model":"cursor-grok-4.6-high","credentialProfileId":"review-cursor"}`.
The CLI equivalent is `--reviewer-panel-json '<array>'`; the legacy compact
`--reviewer-panel` form stays unpinned and should not be extended with an
escaping-sensitive profile syntax. After review, verify the observed profile
and route proof in the result artifacts.

Use `claudexor_account_resources` for independently dated balances, spending
facts, reset offers and quota. Its optional `refresh` and exact
`target: {harness, profile_id}` use the existing foreground observation path.
Use `claudexor_account_reset` for an intentional reset under the caller's existing
authority. Preserve the original `idempotency_key` and complete request body:
retrying that pair recovers the same operation, even if the first reply lost its
receipt id; `operation_id` reads a known receipt. A different key is a separate
reset. Provider outcome and refreshed usage are distinct: Codex
`already_redeemed` confirms the original request; Claude `already_used` does not.
The primitive does not choose an automatic reset or spending strategy.

Use `claudexor_journal_recovery` for read-only journal inspection, validation,
or export. `claudexor_quarantine_journal` is destructive: invoke it only after
the user explicitly requests quarantine and provides the exact fingerprint and
confirmation required by its schema.

## Safety

- Credentials Claudexor itself uses belong in `claudexor auth login <harness>`
  or `claudexor secrets set`, outside the conversation; do not collect or
  transform them. Working content (prompts, attachments, files, test fixtures)
  reaches the selected harness exactly and stays in local run records; only
  `pr` delivery checks content, scanning what would be pushed with the pinned
  Betterleaks scanner before anything is published.
- NEVER auto-answer `claudexor decision` for a blocked run. Risk acceptance and
  overrides are human decisions, even when the calling host otherwise permits
  mutation.
- Do not infer success, applyability, readiness, or completion from model
  prose. Use the typed status, result, and `applyEligibility` projections.
- Do not claim native vendor sessions move between credential profiles.
