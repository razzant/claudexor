#!/usr/bin/env bash
# Small 3-arm pilot on the SAME task set: baseline claude-code, baseline codex
# (if a model is configured), and the Claudexor orchestrated arm. All three write under
# one pilot dir, then results are summarized (resolve% + Claudexor lift).
#   usage: run-pilot-small.sh [task-id ...]   (default: tasksets/pilot-small.txt)
source "$(dirname "$0")/scripts/_common.sh"
load_keys
require_harbor
HERE="$(dirname "$0")"

STAMP="$(date +%Y%m%d-%H%M%S)"
PILOT="$RUNS_ROOT/pilot-$STAMP"
mkdir -p "$PILOT"
log "3-arm pilot -> $PILOT (tasks: ${*:-from $TASKSET_DEFAULT})"

# Arm 1: bare claude-code baseline.
CLAUDEXOR_TB_RUNS_ROOT="$PILOT" bash "$HERE/run-baseline-claude.sh" "$@" || log "baseline-claude arm failed"

# Arm 2: bare codex baseline (requires a model slug).
if [ -n "$CODEX_MODEL" ]; then
  CLAUDEXOR_TB_RUNS_ROOT="$PILOT" bash "$HERE/run-baseline-codex.sh" "$@" || log "baseline-codex arm failed"
else
  log "skipping baseline-codex arm (set CLAUDEXOR_TB_CODEX_MODEL to include it)"
fi

# Arm 3: Claudexor orchestrated (in-place convergence + cross-family review).
CLAUDEXOR_TB_RUNS_ROOT="$PILOT" bash "$HERE/run-claudexor.sh" "$@" || log "claudexor arm failed"

log "summarizing $PILOT"
python3 "$HERE/scripts/summarize-results.py" "$PILOT" || true
log "pilot complete: $PILOT"
