#!/usr/bin/env bash
# Prepare per-instance repos for Claudexor to solve: clone each task's repo into
# <workdir>/<instance_id> and check out its base_commit. Reads a tasks.jsonl produced
# by export_tasks.py. Idempotent: existing instance dirs are skipped.
#   usage: prepare-repos.sh <tasks.jsonl> <workdir>
source "$(dirname "$0")/_common.sh"

TASKS="${1:?usage: prepare-repos.sh <tasks.jsonl> <workdir>}"
WORKDIR="${2:?usage: prepare-repos.sh <tasks.jsonl> <workdir>}"
[ -f "$TASKS" ] || die "tasks file not found: $TASKS"
mkdir -p "$WORKDIR"

# Emit "<instance_id>\t<repo>\t<base_commit>" rows.
python3 - "$TASKS" <<'PY' | while IFS=$'\t' read -r iid repo base; do
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    print(f"{r['instance_id']}\t{r.get('repo','')}\t{r.get('base_commit','')}")
PY
  dest="$WORKDIR/$iid"
  if [ -d "$dest/.git" ]; then
    log "skip (exists): $iid"
    continue
  fi
  [ -n "$repo" ] && [ -n "$base" ] || { log "skip (missing repo/base): $iid"; continue; }
  log "clone $repo @ ${base:0:8} -> $dest"
  rm -rf "$dest"
  if git clone --quiet "https://github.com/$repo.git" "$dest" 2>/dev/null; then
    git -C "$dest" checkout --quiet "$base" 2>/dev/null || log "WARN: checkout failed for $iid ($base)"
  else
    log "WARN: clone failed for $repo"
  fi
done
log "prepared repos under $WORKDIR"
