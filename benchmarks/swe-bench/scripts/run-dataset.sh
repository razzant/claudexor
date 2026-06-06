#!/usr/bin/env bash
# End-to-end SWE-bench run engine: export tasks -> prepare repos -> Claudex predictions
# -> official evaluation. Used by run-lite.sh / run-verified.sh.
#   usage: run-dataset.sh <hf-dataset> [split] [limit]
# Docker is required for the official evaluator.
source "$(dirname "$0")/_common.sh"
load_keys

DATASET_HF="${1:?usage: run-dataset.sh <hf-dataset> [split] [limit]}"
SPLIT="${2:-test}"
LIMIT="${3:-${CLAUDEX_SWE_LIMIT:-}}"
SWE_DIR="$CLAUDEX_REPO_ROOT/benchmarks/swe-bench"

slug="$(printf '%s' "$DATASET_HF" | tr '/' '_' )"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_ID="claudex-${slug}-${STAMP}"
OUT="$SWE_RUNS_ROOT/$RUN_ID"
TASKS="$OUT/tasks.jsonl"
WORKDIR="$OUT/repos"
PREDS="$OUT/predictions.jsonl"
mkdir -p "$OUT"
log "run $DATASET_HF[$SPLIT]${LIMIT:+ limit=$LIMIT} -> $OUT"

log "1/4 export tasks (HuggingFace via uv)"
uv run --with "$DATASETS_SPEC" python "$SWE_DIR/scripts/export_tasks.py" "$DATASET_HF" "$SPLIT" "$TASKS" "${LIMIT:-}"

log "2/4 prepare per-instance repos"
bash "$SWE_DIR/scripts/prepare-repos.sh" "$TASKS" "$WORKDIR"

log "3/4 Claudex predictions"
bash "$SWE_DIR/make-predictions.sh" "$TASKS" "$PREDS" "$WORKDIR"

log "4/4 official evaluation (Docker; swebench harness)"
uv run --with "$SWEBENCH_SPEC" python -m swebench.harness.run_evaluation \
  --dataset_name "$DATASET_HF" \
  --predictions_path "$PREDS" \
  --max_workers "${CLAUDEX_SWE_WORKERS:-4}" \
  --run_id "$RUN_ID" || die "evaluation failed (is Docker running?)"

log "done: $OUT  (evaluation report: ./<model>.$RUN_ID.json in CWD per swebench harness)"
