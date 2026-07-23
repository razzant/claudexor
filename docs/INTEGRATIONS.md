# Claudexor Integrations

This document is for tools, editors, and agents that want to drive Claudexor as a
local control plane. It describes the current integration surfaces and their
stability tier (the tiers are defined by "Stability at 2.0" in the repository
README). It is not a future target spec, and it is not contributor workflow for
changing Claudexor.

## Surface Matrix

| Surface | Current role | Stability |
|---|---|---|
| CLI | Human and automation entrypoint: run verbs (init, ask — `--deep-scan` for the research sweep — agent — `--delegate` for the delegation belt — best-of, plan, create), run inspection/recovery (inspect, follow, retry, run-again, apply, decision, review), ops (project, models, harness, doctor, quota, plugin, daemon, gc, auth, secrets, profiles, settings, trust, release), and agent introspection (capabilities, about, `help --json`). | Stable contract: the verb/flag surface (`help --json`) and `--json` output keys on run paths (add-only). JSON support exists on primary machine-readable paths, not every subcommand. |
| Daemon and control API | Local durable queue, run list/detail, artifacts, SSE events, settings, harness status, secrets metadata, apply, and run control. | Stable contract: endpoints and DTOs per `docs/reference/endpoints.json` + generated schemas (add-only fields). Loopback + bearer token only. |
| MCP server | Exposes Claudexor tools to MCP clients. | Stable contract: the tool set with input/output schemas. Tool list follows the implementation, not old docs. |
| ACP server | Lets compatible editors or agents talk to Claudexor as a local agent surface. | Experimental (may change in minors, disclosed in the CHANGELOG). |
| Host plugins | User-global Claude Code, Codex, Cursor, and OpenCode integrations managed by `claudexor plugin`. | Experimental file layout (regenerate with `claudexor plugin repair all`). Installs owned local files/config only; host enablement can still require reload/manual action. |

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
`POST /v2/runs`; MCP/ACP exposure is deferred per the parity gate's recorded
exemptions):

- Prompt sources: positional text, `-` (stdin), or `--prompt-file <file>` —
  exactly one source.
- `--instructions <text>` / `--instructions-file <file>`: per-run system-level
  instructions layered onto every task-producing lane (never reviewers or the
  synthesis judge).
- `--max-seconds <n>`: hard wall-clock deadline for the whole run; on expiry
  the run ends `cancelled` with reason `wall_clock_exceeded` and partial
  artifacts (diagnostic `final/summary.md`) are kept.
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
  `invalid_output_schema` code — never a mid-run vendor error.
- `--thread <id>` / `--resume`: continue an existing thread (the daemon
  funnels the run through its single thread-turn creation point); `--resume`
  picks the most recently updated thread.
- `--json-stream`: NDJSON — early `run.started` frame with the runId, one line
  per run event, terminal summary object last. `--json` keeps its
  exactly-one-object contract.

Run summaries (`GET /v2/runs/:id`, CLI `--json`) carry the matching receipts:
`inputTokens`/`outputTokens`/`cachedInputTokens` (null when a harness reported
none — never a fake 0), `outputConformance`, and `authRoute`
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
zero. The CLI projection is `claudexor quota [--refresh] --json`.
Codex refreshes through the vendor app-server (including the live-verified
`rateLimitResetCredits` balance, surfaced only when positive). Claude's
PRIMARY subscription source is the `api.anthropic.com/api/oauth/usage`
endpoint, read per credential profile from the profile's own vendor store:
on macOS its keychain item
(`Claude Code-credentials-<sha256(configDir)[:8]>`, live-verified formula),
on Linux the vendor's `.credentials.json` inside the profile's config dir.
Either store yields an access token held transiently for exactly one request — never
persisted, logged, or included in errors — and returns proactive
five_hour/seven_day/per-model utilization attributed to the profile
(`subject_id`). An expired idle token fails to unknown (the vendor CLI
refreshes tokens on real use); endpoint refusal never degrades auth
readiness. The status-line collector stays as a secondary source: an explicit
`claudexor plugin install claude` composes it with an existing user
`statusLine` command and restores it on uninstall; it persists only the two
documented windows and provenance in the Claudexor-owned v3 root and does not
read Claude credential or session files. See the official
[Claude Code status-line contract](https://code.claude.com/docs/en/statusline).
Native login commands are server allowlisted and run as setup jobs with
typed phase/deadline/outcome. An awaiting-user login SURVIVES an ordinary
daemon restart — the successor adopts the identity-proven runner; only an
explicit cancel or the deadline timeout signals it. Codex login defaults to device-auth (a URL plus
one-time code shown in the Terminal), with the older localhost-callback flow
selectable through the request `loginFlow` (`--browser-redirect` on the CLI,
codex only); an older codex CLI without device-auth support yields a typed
`not_supported` outcome, never a silent fallback. The Terminal wrapper prints
the isolation instruction — complete the link in a private window or a profile
signed into no other OpenAI account, because an in-browser account switch can
revoke sibling OpenAI sessions server-side. The lifecycle streams over a
polling-backed SSE channel
(`/v2/setup/jobs/:id/events`) that carries the complete job snapshot,
heartbeats, and closes on every terminal state including `timed_out` and
`interrupted_unknown`. A reconnecting client first GET-resnapshots the job;
every event names its exact request-relative predecessor cursor, and
missing, duplicate, regressive, dropped, unknown, malformed, or
EOF-without-terminal frames require a scoped resnapshot. Network loss never
changes the server-owned outcome. `GET /v2/setup/jobs` optionally filters by
`harness`, `action`, `active`, and `limit`. `POST /v2/setup/jobs/:id/extend`
adds the fixed 15-minute login extension. Cancel is asynchronous and
resolves only after termination is proved; duplicate create returns the same
active login instead of opening another Terminal.
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
and `summary.webEvidence` projections for clients that need the main
answer/report, streamed activity, known spend state, and tool/web status without
scraping artifacts. Web/tool evidence is projected from the engine-owned
`final/telemetry.yaml`; runs that predate it report `available: false`. Unknown
quota or spend remains unknown; do not render missing values as `$0`. Large
artifacts are size-capped (HTTP 413 names the on-disk path) and timelines are
capped with an explicit truncation marker.

Terminal state may include diagnostic non-success states such as
`stuck_no_progress` (the same diff repeated while a required gate still failed).
Telemetry attempts can include adapter-declared transient failures; integrations
should render those as infrastructure/retry evidence, not as model findings.

`POST /v2/runs/:id/control` supports cancel for active daemon jobs.
Interactive runs use the typed interaction surface instead of raw input
forwarding: `interaction.requested` events carry the questions, the macOS app
and `claudexor follow` answer via `POST /v2/runs/:id/interactions/:id/answer`,
and an unanswered question declines benignly after the configurable
`interaction_timeout_ms`. Pending and resolved interaction projections are
fsynced in the run's journal partition; daemon restart terminalizes unresolved
questions instead of presenting a stale prompt as live.

A thread turn whose run is refused before it starts (trust gate, preflight)
carries the persisted reason in its projection (`enqueueError`);
`POST /v2/threads/:id/turns/:turnId/retry` re-enqueues that same turn.
`GET /v2/trust` / `POST /v2/trust` are the sole CLI/app trust boundary for the
user-level full-access grant and `readonly|workspace_write` access default.

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

MCP Tasks remain experimental and are not advertised. Run tools return a
daemon-bound durable handle instead of holding a tool call open until terminal.
The implemented tools include `claudexor_ask` (with `deepScan`), `claudexor_run`,
`claudexor_best_of`, `claudexor_plan`, `claudexor_create`,
`claudexor_status`, `claudexor_capabilities`
(the derived AgentCapabilityCatalog: per-harness live capabilities, modes,
the mutability matrix, run-control keys), and the read-only recovery tools
`claudexor_runs`, `claudexor_inspect`, `claudexor_run_status`,
`claudexor_run_result`, `claudexor_run_cancel`,
`claudexor_run_interactions`, `claudexor_answer_interaction`,
`claudexor_apply_check`, and
`claudexor_journal_recovery`. The destructive
`claudexor_quarantine_journal` requires an exact partition fingerprint and
explicit `quarantine_and_start_fresh` confirmation. MCP does not claim live
thread parity.

Tools declare MCP behavior annotations (readOnlyHint for every non-agent
route — ask/plan are read-only) and, for run tools and
the capability catalog, an outputSchema with a structuredContent mirror of
the text result: `{summary, runId, runDir, status, applyEligibility}` —
`applyEligibility` is the derived apply-gate verdict `{eligible, state,
reason, requiredAction}` the control API serves on `GET /v2/runs/:id`.

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
vendor config and uses the macOS login Keychain; Cursor uses its Keychain-backed native
state. Claudexor's API-key store and Claude setup-token source are separate
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
`session/new` creates a daemon thread (default `in_place`) and returns that
thread id. `session/list`, `session/load`, `session/resume`, `session/close`,
`session/prompt`, and `session/cancel` all resolve through the same `/v2`
authority; no second in-memory session catalog exists. Images and embedded
resources are uploaded/finalized into immutable daemon resource IDs before the
turn enqueues. Blocked/failed daemon outcomes return ACP `refusal` plus typed
`_meta.claudexor` run/status/apply evidence rather than a false `end_turn`.

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
- For a project that has `AGENTS.md` and no `CLAUDE.md`, a write-mode run creates
  a thin `CLAUDE.md` at the project root whose entire body is the official
  Anthropic import `@AGENTS.md` plus a Claudexor ownership marker, so Claude Code
  reads the same file. The create is exclusive and never follows a symlink, so a
  hand-written `CLAUDE.md` is never overwritten; it is announced via the
  `project.claude_bridge.created` run event; and deleting the generated file
  stops the bridging. Read-only runs and `--in-place` stateful targets do not
  write it.

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

Discovery/manifests describe static capabilities and possible auth sources.
Doctor output is the readiness source: UI status, routing, reviewer selection,
and live controls must rely on doctor status, enabled intents, and smoke checks.
Auto-routing and reviewer pools take only doctor-OK harnesses. OpenCode and the
raw-API adapter currently report `degraded` even with a key (no isolated smoke
proves their routes yet), so they are skipped by auto-pools and selectable only
explicitly; explicitly selecting an `unavailable` harness fails loudly.

Adapters must translate native I/O into Claudexor events and artifacts. They must
not orchestrate, arbitrate, manage budgets, or decide review policy.

Comparator notes for current adapters: Claude Code exposes permissioned
`WebSearch`/`WebFetch` tools and native flags such as `--model`, `--effort`,
`--max-turns`, `--allowedTools`, and `--disallowedTools`. Codex exposes web
search as `cached`, `live`, or `disabled`, with live search controlled by
`--search`/config and command network access controlled separately. Claudexor
maps its typed policy onto those native surfaces and records observed tool
evidence rather than relying on final-answer claims.

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

**Codex** — wire: `codex exec --json … [-i <img>… --] "<prompt>"` (resume:
`codex exec resume <id> --json`; sandbox rides `-c sandbox_mode` on resume).
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

**Cursor** — wire: `cursor-agent -p --output-format stream-json <sandbox
args> [--stream-partial-output] "<prompt>"` (no native system-prompt flag —
instructions ride a delimited prompt prefix; full access is refused
pre-spawn). Events: `system/init` → `started` (session id under
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
No typed rate-limit path exists: transient conditions
surface as generic `error` events — honest degradation, never invented
status.

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
- The cursor and opencode adapters emit no typed rate-limit/transient signals
  yet: a detector is added only from a recorded native rate-limit transcript
  (fail-honest, never guessed from prose), and their stream fixtures are
  synthetic until real transcripts are captured.
- opencode sources any configured provider key — opencode/openai/anthropic
  order — because the vendor CLI consumes provider keys directly.
- Raw-api routes report token usage but no dollar cost — chat-completions
  responses carry no price and Claudexor maintains no vendor price tables.
  Under a finite paid budget that missing cash cost remains `unknown` and can
  end `cost_unverifiable`; Claudexor never fabricates `$0`.
- Cursor native auth lives in the macOS Keychain, so scoped envelopes bridge
  the host keychain (declared `scoped_home_keychain_bridge` containment)
  rather than fully isolating HOME; the cursor doctor's paid smoke result is
  cached per adapter instance.
- Benchmark suites (swe-bench, terminal_bench) are operator-run with real keys
  and Docker; they are never wired into CI. The real-harness battery is
  likewise a manual pre-release operator step (see `docs/CHECKLISTS.md`), not
  a CI job.
- `plugin uninstall` removes only Claudexor-owned files and config entries;
  now-empty host directories and `.claudexor-backups/` are deliberately left
  behind (Claudexor never deletes directories or backups it does not own).
- The embedder run-control contract is CLI/HTTP-first (DT2.1-1): per-run
  knobs added in 2.1 — `--profile`, `--instructions`, `--max-seconds`,
  `--deny-path`, `--output-schema`, `--max-turns`, thread continuation — are
  deliberately NOT exposed as MCP/ACP tool arguments yet; every exemption is
  recorded with its rationale in `scripts/mcp-cli-parity-check.mjs`
  (CLI_ONLY_EXEMPT), and the parity gate fails on any UNRECORDED divergence.

## Environment reference

Every `CLAUDEXOR_*` variable a live surface reads (adapters, daemon, doctor,
plugins). Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`) are adapter fallbacks — native CLI login sessions are
always preferred.

| Variable | Owner | Effect |
|---|---|---|
| `CLAUDEXOR_CONFIG_DIR` | util | Relocates the whole config/state root (default `~/.claudexor/v3`; tests and CI use a disposable absolute path). |
| `CLAUDEXOR_BUILD_SHA` | util | Build-time stamp of the engine's git commit SHA (packaging sets it); without it a dev checkout reads `git rev-parse HEAD` and packaged builds report `unknown`. Reported in the handshake build identity. |
| `CLAUDEXOR_DISABLE_STORED_SECRETS` | secrets | Ignore v2 file-stored secret refs entirely (hermetic runs; native sessions still work). |
| `CLAUDEXOR_CODEX_BIN` / `CLAUDEXOR_CLAUDE_BIN` / `CLAUDEXOR_CURSOR_BIN` / `CLAUDEXOR_OPENCODE_BIN` | adapters | Explicit vendor CLI binary when PATH discovery is not enough. |
| `CLAUDEXOR_CODEX_API_KEY` / `CLAUDEXOR_ANTHROPIC_API_KEY` / `CLAUDEXOR_CURSOR_API_KEY` | adapters | Claudexor-scoped API-key overrides (take precedence over provider env names). |
| `CLAUDEXOR_CODEX_MODEL` | codex adapter | Default model override for the codex route. |
| `CLAUDEXOR_CODEX_NATIVE_HOME` / `CLAUDEXOR_CLAUDE_NATIVE_DIR` | adapters | Explicit Claudexor-owned Codex profile or Claude native config directory overrides. |
| `CLAUDEXOR_CLAUDE_KEYCHAIN_BRIDGE` | Claude adapter (internal child env) | Marker for the capability-declared macOS Keychain bridge in a disposable Claude-only HOME (`ready` / `unavailable`). Users never set it; generic scoped homes and other harnesses do not receive it (INV-067). |
| `CLAUDEXOR_RAWAPI_BASE_URL` / `CLAUDEXOR_RAWAPI_KEY` / `CLAUDEXOR_RAWAPI_MODEL` | raw-api adapter | OpenAI-compatible endpoint, key, and model for the raw-API route. |
| `CLAUDEXOR_OPENROUTER_BASE_URL` / `CLAUDEXOR_OPENROUTER_MODEL` | openrouter route | Base URL and default model for the built-in OpenRouter raw-API instance (key: `OPENROUTER_API_KEY`). |
| `CLAUDEXOR_CONTROL_PORT` | daemon | Pin the control-API port (default: OS-assigned loopback port). |
| `CLAUDEXOR_NO_CONTROL_API` | daemon | Start the daemon without the HTTP control API (socket only). |
| `CLAUDEXOR_DAEMON_SOCK` | daemon | Override the daemon's UNIX socket path. |
| `CLAUDEXOR_DOCTOR_TTL_MS` / `CLAUDEXOR_DOCTOR_NON_OK_TTL_MS` | doctor | Cache TTLs for ok / non-ok doctor probes. |
| `CLAUDEXOR_CLI_PATH` / `CLAUDEXOR_NODE_PATH` | plugins | Paths baked into generated host-plugin MCP configs (set by the installer, rarely by hand). |
| `CLAUDEXOR_PLUGIN_VERSION` | mcp-server | Set by generated host configs; a mismatch with the CLI version is a hard `mcp serve` refusal (`plugin_artifact_skew`) whose message names `claudexor plugin repair all`. |
| `CLAUDEXOR_ROOT_MODE` | plugins / mcp-server | Provenance marker (`explicit`) the installer stamps ALONGSIDE a serialized `CLAUDEXOR_CONFIG_DIR` only for an operator-chosen non-default root; its absence next to a frozen non-default root is treated as legacy skew and refused. Default-root installs serialize neither. Never set by hand. |
| `CLAUDEXOR_MANAGED` | plugins | Ownership marker the installer writes into generated host MCP configs (never set by hand). |
| `CLAUDEXOR_DELEGATION_PARENT_RUN_ID` / `CLAUDEXOR_DELEGATION_DEPTH` / `CLAUDEXOR_DELEGATION_MAX_SUBRUNS` / `CLAUDEXOR_DELEGATION_BUDGET` | mcp-server (delegation belt) | Injected by the daemon into the `agent --delegate` belt process (`claudexor mcp serve-belt`); carry the parent run id, nesting depth (belt refuses depth>0), the per-parent sub-run cap, and the parent paid-budget headroom snapshot. Never set by hand. |
| `CLAUDEXOR_REVIEWER_TIMEOUT_MS` | config | Per-reviewer timeout override for review panels. |
| `CLAUDEXOR_REVIEW_WAVE_ID` | release review | Operator-generated UUID shared by native and triad/scope reviewer processes; sealed release attestation refuses mixed or sequential wave artifacts. |
| `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` | config | Inactivity window before a silent harness stream is failed (not a wall-clock cap). |
| `CLAUDEXOR_TRANSIENT_RETRY_MAX` / `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS` / `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS` | config | Transient-error retry budget and backoff for harness launches. |
| `CLAUDEXOR_CODEX_PRICE_INPUT` / `CLAUDEXOR_CODEX_PRICE_OUTPUT` / `CLAUDEXOR_CODEX_PRICE_CACHED` | codex adapter | Cost-estimator price overrides (USD per 1M tokens) when vendor pricing changes. |
