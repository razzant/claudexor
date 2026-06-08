#!/usr/bin/env bash
# Baseline arm: Harbor's built-in `codex` agent (a bare single harness). Requires an
# explicit model slug (Harbor's codex agent errors without one). Set:
#   CLAUDEXOR_TB_CODEX_MODEL=openai/<current-codex-model>
#   usage: run-baseline-codex.sh [task-id ...]
source "$(dirname "$0")/scripts/_common.sh"
load_keys
require_harbor
have_key OPENAI_API_KEY
[ -n "$CODEX_MODEL" ] || die "set CLAUDEXOR_TB_CODEX_MODEL=openai/<model> (Harbor's codex agent requires a model)"

SEL="$(task_selection_flags "$@")"
RUN_ID="baseline-codex-$(date +%Y%m%d-%H%M%S)"
OUT="$RUNS_ROOT/$RUN_ID"
mkdir -p "$OUT"

log "baseline codex: dataset=$DATASET model=$CODEX_MODEL -> $OUT"
# shellcheck disable=SC2086
harbor run -d "$DATASET" -a codex -m "$CODEX_MODEL" $SEL -n "$N_CONCURRENT" -o "$OUT"
log "done: $OUT"
