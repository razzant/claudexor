# Claudexor Integrations

This document is for tools, editors, and agents that want to drive Claudexor as a
local control plane. It describes the current integration surfaces and their
stability tier (the tiers are defined by "Stability at 1.0" in the repository
README). It is not a future target spec, and it is not contributor workflow for
changing Claudexor.

## Surface Matrix

| Surface | Current role | Stability |
|---|---|---|
| CLI | Human and automation entrypoint: run verbs (init, ask, explore, agent, best-of, plan, spec, create, audit — `map` is its alias — orchestrate), run inspection (inspect, follow, apply, decision, review), ops (project, models, harness, doctor, plugin, daemon, auth, secrets, settings, trust, release), and agent introspection (capabilities, `help --json`). | Stable contract: the verb/flag surface (`help --json`) and `--json` output keys on run paths (add-only). JSON support exists on primary machine-readable paths, not every subcommand. |
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
claudexor explore "map this repo's run storage" --json
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
engine-owned telemetry (web evidence and unrecovered tool errors), primary
output, decision record, work product, and artifact paths. Terminal daemon
state, live budget, and event streams come from the daemon/control API, not
from `inspect`.

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
then send `X-Claudexor-Protocol-Major: 2`; incompatible or missing negotiation
returns a typed `426`. `GET /v2/operations` is the runtime operation catalog,
and unversioned product aliases do not exist. Native login commands are server allowlisted and use setup jobs with
typed phase/deadline/outcome,
restart reconciliation, watchdog timeouts, and a polling-backed SSE lifecycle
stream (`/v2/setup/jobs/:id/events`) that carries the complete job snapshot,
heartbeats, and closes on every terminal state including `timed_out` and
`interrupted_unknown`. A client that reconnects first GET-resnapshots the job;
every event names its exact request-relative predecessor cursor. Missing,
duplicate, regressive, dropped, unknown, malformed, or EOF-without-terminal
frames require a scoped resnapshot. Network loss never changes the server-owned
outcome.
Native login is executed by the bundled Node runner with an absolute vendor
binary and argv (never `sh -c`), inherited Terminal TTY, and a provider-secret-
scrubbed environment. Stdout/stderr stay in Terminal. The global journal records
the immutable command authorization and fsynced one-use permit before the runner
may spawn; operational sidecars record only process identity and the hash-bound
result, which is journaled before readiness verification. The native-login path
neither receives nor copies/persists vendor session tokens or credential files.
Cancellation or
restart signals a process group only after PID + kernel-start proof. Missing
identity fails closed as `termination_unconfirmed`, not a claimed cancellation.
Terminal presents the final exit result and remains open until Return.
The exact native-source probe runs in process through the same gateway code as
Harness Doctor, never as a shell command. API-key fallback goes through
`/secrets` as a separate operation, not through setup jobs or inline setup
payloads. Native login then runs an isolated same-harness
capability smoke on the exact native route; status-probe success, another
provider, or an API key cannot satisfy it. The receipt proves credential
transport only, not plan tier, entitlement, quota, or zero cost.
`GET /v2/setup/jobs` optionally filters by `harness`, `action`, `active`, and
`limit`; no-query behavior returns the v2 journal projection. `POST /v2/setup/jobs/:id/extend`
adds the fixed 15-minute login extension without a cumulative limit. Cancel is
asynchronous and resolves only after termination is proved. Duplicate create
returns the same active login instead of opening another Terminal. The checksummed global journal is the only
lifecycle authority. Private per-job directories hold runner handshake
artifacts only; v1 registries and per-job snapshots are neither read nor
imported.
`POST /v2/setup/jobs/:id/reconcile` is the sole replacement-fence recovery path:
it succeeds only after a fresh daemon-side probe proves the recorded group empty.

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

MCP is one-shot: a host receives the final Claudexor output from the twelve
implemented tools — `claudexor_ask`, `claudexor_explore`, `claudexor_run`,
`claudexor_best_of`, `claudexor_plan`, `claudexor_create`,
`claudexor_orchestrate`, `claudexor_status`, `claudexor_capabilities`
(the derived AgentCapabilityCatalog: per-harness live capabilities, modes,
the mutability matrix, run-control keys), and the read-only recovery tools
`claudexor_runs`, `claudexor_inspect`, and `claudexor_apply_check` — not
live thread parity.

Tools declare MCP behavior annotations (readOnlyHint for every non-agent
route — MCP orchestrate is suggest-autonomy only) and, for run tools and
the capability catalog, an outputSchema with a structuredContent mirror of
the text result: `{summary, runId, runDir, status, applyEligibility}` —
`applyEligibility` is the derived apply-gate verdict `{eligible, state,
reason, requiredAction}` the control API serves on `GET /v2/runs/:id`.

Current operational behavior:

- All five run modes are daemon-tracked through `/v2`; the server auto-starts
  the local daemon and enqueues through the control API. `GET /v2/runs` lists
  every MCP-started run, including ask/plan/audit/orchestrate, while mutating
  runs remain cancellable and operator-unblockable through the same authority.
- Every run result ends with a `runId:`/`artifacts:`/`status:` trailer — the
  host has a handle for `claudexor inspect`, `follow`, `apply`, `decision`.
- Mid-run harness questions bridge to MCP ELICITATION when the host declares
  the capability (Cursor does): each engine question becomes one
  `elicitation/create` round-trip. Hosts without elicitation keep the honest
  fallback — the question declines benignly after `interaction_timeout_ms`.
- A version skew between installed plugin artifacts
  (`CLAUDEXOR_PLUGIN_VERSION`) and the running CLI is disclosed on stderr at
  serve time; run `claudexor plugin repair all` and reload the host.
- Long blocking calls remain subject to HOST tool timeouts (a race can run
  many minutes). The runId trailer plus daemon tracking make the run
  recoverable even if the host abandons the call.

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
(`~/.claudexor/plugins/state.json` by default). Generated files carry Claudexor
ownership markers, and uninstall removes only owned files or owned scoped config
entries. Unknown user files fail loudly instead of being overwritten.

Current host layouts:

- Claude Code: `~/.claude/skills/claudexor/` with plugin manifest, skill,
  command, and bundled `.mcp.json`.
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

`session/new` must provide `params.cwd` as a non-empty absolute path to an
existing directory; missing, relative, blank, non-string, or non-directory values
are rejected before a session is created. `session/prompt` must use the returned
session id, which anchors the run scope to that cwd rather than the ACP server
process cwd. Treat ACP as experimental and verify the exact behavior against the
current package before building a hard dependency.

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

## Storage

Project runs write under the target repository's `.claudexor/runs/<run_id>/`.
No-project Ask runs use a synthetic cwd and write artifacts under the user-level
Claudexor store. See `docs/ARCHITECTURE.md` for the full current layout.

## Stability Rules

- Schema and generated JSON Schema are the data-shape source of truth.
- Unknown modes and unavailable harnesses fail loudly.
- Raw secrets never become run artifacts or docs.
- No regex governance for risk, permissions, tool success, web-required
  detection, winners, or tests-passed. Use typed contracts, settings, events,
  gates, artifacts, and reviewer evidence.
- When a client intentionally starts test-authoring work that edits existing
  protected gate/test files, it should pass `protectedPathApprovals` on the run
  request instead of inferring approval from prompt prose or from frozen
  SpecPack/config state.
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
  responses carry no price and Claudexor maintains no vendor price tables — so
  the budget ledger records $0 spend for raw-api attempts.
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

## Environment reference

Every `CLAUDEXOR_*` variable a live surface reads (adapters, daemon, doctor,
plugins). Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`) are adapter fallbacks — native CLI login sessions are
always preferred.

| Variable | Owner | Effect |
|---|---|---|
| `CLAUDEXOR_CONFIG_DIR` | util | Relocates the whole `~/.claudexor` config/state root (tests, CI hermeticity). |
| `CLAUDEXOR_DISABLE_STORED_SECRETS` | secrets | Ignore Keychain/file-stored secret refs entirely (hermetic runs; native sessions still work). |
| `CLAUDEXOR_SECRETS_BACKEND` | secrets | Force the secrets backend: `keychain` or `file` (default `auto`). |
| `CLAUDEXOR_CODEX_BIN` / `CLAUDEXOR_CLAUDE_BIN` / `CLAUDEXOR_CURSOR_BIN` / `CLAUDEXOR_OPENCODE_BIN` | adapters | Explicit vendor CLI binary when PATH discovery is not enough. |
| `CLAUDEXOR_CODEX_API_KEY` / `CLAUDEXOR_ANTHROPIC_API_KEY` / `CLAUDEXOR_CURSOR_API_KEY` | adapters | Claudexor-scoped API-key overrides (take precedence over provider env names). |
| `CLAUDEXOR_CODEX_MODEL` | codex adapter | Default model override for the codex route. |
| `CLAUDEXOR_CODEX_NATIVE_HOME` / `CLAUDEXOR_CLAUDE_NATIVE_DIR` | adapters | Explicit Claudexor-owned Codex profile or Claude native config directory overrides. |
| `CLAUDEXOR_RAWAPI_BASE_URL` / `CLAUDEXOR_RAWAPI_KEY` / `CLAUDEXOR_RAWAPI_MODEL` | raw-api adapter | OpenAI-compatible endpoint, key, and model for the raw-API route. |
| `CLAUDEXOR_OPENROUTER_BASE_URL` / `CLAUDEXOR_OPENROUTER_MODEL` | openrouter route | Base URL and default model for the built-in OpenRouter raw-API instance (key: `OPENROUTER_API_KEY`). |
| `CLAUDEXOR_CONTROL_PORT` | daemon | Pin the control-API port (default: OS-assigned loopback port). |
| `CLAUDEXOR_NO_CONTROL_API` | daemon | Start the daemon without the HTTP control API (socket only). |
| `CLAUDEXOR_DAEMON_SOCK` | daemon | Override the daemon's UNIX socket path. |
| `CLAUDEXOR_DOCTOR_TTL_MS` / `CLAUDEXOR_DOCTOR_NON_OK_TTL_MS` | doctor | Cache TTLs for ok / non-ok doctor probes. |
| `CLAUDEXOR_NPX_BIN` | core (browser MCP) | Explicit `npx` binary for the browser-tool MCP child. |
| `CLAUDEXOR_CLI_PATH` / `CLAUDEXOR_NODE_PATH` | plugins | Paths baked into generated host-plugin MCP configs (set by the installer, rarely by hand). |
| `CLAUDEXOR_PLUGIN_VERSION` | mcp-server | Set by generated host configs; a mismatch with the CLI version prints the plugin-repair warning. |
| `CLAUDEXOR_MANAGED` | plugins | Ownership marker the installer writes into generated host MCP configs (never set by hand). |
| `CLAUDEXOR_REVIEWER_TIMEOUT_MS` | config | Per-reviewer timeout override for review panels. |
| `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` | config | Inactivity window before a silent harness stream is failed (not a wall-clock cap). |
| `CLAUDEXOR_TRANSIENT_RETRY_MAX` / `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS` / `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS` | config | Transient-error retry budget and backoff for harness launches. |
| `CLAUDEXOR_CODEX_PRICE_INPUT` / `CLAUDEXOR_CODEX_PRICE_OUTPUT` / `CLAUDEXOR_CODEX_PRICE_CACHED` | codex adapter | Cost-estimator price overrides (USD per 1M tokens) when vendor pricing changes. |
