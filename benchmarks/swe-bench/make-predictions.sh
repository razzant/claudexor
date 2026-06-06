#!/usr/bin/env bash
# Generate SWE-bench predictions with Claudex (best-of-N + cross-family review over
# prepared per-instance repos). Writes a predictions file for the official evaluator.
#   usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>
# Env: CLAUDEX_SWE_N (candidates, default 2), CLAUDEX_SWE_MAX_USD, CLAUDEX_SWE_REVIEWER_MODEL
source "$(dirname "$0")/scripts/_common.sh"
load_keys

TASKS="${1:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
PREDS="${2:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
WORKDIR="${3:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
have_key ANTHROPIC_API_KEY
have_key OPENAI_API_KEY

ARGS=(bench run swe-bench --tasks "$TASKS" --predictions "$PREDS" --workdir "$WORKDIR" --n "${CLAUDEX_SWE_N:-2}")
[ -n "${CLAUDEX_SWE_MAX_USD:-}" ] && ARGS+=(--max-usd "$CLAUDEX_SWE_MAX_USD")
[ -n "${CLAUDEX_SWE_REVIEWER_MODEL:-}" ] && ARGS+=(--reviewer-model "$CLAUDEX_SWE_REVIEWER_MODEL")

log "claudex bench run -> $PREDS (n=${CLAUDEX_SWE_N:-2}, workdir=$WORKDIR)"
claudex "${ARGS[@]}"
log "predictions: $PREDS"
