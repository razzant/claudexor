#!/usr/bin/env bash
# Sanity-check the official evaluator + Docker by scoring GOLD patches (must resolve).
# No Claudex/keys needed; just Docker + the swebench harness.
#   usage: run-gold-validate.sh [hf-dataset] [instance_id]
#   default: princeton-nlp/SWE-bench_Lite, a single instance for speed.
source "$(dirname "$0")/scripts/_common.sh"

DATASET_HF="${1:-princeton-nlp/SWE-bench_Lite}"
INSTANCE="${2:-sympy__sympy-20590}"
RUN_ID="gold-validate-$(date +%Y%m%d-%H%M%S)"

log "gold validation: $DATASET_HF instance=$INSTANCE (Docker required)"
ARGS=(--dataset_name "$DATASET_HF" --predictions_path gold --max_workers 1 --run_id "$RUN_ID")
[ -n "$INSTANCE" ] && ARGS+=(--instance_ids "$INSTANCE")
uv run --with "$SWEBENCH_SPEC" python -m swebench.harness.run_evaluation "${ARGS[@]}"
log "gold validation done (run_id=$RUN_ID)"
