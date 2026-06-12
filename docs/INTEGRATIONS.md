# Claudexor Integrations

This document is for tools, editors, and agents that want to drive Claudexor as a
local control plane. It describes current beta integration surfaces. It is not a
future target spec, and it is not contributor workflow for changing Claudexor.

## Surface Matrix

| Surface | Current role | Stability |
|---|---|---|
| CLI | Human and automation entrypoint for ask/run/race/plan/inspect/apply/daemon/auth/secrets/settings flows. | Beta. JSON support exists on primary machine-readable paths, not every subcommand. |
| Daemon and control API | Local durable queue, run list/detail, artifacts, SSE events, settings, harness status, secrets metadata, apply, and run control. | Beta local loopback contract. |
| MCP server | Exposes Claudexor tools to MCP clients. | Beta. Tool list follows the implementation, not old docs. |
| ACP server | Lets compatible editors or agents talk to Claudexor as a local agent surface. | Early beta. |
| Adapter protocol | JSON-RPC-over-stdio protocol for external harness adapters. | Beta. Implemented methods are the source of truth. |

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

Core endpoints:

- `POST /runs`
- `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`
- `POST /threads`, `GET /threads`, `GET /threads/:id` (chat/session-first threads)
- `POST /threads/:id/turns` (follow-up turn; read-only turns resume native sessions, write turns run fresh with a `session.rebound` disclosure)
- `POST /runs/:id/decision` (typed operator decision: accept risk / rerun / apply)
- `GET /events` (global live-only run-event multiplex, no replay)
- `POST /runs/:id/interactions/:id/answer` (answer a waiting_on_user question)
- `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/<path>`
- `POST /runs/:id/apply/check`, `POST /runs/:id/apply`
- `POST /runs/:id/control`
- `GET /harnesses`, `POST /harnesses/setup`
- `GET /setup/jobs`, `POST /setup/jobs`, `GET /setup/jobs/:id`,
  `GET /setup/jobs/:id/events`, `POST /setup/jobs/:id/confirm`,
  `POST /setup/jobs/:id/cancel`
- `GET|POST /settings`
- `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

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

## ACP

Run:

```bash
claudexor acp serve
```

ACP support is intended for editor and agent hosts that can speak the protocol.
Treat it as beta and verify the exact behavior against the current package before
building a hard dependency.

## External Harness Adapters

External adapters can be implemented out of tree and driven over JSON-RPC stdio.
The adapter protocol currently covers discovery, doctor/capability reporting,
run, review, and cancel style operations. Native capabilities may expose richer
surfaces, such as Codex app-server JSON-RPC or Claude stream-json stdin, but do
not assume resume, estimate, live steering, or structured output support unless
the current protocol, capability profile, and adapter doctor output prove it for
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
- Integrations should display beta limitations instead of silently falling back
  to another harness or another mode.
