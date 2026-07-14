# Claudexor x Terminal-Bench 2.1 (Harbor)

Reproducible Terminal-Bench runs for Claudexor, on the **latest stable** dataset
(`terminal-bench/terminal-bench-2-1`, 89 tasks) via the official **Harbor** harness
(`uv tool install harbor`). There is no legacy `tb` path here by design.

## What this measures

Terminal-Bench scores a container's **runtime state** (services, files, packages). Two
ways to use this suite:

1. **Single-harness baselines through the Claudexor CLI** — `claudexor agent --in-place
   --harness <codex|claude> --n 1`. One candidate runs directly in `/app`, so all
   runtime state is graded.
2. **Dual-harness, two strategies:**
   - **Convergence + cross-family review** (`--attempts N`, the README's original lift
     mode): harness A implements in place, a DIFFERENT provider family reviews the live
     tree, A repairs, repeat until the cross-family review is clean or the attempt budget
     runs out. Correct for stateful tasks (state is never thrown away).
   - **Best-of-N race** (`--harness codex,claude --n 2`): N candidates run in **isolated
     git worktrees**, cross-family review picks a winner, and the winner's **git diff** is
     delivered through the preimage-bound protected apply path into `/app`. ⚠️ Only file changes are adopted — runtime-only
     state (started services, `apt`/`pip` installs, DB rows, untracked files) in the
     losing/disposed envelopes is NOT graded, so a race resolve% is a **lower bound** for
     runtime-state tasks. Use race only when you specifically want best-of-N semantics.

Convergence is driven by **cross-family review** (and the agent's own checks). The agent
is **instructed** not to search for, read, or run Terminal-Bench's hidden grading tests
— peeking would be reward hacking and is off-limits. ⚠️ This is **prompt-enforced** under
`--access full`, **not** sandboxed: there is no filesystem read-protection of the
held-out tests yet (a future improvement), so it's an instruction, not a hard guarantee.

```
lift = resolve%(Claudexor dual)  -  max(resolve%(codex-only), resolve%(claude-only))
```
on the *same* tasks. Comparability caveats: (a) these arms run codex/claude **through the
Claudexor CLI wrapper**, which is a different scaffold than the native Codex CLI / Claude
Code agents on the public leaderboard (expect a few points of wrapper overhead);
(b) cross-family review runs in every arm but is **read-only** (it never mutates `/app`),
so a single arm's graded state is the implementer's work alone.

The agent runs as the container's default user with `IS_SANDBOX=1`, exactly like Harbor's
own `claude-code` agent, so Claude Code may use full permissions.

## Execution environment & methodology (READ THIS)

TB 2.x task images are **amd64-only**. Where you run them determines correctness:

| Environment | Emulation | Status | Use |
|---|---|---|---|
| **Native x86_64 Linux** (cloud sandbox / CI / x86 box) | none | ✅ canonical — matches the public leaderboard env | full-dataset, comparable numbers |
| **Apple Silicon + Colima `vz` + Rosetta** | Rosetta (x86→arm) | ✅ works (this suite's local path) | local iteration; carries an emulation caveat |
| Apple Silicon + Colima default (`qemu`) | qemu | ❌ `claude-code` (Bun) **crashes** (`Linux x64 baseline, no_avx`) | do not use |

- The **canonical / most stable** methodology is a **native x86_64 Linux host** — no
  emulation, so no Bun crash, no Rosetta timing skew, and results are comparable to the
  official Terminal-Bench leaderboard. Run there for any number you intend to report:
  `harbor run --env daytona` (needs `DAYTONA_API_KEY`) or `--env modal`/`--env e2b`.
- On an **Apple Silicon Mac** you must emulate amd64. Colima's default is **qemu**, under
  which the Bun-compiled `claude-code` binary crashes — so `scripts/colima-setup.sh` now
  forces **`--vm-type vz --vz-rosetta`** (Apple Rosetta), which runs the x86 binaries
  correctly and far faster than qemu. **Emulation caveat:** Rosetta is slower than native,
  which inflates wall-clock and can flip time-sensitive tasks and trigger
  `AgentSetupTimeoutError` (see knobs below); treat local Mac numbers as indicative, not
  leaderboard-grade.

## Prerequisites

- **Docker via Colima** with Compose v2 **and buildx** (buildx is required: the classic
  builder fails on tasks using `COPY <<EOT` heredocs). Run `scripts/colima-setup.sh` — on
  Apple Silicon it enables VZ+Rosetta automatically (override with
  `CLAUDEXOR_COLIMA_ROSETTA=0`).
- `uv tool install harbor`.
- **Prebuilt Claudexor bundles** on the host (`pnpm build && pnpm bench:bundle`) — the
  CLI and its daemon as two sibling files. The agent uploads both into each container,
  so there is **no in-container clone** — `GITHUB_TOKEN` is no longer required for a
  private repo. (The agent will try to build them on demand if missing, but build them
  explicitly for speed.)
- Keys exported, or loaded from an explicit `CLAUDEXOR_KEYS_FILE` (values never printed):
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
- Model slugs rotate — set `CLAUDEXOR_TB_CODEX_MODEL` / `CLAUDEXOR_TB_CLAUDE_MODEL` to
  current slugs. See `config.example.env`.

## Quickstart

```bash
# Use a notarized Node if you keep one under ~/.claudexor/node (macOS setups
# where ad-hoc-signed Homebrew Node is killed during the build); else system node.
[ -d "$HOME/.claudexor/node/bin" ] && export PATH="$HOME/.claudexor/node/bin:$PATH"
pnpm build && pnpm bench:bundle  # prebuilt CLI + daemon bundles the agent uploads per container
cd benchmarks/terminal_bench
./scripts/colima-setup.sh        # start/resize Colima (+Rosetta on Apple Silicon)
./scripts/preflight.sh           # toolchain, docker, keys (presence only), agent import
./run-oracle-smoke.sh            # harbor + docker sanity (oracle solves a real task)
./run-claudexor.sh terminal-bench/sqlite-db-truncate   # one Claudexor arm on one task
```

## Reproducible 3-arm comparison (codex-only vs claude-only vs dual-race)

Runs all three arms through the Claudexor CLI into one results root and prints the
per-arm resolve% + `dual − max(single)` lift. The dual arm is the **best-of-N race**
(`--n 2`); for the convergence+review dual instead, set `CLAUDEXOR_TB_MODE` unset and
`CLAUDEXOR_TB_HARNESS=claude` on `run-claudexor.sh`.

```bash
cd benchmarks/terminal_bench
export CLAUDEXOR_KEYS_FILE="$HOME/.claudexor/keys.env"   # or export the keys directly
# The code under test is the prebuilt bundle (pnpm bench:bundle on the host); to test a
# different ref, check it out and rebuild the bundle. CLAUDEXOR_TB_REPO/REF are legacy.
export CLAUDEXOR_TB_CLAUDE_MODEL="anthropic/claude-sonnet-4-6"
export CLAUDEXOR_TB_CODEX_MODEL="openai/gpt-5.5"
export CLAUDEXOR_TB_MAX_USD="5"                   # per-task spend cap
export CLAUDEXOR_TB_N_CONCURRENT="10"            # single arms
export CLAUDEXOR_TB_N_CONCURRENT_RACE="4"        # race arm (heavier; lower contention)
export CLAUDEXOR_TB_TIMEOUT_MULT="6"             # setup budget x6 (Rosetta build is slow)

# enumerate all 89 task ids once:
"$HOME/.local/share/uv/tools/harbor/bin/python" -c \
  "import asyncio;from harbor.registry.client.package import PackageDatasetClient as C;\
print('\n'.join(sorted(t.get_name() for t in asyncio.run(C().get_dataset_metadata('terminal-bench/terminal-bench-2-1@latest')).task_ids)))" \
  > tasksets/all-tasks.txt

# run all 3 arms (or pass explicit task ids instead of $(cat ...)):
./run-three-arm.sh $(cat tasksets/all-tasks.txt)
```

Results land under `~/.claudexor/cache/bench-experiments/terminal-bench/harbor/three-arm-*/`
(override the root with `CLAUDEXOR_TB_THREEARM_ROOT`). Aggregate any results root:

```bash
python3 scripts/summarize-results.py <root>     # per-arm resolve% + lift
./scripts/collect-artifacts.sh <root>           # gather Claudexor run artifacts/costs/adopted
```

## How the agent plugs into Harbor

`claudexor_agent.py` is a `BaseInstalledAgent` loaded by import path; Harbor needs the
repo root on `PYTHONPATH` (the scripts set this). `install()` provisions Node 22 (nvm) +
Claude Code + Codex, then **uploads two prebuilt sibling Claudexor bundles** into the
container — the CLI (`/opt/claudexor/claudexor-cli.js`) and its daemon
(`/opt/claudexor/claudexord.js`) — no in-container clone, `pnpm install`, or `tsc`.
`run()` invokes `claudexor agent --in-place ...` and exports the external
`$HOME/.claudexor/projects/<sha256-of-/app>/runs` namespace to `/logs/agent/`.

Why two files: `claudexor agent` routes through `ensureDaemon()`, which
auto-starts the daemon by spawning the **sibling** `new URL("./claudexord.js",
import.meta.url)` next to the running CLI bundle (there is no in-process `--local`
fallback — CLI runs are always daemon-tracked). So `claudexord.js` must sit right beside
`claudexor-cli.js` in `/opt/claudexor`; `bundle-cli.mjs` emits both and `install()`
uploads both, preserving that sibling relationship.

**Build the bundles once on the host** before running (the agent will also try to build
them on demand, but explicit is faster):

```bash
[ -d "$HOME/.claudexor/node/bin" ] && export PATH="$HOME/.claudexor/node/bin:$PATH"
pnpm build           # build the workspace (produces packages/cli/dist/{cli,claudexord}.js)
pnpm bench:bundle    # esbuild → dist/claudexor-cli.js + dist/claudexord.js (sibling bundles)
node benchmarks/terminal_bench/dist/claudexor-cli.js --version   # sanity: prints the root package version
```

The bundles **are the code under test** — to test a different ref, check it out and
rebuild them on the host. (`claudexor_repo` / `claudexor_ref` kwargs are still accepted
for backward compatibility but no longer drive an in-container clone.)

Agent kwargs (`--ak key=value`):

| kwarg | meaning | default |
|---|---|---|
| `harness` | implementer(s), comma-separated for race (`codex,claude`) | `claude` |
| `mode` | `single` (→ `--attempts`) or `race` (→ `--n`) | `single` |
| `n` | race width (else derived from the harness count) | #harnesses |
| `attempts` | convergence cap (single mode) | 2 |
| `reviewer_model` / `codex_model` / `claude_model` | per-family models (race seeds `~/.claudexor/config.yaml` `harnesses.<id>.default_model` per candidate; a single `--model` would collide across race candidates) | — |
| `max_usd` | per-task spend cap | — |
| `claudexor_repo` / `claudexor_ref` | **legacy / accepted-but-unused** — the bundled CLI is the code under test; rebuild the bundle to change it | — |

## Per-container setup cost & timeouts (important on Mac)

Setup is now just **Node 22 (nvm) + `npm i -g` the two harness CLIs + uploading the
two prebuilt sibling bundles** — no in-container `pnpm install` or `tsc`. This was the
main cause of `AgentSetupTimeoutError` under Rosetta (a serialized ~30-package `tsc` build
inside each emulated container); shipping the prebuilt bundle removes it entirely. The
remaining cost is `npm i -g claude-code + codex`, which is comparatively small. If you
still hit a setup-timeout under heavy concurrency, raise `CLAUDEXOR_TB_TIMEOUT_MULT`
(setup budget = 360s × mult) and/or lower `*_N_CONCURRENT`.

## Status / limitations (validated 2026-06)

- **Local Apple Silicon (Colima `vz`+Rosetta) WORKS end-to-end.** Smoke on
  `sqlite-db-truncate` resolved (reward 1.0) for codex-only, claude-only, and dual-race;
  a full 89-task run completed for the single arms. Three real blockers were fixed:
  1. **claude-code Bun crash under qemu** → switch Colima to VZ+Rosetta (this script).
  2. **In-container monorepo build** (`pnpm install` + `tsc`) blew Harbor's
     `AgentSetupTimeoutError` under Rosetta → replaced by uploading **prebuilt sibling
     CLI + daemon bundles** (`pnpm bench:bundle`), eliminating the in-container build
     (and the private-repo clone / `GITHUB_TOKEN` it required) entirely.
  3. **claude auth route** — `harness-claude` mistook an API key for a native session and
     took the (unauthenticated) subscription route → "Not logged in"; fixed in the engine
     (`authStatusOk` scrubs `ANTHROPIC_API_KEY` from its native-session probe).
- **DNS / network:** harbor resolves each task version from its registry at run start; a
  transient DNS failure aborts the whole arm (`ConnectError: nodename nor servname`). Just
  re-run that arm.
- **Honest-lift caveat:** confirm `review_verified: true` and (for race) the `adopted`
  field in the exported artifacts (`scripts/collect-artifacts.sh`) before attributing lift
  to orchestration. If only one provider family is reachable in-container, cross-family
  review can't verify and convergence degrades to a single attempt ("no lift").
- **Comparability:** these arms wrap codex/claude in the Claudexor CLI, not the native
  leaderboard agents; and local Rosetta timing differs from native x86 — so local numbers
  are indicative. Report leaderboard-grade numbers only from a native x86_64 environment.

## Scaling beyond local Docker

Harbor supports cloud sandboxes for massive parallelism and the canonical x86 env:
`harbor run --env daytona` (needs `DAYTONA_API_KEY`) or `--env modal`/`--env e2b`. Start
local for tight observability; move to a cloud env for full-dataset, reportable runs.
