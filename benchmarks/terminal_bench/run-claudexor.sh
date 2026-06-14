#!/usr/bin/env bash
# Claudexor arm: the orchestrated agent. One harness implements in place; a different
# provider family reviews the live /app; Claudexor repairs until the cross-family review
# is clean or the bounded attempt budget runs out (review-only convergence, hidden
# tests never consulted). This is the arm that measures Claudexor's orchestration lift.
#
# Env knobs:
#   CLAUDEXOR_TB_HARNESS   implementer harness (default: claude)
#   CLAUDEXOR_TB_CLAUDE_MODEL  pin the Claude model (optional)
#   CLAUDEXOR_TB_CODEX_MODEL   cross-family (codex) reviewer model (recommended)
#   CLAUDEXOR_TB_ATTEMPTS  bounded repair attempts (default: 2)
#   CLAUDEXOR_TB_MAX_USD   per-task spend cap (optional but recommended)
#   usage: run-claudexor.sh [task-id ...]
source "$(dirname "$0")/scripts/_common.sh"
load_keys
require_harbor
have_key ANTHROPIC_API_KEY
have_key OPENAI_API_KEY
have_key GITHUB_TOKEN  # optional: only needed when your configured repo/task fetch requires it

SEL="$(task_selection_flags "$@")"
RUN_ID="claudexor-$(date +%Y%m%d-%H%M%S)"
OUT="$RUNS_ROOT/$RUN_ID"
mkdir -p "$OUT"

MODE="${CLAUDEXOR_TB_MODE:-single}"
MODEL_FLAG=()
# A global -m collides across race candidates; the agent pins each candidate via the
# seeded GlobalConfig (harnesses.<id>.default_model) + ANTHROPIC_MODEL instead. Only
# pass -m for non-race arms.
[ -n "$CLAUDE_MODEL" ] && [ "$MODE" != "race" ] && MODEL_FLAG=(-m "$CLAUDE_MODEL")

AK=(--ak "harness=${CLAUDEXOR_TB_HARNESS:-claude}" --ak "mode=$MODE")
if [ "$MODE" = "race" ]; then
  # n unset -> agent derives it from the comma-harness count (codex,claude -> 2).
  [ -n "${CLAUDEXOR_TB_N:-}" ] && AK+=(--ak "n=${CLAUDEXOR_TB_N}")
else
  AK+=(--ak "attempts=$ATTEMPTS")
fi
[ -n "$CODEX_MODEL" ] && AK+=(--ak "reviewer_model=${CODEX_MODEL#openai/}" --ak "codex_model=${CODEX_MODEL#openai/}")
[ -n "$CLAUDE_MODEL" ] && AK+=(--ak "claude_model=${CLAUDE_MODEL#anthropic/}")
[ -n "${CLAUDEXOR_TB_REF:-}" ]  && AK+=(--ak "claudexor_ref=${CLAUDEXOR_TB_REF}")
[ -n "${CLAUDEXOR_TB_REPO:-}" ] && AK+=(--ak "claudexor_repo=${CLAUDEXOR_TB_REPO}")
[ -n "${CLAUDEXOR_TB_MAX_USD:-}" ] && AK+=(--ak "max_usd=${CLAUDEXOR_TB_MAX_USD}")

log "claudexor (mode=$MODE harness=${CLAUDEXOR_TB_HARNESS:-claude} n=${CLAUDEXOR_TB_N:-auto} attempts=$ATTEMPTS reviewer=${CODEX_MODEL:-<codex default>} ref=${CLAUDEXOR_TB_REF:-main}): dataset=$DATASET -> $OUT"
# shellcheck disable=SC2086
# ${arr[@]+...} guards empty-array expansion under `set -u` on bash 3.2 (macOS).
harbor run -d "$DATASET" --timeout-multiplier "${CLAUDEXOR_TB_TIMEOUT_MULT:-3}" --agent-import-path "$AGENT_IMPORT" ${MODEL_FLAG[@]+"${MODEL_FLAG[@]}"} "${AK[@]}" $SEL -n "$N_CONCURRENT" -o "$OUT"
log "done: $OUT"
