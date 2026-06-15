# shellcheck shell=bash
# Common setup for Claudexor x SWE-bench operator scripts. Optionally loads API keys from
# CLAUDEXOR_KEYS_FILE WITHOUT printing values, sets PATH, and exposes a `claudexor` helper that
# runs the locally built CLI. The official SWE-bench evaluator and HuggingFace dataset
# loader are invoked via `uv run --with ...` so no global installs are required.

set -euo pipefail

CLAUDEXOR_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export CLAUDEXOR_REPO_ROOT
export PATH="$HOME/.local/bin:$HOME/.claudex/node/bin:/opt/homebrew/bin:$PATH"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"

SWE_RUNS_ROOT="${CLAUDEXOR_SWE_RUNS_ROOT:-$HOME/.claudexor/cache/bench-experiments/swe-bench}"
SWEBENCH_SPEC="${CLAUDEXOR_SWEBENCH_SPEC:-swebench}"   # uv --with target (pin e.g. swebench==4.1.0 if needed)
DATASETS_SPEC="${CLAUDEXOR_DATASETS_SPEC:-datasets}"
export SWE_RUNS_ROOT SWEBENCH_SPEC DATASETS_SPEC

log() { printf '[claudexor-swe] %s\n' "$*" >&2; }
die() { printf '[claudexor-swe] ERROR: %s\n' "$*" >&2; exit 1; }
have_key() { [ -n "${!1:-}" ] && log "$1: present" || log "$1: MISSING"; }

claudexor() {
  local cli="$CLAUDEXOR_REPO_ROOT/packages/cli/dist/cli.js"
  [ -f "$cli" ] || die "claudexor CLI not built; run: (cd $CLAUDEXOR_REPO_ROOT && pnpm build)"
  node "$cli" "$@"
}

load_keys() {
  local f="${CLAUDEXOR_KEYS_FILE:-}"
  [ -n "$f" ] || { log "CLAUDEXOR_KEYS_FILE not set (relying on already-exported env)"; return 0; }
  [ -f "$f" ] || { log "keys file not found: $f (relying on already-exported env)"; return 0; }
  eval "$(python3 - "$f" <<'PY'
import os, shlex, sys
vals = {}
try:
    lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
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
    if name and "anthropic" in name and v:
        vals.setdefault("ANTHROPIC_API_KEY", v)
    elif name and "openrouter" in name:
        pass
    elif name and "openai" in name and v:
        vals.setdefault("OPENAI_API_KEY", v)
    elif name and "github" in name and v:
        vals.setdefault("GITHUB_TOKEN", v)
    else:
        t = s.strip('"').strip("'")
        if "sk-ant-" in t:
            vals.setdefault("ANTHROPIC_API_KEY", t[t.find("sk-ant-"):])
        elif "github_pat_" in t:
            vals.setdefault("GITHUB_TOKEN", t[t.find("github_pat_"):])
        elif "ghp_" in t:
            vals.setdefault("GITHUB_TOKEN", t[t.find("ghp_"):])
        elif "sk-proj-" in t:
            vals.setdefault("OPENAI_API_KEY", t[t.find("sk-proj-"):])
for k, v in vals.items():
    if not os.environ.get(k):
        print(f"export {k}={shlex.quote(v)}")
PY
)"
}
