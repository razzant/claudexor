#!/usr/bin/env bash
# Start/resize Colima with generous resources and verify the Docker plumbing
# Terminal-Bench needs (Compose v2 + buildx). buildx matters: the classic builder
# fails on tasks whose Dockerfile uses `COPY <<EOT` heredocs.
#   env overrides: CLAUDEX_COLIMA_CPU CLAUDEX_COLIMA_MEM(GiB) CLAUDEX_COLIMA_DISK(GiB)
source "$(dirname "$0")/_common.sh"

CPU="${CLAUDEX_COLIMA_CPU:-12}"
MEM="${CLAUDEX_COLIMA_MEM:-64}"
DISK="${CLAUDEX_COLIMA_DISK:-200}"

command -v colima >/dev/null 2>&1 || die "colima not installed (brew install colima docker docker-compose docker-buildx)"

if colima status >/dev/null 2>&1; then
  log "colima already running; restarting to apply CPU=$CPU MEM=${MEM}GiB DISK=${DISK}GiB"
  colima stop || true
fi
log "starting colima: CPU=$CPU MEM=${MEM}GiB DISK=${DISK}GiB"
colima start --cpu "$CPU" --memory "$MEM" --disk "$DISK"

log "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unreachable)"
if docker compose version >/dev/null 2>&1; then
  log "docker compose: $(docker compose version --short 2>/dev/null || echo present)"
else
  log "WARN: docker compose v2 plugin missing -> brew install docker-compose && \\"
  log "      ln -sf \"\$(brew --prefix)/opt/docker-compose/bin/docker-compose\" ~/.docker/cli-plugins/docker-compose"
fi
if docker buildx version >/dev/null 2>&1; then
  log "docker buildx: $(docker buildx version 2>/dev/null | head -1)"
else
  log "WARN: docker buildx missing -> brew install docker-buildx && \\"
  log "      ln -sf \"\$(brew --prefix)/opt/docker-buildx/bin/docker-buildx\" ~/.docker/cli-plugins/docker-buildx"
fi
log "colima ready"
