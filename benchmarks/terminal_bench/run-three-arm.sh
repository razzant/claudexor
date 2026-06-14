#!/usr/bin/env bash
# Three-arm Terminal-Bench comparison, ALL through the Claudexor CLI agent, to isolate
# the dual-harness lift (the only variable is harness count / strategy):
#   1) codex-only      : claudexor run --in-place --harness codex      --n 1
#   2) claude-only     : claudexor run --in-place --harness claude     --n 1
#   3) dual best-of-N  : claudexor run --in-place --harness codex,claude --n 2  (race)
#
# All arms use mode=race so they share the SAME strategy; singles just have n=1
# (one candidate, runs directly in /app, runtime state preserved). The dual race runs
# 2 candidates in isolated worktrees and adopts the WINNER'S GIT DIFF into /app — so
# any non-file runtime state (services/installs/DB) the winner produced is NOT graded.
# Treat the dual-race resolve% as a LOWER BOUND for runtime-state tasks.
#
# Cross-family review runs in every arm but is READ-ONLY (it never mutates /app), so
# the codex-only / claude-only graded container state is the implementer's work alone.
#
# Required env: ANTHROPIC_API_KEY, OPENAI_API_KEY (or CLAUDEXOR_KEYS_FILE),
#   CLAUDEXOR_TB_CLAUDE_MODEL, CLAUDEXOR_TB_CODEX_MODEL, CLAUDEXOR_TB_REF (+ _REPO),
#   CLAUDEXOR_TB_MAX_USD. Optional: CLAUDEXOR_TB_N_CONCURRENT, CLAUDEXOR_TB_N_CONCURRENT_RACE.
#   usage: run-three-arm.sh [task-id ...]   (default: tasksets/pilot-small.txt)
source "$(dirname "$0")/scripts/_common.sh"
load_keys
require_harbor
HERE="$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
ROOT="${CLAUDEXOR_TB_THREEARM_ROOT:-$RUNS_ROOT/three-arm-$STAMP}"
mkdir -p "$ROOT"
log "3-arm (codex-only / claude-only / claudexor-dual-race) -> $ROOT"
log "tasks: ${*:-from $TASKSET_DEFAULT}"

N_SINGLE="${CLAUDEXOR_TB_N_CONCURRENT:-6}"
N_RACE="${CLAUDEXOR_TB_N_CONCURRENT_RACE:-4}"

# Arm 1: codex-only (single candidate, in-place).
CLAUDEXOR_TB_RUNS_ROOT="$ROOT/codex-only" CLAUDEXOR_TB_MODE=race CLAUDEXOR_TB_N=1 \
  CLAUDEXOR_TB_HARNESS=codex CLAUDEXOR_TB_N_CONCURRENT="$N_SINGLE" \
  bash "$HERE/run-claudexor.sh" "$@" || log "codex-only arm failed"

# Arm 2: claude-only (single candidate, in-place).
CLAUDEXOR_TB_RUNS_ROOT="$ROOT/claude-only" CLAUDEXOR_TB_MODE=race CLAUDEXOR_TB_N=1 \
  CLAUDEXOR_TB_HARNESS=claude CLAUDEXOR_TB_N_CONCURRENT="$N_SINGLE" \
  bash "$HERE/run-claudexor.sh" "$@" || log "claude-only arm failed"

# Arm 3: dual best-of-N race (codex + claude candidates; winner's diff adopted).
# Dir name contains "claudexor" so summarize-results.py's lift line fires:
# lift = dual-race − max(codex-only, claude-only).
CLAUDEXOR_TB_RUNS_ROOT="$ROOT/claudexor-dual-race" CLAUDEXOR_TB_MODE=race \
  CLAUDEXOR_TB_HARNESS="codex,claude" CLAUDEXOR_TB_N_CONCURRENT="$N_RACE" \
  bash "$HERE/run-claudexor.sh" "$@" || log "dual-race arm failed"

log "summarizing $ROOT"
python3 "$HERE/scripts/summarize-results.py" "$ROOT" || true
bash "$HERE/scripts/collect-artifacts.sh" "$ROOT" || true
log "3-arm complete: $ROOT"
