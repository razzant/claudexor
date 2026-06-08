# shellcheck shell=bash
# Common setup for Claudexor x Terminal-Bench (Harbor) operator scripts.
# Source this from every run-*.sh. It sets PATH/DOCKER_HOST/PYTHONPATH, optionally
# loads API keys from CLAUDEXOR_KEYS_FILE WITHOUT printing their values, and exposes
# shared defaults.

set -euo pipefail

# Repo root = three levels up from this scripts/ dir (scripts -> terminal_bench -> benchmarks -> repo).
CLAUDEXOR_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export CLAUDEXOR_REPO_ROOT

# Toolchain + Docker (Colima) discovery. Override DOCKER_HOST if you use a different VM.
export PATH="$HOME/.local/bin:$HOME/.claudexor/node/bin:/opt/homebrew/bin:$PATH"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
# So Harbor can import the Claudexor agent as a dotted module.
export PYTHONPATH="${CLAUDEXOR_REPO_ROOT}${PYTHONPATH:+:$PYTHONPATH}"

# Shared defaults (all overridable via env).
DATASET="${CLAUDEXOR_TB_DATASET:-terminal-bench/terminal-bench-2-1}"
AGENT_IMPORT="benchmarks.terminal_bench.claudexor_agent:ClaudexorAgent"
N_CONCURRENT="${CLAUDEXOR_TB_N_CONCURRENT:-4}"
ATTEMPTS="${CLAUDEXOR_TB_ATTEMPTS:-2}"
RUNS_ROOT="${CLAUDEXOR_TB_RUNS_ROOT:-$HOME/.claudexor/cache/bench-experiments/terminal-bench/harbor}"
TASKSET_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tasksets/pilot-small.txt"
export DATASET AGENT_IMPORT N_CONCURRENT ATTEMPTS RUNS_ROOT TASKSET_DEFAULT

# Model slugs are volatile, so they are NOT hardcoded. Set these to current slugs:
#   CLAUDEXOR_TB_CLAUDE_MODEL  e.g. anthropic/claude-opus-4-7   (optional; claude-code has its own default)
#   CLAUDEXOR_TB_CODEX_MODEL   e.g. openai/<current-codex>      (REQUIRED for any codex arm)
CLAUDE_MODEL="${CLAUDEXOR_TB_CLAUDE_MODEL:-}"
CODEX_MODEL="${CLAUDEXOR_TB_CODEX_MODEL:-}"
export CLAUDE_MODEL CODEX_MODEL

log() { printf '[claudexor-tb] %s\n' "$*" >&2; }
die() { printf '[claudexor-tb] ERROR: %s\n' "$*" >&2; exit 1; }

# Load API keys from CLAUDEXOR_KEYS_FILE without ever echoing their values. Existing exports
# are preserved (the file only fills in what is missing).
load_keys() {
  local f="${CLAUDEXOR_KEYS_FILE:-}"
  [ -n "$f" ] || { log "CLAUDEXOR_KEYS_FILE not set (relying on already-exported env)"; return 0; }
  [ -f "$f" ] || { log "keys file not found: $f (relying on already-exported env)"; return 0; }
  eval "$(python3 - "$f" <<'PY'
import os, shlex, sys
path = sys.argv[1]
vals = {}
try:
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
except OSError:
    lines = []
def value_of(line):
    for sep in ("=", ":"):
        if sep in line:
            return line.split(sep, 1)[1].strip().strip('"').strip("'")
    return None

for raw in lines:
    s = raw.strip()
    if not s or s.startswith("#"):
        continue
    name = ""
    for sep in ("=", ":"):
        if sep in s:
            name = s.split(sep, 1)[0].strip().lower()
            break
    v = value_of(s)
    # Name-based first (the file is `name=value` pairs). Skip OpenRouter so its
    # sk-or-* key is never mistaken for an OpenAI key.
    if name and "anthropic" in name and v:
        vals.setdefault("ANTHROPIC_API_KEY", v)
    elif name and "openrouter" in name:
        pass
    elif name and "openai" in name and v:
        vals.setdefault("OPENAI_API_KEY", v)
    elif name and "github" in name and v:
        vals.setdefault("GITHUB_TOKEN", v)
    else:
        # Fallback for bare tokens. Never blanket-grab `sk-` (could be sk-or-*).
        t = s.strip('"').strip("'")
        if "sk-ant-" in t:
            vals.setdefault("ANTHROPIC_API_KEY", t[t.find("sk-ant-"):])
        elif "github_pat_" in t:
            vals.setdefault("GITHUB_TOKEN", t[t.find("github_pat_"):])
        elif "ghp_" in t:
            vals.setdefault("GITHUB_TOKEN", t[t.find("ghp_"):])
        elif "sk-proj-" in t:
            vals.setdefault("OPENAI_API_KEY", t[t.find("sk-proj-"):])
# Only emit exports for keys not already present in the environment.
for k, v in vals.items():
    if not os.environ.get(k):
        print(f"export {k}={shlex.quote(v)}")
PY
)"
}

# Report presence (not value) of a required env var.
have_key() { [ -n "${!1:-}" ] && log "$1: present" || log "$1: MISSING"; }

# Echo `-i <name>` flags for each non-comment, non-blank line of a taskset file.
# Prints nothing if the file is absent/empty (caller can fall back to --n-tasks).
include_flags_from() {
  local file="$1"
  [ -f "$file" ] || return 0
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && printf -- '-i %s ' "$line"
  done < "$file"
}

require_harbor() { command -v harbor >/dev/null 2>&1 || die "harbor not found; run: uv tool install harbor"; }

# Resolve task-selection flags for `harbor run`:
#   1) explicit task ids passed as args  -> `-i <id> ...`
#   2) else non-empty default taskset     -> `-i <id> ...`
#   3) else                               -> `--n-tasks <CLAUDEXOR_TB_NTASKS|5>`
# Passing the SAME explicit ids to every arm is what keeps the 3-arm comparison fair.
task_selection_flags() {
  if [ "$#" -gt 0 ]; then
    for t in "$@"; do printf -- '-i %s ' "$t"; done
    return 0
  fi
  local inc
  inc="$(include_flags_from "$TASKSET_DEFAULT")"
  if [ -n "$inc" ]; then
    printf '%s' "$inc"
    return 0
  fi
  printf -- '--n-tasks %s ' "${CLAUDEXOR_TB_NTASKS:-5}"
}

# Path to Harbor's interpreter (uv tool venv), for import-checking the agent.
harbor_python() {
  local p="$HOME/.local/share/uv/tools/harbor/bin/python"
  [ -x "$p" ] && printf '%s' "$p"
}
