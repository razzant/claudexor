#!/usr/bin/env bash
# Claudex arm: the orchestrated agent. One harness implements in place; a different
# provider family reviews the live /app; Claudex repairs until the cross-family review
# is clean or the bounded attempt budget runs out (review-only convergence, hidden
# tests never consulted). This is the arm that measures Claudex's orchestration lift.
#
# Env knobs:
#   CLAUDEX_TB_HARNESS   implementer harness (default: claude)
#   CLAUDEX_TB_CLAUDE_MODEL  pin the Claude model (optional)
#   CLAUDEX_TB_CODEX_MODEL   cross-family (codex) reviewer model (recommended)
#   CLAUDEX_TB_ATTEMPTS  bounded repair attempts (default: 2)
#   CLAUDEX_TB_MAX_USD   per-task spend cap (optional but recommended)
#   usage: run-claudex.sh [task-id ...]
source "$(dirname "$0")/scripts/_common.sh"
load_keys
require_harbor
have_key ANTHROPIC_API_KEY
have_key OPENAI_API_KEY
have_key GITHUB_TOKEN  # optional: only needed when your configured repo/task fetch requires it

SEL="$(task_selection_flags "$@")"
RUN_ID="claudex-$(date +%Y%m%d-%H%M%S)"
OUT="$RUNS_ROOT/$RUN_ID"
mkdir -p "$OUT"

MODEL_FLAG=()
[ -n "$CLAUDE_MODEL" ] && MODEL_FLAG=(-m "$CLAUDE_MODEL")

AK=(--ak "harness=${CLAUDEX_TB_HARNESS:-claude}" --ak "attempts=$ATTEMPTS")
[ -n "$CODEX_MODEL" ] && AK+=(--ak "reviewer_model=${CODEX_MODEL#openai/}")
[ -n "${CLAUDEX_TB_MAX_USD:-}" ] && AK+=(--ak "max_usd=${CLAUDEX_TB_MAX_USD}")

log "claudex (in-place convergence + cross-family review): dataset=$DATASET harness=${CLAUDEX_TB_HARNESS:-claude} attempts=$ATTEMPTS reviewer=${CODEX_MODEL:-<codex default>} -> $OUT"
# shellcheck disable=SC2086
# ${arr[@]+...} guards empty-array expansion under `set -u` on bash 3.2 (macOS).
harbor run -d "$DATASET" --agent-import-path "$AGENT_IMPORT" ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} "${AK[@]}" $SEL -n "$N_CONCURRENT" -o "$OUT"
log "done: $OUT"
