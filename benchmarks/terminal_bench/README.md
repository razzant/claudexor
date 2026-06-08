# Claudex x Terminal-Bench 2.1 (Harbor)

Reproducible Terminal-Bench runs for Claudex, on the **latest stable** dataset
(`terminal-bench/terminal-bench-2-1`) via the official **Harbor** harness. There is no
legacy `tb` path here by design.

## What this measures (Claudex, not just the model)

Terminal-Bench scores a container's **runtime state** (services, files, packages), so
independent best-of-N diffs cannot be merged. The Claudex contribution that *is*
measurable here is **intra-trial orchestration**:

```
implement (harness A, in place on /app)
   -> review (harness B, a DIFFERENT provider family, reads the live tree)
   -> repair (harness A) on the findings
   -> repeat until the cross-family review is clean or the attempt budget runs out
```

Convergence is driven **only by cross-family review** (and the agent's own checks),
**never** by Terminal-Bench's hidden grading tests — peeking at them would be reward
hacking and is off-limits. The lift is then:

```
lift = resolve%(Claudex orchestrated)  -  max(resolve%(bare claude-code), resolve%(bare codex))
```

on the *same* tasks. Comparing the Claudex(claude) arm against Harbor's built-in
`claude-code` isolates the orchestration effect from the model.

The agent runs as the container's default user with `IS_SANDBOX=1`, exactly like
Harbor's own `claude-code` agent — so Claude Code may use full permissions and root
stays available for tasks that need it (e.g. installing/operating services).

## Prerequisites

- Docker via Colima with Compose v2 **and buildx** (buildx is required: the classic
  builder fails on tasks using `COPY <<EOT` heredocs). Run `scripts/colima-setup.sh`.
- `uv tool install harbor`.
- Keys exported in the environment, or loaded from an explicit `CLAUDEX_KEYS_FILE`:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (for the cross-family reviewer / codex),
  `GITHUB_TOKEN` only for private external fetches configured by your benchmark run.
- Model slugs rotate — set `CLAUDEX_TB_CODEX_MODEL` (and optionally
  `CLAUDEX_TB_CLAUDE_MODEL`) to current slugs. See `config.example.env`.

## Quickstart

```bash
cd benchmarks/terminal_bench
./scripts/colima-setup.sh        # start/resize Colima, verify compose + buildx
./scripts/preflight.sh           # toolchain, docker, keys (presence only), agent import
./run-oracle-smoke.sh            # harbor + docker sanity (oracle solves a real task)
./run-claudex.sh terminal-bench/sqlite-db-truncate   # the Claudex arm on one task
./run-pilot-small.sh             # 3-arm pilot over tasksets/pilot-small.txt + summary
```

Results land under `~/.claudex/cache/bench-experiments/terminal-bench/harbor/`
(override with `CLAUDEX_TB_RUNS_ROOT`). Summarize any pilot dir:

```bash
python3 scripts/summarize-results.py <pilot-dir>
./scripts/collect-artifacts.sh <pilot-dir>   # gather Claudex run artifacts/costs
```

## How the agent plugs into Harbor

`claudex_agent.py` is a `BaseInstalledAgent` loaded by import path; Harbor needs
the repo root on `PYTHONPATH` (the scripts set this for you). Note the agent module is
NOT under a `harbor/` subpackage — that name would shadow the real `harbor` package:

```bash
PYTHONPATH=<repo-root> harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path benchmarks.terminal_bench.claudex_agent:ClaudexAgent \
  --ak harness=claude --ak reviewer_model=<openai-model> --ak attempts=2 \
  -i terminal-bench/sqlite-db-truncate -n 1
```

`install()` provisions Node 22 (nvm) + Claude Code + Codex + the Claudex CLI (built
from source) into the container; `run()` invokes `claudex run --in-place --mode
max-attempts --access full ...` and exports `/app/.claudex/runs` to `/logs/agent/`.

Agent kwargs (`--ak key=value`): `harness` (default `claude`), `reviewer_model`,
`attempts` (default 2), `max_usd`, `claudex_ref`, `claudex_repo`.

## Scaling beyond local Docker (documented, not wired)

Harbor supports cloud sandboxes for massive parallelism: `harbor run --env daytona`
(needs `DAYTONA_API_KEY`) or `--env modal`/`--env e2b`. Start local for tight
observability and iteration; move to a cloud env for full-dataset runs.

## Status / limitations

- Validated locally: Harbor + Docker + buildx work and the `oracle` agent resolves real
  tasks (e.g. `terminal-bench/sqlite-db-truncate`, reward 1.0); the Claudex agent
  installs Node/Claude/Codex and clones Claudex, and `pnpm install` completes inside the
  task container.
- KNOWN BLOCKER (local Colima): building the Claudex monorepo *inside the task
  container* aborts. The repo pins `pnpm@11`, which requires Node 22; Node 22 then hits
  a libuv `uv__io_poll: Assertion errno == EEXIST` crash on teardown inside
  Terminal-Bench's task container under local Colima (the container is native arm64 —
  not emulation — and a plain `node:22` container under the same Colima does NOT crash,
  so this is specific to the task base image/runtime, not a Claudex defect).
  `UV_USE_IO_URING=0` did not suppress it; `--ignore-scripts` removed a separate native
  `esbuild` postinstall SIGSEGV but not the libuv abort.
- Follow-ups to unblock the live Claudex arm (either works):
  1. Run on a native cloud sandbox where Terminal-Bench's own leaderboard runs:
     `harbor run --env daytona` (needs `DAYTONA_API_KEY`) or `--env modal`.
  2. Ship a prebuilt Claudex (single-file bundle / published package / prebuilt image)
     so no in-container `pnpm install`/`pnpm build` runs; a prebuilt runtime can also use
     Node 20 (no pnpm at runtime), sidestreaming the Node-22 libuv crash.
- Honest-lift caveat: if only one provider family is reachable in-container (e.g. no
  `OPENAI_API_KEY`), cross-family review cannot verify and convergence degrades to a
  single bare attempt — which would read as "no lift", not orchestration value. Confirm
  `review_verified: true` in the exported Claudex artifacts (`scripts/collect-artifacts.sh`)
  before attributing any lift to orchestration.
- The default taskset is a light, moderate subset; populate `tasksets/pilot-small.txt`
  with more ids (see the file header) for a fuller pilot.
- Leaderboard submissions have their own integrity rules; this suite targets internal
  lift measurement.
