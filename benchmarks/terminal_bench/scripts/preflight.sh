#!/usr/bin/env bash
# Preflight for Claudex x Terminal-Bench. Verifies the toolchain, Docker plumbing,
# key presence (values never printed), and that Harbor can import the Claudex agent.
# Read-only: makes no changes.
source "$(dirname "$0")/_common.sh"
load_keys

ok=0
note() { printf '[claudex-tb]   %s\n' "$*" >&2; }

log "=== preflight: toolchain ==="
command -v harbor >/dev/null 2>&1 && note "harbor: $(harbor --version 2>/dev/null)" || { note "harbor: MISSING (uv tool install harbor)"; ok=1; }
command -v uv >/dev/null 2>&1 && note "uv: $(uv --version 2>/dev/null)" || note "uv: missing (optional)"
command -v node >/dev/null 2>&1 && note "node: $(node -v 2>/dev/null)" || note "node: not on PATH (only needed for local CLI dev, not the container)"

log "=== preflight: docker ==="
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  note "docker server: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
else
  note "docker: NOT reachable -> run scripts/colima-setup.sh"; ok=1
fi
docker compose version >/dev/null 2>&1 && note "compose v2: ok" || { note "compose v2: MISSING"; ok=1; }
docker buildx version >/dev/null 2>&1 && note "buildx: ok" || { note "buildx: MISSING (COPY <<EOT tasks will fail)"; ok=1; }

log "=== preflight: keys (presence only) ==="
have_key ANTHROPIC_API_KEY
have_key OPENAI_API_KEY
have_key GITHUB_TOKEN  # optional: only needed when your configured repo/task fetch requires it

log "=== preflight: claudex agent import (Harbor python) ==="
HPY="$(harbor_python || true)"
if [ -n "$HPY" ]; then
  if PYTHONPATH="$CLAUDEX_REPO_ROOT" "$HPY" -c "from benchmarks.terminal_bench.claudex_agent import ClaudexAgent; print('import ok:', ClaudexAgent.name())" 2>/dev/null; then
    note "agent import: ok"
  else
    note "agent import: FAILED (check PYTHONPATH=$CLAUDEX_REPO_ROOT)"; ok=1
  fi
else
  note "harbor python not found; skipping agent import check"
fi

log "=== preflight: models ==="
[ -n "$CLAUDE_MODEL" ] && note "CLAUDEX_TB_CLAUDE_MODEL=$CLAUDE_MODEL" || note "CLAUDEX_TB_CLAUDE_MODEL unset (claude-code uses its own default)"
[ -n "$CODEX_MODEL" ] && note "CLAUDEX_TB_CODEX_MODEL=$CODEX_MODEL" || note "CLAUDEX_TB_CODEX_MODEL unset (codex baseline arm will be skipped; codex reviewer uses default)"

if [ "$ok" -eq 0 ]; then
  log "preflight: OK"
else
  log "preflight: issues found (see above)"
fi
exit "$ok"
