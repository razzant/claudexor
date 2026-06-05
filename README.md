# Claudex

Claudex is a local-first control plane for AI coding harnesses. It runs Codex
CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters, and future harnesses
behind one typed interface.

The core rule is simple: a harness is not a role. Roles are intents such as
`plan`, `implement`, `repair`, `review`, `compare`, `synthesize`, `audit`, and
`benchmark`. Any harness that declares the capability can be assigned the intent.

Current status: **v0.1.0 engineering preview**. The repo has the breadth-first
control-plane skeleton, real Codex/Claude dogfood, typed artifacts, and CI. Some
important v0.2 pieces are still explicit gaps, especially config-driven
deterministic gates.

## What It Does

Claudex adds a reproducible layer around native coding tools:

- single-harness runs when only one tool is configured;
- best-of-n races in isolated git worktrees;
- cross-family review when multiple providers are available;
- convergence loops that feed accepted findings back into repair attempts;
- structured artifacts under `.claudex/runs/<run_id>/`;
- budget/quota accounting and observed rate-limit handling;
- CLI, daemon, MCP, ACP, and plugin surfaces over the same control plane;
- benchmark runner scaffolding, including SWE-bench Verified prediction output.

It does not replace the native tools. It controls how they are selected, isolated,
reviewed, and delivered.

## Install From Source

```bash
git clone https://github.com/joi-lab/claudex.git
cd claudex
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Local macOS note: if Homebrew's `node` is killed by the OS code-signing monitor,
use an official notarized Node distribution on `PATH`.

Run the local CLI:

```bash
node packages/cli/dist/cli.js help
node packages/cli/dist/cli.js doctor
```

`doctor` checks which harnesses are installed and authenticated. A healthy
Codex/Claude setup looks like this:

```text
[ok] codex codex-cli 0.137.0
[ok] claude 2.1.165 (Claude Code)
```

Cursor and OpenCode may be unavailable until their CLIs are installed. That is a
degraded but valid state.

## Basic Usage

For examples below, define a short alias while developing from source:

```bash
alias claudex='node /path/to/claudex/packages/cli/dist/cli.js'
```

### Single Harness

Force one harness:

```bash
claudex run "fix the failing auth refresh test" --harness codex
claudex run "summarize the migration risk" --harness claude --json
```

If only one harness is configured, Claudex should collapse to that native tool
plus structured run artifacts.

### Best-of-N Race

Run Codex and Claude in separate envelopes, review the candidate diffs, and
arbitrate a winner:

```bash
claudex race "fix add() in src/math.js and keep the patch minimal" \
  --harness codex,claude \
  --n 2 \
  --json
```

Inspect the result:

```bash
claudex inspect <run_id>
claudex apply <run_id> --dry-run
```

`apply --dry-run` checks whether `final/patch.diff` applies cleanly without
mutating the repo.

### Convergence

Run a repair loop until the convergence predicate is met, budget/quota is
exhausted, or the task stalls:

```bash
claudex run "fix the bug and address accepted review findings" \
  --mode until-convergence \
  --harness codex,claude
```

Use a bounded loop when you want an explicit cap:

```bash
claudex run "try to repair the failing parser test" \
  --mode max-attempts \
  --attempts 3 \
  --harness claude
```

Hyphenated mode names are accepted (`until-convergence`, `max-attempts`).
Unknown modes fail loudly instead of falling back to `daily`.

### Planning

Produce a read-only SpecPack:

```bash
claudex plan "design a config-to-gates implementation" --harness codex,claude
```

Plan mode collects plans from configured harnesses and writes `final/plan.md`.
The live interactive interview layer is still a v0.2 follow-up.

## MCP, ACP, And Daemon

MCP stdio server:

```bash
claudex mcp serve
```

Available MCP tools in v0.1:

- `claudex_run`
- `claudex_race`
- `claudex_plan`
- `claudex_create`
- `claudex_status`

ACP stdio server:

```bash
claudex acp serve
```

Optional local daemon:

```bash
claudex daemon start
claudex daemon status --json
claudex daemon logs
claudex daemon stop
```

The daemon is local-only and uses the same runner as the CLI.

## Benchmark Runner

List available benchmark surfaces:

```bash
claudex bench list
```

Generate SWE-bench prediction output from prepared task rows:

```bash
claudex bench run swe-bench \
  --tasks tasks.jsonl \
  --predictions predictions.json \
  --workdir /path/to/prepared/instance/repos
```

Without `--workdir`, the command writes skeleton predictions and prints setup
instructions. External evaluator tooling and prepared per-instance repos are
still required for full evaluation.

## Artifact Layout

Every run creates a directory under `.claudex/runs/<run_id>/`:

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
```

Files are the source of truth. Terminal output is only a projection.

## Architecture

The current package map and data flow are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Important boundaries:

- `packages/schema` owns contracts and generated JSON Schema.
- `packages/harness-*` adapters translate native tool I/O into typed events.
- `packages/workspace` owns worktree envelopes and scoped harness homes.
- `packages/orchestrator` owns race, convergence, plan, and audit modes.
- `packages/review`, `arbitration`, `synthesis`, and `budget` own selection and
  validation logic.
- CLI, daemon, MCP, ACP, and plugins are thin surfaces.

## Current Limitations

These are known v0.1 limits, not hidden guarantees:

- Deterministic gates are not yet populated from config or CLI. `TaskContract`
  supports `tests.commands`, but the CLI does not build them yet, so
  `gatesPassed([])` is currently vacuously true. Wiring config-to-gates is the
  highest-value v0.2 task.
- `readonly_swarm` is currently a single read-only audit report.
- Plan mode writes open questions but does not yet run an interactive interview.
- Fresh-envelope final verification is not fully wired for every mode.
- Cursor and OpenCode adapters exist but need live dogfood on machines where
  their CLIs are installed.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
```

There is no root `pnpm lint` script in v0.1.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): current codebase map and
  invariants.
- [`docs/SPEC.md`](docs/SPEC.md): canonical technical specification.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): design decisions from planning.
- [`docs/PLAN.md`](docs/PLAN.md): original breadth-first build plan.
- [`docs/REVIEW.md`](docs/REVIEW.md): adversarial review history and dogfood
  findings.
- [`docs/EMBEDDING.md`](docs/EMBEDDING.md): embedding/Ouroboros integration
  contract.

## License

[MIT](LICENSE) (c) 2026 joi-lab
