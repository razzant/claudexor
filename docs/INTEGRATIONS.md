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
claudexor explore "map this repo's run storage" --json
claudexor run "fix the failing parser test" --json
claudexor race "fix add() in src/math.js" --harness codex,claude --n 2 --json
claudexor inspect <run_id> --json
```

Not every subcommand has stable JSON output. Integrations should prefer the
daemon/control API for long-running interactive use and use CLI JSON only where
the command documents or returns machine-readable output.

## Daemon And Control API

The daemon owns local durable scheduling. The loopback control API is the live
surface used by the macOS app.

Core endpoints:

- `POST /runs`
- `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`
- `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/<path>`
- `POST /runs/:id/apply/check`, `POST /runs/:id/apply`
- `POST /runs/:id/control`, `POST /runs/:id/input`
- `GET /harnesses`, `POST /harnesses/setup`
- `GET /setup/jobs`, `POST /setup/jobs`, `GET /setup/jobs/:id`,
  `GET /setup/jobs/:id/events`, `POST /setup/jobs/:id/cancel`
- `GET|POST /settings`
- `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

The API is loopback-only and bearer-token guarded. Artifact files remain the
source of truth; API responses are projections over daemon state and run files.
Harness setup commands are server allowlisted. Install/login/doctor execution
uses setup jobs with risk flags and redacted logs; API-key fallback goes through
`/secrets`, not inline setup payloads.

`GET /runs/:id` includes `primaryOutput`, `timeline`, and `budget` projections
for clients that need the main answer/report, streamed activity, and known spend
state without scraping artifacts. Unknown quota or spend remains unknown; do not
render missing values as `$0`.

`POST /runs/:id/control` supports cancel/interrupt for active daemon jobs.
`POST /runs/:id/input` is a typed beta endpoint, but v0.6.0 does not forward
live user input into active runs by default. Integrations must treat
`unsupported` as an honest state and disable input UI for that run.

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

Adapters must translate native I/O into Claudexor events and artifacts. They must
not orchestrate, arbitrate, manage budgets, or decide review policy.

## Storage

Project runs write under the target repository's `.claudexor/runs/<run_id>/`.
No-project Ask runs use a synthetic cwd and write artifacts under the user-level
Claudexor store. See `docs/ARCHITECTURE.md` for the full current layout.

## Stability Rules

- Schema and generated JSON Schema are the data-shape source of truth.
- Unknown modes and unavailable harnesses fail loudly.
- Raw secrets never become run artifacts or docs.
- Integrations should display beta limitations instead of silently falling back
  to another harness or another mode.
