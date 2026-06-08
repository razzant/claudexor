#!/usr/bin/env bash
# Generate SWE-bench predictions with Claudexor (best-of-N + cross-family review over
# prepared per-instance repos). Writes a predictions file for the official evaluator.
#   usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>
# Env: CLAUDEXOR_SWE_N (candidates, default 2), CLAUDEXOR_SWE_MAX_USD, CLAUDEXOR_SWE_REVIEWER_MODEL
source "$(dirname "$0")/scripts/_common.sh"
load_keys

TASKS="${1:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
PREDS="${2:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
WORKDIR="${3:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
have_key ANTHROPIC_API_KEY
have_key OPENAI_API_KEY

RUNNER="${CLAUDEXOR_BENCHMARK_RUNNER:-}"
if [ -z "$RUNNER" ]; then
  echo "CLAUDEXOR_BENCHMARK_RUNNER must point to an external SWE-bench runner; v0.5 core CLI has no bench command." >&2
  exit 2
fi

ARGS=(--tasks "$TASKS" --predictions "$PREDS" --workdir "$WORKDIR" --n "${CLAUDEXOR_SWE_N:-2}")
[ -n "${CLAUDEXOR_SWE_MAX_USD:-}" ] && ARGS+=(--max-usd "$CLAUDEXOR_SWE_MAX_USD")
[ -n "${CLAUDEXOR_SWE_REVIEWER_MODEL:-}" ] && ARGS+=(--reviewer-model "$CLAUDEXOR_SWE_REVIEWER_MODEL")

log "external benchmark runner -> $PREDS (n=${CLAUDEXOR_SWE_N:-2}, workdir=$WORKDIR)"
"$RUNNER" "${ARGS[@]}"
log "predictions: $PREDS"
