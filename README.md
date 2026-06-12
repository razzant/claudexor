# Claudexor

Claudexor is a local-first control plane for AI coding harnesses. It runs Codex
CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters, and future harnesses
behind one typed interface.

The core rule is simple: a harness is not a role. Roles are intents such as
`explain`, `plan`, `implement`, `repair`, `review`, `compare`, `synthesize`,
and `audit`. Any harness that declares the capability can be assigned the
intent.

Current status: **v0.9.0 beta**. This is a breaking preview: old mode ids are
intentionally not supported.

## Quickstart

```bash
pnpm install --frozen-lockfile
pnpm build

# Run the CLI from the repo (or add an alias/PATH entry for it):
node packages/cli/dist/cli.js doctor
alias claudexor="node $(pwd)/packages/cli/dist/cli.js"

claudexor ask "2+2?"
claudexor ask "google the latest release notes" --web auto
claudexor explore "map this repo's auth and run storage"
claudexor run "fix the failing auth refresh test" --harness codex
claudexor race "fix add() and keep the patch minimal" --harness codex,claude --n 2
claudexor inspect <run_id>
claudexor follow <run_id>     # live event tail of a daemon run; answers questions in the TTY
claudexor apply <run_id> --dry-run
claudexor doctor
claudexor secrets list
claudexor daemon start
```

`apply --dry-run` checks `final/patch.diff` with `git apply --check` and does
not mutate the repo. Unknown flags and invalid `--access`/`--web`/`--effort`
values fail loudly with exit code 2 — a typo never silently runs with defaults.

## Modes

Canonical mode ids (v0.9: five intents; engine strategies are FLAGS, not modes):

- `ask` - read-only answer/explanation route. Default in the macOS composer.
- `plan` - read-only multi-harness planning and draft SpecPack grounding.
- `audit` - read-only audit/map report; `--swarm` runs the bounded research
  swarm (per-explorer findings, synthesis, omissions, follow-up questions).
- `agent` - default `claudexor run` route. Strategy flags: `--n N` (best-of-N
  race with isolated candidates, review, synthesis, arbitration),
  `--attempts N` (repair loop with a hard cap), `--until-clean` (repair loop
  until gates/review converge, budget/quota exhausts, cancellation happens, or
  the run stalls), `--create` (create-from-scratch intent).
- `orchestrate` - the brain: routed like reviewers, read-only, produces a typed
  orchestration plan over the tool belt (start_run / race / status /
  answer_question / apply / review).

Unknown modes fail loudly. The old strategy mode ids (`best_of_n`,
`max_attempts`, `until_clean`, `explore`, `create`, `readonly_audit`) and the
pre-v0.8 ids (`daily`, `until_convergence`, `readonly_swarm`) are NOT aliases.

Chat is the normal loop: `claudexor` with no arguments opens a REPL over a
thread. Read-only turns (ask/plan/audit/orchestrate) RESUME the routed
harness's own native CLI session (codex `exec resume`, claude `--resume`) —
plan first, then keep asking, in ONE conversation. Write (agent) turns run in
fresh isolated envelopes where the native session is not portable: the engine
emits a typed `session.rebound` disclosure and continuity rides on the thread
prompt plus repo state (envelope-per-session lifetime is future work).

Examples:

```bash
claudexor                       # REPL: a thread of turns (read-only turns resume natively)
claudexor ask "2+2?"
claudexor ask "google the latest release notes" --web auto
claudexor explore "map this repo's auth and run storage"   # = audit --swarm
claudexor run "fix the failing auth refresh test" --harness codex
claudexor race "fix add() in src/math.js and keep the patch minimal" --harness codex,claude --n 2
claudexor run "repair the parser test" --attempts 3
claudexor run "fix the bug and keep repairing until clean" --until-clean
claudexor plan "design a config-to-gates implementation"
claudexor audit "map artifact writers and secret risk"
claudexor orchestrate "ship the v2 parser refactor across this repo"
```

## Web, Tool Evidence, And Output Readiness

External web context is a typed run policy, separate from shell/network
sandboxing. The CLI-first contract is:

```bash
claudexor ask "google this library's current release" --web auto
claudexor ask "use cached web context only" --web cached
claudexor ask "force live search where supported" --web live
claudexor ask "answer from local/project context only" --web off
```

The policy values are `off | auto | cached | live`. `auto` allows web-capable
harness tools where supported and records whether the harness actually attempted
`WebSearch`/`WebFetch`. A run that attempts a web tool and gets a tool error
cannot be plain green success unless a later successful web result proves
recovery. Read-only Ask/Audit can fall back to another eligible route and emits
`route.fallback.*` events.

Run terminal state is separate from output readiness. Control API, CLI, and app
expose `outputReadyState` (`pending | finalizing | ready | diagnostic`),
`webEvidence`, tool errors, budget, and artifact paths. `claudexor inspect
<run_id>` is the CLI projection of the same run detail the macOS app renders.

## Routing, Auth, And Secrets

Routing is `Pool + Primary + Portfolio`:

- selected harnesses are the eligible pool;
- `--primary-harness <id>` biases single-route modes and the first candidate;
- `--portfolio <id>` records the routing/budget portfolio, default
  `subscription-first`.

Harness chips in the macOS app are not decorative toggles: unavailable,
unauthenticated, degraded, or intent-incompatible harnesses are shown with the
reason and are gated out of launch.

Claudexor mirrors native harness auth first. API keys are a fallback and live in
the OS Keychain where available, otherwise a `0600` file. Run params, daemon
`jobs.json`, artifacts, summaries, patches, and PR text store only refs/metadata,
not raw secret values. Subscription/native routes scrub provider API-key env
vars unless an API-key source is explicitly selected.

```bash
claudexor auth status
claudexor auth login codex   # prints the native setup command/hint; no SaaS broker
claudexor secrets set openai --from-env OPENAI_API_KEY
claudexor secrets list
claudexor settings show
claudexor settings set default_portfolio subscription-first
```

`auth status` distinguishes source availability from readiness: manifest auth
sources say what could be used, while doctor status/checks decide whether a
harness is actually routable.

## Daemon And Control API

The optional daemon owns durable local job queueing over a Unix socket. The
loopback HTTP/SSE control API is a thin viewport over the daemon and run files:

- `POST /runs`
- `POST /threads`, `GET /threads`, `GET /threads/:id` (chat/session-first threads)
- `POST /threads/:id/turns` (follow-up turn; read-only turns resume native sessions, write turns run fresh with a `session.rebound` disclosure)
- `POST /runs/:id/decision` (typed operator decision: accept risk / rerun / apply)
- `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`
- `GET /events` (global live-only run-event multiplex)
- `POST /runs/:id/interactions/:id/answer` (answer a waiting_on_user question)
- `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/<path>`
- `POST /runs/:id/apply/check`, `POST /runs/:id/apply`
- `POST /runs/:id/control`
- `GET /harnesses`, `POST /harnesses/setup`
- `GET /setup/jobs`, `POST /setup/jobs`, `GET /setup/jobs/:id`,
  `GET /setup/jobs/:id/events`, `POST /setup/jobs/:id/confirm`,
  `POST /setup/jobs/:id/cancel`
- `GET|POST /settings`, `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

Harness setup is server-owned. `/harnesses/setup` is the typed prepare surface;
`/setup/jobs` is the execution lifecycle for allowlisted install/login jobs
with redacted logs, risk flags, persistence across restarts, watchdog
timeouts, and an SSE lifecycle stream; doctor verification runs in-process
inside the daemon (no PATH dependency). UI surfaces must not invent harness
setup commands or accept inline secrets.

Run events carry a monotonic per-run `seq`; `GET /runs/:id` returns the
snapshot plus `lastSeq`, so clients subscribe to `GET /runs/:id/events` with
`Last-Event-ID` for gap-free live state (snapshot-then-subscribe). Run detail
responses include `primaryOutput`, `timeline`, `budget`, `pendingInteractions`,
and `summary.route` projections. Web/tool evidence is projected from the
engine-owned `final/telemetry.yaml`. Clients should use those fields first
instead of guessing artifact paths or displaying fake zero spend/quota values.
`POST /runs/:id/control` supports cancel/interrupt for active daemon jobs.
Interactive harnesses (Claude Code) can ask typed questions mid-run: the run
parks as waiting_on_user, the macOS app or `claudexor follow` answers via the
interactions endpoint, and unanswered questions decline benignly after the
configurable timeout.

Start it:

```bash
claudexor daemon start
claudexor daemon status --json
claudexor daemon logs
claudexor daemon stop
```

## Artifact Layout

Every project run creates files under `.claudexor/runs/<run_id>/`. App-launched
Ask without a project uses an empty synthetic cwd at
`~/.cache/claudexor/no-project` and writes artifacts to the user-level store
`~/.claudexor/runs/<run_id>/`:

```text
events.jsonl
context/task.yaml
context/context_pack.yaml?
attempts/a01/attempt.yaml
attempts/a01/patch.diff
reviews/a01.yaml
arbitration/decision.yaml
final/telemetry.yaml
final/patch.diff
final/work_product.yaml
final/summary.md
final/failure.yaml?
final/answer.md?
final/explore.md?
final/explore-findings.yaml?
final/omissions.md?
final/report.md?
final/plan.md?
context/context_error.md?
```

Files are the source of truth. Terminal output and UI rows are projections. The
macOS run detail screen surfaces `Outcome`, `Timeline`, and `Diagnostics`
directly from these artifacts/events, so successful answers and failed runs are
inspectable instead of disappearing into logs.

Project runs execute in isolated envelopes under
`.claudexor/workspaces/.../tree`; harness `cwd` is that envelope worktree.
Proven work product means a git diff in the envelope, a declared run artifact,
or an explicitly verified host side-effect. Absolute `/tmp/...` writes are host
side effects and do not count as project success. A project prompt asking for a
tmp file should resolve to project-local `tmp/...` or a run artifact unless a
future verified host-side-effect mode is explicitly selected.

## Integrations

Claudexor can be driven by other tools through CLI JSON on supported commands, the
local daemon/control API, MCP, and ACP (the external JSON-RPC adapter-protocol package was removed in v0.9 as dead code). These
surfaces are beta and capability-gated; integrations should not assume every
subcommand has JSON output or every harness supports live steering.

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for the current integration
matrix and limitations.

## Architecture

Important boundaries:

- `packages/schema` owns contracts and generated JSON Schema.
- `packages/harness-*` adapters translate native tool I/O into typed events.
- `packages/workspace` owns worktree envelopes and scoped harness homes.
- `packages/orchestrator` owns Ask, Explore, Agent, Best-of-N, Max Attempts,
  Until Clean, Plan, Create, and Read-only Audit modes.
- `packages/review`, `arbitration`, `synthesis`, and `budget` own selection and
  validation logic.
- CLI, daemon, control API, MCP, ACP, plugins, and macOS are thin surfaces.

Read next:

- [`CLAUDEXOR_BIBLE.md`](CLAUDEXOR_BIBLE.md) - product and engineering principles.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - current runtime and package
  map.
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) - external integration
  surfaces.
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) - macOS UI/UX contract.
- [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) - public rationale and conceptual
  model.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) - contributor workflow for
  changing Claudexor itself.
- [`docs/CHECKLISTS.md`](docs/CHECKLISTS.md) - human gates for docs, schema,
  release, visual QA, and security.
- [`apps/macos/README.md`](apps/macos/README.md) - macOS app notes.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
pnpm docs:check   # docs-truth gate: endpoints, mode ids, CLI flags vs source
pnpm knip         # dead exports/files gate
```

`pnpm release:verify` runs Node/schema checks, Swift tests/build, and unsigned
local app ZIP/DMG packaging for smoke. Final GitHub Release assets are built by
the `Release` GitHub Actions workflow from the pushed `v*` tag; do not upload
stale local `apps/macos/dist` artifacts.

There is no root `pnpm lint` script.

macOS:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift build
```

## Version History

- **v0.9.0** — chat/session-first + harness-agnostic truth: modes collapse 9→5
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
- **v0.8.0** — live truth pass: event-sourced streaming with a monotonic
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
- **v0.7.0** — engine truth pass: typed `tool_call`/`tool_result` events with a
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
- **v0.6.0** — first public beta: canonical modes, daemon + control API, macOS
  app, review/arbitration pipeline, secret store, release automation.

## License

[MIT](LICENSE) (c) 2026 joi-lab
