# Claudexor Integrations

This document is for tools, editors, and agents that want to drive Claudexor as a
local control plane. It describes current beta integration surfaces. It is not a
future target spec, and it is not contributor workflow for changing Claudexor.

## Surface Matrix

| Surface | Current role | Stability |
|---|---|---|
| CLI | Human and automation entrypoint for init/ask/explore/run/race/plan/spec/create/audit (alias map)/orchestrate/inspect/follow/apply/decision/review/models/harness/doctor/plugin/daemon/auth/secrets/settings/trust/release flows. | Beta. JSON support exists on primary machine-readable paths, not every subcommand. |
| Daemon and control API | Local durable queue, run list/detail, artifacts, SSE events, settings, harness status, secrets metadata, apply, and run control. | Beta local loopback contract. |
| MCP server | Exposes Claudexor tools to MCP clients. | Beta. Tool list follows the implementation, not old docs. |
| ACP server | Lets compatible editors or agents talk to Claudexor as a local agent surface. | Early beta. |
| Host plugins | User-global Claude Code, Codex, Cursor, and OpenCode integrations managed by `claudexor plugin`. | Beta. Installs owned local files/config only; host enablement can still require reload/manual action. |

## CLI

Use CLI commands when another process can launch Claudexor and read stdout or the
artifact directory.

```bash
claudexor ask "explain the auth flow" --json
claudexor ask "google the latest release notes" --web auto --json
claudexor explore "map this repo's run storage" --json
claudexor run "fix the failing parser test" --json
claudexor race "fix add() in src/math.js" --harness codex,claude --n 2 --json
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
surface used by the macOS app.

The canonical endpoint inventory lives in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §7 and is generated from source; this
document does not duplicate it.

The API is loopback-only and bearer-token guarded (`GET /healthz` is the one
unauthenticated, loopback-host-guarded liveness route). Artifact files remain
the source of truth; API responses are projections over daemon state and run
files. Harness setup commands are server allowlisted. Install/login execution
uses setup jobs with risk flags, redacted logs, persistence across daemon
restarts, watchdog timeouts, and a polling-backed SSE lifecycle stream
(`/setup/jobs/:id/events`) that heartbeats and closes on terminal states.
Doctor verification (the `doctor` and `store_key` jobs, and the post-install
phase) runs IN-PROCESS through the same gateway code as the Harness Doctor
screen — never as a `claudexor ...` shell command, which does not exist on
PATH inside the bundled app. API-key fallback goes through `/secrets`, not
inline setup payloads.

`GET /runs/:id` includes `lastSeq` (the snapshot's event cursor for
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

`POST /runs/:id/control` supports cancel/interrupt for active daemon jobs.
Interactive runs use the typed interaction surface instead of raw input
forwarding: `interaction.requested` events carry the questions, the macOS app
and `claudexor follow` answer via `POST /runs/:id/interactions/:id/answer`,
and an unanswered question declines benignly after the configurable
`interaction_timeout_ms`.

## MCP

Run:

```bash
claudexor mcp serve
```

The MCP server is a thin surface over the same engine and run artifacts. Keep MCP
clients honest: read-only modes stay read-only, unavailable harnesses fail
loudly, and apply/delivery state comes from server-owned artifacts.

MCP is one-shot in this release. A host receives the final Claudexor output
from the eight implemented tools — `claudexor_ask`, `claudexor_explore`,
`claudexor_run`, `claudexor_race`, `claudexor_plan`, `claudexor_create`,
`claudexor_orchestrate`, and `claudexor_status` — and does not gain live
Claudexor thread parity through MCP.

Honest operational caveats of the current MCP surface (fixes for all of
these are scheduled in the v0.15 MCP upgrade):

- Requests are handled strictly sequentially: a long tool call (a race can run
  for many minutes) blocks subsequent requests, including pings, so hosts with
  aggressive timeouts may drop the call.
- Tool results carry the final output text but no run id — MCP is launch-only;
  correlate artifacts through the CLI (`claudexor inspect`) or the run
  directory if you need the run's evidence.
- There is no interaction/elicitation channel: a mid-run harness question
  cannot reach the MCP host and declines benignly after the configurable
  `interaction_timeout_ms`.
- MCP runs execute in-process in the MCP server, not through the daemon:
  `GET /runs` does not list them. Artifacts still land under
  `.claudexor/runs/` as usual.

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
  strict-parseable `opencode.jsonc`.

`plugin doctor` checks install health and starts the local Claudexor MCP server.
It is not harness readiness. Use `claudexor doctor` for Codex/Claude/Cursor/
OpenCode harness availability and smoke status.

Harness readiness is route/context-specific: doctor output distinguishes static
auth source availability from smoke-proven routes, and manifests declare the
credential transport plus containment strategy. A key string alone is degraded
until the adapter proves the exact CLI/auth/isolation path it will use. Cursor
keeps normal non-scoped `auto` runs on the native session when available, while
scoped/envelope `auto` may prefer the API-key route only after that key is
smoke-proven. Explicit `subscription` keeps native-session routing and fails
closed when native Cursor auth is unavailable rather than falling back to an API
key. When both
Cursor sources exist and scoped `auto` selects the API-key route, the adapter
also emits a typed `readiness_preferred` disclosure so clients can show the
billing/readiness tradeoff.

## ACP

Run:

```bash
claudexor acp serve
```

ACP support is intended for editor and agent hosts that can speak the protocol.
`session/new` must provide `params.cwd` as a non-empty absolute path to an
existing directory; missing, relative, blank, non-string, or non-directory values
are rejected before a session is created. `session/prompt` must use the returned
session id, which anchors the run scope to that cwd rather than the ACP server
process cwd. Treat ACP as beta and verify the exact behavior against the current
package before building a hard dependency.

## External Harness Adapters

The out-of-tree JSON-RPC adapter-protocol package was REMOVED in v0.9 as dead
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
- Integrations should display beta limitations instead of silently falling back
  to another harness or another mode.
