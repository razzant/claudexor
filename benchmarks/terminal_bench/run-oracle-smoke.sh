#!/usr/bin/env bash
# Oracle smoke: prove Harbor + Docker can build a Terminal-Bench task and that the
# reference solution resolves it. No API keys or Claudex needed.
#   usage: run-oracle-smoke.sh [task-id]   (default: terminal-bench/sqlite-db-truncate)
source "$(dirname "$0")/scripts/_common.sh"
require_harbor

TASK="${1:-terminal-bench/sqlite-db-truncate}"
RUN_ID="oracle-smoke-$(date +%Y%m%d-%H%M%S)"
OUT="$RUNS_ROOT/$RUN_ID"
mkdir -p "$OUT"

log "oracle smoke: dataset=$DATASET task=$TASK -> $OUT"
harbor run -d "$DATASET" -a oracle -i "$TASK" -n 1 -o "$OUT"
log "done: $OUT"
