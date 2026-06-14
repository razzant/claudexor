#!/usr/bin/env bash
# Start/resize Colima with generous resources and verify the Docker plumbing
# Terminal-Bench needs (Compose v2 + buildx). buildx matters: the classic builder
# fails on tasks whose Dockerfile uses `COPY <<EOT` heredocs.
#   env overrides: CLAUDEXOR_COLIMA_CPU CLAUDEXOR_COLIMA_MEM(GiB) CLAUDEXOR_COLIMA_DISK(GiB)
#                  CLAUDEXOR_COLIMA_ROSETTA=0 to disable Rosetta on Apple Silicon
#
# Apple Silicon NOTE: TB 2.x task images are amd64-only, so on an arm64 Mac they run
# EMULATED. Colima's DEFAULT amd64 emulation is qemu, under which the Bun-compiled
# `claude-code` binary CRASHES (`Bun ... Linux x64 (baseline) ... no_avx`), failing the
# claude/dual arms. Rosetta (VZ) is Apple's x86 translation and runs those binaries
# correctly, so we force `--vm-type vz --vz-rosetta` here. The CANONICAL (no-emulation)
# methodology is still a native x86_64 Linux host / cloud sandbox (see README).
source "$(dirname "$0")/_common.sh"

CPU="${CLAUDEXOR_COLIMA_CPU:-12}"
MEM="${CLAUDEXOR_COLIMA_MEM:-64}"
DISK="${CLAUDEXOR_COLIMA_DISK:-200}"

command -v colima >/dev/null 2>&1 || die "colima not installed (brew install colima docker docker-compose docker-buildx)"

# On Apple Silicon, enable VZ + Rosetta for correct (and far faster) amd64 emulation.
ROSETTA_ARGS=()
if [ "$(uname -m)" = "arm64" ] && [ "${CLAUDEXOR_COLIMA_ROSETTA:-1}" != "0" ]; then
  ROSETTA_ARGS=(--vm-type vz --vz-rosetta)
  log "Apple Silicon detected -> --vm-type vz --vz-rosetta (qemu crashes the Bun claude-code binary)"
fi

if colima status >/dev/null 2>&1; then
  log "colima already running; restarting to apply CPU=$CPU MEM=${MEM}GiB DISK=${DISK}GiB ${ROSETTA_ARGS[*]:-}"
  colima stop || true
fi
log "starting colima: CPU=$CPU MEM=${MEM}GiB DISK=${DISK}GiB ${ROSETTA_ARGS[*]:-}"
colima start --cpu "$CPU" --memory "$MEM" --disk "$DISK" ${ROSETTA_ARGS[@]+"${ROSETTA_ARGS[@]}"}

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
