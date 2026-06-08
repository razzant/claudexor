# Claudex

Claudex is a local-first control plane for AI coding harnesses. It runs Codex
CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters, and future harnesses
behind one typed interface.

The core rule is simple: a harness is not a role. Roles are intents such as
`explain`, `plan`, `implement`, `repair`, `review`, `compare`, `synthesize`,
`audit`, and `benchmark`. Any harness that declares the capability can be
assigned the intent.

Current status: **v0.4.1 beta**. This is a breaking preview: old mode ids are
intentionally not supported.

## Quickstart

```bash
pnpm install --frozen-lockfile
pnpm build

claudex ask "2+2?"
claudex explore "map this repo's auth and run storage"
claudex run "fix the failing auth refresh test" --harness codex
claudex inspect <run_id>
claudex apply <run_id> --dry-run
```

`apply --dry-run` checks `final/patch.diff` with `git apply --check` and does
not mutate the repo.

## Modes

Canonical mode ids:

- `ask` - read-only answer/explanation route. Default in the macOS composer.
- `explore` - bounded read-only research swarm with synthesis, omissions, and
  follow-up questions.
- `agent` - default `claudex run` route; one primary-biased harness, direct edit.
- `best_of_n` - N isolated candidates, review, synthesis when useful,
  arbitration.
- `max_attempts` - repair loop with a hard attempt cap.
- `until_clean` - repair loop until gates/review converge, budget/quota exhausts,
  cancellation happens, or the run stalls.
- `plan` - read-only multi-harness planning and draft SpecPack grounding.
- `create` - create-from-scratch path.
- `readonly_audit` - read-only audit/map report.
- `benchmark` - benchmark-oriented best-of-N path.

Unknown modes fail loudly. `daily`, `until_convergence`, `readonly_swarm`, and
`audit` as mode ids are not aliases.

Examples:

```bash
claudex ask "2+2?"
claudex explore "map this repo's auth and run storage"
claudex run "fix the failing auth refresh test" --harness codex
claudex race "fix add() in src/math.js and keep the patch minimal" --harness codex,claude --n 2
claudex run "repair the parser test" --mode max-attempts --attempts 3
claudex run "fix the bug and keep repairing until clean" --mode until-clean
claudex plan "design a config-to-gates implementation"
claudex run "map artifact writers and secret risk" --mode readonly_audit
```

## Routing, Auth, And Secrets

Routing is `Pool + Primary + Portfolio`:

- selected harnesses are the eligible pool;
- `--primary-harness <id>` biases single-route modes and the first candidate;
- `--portfolio <id>` records the routing/budget portfolio, default
  `subscription-first`.

Harness chips in the macOS app are not decorative toggles: unavailable,
unauthenticated, degraded, or intent-incompatible harnesses are shown with the
reason and are gated out of launch.

Claudex mirrors native harness auth first. API keys are a fallback and live in
the OS Keychain where available, otherwise a `0600` file. Run params, daemon
`jobs.json`, artifacts, summaries, patches, and PR text store only refs/metadata,
not raw secret values. Subscription/native routes scrub provider API-key env
vars unless an API-key source is explicitly selected.

```bash
claudex auth status
claudex auth login codex   # prints the native setup command/hint; no SaaS broker
claudex secrets set openai --from-env OPENAI_API_KEY
claudex secrets list
claudex settings show
claudex settings set default_portfolio subscription-first
```

## Daemon And Control API

The optional daemon owns durable local job queueing over a Unix socket. The
loopback HTTP/SSE control API is a thin viewport over the daemon and run files:

- `POST /runs`
- `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`
- `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/<path>`
- `POST /runs/:id/apply/check`, `POST /runs/:id/apply`
- `POST /runs/:id/control`, `POST /runs/:id/input`
- `GET /harnesses`, `POST /harnesses/setup`
- `GET|POST /settings`, `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

Harness setup is server-owned: the control API returns allowlisted native
login/doctor commands and official guide URLs. UI surfaces can open Terminal or
copy returned commands, but they must not invent harness setup commands.

Start it:

```bash
claudex daemon start
claudex daemon status --json
claudex daemon logs
claudex daemon stop
```

## Artifact Layout

Every project run creates files under `.claudex/runs/<run_id>/`. App-launched
Ask without a project uses an empty synthetic cwd at
`~/.cache/claudex/no-project` and writes artifacts to the user-level store
`~/.claudex/runs/<run_id>/`:

```text
events.jsonl
context/task.yaml
attempts/a01/attempt.yaml
attempts/a01/patch.diff
reviews/a01.yaml
arbitration/decision.yaml
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
macOS run detail screen surfaces `Answer` and `Diagnostics` directly from these
artifacts, so failed runs are inspectable instead of disappearing into logs.

## Integrations

Claudex can be driven by other tools through CLI JSON on supported commands, the
local daemon/control API, MCP, ACP, and external JSON-RPC adapter protocol. These
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
  Until Clean, Plan, Create, Read-only Audit, and Benchmark modes.
- `packages/review`, `arbitration`, `synthesis`, and `budget` own selection and
  validation logic.
- CLI, daemon, control API, MCP, ACP, plugins, and macOS are thin surfaces.

Read next:

- [`CLAUDEX_BIBLE.md`](CLAUDEX_BIBLE.md) - product and engineering principles.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - current runtime and package
  map.
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) - external integration
  surfaces.
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) - macOS UI/UX contract.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) - contributor workflow for
  changing Claudex itself.
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
```

`pnpm release:verify` runs Node/schema checks, Swift tests/build, and unsigned
app ZIP/DMG packaging before tagging or publishing artifacts.

There is no root `pnpm lint` script.

macOS:

```bash
cd apps/macos/ClaudexKit && swift test
cd ../ClaudexApp && swift build
```

## License

[MIT](LICENSE) (c) 2026 joi-lab
