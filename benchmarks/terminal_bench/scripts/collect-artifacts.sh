#!/usr/bin/env bash
# Collect Claudexor run artifacts (events, attempts, reviews, final summaries, cost)
# that the agent exported to each trial's agent/claudexor-runs directory, into one
# tree for inspection.
#   usage: collect-artifacts.sh <harbor-run-or-pilot-dir> [dest-dir]
source "$(dirname "$0")/_common.sh"

SRC="${1:?usage: collect-artifacts.sh <run-or-pilot-dir> [dest]}"
DEST="${2:-$SRC/_claudexor-artifacts}"
mkdir -p "$DEST"

count=0
while IFS= read -r d; do
  rel="$(printf '%s' "$d" | sed "s#^$SRC/##; s#/claudexor-runs##; s#/#__#g")"
  mkdir -p "$DEST/$rel"
  cp -R "$d/." "$DEST/$rel/" 2>/dev/null || true
  count=$((count + 1))
done < <(find "$SRC" -type d -name claudexor-runs 2>/dev/null)

log "collected $count claudexor-runs tree(s) -> $DEST"
