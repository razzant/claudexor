# Claudex

Claudex is a local-first control plane for AI coding harnesses. It runs Codex
CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters, and future harnesses
behind one typed interface.

The core rule is simple: a harness is not a role. Roles are intents such as
`explain`, `plan`, `implement`, `repair`, `review`, `compare`, `synthesize`,
`audit`, and `benchmark`. Any harness that declares the capability can be
assigned the intent.

Current status: **v0.2.0 engineering preview**. This is a breaking preview:
old mode ids are intentionally not supported.

## Modes

Canonical mode ids:

- `ask` - read-only answer/explanation route. Default in the macOS composer.
- `agent` - default `claudex run` route; one primary-biased harness, direct edit.
- `best_of_n` - N isolated candidates, review, synthesis when useful, arbitration.
- `max_attempts` - repair loop with a hard attempt cap.
- `until_clean` - repair loop until gates/review converge, budget/quota exhausts, or it stalls.
- `plan` - read-only multi-harness planning and draft SpecPack grounding.
- `create` - create-from-scratch path.
- `readonly_audit` - read-only audit/map report.
- `benchmark` - benchmark-oriented best-of-N path.

Unknown modes fail loudly. `daily`, `until_convergence`, `readonly_swarm`, and
`audit` as mode ids are not aliases.

## Basic Usage

```bash
claudex ask "2+2?"
claudex run "fix the failing auth refresh test" --harness codex
claudex race "fix add() in src/math.js and keep the patch minimal" --harness codex,claude --n 2
claudex run "repair the parser test" --mode max-attempts --attempts 3
claudex run "fix the bug and keep repairing until clean" --mode until-clean
claudex plan "design a config-to-gates implementation"
claudex audit "map artifact writers and secret risk"
```

Inspect and apply:

```bash
claudex inspect <run_id>
claudex apply <run_id> --dry-run
claudex apply <run_id> --mode apply
```

`apply --dry-run` checks `final/patch.diff` with `git apply --check` and does
not mutate the repo.

## Routing, Auth, And Secrets

Routing is `Pool + Primary + Portfolio`:

- selected harnesses are the eligible pool;
- `--primary-harness <id>` biases single-route modes and the first candidate;
- `--portfolio <id>` records the routing/budget portfolio, default
  `subscription-first`.

Claudex mirrors native harness auth first. API keys are a fallback and live in
the OS Keychain where available, otherwise a `0600` file. Run params, daemon
`jobs.json`, artifacts, summaries, patches, and PR text store only refs/metadata,
not raw secret values.

```bash
claudex auth status
claudex auth login codex
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
- `GET /harnesses`, `GET|POST /settings`, `GET|POST|DELETE /secrets`
- `POST /spec/questions`, `POST /spec/freeze`

Start it:

```bash
claudex daemon start
claudex daemon status --json
claudex daemon logs
claudex daemon stop
```

## Artifact Layout

Every run creates files under `.claudex/runs/<run_id>/`:

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
final/answer.md?
final/report.md?
final/plan.md?
```

Files are the source of truth. Terminal output and UI rows are projections.

## Architecture

Important boundaries:

- `packages/schema` owns contracts and generated JSON Schema.
- `packages/harness-*` adapters translate native tool I/O into typed events.
- `packages/workspace` owns worktree envelopes and scoped harness homes.
- `packages/orchestrator` owns Ask, Agent, Best-of-N, Max Attempts, Until Clean,
  Plan, Create, Read-only Audit, and Benchmark modes.
- `packages/review`, `arbitration`, `synthesis`, and `budget` own selection and
  validation logic.
- CLI, daemon, control API, MCP, ACP, plugins, and macOS are thin surfaces.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SPEC.md`](docs/SPEC.md),
and [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
pnpm build
```

`pnpm release:verify` runs the same locked chain before package publishing.

There is no root `pnpm lint` script.

macOS:

```bash
cd apps/macos/ClaudexKit && swift test
cd ../ClaudexApp && swift build
```

## License

[MIT](LICENSE) (c) 2026 joi-lab
