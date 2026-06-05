# Claudex × Terminal-Bench 2.1

A [Terminal-Bench](https://www.tbench.ai/) installed-agent adapter that runs
Claudex inside a task container. Terminal-Bench complements SWE-bench: it scores
stateful terminal tasks (install/configure/operate), not just file-edit PRs.

## How it works

Terminal-Bench drives an agent in each task's Docker container via a tmux session.
[`claudex_agent.py`](claudex_agent.py) subclasses `AbstractInstalledAgent` and:

1. installs Node + the chosen harness CLI(s) + the Claudex CLI into the container
   ([`claudex-setup.sh.j2`](claudex-setup.sh.j2)), then
2. runs `claudex run --harness <h> --access full "<instruction>"` (daily mode).

### Why daily / single-harness on Terminal-Bench

Claudex's cross-harness best-of-N is **patch-oriented**: independent candidate
diffs are reviewed and one is selected (great for SWE-bench). Terminal-Bench tasks
are **stateful** — two independent terminal sessions cannot be merged or
selected after the fact — so the paradigm-correct mode here is daily: a single
harness drives the real container with full access. Claudex still adds uniform
routing, typed artifacts, the budget ledger, and honest cost, and collapses
cleanly to the native harness. (For multi-harness comparison on Terminal-Bench,
run separate passes with `harness=codex` vs `harness=claude` and compare resolve
rates, rather than expecting in-task best-of-N lift.)

## Prerequisites

- Docker with the Compose v2 plugin (`docker compose version`). On Colima:
  `brew install docker-compose` then
  `ln -s "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose`.
- `uv tool install terminal-bench` (provides `tb`).
- Host env: `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` for the chosen harness,
  and `GITHUB_TOKEN` to clone the private Claudex repo into the container.
- Recommended VM: >= 8 CPU / 16 GB RAM. A 2 GiB VM building the monorepo and
  running a harness in-container will be slow and may OOM.

## Run

```bash
tb run \
  --agent-import-path integrations.terminal_bench.claudex_agent:ClaudexAgent \
  --agent-kwarg harness=claude \
  -d terminal-bench-core==0.1.1 \
  --task-id hello-world \
  --n-concurrent 1
```

Useful kwargs: `harness=codex|claude`, `model_name=<id>`, `claudex_ref=<git-ref>`.

## Status / limitations

- Validated: the Terminal-Bench harness + Docker path works locally (the `oracle`
  agent resolves `hello-world`); the agent ABI and install/run pattern are
  implemented per Terminal-Bench's own `codex`/`claude_code` installed agents.
- The in-container install builds the (private) Claudex monorepo from source via
  `GITHUB_TOKEN`. A published Claudex package or a prebuilt image would make this
  lighter; that is a follow-up.
- Full multi-task validation needs a larger VM than the local 2 GiB Colima used
  during bring-up.
