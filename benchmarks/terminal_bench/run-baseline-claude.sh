#!/usr/bin/env bash
# Baseline arm: Harbor's built-in `claude-code` agent (a bare single harness). This is
# the control to isolate the Claudex orchestration lift. Tasks: args, else the default
# taskset, else --n-tasks.
#   usage: run-baseline-claude.sh [task-id ...]
source "$(dirname "$0")/scripts/_common.sh"
load_keys
require_harbor
have_key ANTHROPIC_API_KEY

SEL="$(task_selection_flags "$@")"
RUN_ID="baseline-claude-$(date +%Y%m%d-%H%M%S)"
OUT="$RUNS_ROOT/$RUN_ID"
mkdir -p "$OUT"

MODEL_FLAG=()
[ -n "$CLAUDE_MODEL" ] && MODEL_FLAG=(-m "$CLAUDE_MODEL")

log "baseline claude-code: dataset=$DATASET model=${CLAUDE_MODEL:-<claude-code default>} -> $OUT"
# shellcheck disable=SC2086
# ${arr[@]+...} guards empty-array expansion under `set -u` on bash 3.2 (macOS).
harbor run -d "$DATASET" -a claude-code ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} $SEL -n "$N_CONCURRENT" -o "$OUT"
log "done: $OUT"
