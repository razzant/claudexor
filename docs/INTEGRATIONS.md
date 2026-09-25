# Claudexor Integrations

This document is for tools, editors, and agents that want to drive Claudexor as a
local control plane. It describes the current integration surfaces and their
stability tier (the tiers are defined by "Stability at 2.0" in the repository
README). It is not a future target spec, and it is not contributor workflow for
changing Claudexor.

## Surface Matrix

| Surface | Current role | Stability |
|---|---|---|
| CLI | Human and automation entrypoint: run verbs (init, ask — `--deep-scan` for the research sweep — agent — `--delegate` for the delegation belt — best-of, plan, create), run inspection/recovery (inspect, follow, retry, run-again, apply, decision, review), ops (project, models, harness, doctor, quota, accounts, plugin, daemon, gc, auth, secrets, profiles, settings, trust, setup, remote, release), and agent introspection (capabilities, about, `help --json`). | Stable contract: the verb/flag surface (`help --json`) and `--json` output keys on run paths (add-only). JSON support exists on primary machine-readable paths, not every subcommand. |
| Daemon and control API | Local durable queue, Agent runs, caller-owned model operations, artifacts, SSE events, settings, harness status, secrets metadata, apply, and run control. | Stable contract: endpoints and DTOs per `docs/reference/endpoints.json` + generated schemas (add-only fields). Loopback + bearer token only. |
| MCP server | Exposes Claudexor tools to MCP clients. | Stable contract: the tool set with input/output schemas. Tool list follows the implementation, not old docs. |
| ACP server | Lets compatible editors or agents talk to Claudexor as a local agent surface. | Experimental (may change in minors, disclosed in the CHANGELOG). |
| Host plugins | User-global Claude Code, Codex, Cursor, and OpenCode integrations managed by `claudexor plugin`. | Experimental file layout (regenerate with `claudexor plugin repair all`). Installs owned local files/config only; host enablement can still require reload/manual action. |
| Engine runtime closure | Node-free release artifact containing reviewed daemon and CLI entrypoints for a host that owns its daemon lifecycle, such as [Ouroboros](https://github.com/razzant/ouroboros). | Exact-pin contract: one link-free archive and the existing signed runtime manifest; the host supplies the tested full Node toolchain and verifies archive plus `--probe` identity. |

## Caller-Owned Model Operations

The model capability uses the same negotiated, authenticated control API and
managed accounts as Agents. Codex is the current raw-model source; other harness
connections remain Agent capabilities. This is an engine operation for a caller
that owns its conversation and tools, not an OpenAI-compatible server or an
Agent Run. The operation catalog and generated schemas describe upload purpose,
request/response shapes, exact account metadata, status, cancellation and ACK.

Use the stable operation identity to recover a lost local reply. Accept the
digest-bound result into the caller's own history before acknowledging it;
reading alone does not acknowledge custody. See
[Caller-owned model operations](ARCHITECTURE.md#caller-owned-model-operations)
for lifecycle, retention, continuation and capacity semantics, and the
[feature ledger](FEATURES.md) for transport and acceptance limitations.

Processing uses the optional `processingPreference` contract and the
[single advisory rule](DEVELOPMENT.md#processing-preference). Discover account
view support from the existing operation catalog before requesting `view=accounts`;
preserve per-account models, capability evidence and observation provenance.
Keep legacy request shapes when the parameter is not advertised. The exact wire
forms and admission distinction live in [ARCHITECTURE](ARCHITECTURE.md#processing-and-account-catalogs).
A confirmed processing refusal may authorize a separate caller-owned Standard
request/reservation; it does not erase the first operation's physical dispatch
or permit retrying an unknown outcome.

## Embedded Engine Runtime

An embedding host reuses `claudexor-runtime-<version>.tar.gz`, the same closure
the macOS updater consumes. The archive contains regular files/directories only
and deliberately excludes Node while including top-level
`claudexord.bundle.cjs` and `claudexor.bundle.cjs`. A host pins its exact URL,
build SHA, SHA-256, size, protocol major, separate daemon/CLI entrypoints, and
tested full Node toolchain; after extraction it requires
`node claudexord.bundle.cjs --probe` to report the same version/build identity.
A host invoking
`node claudexor.bundle.cjs harness install <harness> --target local --yes --json`
must provide the toolchain's own npm entrypoint next to the Node it runs the
CLI on: `<node-root>/bin/node` plus `<node-root>/lib/node_modules/npm/bin/npm-cli.js`
on POSIX, `<node-dir>\node.exe` plus `<node-dir>\node_modules\npm\bin\npm-cli.js`
(the official zip layout) on Windows; no system/PATH npm is used. On Windows
the local target is supported for Codex only: npm's `.cmd` shim is never the
launcher, the receipt's `installedBinary` is the package-native
`codex.exe` under `~/.claudexor/node/node_modules/@openai/codex/node_modules/@openai/codex-win32-<arch>/vendor/<triple>/bin`,
and the host's `HOME` (or the user profile when unset) anchors that root exactly
as the engine's own harness PATH does. Every other vendor is a typed
`unsupported_platform` refusal before any side effect. The existing signed runtime manifest remains the
publication authority, so an embedder does not create a second artifact or
trust root.

Releases `3.8.0`, `3.9.0`, and `3.9.7` are explicit owner-authorized exceptions: their
GitHub Releases omit
the custom signed runtime and remote-runtime manifests instead of publishing
unsigned files. Existing app installs cannot use in-place engine update for
those versions, and the app cannot first-bootstrap a remote runtime from them.
Fresh signed/notarized app installs, npm packages, and reviewed embedders that
pin the exact archive URL/build SHA/SHA-256/size remain usable. The normal
signed-manifest contract above remains fail-closed for every non-exempt
release.

For a valid `harness install ... --yes --json` invocation, stdout is exactly one
JSON object. Every executed result carries `ok: boolean`, `dryRun: false`,
`exitCode: number`, `target: "local" | "remote"`, `harness: string`,
`command: string`, `installLocation: string`, `pinnedVersion: string | null`, and
`verification: string`. Every successful `--target local` result additionally carries
`installedBinary` (an absolute launcher path; on Windows the package-native
image) and `installedVersion` (the exact
npm pin, or Cursor's bounded non-empty version line). On the local target,
child exit zero is not sufficient: if that launcher/version proof fails, the
result is `ok: false`, `code: "install_verification_failed"`. A remote success
keeps the historical contract — `exitCode: 0` with no proof fields. A Cursor result after a
successful non-empty download additionally carries `installerSha256` (64
lowercase hex characters) and `installerByteLength` (a positive integer),
including when the downloaded script itself exits non-zero or its post-install
proof fails. A refusal may add `code`, `refusal`, or `message`; child/progress
output goes only to stderr. If setup throws before producing a typed result,
the canonical `harness_install_failed` JSON failure still carries every
disclosure field (and the native `causeCode` when available). Dry-run
returns the disclosure fields with
`ok: true` and `dryRun: true`, without executing, proving a binary, or acquiring
the install lease.

The public [Ouroboros runtime pin](https://github.com/razzant/ouroboros/blob/ouroboros/ouroboros/claudexor_runtime_pin.json)
is a working example of that exact-version, exact-build, and checksum contract.

The host owns install location, daemon config root, process lifecycle, and
rollback. Start, handshake, and stop must address the same config root/socket.
Portable extraction alone is not a platform-support claim: Windows support
also requires a native extract, exact-Node probe, isolated daemon handshake,
and graceful-stop smoke; individual harness and login capabilities keep their
own platform evidence.

## CLI

Use CLI commands when another process can launch Claudexor and read stdout or the
artifact directory.

```bash
claudexor ask "explain the auth flow" --json
claudexor ask "google the latest release notes" --web auto --json
claudexor ask --deep-scan "map this repo's run storage" --json
claudexor agent "fix the failing parser test" --json
claudexor best-of "fix add() in src/math.js" --harness codex,claude --n 2 --json
claudexor inspect <run_id> --json
```

Not every subcommand has stable JSON output. Integrations should prefer the
daemon/control API for long-running interactive use and use CLI JSON only where
the command documents or returns machine-readable output.

`--web off|auto|cached|live` is the CLI-first external context policy. It is
separate from process/network sandboxing. `claudexor inspect <run_id> --json`
projects the run artifacts: output-ready state, the task contract, the
engine-owned telemetry (web evidence, token usage, the auth route receipt,
structured-output conformance, unrecovered tool errors), primary output,
decision record, work product, and artifact paths. Terminal daemon state, live
budget, and event streams come from the daemon/control API, not from
`inspect`.

### Embedder run controls (v2.1)

Headless per-run knobs on the canonical run verbs (all also accepted by
`POST /v2/runs`; protocol exposure follows the shared schemas and the parity
gate's explicit exemptions):

- Prompt sources: positional text, `-` (stdin), or `--prompt-file <file>` —
  exactly one source.
- `--instructions <text>` / `--instructions-file <file>`: per-run system-level
  instructions layered onto every task-producing lane (never reviewers or the
  synthesis judge).
- `--max-seconds <n>`: hard wall-clock deadline for the whole run; on expiry
  the run ends `cancelled` with reason `wall_clock_exceeded` and partial
  artifacts (diagnostic `final/summary.md`) are kept. Consumers must use both
  facts: the process lifecycle is cancelled, while user-facing presentation is
  "Time limit reached" and ACP reports a refusal; an explicit Stop remains
  `user_cancelled` / cancelled. A control may additionally carry the typed
  `reason_code` (`user_cancelled` | `host_cancelled` | `owner_task_gone`), so
  a host-initiated stop (daemon shutdown, MCP host teardown, an integrating
  host whose owning task died) records its real provenance instead of
  coercing to user intent; an absent code keeps the historical coercion.
- `--processing standard|fast|economy`: advisory service preference, carried as
  `processingPreference` on Agent requests and as `options.processingPreference`
  on raw model requests. Structured reviewer entries accept their own optional
  `processingPreference`; raw `serviceTier` remains the exact native override.
- `--workspace-kind directory` and repeatable `--scope-path <relative-path>`:
  `execution.workspaceKind` and `execution.scopePaths` select the copied input
  footprint or direct capture coverage; `--scope-path .` selects the whole
  folder. A selected path may be absent initially and created by the run.
  `--in-place` maps to `execution.isolation: live` for direct work. These fields
  are also carried by the typed MCP/ACP run controls; legacy omission preserves existing behavior.
  See [directory execution](ARCHITECTURE.md#directory-execution).
- `--max-turns <n>`: per-run turn cap; beats per-harness settings, and a lane
  without native support discloses the ignored knob.
- `--deny-path <glob>` (repeatable): globs no candidate may touch at all;
  isolated/envelope runs only (in-place refuses at preflight) — a violating
  patch is blocked before delivery, per-lane enforcement is disclosed via
  `path_deny` receipts, and an operator `accept_risk` decision may still
  deliver (the human is the final authority).
- `--output-schema <file>`: mandatory JSON Schema for the final answer; an
  incapable lane is a preflight refusal, the single engine validator writes
  `final/output.json` plus a typed conformance receipt, and a non-conformant
  answer ends success-with-warnings (`outputConformance: failed`) for the
  embedder to retry. Caller schemas may omit `$schema` (draft-07, retained for
  compatibility) or declare draft-07 / draft 2020-12 explicitly; any other
  dialect is refused at preflight with `unsupported_schema_dialect`. Local
  JSON Pointer `$ref`s (`#/...`) to object-schema targets are accepted and
  inlined into the provider
  transport copy; external, cyclic, dynamic/recursive, and nested-`$id`
  references, `$ref` siblings, `unevaluatedItems`, and non-equivalent
  `unevaluatedProperties` shapes are refused at preflight with the typed
  `invalid_output_schema` code — never a mid-run vendor error. Strict transport
  may emit `null` for a caller-optional field; for inline object properties and
  nested array `items`, the engine restores that adapter-created omission before
  original-schema validation and records the count in `normalized_optional_nulls`.
  Required-null and caller-nullable fields retain their original semantics;
  branch-dependent applicators, maps and conditionals remain typed failures.
- `--thread <id>` / `--resume`: continue an existing thread (the daemon
  funnels the run through its single thread-turn creation point); `--resume`
  picks the most recently updated thread.
- `--json-stream`: NDJSON — early `run.started` frame with the runId, one line
  per run event, terminal summary object last. `--json` keeps its
  exactly-one-object contract.

Run summaries (`GET /v2/runs/:id`, CLI `--json`) carry the matching receipts:
`inputTokens`/`outputTokens`/`cachedInputTokens` (null when a harness reported
none — never a fake 0), the optional normalized `inputTokenUsage` object
(complete input total, cache reads, cache writes; each null when unknown, absent
on older runs), `outputConformance`, and `authRoute`
({requested, effective, source, reason, modelMismatch}) so embedders act on
typed truth instead of parsing prose.

## Daemon And Control API

The daemon owns local durable scheduling. The loopback control API is the live
surface used by CLI, macOS, MCP, and ACP.

The canonical endpoint inventory lives in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §7 and is generated from source; this
document does not duplicate it.

The API is loopback-only and bearer-token guarded (`GET /healthz` is the one
unauthenticated, loopback-host-guarded liveness route). Artifact files remain
the source of truth; API responses are projections over daemon state and run
files. Every product route is under `/v2`: clients first `POST /v2/handshake`,
then send `X-Claudexor-Protocol-Major: 3`; incompatible or missing negotiation
returns a typed `426`. `GET /v2/operations` is the runtime operation catalog,
and unversioned product aliases do not exist.
`GET /v2/quota` returns every independently reported vendor-owned quota window
with provenance and freshness; `POST /v2/quota` requests a live refresh and
fails explicitly when no official refresher is available. Missing usage stays
unknown and an elapsed reset marks data stale rather than locally setting it to
zero. Each snapshot also carries a derived `availability` projection (`state`,
`blocking_constraints`, earliest known `resets_at`,
`model_scoped_exhaustions`): only windows applying to every model can set
`exhausted`/`cooldown`, while a spent model-scoped window keeps the subject
available and is disclosed separately, so consumers never aggregate raw
constraints themselves. `POST /v2/quota` accepts an optional `{"model": …}`
body to compute `state` against the model the caller intends to spend
(case-insensitive alias containment in either direction). The CLI projection
is `claudexor quota [--refresh] --json`.
Codex refreshes through the vendor app-server (including the live-verified
`rateLimitResetCredits` balance, surfaced only when positive). Claude's
PRIMARY subscription source is the `api.anthropic.com/api/oauth/usage`
endpoint, read per credential profile from the profile's own vendor store:
on macOS its keychain item
(`Claude Code-credentials-<sha256(configDir)[:8]>`, live-verified formula),
on Linux the vendor's `.credentials.json` inside the profile's config dir.
Either store yields an access token held transiently for at most one request — never
persisted, logged, or included in errors — plus only its expiry timestamp and
whether a refresh token exists (the refresh token itself is never projected).
The endpoint returns proactive
five_hour/seven_day/per-model utilization attributed to the profile
(`subject_id`). Before probing a refreshable token that is expired or inside
Claude Code's five-minute refresh window, Claudexor starts the vendor's
documented, prompt-free `claude mcp serve` lifecycle in that exact profile
environment, sends no MCP request, and waits for Claude Code to publish a fresh
expiry under its own credential lock. No model request or inference quota is
used, and Claudexor never reads the refresh token or writes the vendor store.
If the proactive wake fails while the old access token is still valid, the
bounded usage request may use that token; an expired token remains a typed
`refresh_failed` absence. If expiry is absent, the bounded request may still
succeed, but a 401/403 cannot prove revocation and also yields `refresh_failed`.
Only a token proven fresh at rejection remains vendor revocation evidence and
may degrade auth readiness; a token without refresh capability retains that
conservative real-response behavior. The status-line collector
stays as a secondary source: an explicit
`claudexor plugin install claude` composes it with an existing user
`statusLine` command and restores it on uninstall; it persists only the two
documented windows and provenance in the Claudexor-owned v3 root and does not
read Claude credential or session files. See the official
[Claude Code status-line contract](https://code.claude.com/docs/en/statusline).

`GET /v2/credential-profiles` with the `snapshot=true` query is the opt-in
Accounts read for interactive clients. It returns profiles/readiness,
per-harness `next_up`, Workspace Git, quota, and an opaque quota-event cursor
from one server-authored epoch. The quota leg (like `POST /v2/quota`) honors
each vendor's poll rate-limit cooldown: a vendor that recently answered 429
is served from last-known registry data, disclosed additively as
`quota.refresh_skipped` rows carrying the vendor and its release instant. Resume the dedicated quota observer from that
cursor. A quota marker or a rejected/lost cursor invalidates the quota and
`next_up` projection; clients keep identity/Enabled/readiness, stop observing,
and wait for an explicit Accounts Refresh rather than automatically fetching a
new snapshot. The engine-default API-key fallback can appear as the native
`next_up` route, but it never becomes an account row or changes the account
count.

`GET /v2/run-applicability` takes an absolute `repoRoot` query and returns the
live Workspace Git status plus the engine-owned in-place/isolated run-shape
matrix for Git-backed thread choices. Directory support is advertised separately
by `workspaceKinds` in the `mutability` section of `AgentCapabilityCatalog`;
clients must not apply a
Git-only matrix verdict to explicit directory execution. Git-backed isolated
threads materialize a worktree on their first
mutating turn; earlier read-only turns do not initialize a project. Explicit
directory execution, live or copied, needs no Git and never enters that initializer.
Git-backed mutating shapes may announce initialization on ordinary non-Git
roots; the user home directory and filesystem roots get a typed
refusal (`git_boundary_root_refused`) naming the remediation instead.
Git-backed direct runs use eager Git admission. Thread turns persist first and
run the same canonical preflight in the durable job before provider execution,
so a refusal is inspectable and Exact Retry replays the unchanged request after
Git is repaired.

Native login commands are server allowlisted and run as setup jobs with
typed phase/deadline/outcome. An awaiting-user login SURVIVES an ordinary
daemon restart — the successor adopts the identity-proven runner; only an
explicit cancel or the deadline timeout signals it. Codex login defaults to
typed device-code over the official codex app-server with NO Terminal (D-17): a
one-time code plus verification URL are surfaced on the job snapshot (and the
CLI/AuthSheet render them inline), and the daemon waits for the app-server's
completion. The request `loginFlow` selects the secondary app-server
browser-callback flow or the legacy Terminal localhost-callback
(`--browser-redirect` on the CLI, codex only). If the installed app-server lacks
the typed auth methods the daemon returns a typed `not_supported` outcome
(offer the Terminal `--browser-redirect` fallback) — never a silent fallback,
never stdout parsing. The one-time code is a transient disclosure: it rides the
job snapshot/SSE overlay only and is never journaled, logged, or persisted. The
isolation instruction still applies — complete the link in a private window or a
profile signed into no other OpenAI account, because an in-browser account
switch can revoke sibling OpenAI sessions server-side. The lifecycle streams over a
polling-backed SSE channel
(`/v2/setup/jobs/:id/events`) that carries the complete job snapshot,
heartbeats, and closes on every terminal state including `timed_out` and
`interrupted_unknown`. A reconnecting client first GET-resnapshots the job;
every event names its exact request-relative predecessor cursor, and
missing, duplicate, regressive, dropped, unknown, malformed, or
EOF-without-terminal frames require a scoped resnapshot. Network loss never
changes the server-owned outcome. `GET /v2/setup/jobs` optionally filters by
`harness`, `action`, `active`, and `limit`. `POST /v2/setup/jobs/:id/extend`
adds the fixed 15-minute login extension to an engine-owned deadline; a job
whose deadline is the vendor's own window (`deadlineFixed`) refuses with a
typed 409. Cancel is asynchronous and
resolves only after termination is proved; duplicate create returns the same
active login instead of launching a second runner.
`POST /v2/setup/jobs/:id/reconcile` is the sole replacement-fence recovery
path. The execution mechanics behind these jobs — the bundled runner, the
journal authority, process-identity fences, and the same-harness capability
smoke — are engine internals owned by `docs/ARCHITECTURE.md` (native login
and setup jobs); API-key fallback goes through `/secrets` as a separate
operation, never through setup jobs.

`GET /v2/runs/:id` includes `lastSeq` (the snapshot's event cursor for
gap-free `Last-Event-ID` subscriptions), `pendingInteractions`,
`summary.waitingOnUser`, `summary.route` (requested vs stream-observed model;
verified only on observed evidence), `primaryOutput`, `timeline`, `budget`,
`summary.outputReadyState`, requested/effective access, external context policy,
`summary.webEvidence`, and terminal `runFacts` for clients that need the main
answer/report, streamed activity, known spend state, tool/web status, and the
immutable terminal receipt without scraping artifacts. `runFacts` is null for
active and legacy runs; terminal clients consume it verbatim rather than
reconstructing outcome, deliverable, presentation, participant, gate, review,
or required-action facts. Its optional `presentation` member is the shared
terminal authority for output-ready state and the primary artifact; only older
receipts without that member use the legacy artifact/failure fallback.
A failed run's `summary.failure` may carry `vendorFailure`: the vendor's own
typed failure as `{ code, message, source }` (any of `code`/`message` may be
null), or `null` — also the meaning of an absent key from an older engine —
when no vendor-typed evidence exists. Display the code beside the message as a
fact; never branch on its value or map it to a remedy, so codes a vendor adds
later flow through with no release on either side.
Web/tool evidence is projected from the engine-owned
`final/telemetry.yaml`; runs that predate it report `available: false`. Unknown
quota or spend remains unknown; do not render missing values as `$0`. The optional
`attemptExecution` array exposes compact per-attempt Processing and amount
evidence through HTTP and MCP run reads; its [field map](ARCHITECTURE.md#8-artifact-layout)
distinguishes observed components from prospective billing. General previews
and timelines remain bounded, with explicit truncation or HTTP 413 diagnostics. Files referenced by a
directory manifest stream complete digest-checked bytes through the existing
artifact endpoint; preview caps never define a delivery payload.

A `files` WorkProduct points to `final/files/manifest.json` and complete content
artifacts. Use the same apply/check and apply operations with optional `paths`
to deliver selected recorded changes. Copy delivery supports `mode: apply`; Git
commit/branch/PR delivery is not a file-mode operation. Partial delivery records
applied paths and retains remaining custody. `POST /v2/runs/:id/decision` with
`{action: "discard"}` (CLI `claudexor decision <run_id> --discard`) returns
`{accepted: true, status: "discarded", message: ...}` for a pending terminal
copy and ends its remaining application without deleting results immediately
or undoing applied files. Direct effects are
already in place and have no separate apply/full-rollback promise. The source
root, preimages, verifier and retention boundaries are defined once in
[ARCHITECTURE](ARCHITECTURE.md#directory-execution).

Terminal state may include diagnostic non-success states such as
`stuck_no_progress` (the same diff repeated while a required gate still failed).
Telemetry attempts can include adapter-declared transient failures; integrations
should render those as infrastructure/retry evidence, not as model findings.

`POST /v2/runs/:id/control` supports cancel for active daemon jobs.
Interactive runs use the typed interaction surface instead of raw input
forwarding: `interaction.requested` events carry the questions, the macOS app
and `claudexor follow` answer via `POST /v2/runs/:id/interactions/:id/answer`,
and a finite `interaction_timeout_ms` lets an unanswered question decline
benignly; `null` disables only that automatic expiry. Answers, cancellation,
outer run deadlines, terminal cleanup, and daemon restart still release the
wait. Pending and resolved interaction projections are
fsynced in the run's journal partition; daemon restart terminalizes unresolved
questions instead of presenting a stale prompt as live.

A thread turn whose run is refused before it starts (trust gate, preflight)
carries a persisted sanitized problem in its projection (`enqueueError`):
message, code, retryability, bounded required actions, and bounded structured
context. Clients present the message/actions and do not dump context wholesale;
`POST /v2/threads/:id/turns/:turnId/retry` re-enqueues that same turn.
`GET /v2/trust` / `POST /v2/trust` are the sole CLI/app trust boundary for the
user-level full-access grant and `readonly|workspace_write` access default. An
embedding orchestrator that owns the workspace marks its runs
`execution.delegated` and does not need that grant to request `access: full`.
A control-API client holds the daemon token and can already grant itself the
allow here, so the exemption costs nothing on that surface. The host MCP server
accepts the same marker from a caller that holds no token and has no
trust-writing tool, so there one tool call with `execution.delegated: true` and
`access: "full"` runs unsandboxed native `full` on any `repoPath` without the
grant, bounded only by the host's own MCP tool-approval policy. The refusal
above still applies to runs an operator starts at a surface.

## MCP

Run:

```bash
claudexor mcp serve
```

The MCP server is a thin surface over the same engine and run artifacts. Keep MCP
clients honest: read-only modes stay read-only, unavailable harnesses fail
loudly, and apply/delivery state comes from server-owned artifacts.

The server runs on the official MCP TypeScript SDK v2: it negotiates the
client's protocol revision (2025-11-25 down to 2024-10-07; Cursor's
2025-06-18 handshake included), dispatches requests CONCURRENTLY (ping and
tools/list answer while a long race runs), and validates arguments against
the declared JSON Schemas. Claudexor's semantic checks (absolute `repoPath`,
the inline-secret fence, reviewer-panel shapes) run inside the tool handlers
and surface as `isError` tool results.

MCP Tasks remain experimental and are not advertised. Run tools enqueue work
and return a daemon-bound durable handle instead of holding a tool call open
until terminal. The initial result is not terminal output or proof of
completion; follow the handle with the status/result tools before claiming an
answer, finished work, or applyability.
The implemented tools include `claudexor_ask` (with `deepScan`), `claudexor_run`,
`claudexor_best_of`, `claudexor_plan`, `claudexor_create`,
`claudexor_thread_create`, `claudexor_thread_turn`,
`claudexor_status`, `claudexor_capabilities`
(the derived AgentCapabilityCatalog: per-harness live capabilities, modes,
the mutability matrix, run-control keys), and the read-only recovery tools
`claudexor_accounts` (the server-authored credential-profile/readiness/quota
view, including freshness and `next_up` state — the default read is the
cached listing; `fresh: true` opts into the expensive atomic snapshot, which
honors per-vendor rate-limit cooldowns),
`claudexor_runs`, `claudexor_inspect`, `claudexor_run_status`,
`claudexor_run_result`, `claudexor_run_cancel`,
`claudexor_run_interactions`, `claudexor_answer_interaction`,
`claudexor_apply_check`, and
`claudexor_journal_recovery`. The destructive
`claudexor_quarantine_journal` requires an exact partition fingerprint and
explicit `quarantine_and_start_fresh` confirmation. One-shot runs and thread
turns accept `credentialProfileId` as a strict account pin. Create a thread
once, enqueue follow-ups with `claudexor_thread_turn`, then follow each returned
`runId` with the ordinary status/result tools. If a turn returns only a queued
`jobId`, use `claudexor_runs` to recover its `runId` after binding.

Tools declare MCP behavior annotations (readOnlyHint for every non-agent
route — ask/plan are read-only) and, for run tools and
the capability catalog, an outputSchema with a structuredContent mirror of
the text result: `{summary, runId, runDir, status, applyEligibility,
runFacts}` — `applyEligibility` is the derived apply-gate verdict `{eligible,
state, reason, requiredAction}` the control API serves on `GET /v2/runs/:id`,
and `runFacts` is the exact validated canonical RunFacts receipt from the
same control detail, or `null` while the run is active and for legacy runs
without a receipt. A genuinely missing/404 or transport-unavailable detail
keeps `runFacts: null` without fabricating a `detailProblem`; a raised typed
detail error, a malformed success body, or a receipt that fails validation
clears every detail-derived field and reports the existing typed
`detailProblem` instead. The public inspect/status/result read tools degrade
exactly `run_facts_invalid` and `invalid_service_response` to a schema-valid
minimal handle that keeps the caller's runId, nulls the receipt and sibling
authority fields, and carries a typed secret-redacted `detailProblem`, while
404, auth, daemon-loss, untyped 500, and transport failures remain ordinary
tool errors.

Current operational behavior:

- Every run mode is daemon-tracked through `/v2`; the server auto-starts
  the local daemon and enqueues through the control API. `GET /v2/runs` lists
  every MCP-started run, including ask/plan/agent, while mutating
  runs remain cancellable and operator-unblockable through the same authority.
- Every run start returns a `runId:`/`artifacts:`/`status:` trailer. Status,
  terminal result, cancellation, pending questions, and answers are separate
  stable tools; cancel/answer success means the `/v2` journal mutation was
  acknowledged.
- A skew between installed plugin artifacts (`CLAUDEXOR_PLUGIN_VERSION`) and
  the running CLI — a version mismatch, or an unmarked non-default frozen
  config root — is a HARD REFUSAL at `mcp serve` time, not an ignorable stderr
  warning: a pre-handshake process refusal (`plugin_artifact_skew`) whose
  message names the `claudexor plugin repair all` remedy. Default-root installs
  no longer serialize `CLAUDEXOR_CONFIG_DIR` at all (every CLI generation
  self-selects its own versioned root at serve time, so a stale frozen root can
  never launch new code against old data); an explicit operator override is
  serialized together with a `CLAUDEXOR_ROOT_MODE=explicit` provenance marker
  so the bridge can tell an intentional override from a legacy frozen root.
- Long work no longer depends on the host's tool-call timeout; the daemon keeps
  running after the durable handle is returned.

## Host Plugins

`claudexor plugin` installs host-native integration artifacts that point Claude
Code, Codex, Cursor, and OpenCode at the local Claudexor CLI/MCP server. These
artifacts are translational consumers: they contain instructions, commands where
the host supports them, and MCP configuration. They do not orchestrate, select
winners, manage budgets, or decide review policy.

```bash
claudexor plugin install all
claudexor plugin status all --json
claudexor plugin doctor all
claudexor plugin repair cursor
claudexor plugin uninstall opencode
```

`plugin status` exits 1 when any host is drifted or blocked (scriptable);
missing/partial/installed/registered hosts exit 0, and the JSON carries the
per-host state either way.

Lifecycle state lives under the user Claudexor config directory
(`~/.claudexor/v3/plugins/state.json` by default). Generated files carry Claudexor
ownership markers, and uninstall removes only owned files or owned scoped config
entries. Unknown user files fail loudly instead of being overwritten.

Current host layouts:

- Claude Code: `~/.claude/skills/claudexor/` with plugin manifest, skill,
  command, and bundled `.mcp.json`. The same explicit install composes the
  official subscription-quota collector into user `~/.claude/settings.json`;
  an existing status-line command remains the display owner and is restored on
  uninstall. Drift is blocked rather than overwritten.
- Codex: source under `~/.codex/plugins/claudexor` plus a personal marketplace
  entry in `~/.agents/plugins/marketplace.json`; this registers a plugin with
  bundled skill and MCP config, but does not prove it is enabled in Codex.
- Cursor: local plugin under `~/.cursor/plugins/local/claudexor` with manifest,
  skill, command, and `mcp.json`.
- OpenCode: global skill, command, `experimental.chat.system.transform` JS
  plugin, and `mcp.claudexor` in `~/.config/opencode/opencode.json` or
  strict-parseable `opencode.jsonc`. The generated `timeout: 5000` is
  OpenCode's tool-DISCOVERY timeout; tool EXECUTION is capped by OpenCode's
  global MCP execution timeout, which long verbs (agent/best-of/create) can
  exceed — raise `experimental.mcp_timeout` or prefer the CLI for
  multi-minute work. The runId trailer keeps abandoned calls recoverable.

`plugin doctor` checks install health and starts the local Claudexor MCP server.
It is not harness readiness. For end-to-end verification of the Cursor chain
(install -> registered command protocol truth -> run lifecycle + failure
modes) run `node scripts/cursor-itest.mjs`; the real-harness battery covers
`mcp serve` / `acp serve` smokes and the plugin lifecycle in a scratch HOME
(phases 10-12, filterable via `CLAUDEXOR_BATTERY_PHASES=10,11,12`). Use `claudexor doctor` for Codex/Claude/Cursor/
OpenCode harness availability and smoke status.

### Portable Agent Skill and Copilot plugin

`plugins/copilot` is the portable GitHub Copilot distribution. It contains one
canonical `skills/claudexor/SKILL.md` and a `.mcp.json` descriptor that invokes
the preinstalled `claudexor mcp serve` command. It intentionally carries no
absolute runtime path, frozen config root, plugin-version environment marker,
credential, hook, command alias, or host-local business logic.

```bash
npm install -g claudexor
copilot plugin install razzant/claudexor:plugins/copilot
```

The portable path supports macOS and Linux with Node.js 20.19 or newer. Windows
is not supported. Copilot owns installation, caching, enable/disable, update,
and uninstall for this plugin; `claudexor plugin install` does not add a fifth
managed Copilot host. Generated Claude Code, Codex, Cursor, and OpenCode
integrations keep their existing ownership and repair semantics and are never
replaced automatically by the portable plugin.

The bundled Skill starts with the aggregate/default doctor projection, the
Accounts snapshot, and read-only tools. It may request mutating run tools only
for explicit implementation intent, and MCP does not expose patch application.
A host may use the ordinary CLI delivery path only after an explicit user
request and a server-owned eligible apply verdict. Credentials remain in the
existing `claudexor auth login` and `claudexor secrets set` flows; risk
acceptance and overrides remain human decisions.

The public MCP Registry descriptor is `server.json`. It points to the executable
`claudexor` npm package and supplies fixed `mcp serve` package arguments for the
embedded local stdio server. `mcpName` in that package, the Registry name, the
package version, and the portable plugin version are release-parity checked.
Registry publication runs only through the separate manual tag-bound
`publish-mcp.yml` GitHub OIDC workflow after the npm package and public stable
GitHub Release exist; it is idempotent and confirms the exact registry record.

Harness readiness is route/context-specific. `auth_sources` / `authSources`
separates credential availability (`available | unavailable | unknown`) from
verification (`passed | failed | not_run`); manifests still declare only
possible source/transport/containment. Absence or a logged-out native session is
`unavailable + not_run`; an indeterminate probe is `unknown + not_run`; present
but wrong or unusable source material is `available + failed`. A key string
alone is degraded until the adapter proves the exact CLI/auth/isolation path it
will use. Explicit `subscription` never probes or accepts API-key readiness;
explicit `api_key`
never falls back to a native session; `auto` remains native-first for Codex,
Claude, and Cursor in host and scoped/envelope runs. It reaches a smoke-proven
API-key route only when native readiness fails (and, for Claude, its verified
setup-token source is also unavailable), and emits a typed `readiness_preferred`
disclosure so clients can show the billing/readiness tradeoff.

Native sessions remain in vendor-owned stores rather than being copied into
Claudexor state or envelopes. Codex points native runs at a Claudexor-dedicated
`CODEX_HOME` and forces the vendor's file credential store, isolating it from
the operator's ordinary Codex CLI/app Keychain session. Claude points at the
vendor config and uses the macOS login Keychain; Cursor uses the vendor's own
file credential store under the selected Claudexor-owned profile HOME with
`AGENT_CLI_CREDENTIAL_STORE=file`, while its mutable config/session state stays
in the profile's scoped `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR`. The host Cursor
OS-Keychain login is retired and is never probed, bridged, or claimed as a
route. Claudexor's API-key store and Claude setup-token source are separate
routes with their own typed readiness and route-specific injection.

## ACP

Run:

```bash
claudexor acp serve
```

ACP support is intended for editor and agent hosts that can speak the protocol.
For Zed, register Claudexor as an agent server in `settings.json`:

```json
{
  "agent_servers": {
    "Claudexor": { "command": "claudexor", "args": ["acp", "serve"] }
  }
}
```

The server uses `@agentclientprotocol/sdk` and stable ACP protocol version 1.
ACP Terminal Auth is **experimental**. When a client explicitly advertises the
experimental terminal-auth capability, Claudexor currently offers Codex
subscription login on macOS and Linux. The client runs
`claudexor acp serve auth login codex` in its interactive terminal; that exact
suffix is allowlisted and routed to the existing durable device-code login.
Clients without the capability receive no terminal auth methods. Claude and
Cursor are not advertised yet because their current macOS setup flow opens a
second Terminal and cannot prove completion inside the ACP client's terminal.
The current experimental surface is proactive: clients may present the method
from `initialize`; Claudexor does not yet emit auth_required or implement the
legacy authenticate request. Cancelling the ACP-owned terminal and an
unsupported Codex device flow both exit non-zero and never launch a second
Terminal window.

`session/new` creates a daemon thread (default `in_place`) and returns that
thread id. `session/list`, `session/load`, `session/resume`, `session/close`,
`session/prompt`, and `session/cancel` all resolve through the same `/v2`
authority; no second in-memory session catalog exists. Images and embedded
resources are uploaded/finalized into immutable daemon resource IDs before the
turn enqueues. Blocked/failed daemon outcomes return ACP `refusal` plus typed
`_meta.claudexor` run/status/apply evidence rather than a false `end_turn`.
Terminal turns also carry the exact validated RunFacts receipt at
`_meta.claudexor.runFacts` (`null` for active runs and legacy runs without a
receipt). A missing/404 or transport-unavailable detail keeps the receipt
`null` without fabricating a `detailProblem`; a typed detail error, malformed
success body, or receipt-validation failure preserves the run id and terminal
answer, clears the detail-derived projections, and explains itself through
the typed `detailProblem`.
The same projection distinguishes deadline exhaustion from user cancellation:
a terminal `cancelled` lifecycle with `wall_clock_exceeded` returns ACP
`refusal`, while an explicit ACP/session Stop returns `cancelled`.

`session/load` replays the conversation on reopen by fetching one run detail
per turn. That fan-out is bounded to the most recent 50 turns: an older thread
replays only its tail, and the omitted count is disclosed as a leading
diagnostic line rather than starting the conversation silently mid-stream. If a
turn's run detail cannot be fetched (for example its artifacts were reclaimed by
retention, a typed `410 run_expired_by_retention`), the agent half is rendered
as `[output unavailable: <typed reason>]` instead of vanishing.

Questions the surface can answer:

- **End-of-turn plan questions** (a plan turn that ends `needs_answers`) render
  as numbered turn text — single/multi/free-text all shown; the user answers by
  sending the next prompt on the same session.
- **Single-choice mid-run questions** are answered inline through the ACP
  permission request (one `session/requestPermission` per question).
- **Multi-select mid-run questions** are answered inline by iterating one
  include/skip permission round per option, so more than one label can be
  selected (a single permission request returns exactly one option and would
  collapse the choice).
- **Free-text (option-less) mid-run questions** cannot be answered through ACP
  (its permission mechanism is choice-only). They are NEVER silently skipped:
  the surface discloses them as turn text naming the remedy, and the run stays
  paused — answer via `claudexor follow <run>` or
  `POST /v2/runs/:id/interactions/:id/answer` (see the `docs/FEATURES.md`
  `acp/interactions` row).

## Project Instruction Files (AGENTS.md)

Keep ONE `AGENTS.md` at your project root as the source of truth for
project-specific agent instructions. Codex, Cursor, and OpenCode read `AGENTS.md`
natively; Claude Code reads `CLAUDE.md`. Claudexor bridges that gap for you so
the same instructions reach every route, without asking you to maintain two
files:

- Codex routes get `CLAUDE.md` added to codex's `project_doc_fallback_filenames`
  (a stateless per-run config override — your `~/.codex/config.toml` is never
  touched), so a project that has only a `CLAUDE.md` and no `AGENTS.md` still
  works on codex. Per codex's own semantics the fallback is consulted ONLY when
  no `AGENTS.md` is present; it is never merged on top of an existing one.
- For a project that has `AGENTS.md` and no `CLAUDE.md`, Git-backed write preparation creates
  a thin `CLAUDE.md` whose entire body is the official Anthropic import
  `@AGENTS.md` plus a Claudexor ownership marker, so Claude Code reads the same
  file. It is written both at the project root (announced via the
  `project.claude_bridge.created` run event; deleting the generated file stops the
  bridging) and inside each isolated envelope worktree a candidate races in —
  because a Git envelope materializes committed files, so an untracked
  project-root bridge would not reach a candidate. The envelope copy carries no
  run event and is excluded from the candidate's diff only when Claudexor created
  it for that run and its bytes still exactly match the generated bridge. Any
  candidate-authored or candidate-edited `CLAUDE.md` is captured normally, even
  if it retains the ownership marker. Both creates are exclusive and never follow
  a symlink, so a hand-written `CLAUDE.md` is never overwritten. The project-root
  write is skipped for read-only runs and `--in-place` stateful targets.

Both behaviors are automatic. If you would rather manage the files yourself,
keep your own `CLAUDE.md` (it is never touched) or add an `AGENTS.md`.

## External Harness Adapters

An out-of-tree JSON-RPC adapter-protocol package was removed as dead
code (zero importers). External adapter authors currently integrate in-tree by
implementing the `HarnessAdapter` contract from `@claudexor/core` (discovery,
doctor/capability reporting, run, review, cancel). Native capabilities may
expose richer surfaces, such as Codex app-server JSON-RPC or Claude stream-json
stdin, but do not assume resume, estimate, live steering, or structured output
support unless the capability profile and adapter doctor output prove it for
the active run.

The Antigravity adapter is the one closed-source vendor CLI in tree: `agy`
ships as a signed Go binary with no npm artifact and no source repository, so
its wire shapes are pinned by fixtures rather than by reading vendor code.
`packages/harness-agy/fixtures/manifest.yaml` says which is which: the run,
schema-envelope and auth-error streams were RECORDED from live sessions, the
resume stream is synthesized from those recorded shapes, and the empty-SUCCESS
soft-deny below has no fixture at all (it is sourced to an upstream report).
Every claim below is re-verified when the pinned vendor version moves.

Discovery/manifests describe static capabilities and possible auth sources.
Doctor output is the aggregate/default-route readiness source: UI default
status and profile-less live controls rely on doctor status, enabled intents,
and smoke checks. Auto-routing and reviewer pools take doctor-OK default routes
plus harnesses with enabled account rows; a selected row is admitted only after
its exact profile probe. Only a genuinely profile-less/default fallback depends
on aggregate doctor. OpenCode and the raw-API adapter currently report
`degraded` even with a key (no isolated smoke proves their default routes yet),
so they are skipped by auto-pools unless a supported exact profile route proves
ready, and explicitly selecting an `unavailable` route fails loudly.

Adapters must translate native I/O into Claudexor events and artifacts. They must
not orchestrate, arbitrate, manage budgets, or decide review policy.

Comparator notes for current adapters: Claude Code exposes permissioned
`WebSearch`/`WebFetch` tools and native flags such as `--model`, `--effort`,
`--max-turns`, `--allowedTools`, and `--disallowedTools`. Codex exposes web
search as `cached`, `live`, or `disabled`, with live search controlled by
`--search`/config and command network access controlled separately. Claudexor
maps its typed policy onto those native surfaces and records observed tool
evidence rather than relying on final-answer claims.

Raw API, including the built-in OpenRouter instance, uses non-streaming Chat
Completions HTTP JSON rather than a native CLI stream. Its terminal semantics
are pinned by adapter unit tests, not a recorded stream fixture: an explicit
terminal provider error yields a bounded, redacted typed `error`, followed by
`usage` and `completed` events, and never yields a message or patch. Ordinary
`finish_reason: "stop"` and `finish_reason: "length"` remain successful
completions.

### Harness Stream Reference

The per-harness wire truth every parser change must be checked against. Each
claim here is pinned by a fixture + conformance expectation
(`packages/harness-<x>/fixtures/manifest.yaml` declares per-fixture stream
SEMANTICS — final-message count, the typed `final_source` stamp the adapter
puts on final messages ("result" / "structured_output" /
"last_agent_message" / "assistant_message"), whether the final is the stream's last message,
thinking/delta counts, typed rate-limit, and the typed retry class — all
asserted by the adapter's conformance test through
`streamExpectationViolations` in `@claudexor/core`). When a vendor CLI moves,
re-record the `recorded-*` fixture and re-verify the expectations; the
fixture-freshness gate discloses drift.

**Claude Code** — wire: `claude -p … --output-format stream-json --verbose`
(one-shot prompt as argv; interactive runs add `--input-format stream-json`
and deliver the prompt plus an `initialize` control handshake on stdin).
Events: `system/init` → `started` (carries `native_session_id` for
`--resume`); `system/api_retry` → typed `status` (kind `api_retry`, typed
`rate_limit`/`transient` enrichment); `assistant` content blocks → `message` /
`thinking` / `tool_call` (Edit/Write family also → `file_change`; TodoWrite
and Task tools also carry plan progress); `user` tool_result blocks →
`tool_result`; terminal `result` → `usage` + the FINAL `message`;
`stream_event` text deltas → `payload.delta === true` messages. Finality: the
terminal `result` is the typed final answer — `final: true` is stamped ONLY on
a success result (`structured_output` verbatim when present, else the result
text); error subtypes never claim finality, and `error_max_turns` /
structured-output-retries-exhausted are benign turn-control outcomes, not run
failures. Deltas: only MAIN-conversation `content_block_delta`/`text_delta`
frames surface (flagged `delta`); subagent frames (`parent_tool_use_id`) and
block/lifecycle frames never do — the complete message always follows.
Plumbing: other `system` subtypes and `control_response`/`control_cancel_request`
frames are recognized and consumed, never timeline events.

**Codex** — wire: `codex exec --json … [-i <img>… --] -` with the one-shot
prompt on stdin (resume: `codex exec resume <id> --json … -`; sandbox rides
`-c sandbox_mode` on resume).
Events: `thread.started` → `started` (thread id = `native_session_id`);
`turn.started` → `started` (a lifecycle boundary — deliberately NOT
`thinking`: mapping it there once planted junk blocks at the top of every
transcript); `item.*` for `reasoning` → `thinking`, `command_execution`/
`mcp_tool_call`/`web_search` → `tool_call`+`tool_result` (exit-code aware),
`file_change` → `file_change`, `agent_message` → `message`, `todo_list` →
plan progress; `turn.completed` → `usage` + the FINAL `message`. Finality:
codex has NO typed final marker on the wire — the adapter tracks the turn's
last `agent_message` and finalizes it (`final: true`,
`payload.final_source: "last_agent_message"`) on `turn.completed`; a failed
turn never finalizes its partial message and a new turn clears stale state.
Consumers MUST thread `CodexParseState` through the parser or finality never
exists. Deltas: none (no partial-output flag is wired). Rate limits surface
as `error`/`turn.failed` with typed `rate_limit` (`resets_at`) and
`transient` enrichment — there is no separate status event.
Post-terminal side channel: the `--json` stream reduces a failed turn to a
sentence, while codex's own session rollout keeps the typed record
(`event_msg` / `task_complete` / `error.{message, codex_error_info}`). When the
run loop disclosed that codex voiced its own error, the adapter reads that
record once after exit and attaches it to the terminal `completed` payload as
`vendor_failure` (`source: "codex_rollout"`), verbatim and uninterpreted; a
tagged-object variant yields its variant name. Skipped for an aborted run and
under `evidence_policy: stream_only`. Pin: `fixtures/rollout/recorded-*.jsonl`
(session-rollout records, not stream captures).

**Cursor** — wire: `cursor-agent -p --output-format stream-json <sandbox
args> [--stream-partial-output]` with the composed prompt on piped stdin (no
positional prompt or native system-prompt flag — instructions ride a delimited
prompt prefix; full access is refused pre-spawn). Events: `system/init` →
`started` (session id under
`chatId`/`chat_id`/`session_id`, version-tolerant); `assistant` →
`message` — with `--stream-partial-output`, a frame with `timestamp_ms` and
no `model_call_id` is a NEW-TEXT delta (flagged), `timestamp_ms` +
`model_call_id` is a buffered duplicate (dropped), and the flag-less frame is
the complete flush; `thinking`/`reasoning` → `thinking`; variant-keyed
`tool_call` objects (`shellToolCall`, `writeToolCall`, …) → `tool_call` on
`started`, `tool_result` (+ `file_change`) on `completed`/`failed`, nothing
on `updated`; a native `{failure:{exitCode|error}}` result is an ERROR even
when the outer subtype says completed. On successful terminal `result`, the
adapter finalizes the LAST complete assistant flush
(`final_source: assistant_message`) rather than Cursor's concatenated `result`
string; it falls back to `result` only when no complete assistant frame exists.
Cursor emits no typed rate-limit frame on the wire; the adapter classifies
the vendor's usage-limit PROSE (grounded in the recorded 2026-08-17 incident
transcript: `ActionRequiredError: You've hit your usage limit … resets …
on 9/12/2026`) into the typed `rate_limit` signal on stream `error` frames,
failed results, and the stderr fatal — scoped to the run's requested model
(operational rejection scope, never a vendor-asserted per-model quota), with
the day-granular reset date disclosed as payload evidence rather than a
fabricated ISO instant (the daemon's quota registry bounds the resulting
cooldown at end-of-that-day UTC). Other transient conditions still surface as
generic `error` events — honest degradation, never invented status.

**Antigravity CLI (`agy`)** — wire: `agy -p "<prompt>" --output-format
stream-json --model <slug> --mode <plan|accept-edits> --add-dir <cwd>`
(`--dangerously-skip-permissions` for full access; `--conversation <id>`
resumes). Events: `init` → `started` (the vendor `conversation_id` is the
resumable native session id); `step_update` with `step_type: "tool"` → a
`tool_call` on `state: "ACTIVE"` and a `tool_result` on `state: "DONE"`
(+ `file_change` for a writing tool) — every OTHER state, including a future
one, is a recognized no-op, never a fabricated success; `step_update` with
`text_delta` → a `message` narration segment (complete segments, not display
deltas); terminal `result` → the typed final from `response`
(`final_source: result`), or from a serialized `structured_output` envelope
when a schema is passed — a branch no shipped path reaches today, because the
adapter passes no `--json-schema` and the manifest declares
`json_schema_output` false. `status: "SUCCESS"` with an EMPTY response is the
vendor's soft-deny class (upstream #794) and surfaces as a typed `error`, not
an empty success. A login timeout also exits 0, but it is a different shape:
it carries `status: "ERROR"` with the failure text
(`packages/harness-agy/fixtures/error-auth.jsonl`). `usage` carries
input/output/cache-read tokens; `thinking_tokens` has no schema home and is
dropped rather than folded into output. No typed rate-limit path exists. The CLI has no config-dir env var
(upstream #155), so a named identity is a Claudexor-owned `HOME` — which also
relocates the vendor's conversation and cache state, so one profile HOME holds
every thread's vendor state. Credential custody is platform-shaped: on Linux
the config-file credential is scoped with that HOME. On Darwin the adapter
also prepares a private profile-local `Library/Keychains/login.keychain-db`
before an agy child; an unsafe profile path refuses the child before it can
trigger SecurityAgent, while an operational setup miss leaves the vendor's
file fallback available. The DB is bootstrapped under a neutral filename
before adoption as `login.keychain-db`, so the `security` create operation does
not add a profile path to the host user's search list. It never
bridges the host Keychain or copies credential bytes. On Windows the vendor
credential is OS-user-scoped, so Claudexor permits one enabled binding and does
not claim per-HOME Google identity isolation. Doctor `/model` and quota
`/quota` share one bounded, console-free print runner with piped stdin closed
immediately. These checks cannot enter interactive sign-in; explicit managed
login retains its terminal input. Ambiguous authentication timeouts are probe
failures, not credential revocation. Local token-file presence is not readiness.

**OpenCode** — markerless: no typed final message; the engine's
AnswerAssembly falls back to joining narration (the documented degradation
for adapters without a finality marker).

Known traps (class → CURRENT rule → pin):

- Double-final / narration+final concatenation: a harness narrates the answer
  mid-run and repeats it as the typed final. Rule: consumers take the
  `final: true` message VERBATIM (AnswerAssembly; narration join is only the
  markerless fallback), and adjacent repeats dedup. Pins: manifest
  `final_messages` expectations on every fixture; `answer-assembly.test.ts`;
  the auth capability smoke consumes typed finality
  (`auth-capability-verifier.test.ts`).
- Lifecycle frame → thinking junk: turn/system lifecycle boundaries rendered
  as reasoning noise. Rule: lifecycle frames map to `started`/nothing, never
  `thinking`. Pin: manifest `thinking_events` exact counts.
- Delta chunks joined into the answer: display-stream chunks concatenated as
  if they were messages. Rule: delta messages carry `payload.delta === true`
  and the complete message always follows; assemblers skip flagged deltas.
  Pins: `stream-deltas.jsonl` + `delta_messages` expectations.
- Rate limit read from prose: retry/limit conditions scraped from message
  text. Rule: adapters attach the typed `rate_limit`/`transient` fields (or a
  typed `status` event for claude's `api_retry`); consumers never regex
  prose. Pin: `session-resume-rate-limit.jsonl` + `typed_rate_limit`
  expectations.
- Retry CLASS silently degrading to `unknown`: the signal survives but its
  classification does not, so bounded-retry policy sees "some transient" and
  loses the reason. Rule: `retry_class` asserts the adapter's typed category
  ONLY (`status.error_category`) — never the presence of a `rate_limit`
  field, which `typed_rate_limit` already owns; a class derived from that
  presence cannot fail independently. CURRENT truth:
  `claudeRetryCategory` accepts the bare enum label AND classifies claude
  2.1.x's prose error line (`"rate_limit_error: Number of request tokens…"`)
  onto the documented categories by their stable markers; anything
  unrecognized still collapses to `unknown`, never free-form text. Pin:
  `session-resume-rate-limit.jsonl` declares `retry_class: "rate_limit"` (the
  F5 deliberate update of the former `"unknown"` declaration).
- A harness-reported failure labelled a crash / a vendor failure code recovered
  from prose: a CLI that printed its own error and exited non-zero read as "the
  process crashed", and the vendor's machine code survived only as a sentence.
  Rule: the run loop types "the harness voiced its own error"
  (`harness_reported_error`) and only a signal kill or a silent non-zero exit is
  a crash; a vendor's machine code is read from a vendor-owned record and
  forwarded verbatim with its source; nothing branches on it, and prose is
  never matched to recover it. Pins: `rollout/recorded-*.jsonl`, the
  text-mention decoy and turn-binding tests in
  `packages/harness-codex/src/transcript.test.ts`, the
  `harness_reported_error` cases in `packages/core/src/runloop.test.ts`.
- Control-protocol leakage: handshake/permission frames surfacing as
  timeline events. Rule: recognized plumbing (`control_response`,
  `control_cancel_request`) is consumed, producing ZERO events; only the
  session's own frames become timeline events. Pin:
  `protocol/control-handshake.jsonl` — an AskUserQuestion round trip whose
  expectations admit exactly the session's events (one terminal final, no
  thinking, no deltas) while its control frames leak nothing.

## Storage

Project runs write under the external per-project namespace
`~/.claudexor/v3/projects/<project-sha256>/runs/<run_id>/`; the target repository's
`.claudexor/` remains user-owned config. No-project Ask runs use a synthetic cwd
and write artifacts under `~/.claudexor/v3/runs/`. See `docs/ARCHITECTURE.md` for
the full current layout.

## Stability Rules

- Schema and generated JSON Schema are the data-shape source of truth.
- Unknown modes and unavailable harnesses fail loudly.
- Raw secrets never become run artifacts or docs.
- No regex governance for risk, permissions, tool success, web-required
  detection, winners, or tests-passed. Use typed contracts, settings, events,
  gates, artifacts, and reviewer evidence.
- When a client intentionally starts test-authoring work that edits existing
  protected gate/test files, it should pass `protectedPathApprovals` on the run
  request instead of inferring approval from prompt prose or from repo config
  state.
- Integrations should display disclosed limitations instead of silently falling
  back to another harness or another mode.

## Design constraints

Deliberate limits of the external/host surfaces. Each is a designed boundary
(not a defect); integrations should surface them instead of working around them.

- MCP host clients enforce their own tool-call timeouts; a multi-minute
  `claudexor_best_of` call can be cut client-side — the result trailer's runId
  keeps the run recoverable via `claudexor_inspect` / `GET /v2/runs`.
- The opencode adapter emits no typed rate-limit/transient signals yet: a
  detector is added only from a recorded native rate-limit transcript
  (fail-honest, never guessed from prose), and its stream fixtures are
  synthetic until real transcripts are captured. The cursor detector cleared
  exactly this bar with the recorded 2026-08-17 usage-limit incident
  transcript.
- opencode sources any configured provider key — opencode/openai/anthropic
  order — because the vendor CLI consumes provider keys directly.
- The built-in OpenRouter raw-api instance carries a documented finite
  non-negative response `usage.cost`, including zero, as an exact USD account
  charge receipt. Generic raw-api routes, untrusted provider cost, and missing
  cost remain `unknown` under a finite paid budget and can end
  `cost_unverifiable`. `cost_details.upstream_inference_cost` is not the account
  charge receipt and is not lifted into canonical cost; Claudexor neither
  estimates raw-api spend nor maintains vendor price tables.
- Cursor account auth uses the vendor's file credential store inside each
  Claudexor-owned row HOME. The host macOS Keychain login is retired: scoped
  envelopes neither bridge nor probe it. The cursor doctor's paid smoke result
  is cached per adapter instance.
- Benchmark suites (swe-bench, terminal_bench) are operator-run with real keys
  and Docker; they are never wired into CI. The real-harness battery is
  likewise a manual pre-release operator step (see `docs/CHECKLISTS.md`), not
  a CI job.
- `plugin uninstall` removes only Claudexor-owned files and config entries;
  now-empty host directories and `.claudexor-backups/` are deliberately left
  behind (Claudexor never deletes directories or backups it does not own).
- Run-control exposure follows the actual MCP/ACP schemas and the explicit
  exceptions in `scripts/mcp-cli-parity-check.mjs` (`CLI_ONLY_EXEMPT`), not a
  blanket claim that every CLI flag is a protocol argument. Processing and
  directory execution fields use the shared typed run-control contract. The
  parity gate rejects unrecorded divergence.

## Environment reference

Every `CLAUDEXOR_*` variable a live surface reads (adapters, daemon, doctor,
plugins). Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`) are adapter fallbacks — the account rows' native
subscription sessions are always preferred.

| Variable | Owner | Effect |
|---|---|---|
| `CLAUDEXOR_CONFIG_DIR` | util | Relocates the whole config/state root (default `~/.claudexor/v3`; tests and CI use a disposable absolute path). |
| `CLAUDEXOR_BUILD_SHA` | util | Build-time stamp of the engine's git commit SHA (packaging sets it); without it a dev checkout reads `git rev-parse HEAD` and packaged builds report `unknown`. Reported in the handshake build identity. |
| `CLAUDEXOR_DISABLE_STORED_SECRETS` | secrets | Ignore v2 file-stored secret refs entirely (hermetic runs; native sessions still work). |
| `CLAUDEXOR_CODEX_BIN` / `CLAUDEXOR_CLAUDE_BIN` / `CLAUDEXOR_CURSOR_BIN` / `CLAUDEXOR_OPENCODE_BIN` / `CLAUDEXOR_AGY_BIN` | adapters | Explicit vendor CLI binary when PATH discovery is not enough. |
| `CLAUDEXOR_CODEX_API_KEY` / `CLAUDEXOR_ANTHROPIC_API_KEY` / `CLAUDEXOR_CURSOR_API_KEY` | adapters | Claudexor-scoped API-key overrides (take precedence over provider env names). |
| `CLAUDEXOR_CODEX_MODEL` | codex adapter | Default model override for the codex route. |
| `CLAUDEXOR_CODEX_NATIVE_HOME` / `CLAUDEXOR_CLAUDE_NATIVE_DIR` | adapters | Explicit Claudexor-owned Codex profile or Claude native config directory overrides. |
| `CLAUDEXOR_CLAUDE_KEYCHAIN_BRIDGE` | Claude adapter (internal child env) | Marker for the capability-declared macOS Keychain bridge in a disposable Claude-only HOME (`ready` / `unavailable`). Users never set it; generic scoped homes and other harnesses do not receive it (INV-067). |
| `CLAUDEXOR_RAWAPI_BASE_URL` / `CLAUDEXOR_RAWAPI_KEY` / `CLAUDEXOR_RAWAPI_MODEL` | raw-api adapter | OpenAI-compatible endpoint, key, and model for the raw-API route. |
| `CLAUDEXOR_OPENROUTER_BASE_URL` / `CLAUDEXOR_OPENROUTER_MODEL` | openrouter route | Base URL and default model for the built-in OpenRouter raw-API instance (key: `OPENROUTER_API_KEY`). |
| `CLAUDEXOR_CONTROL_PORT` | daemon | Pin the control-API port (default: OS-assigned loopback port). |
| `CLAUDEXOR_NO_CONTROL_API` | daemon | Start the daemon without the HTTP control API (socket only). A recovery-required startup verdict overrides it and binds the control API anyway — the `/recovery/*` surface is the recovery plane's point — and the override is disclosed in the daemon log. |
| `CLAUDEXOR_DAEMON_SOCK` | daemon | Override the daemon's UNIX socket path. |
| `CLAUDEXOR_DAEMON_ENTRY` | remote runtime wrapper | Internal path to the bundled daemon entrypoint used by `claudexor remote bootstrap`; release-built wrappers set it, users do not. |
| `CLAUDEXOR_DAEMON_LAUNCH_SOURCE` | daemon (internal child env) | Launch-provenance marker (`cli_ensure_daemon` / `cli_explicit_start`) the CLI stamps into the environment of a detached daemon it spawns, so a running daemon process discloses which caller launched it. Never set by hand. |
| `CLAUDEXOR_REMOTE_RUNTIME` | remote runtime wrapper / core | Internal `1` marker set by signed remote-runtime wrappers. It adds the app-owned remote vendor CLI directory to harness discovery ahead of inherited PATH entries; users do not set it. |
| `CLAUDEXOR_DOCTOR_TTL_MS` / `CLAUDEXOR_DOCTOR_NON_OK_TTL_MS` | doctor | Cache TTLs for ok / non-ok doctor probes. |
| `CLAUDEXOR_CLI_PATH` / `CLAUDEXOR_NODE_PATH` | plugins | Paths baked into generated host-plugin MCP configs (set by the installer, rarely by hand). |
| `CLAUDEXOR_PLUGIN_VERSION` | mcp-server | Set by generated host configs; a mismatch with the CLI version is a hard `mcp serve` refusal (`plugin_artifact_skew`) whose message names `claudexor plugin repair all`. |
| `CLAUDEXOR_ROOT_MODE` | plugins / mcp-server | Provenance marker (`explicit`) the installer stamps ALONGSIDE a serialized `CLAUDEXOR_CONFIG_DIR` only for an operator-chosen non-default root; its absence next to a frozen non-default root is treated as legacy skew and refused. Default-root installs serialize neither. Never set by hand. |
| `CLAUDEXOR_MANAGED` | plugins | Ownership marker the installer writes into generated host MCP configs (never set by hand). |
| `CLAUDEXOR_DELEGATION_PARENT_RUN_ID` / `CLAUDEXOR_DELEGATION_REPO_ROOT` / `CLAUDEXOR_DELEGATION_DEPTH` / `CLAUDEXOR_DELEGATION_MAX_SUBRUNS` / `CLAUDEXOR_DELEGATION_BUDGET` | mcp-server (delegation belt) | Injected by the daemon into the `agent --delegate` belt process (`claudexor mcp serve-belt`); carry the parent run id, the original normalized user-project root, nesting depth (belt refuses depth>0), the per-parent sub-run cap, and the resolved parent budget used to bind children to one live daemon-owned paid-budget authority. The bound root prevents a child from falling into the parent harness envelope or being redirected by a raw tool argument. These bootstrap values seed a conservative process-local refusal ledger so the belt can fail closed between daemon responses; daemon family accounting remains the authoritative cap, every child reports its own spend, and the parent reports the aggregate. Never set by hand. |
| `CLAUDEXOR_DELEGATION_PROCESSING_PREFERENCE` / `CLAUDEXOR_DELEGATION_WORKSPACE_KIND` / `CLAUDEXOR_DELEGATION_SCOPE_PATHS` | orchestrator / mcp-server (delegation belt) | Injected captured Processing preference, workspace kind and JSON array of selected relative paths. The belt carries them into child requests with the parent's bound project; omission preserves the legacy request. These are internal transport fields, never user-set overrides. |
| `CLAUDEXOR_REVIEWER_TIMEOUT_MS` | config | Per-reviewer timeout override for review panels. |
| `CLAUDEXOR_REVIEW_WAVE_ID` | release review | Operator-generated UUID identifying one release review wave; each operator reviewer artifact's metadata must carry it, and the sealed release attestation refuses mixed or sequential wave artifacts. |
| `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` | config | Inactivity window before a silent harness stream is failed (not a wall-clock cap). |
| `CLAUDEXOR_TRANSIENT_RETRY_MAX` / `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS` / `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS` | config | Transient-error retry budget and backoff for harness launches. |
| `CLAUDEXOR_MAX_CONCURRENT` / `CLAUDEXOR_MAX_PARALLEL_CANDIDATES` / `CLAUDEXOR_MAX_DEEP_SCAN_WIDTH` / `CLAUDEXOR_MAX_COUNCIL_MEMBERS` | config | Process-local overrides for the four startup-frozen concurrency caps; values must be finite positive safe integers (Council must be at least 2). |
| `CLAUDEXOR_CODEX_PRICE_INPUT` / `CLAUDEXOR_CODEX_PRICE_OUTPUT` / `CLAUDEXOR_CODEX_PRICE_CACHED` | codex adapter | Explicit estimate rates (USD per 1M tokens). Every used input, output, or cached-input category needs its own rate; otherwise Codex cost stays unknown. No model-name or generic tariff fallback. |
