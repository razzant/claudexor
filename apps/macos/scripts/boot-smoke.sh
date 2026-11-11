#!/usr/bin/env bash
#
# Boot smoke for the exact packaged Node and daemon entry:
#
#   apps/macos/scripts/boot-smoke.sh NODE ENTRY
#
# Starts ENTRY as a daemon with a disposable HOME and waits until it publishes
# control-api discovery in the root derived from that HOME. The child starts
# from an empty environment (`env -i`, like the neighbouring packaged smokes)
# holding only that HOME and a fixed PATH, so an inherited CLAUDEXOR_CONFIG_DIR,
# CLAUDEXOR_DAEMON_SOCK, CLAUDEXOR_NO_CONTROL_API, CLAUDEXOR_CONTROL_PORT,
# CLAUDEXOR_DAEMON_OWNER, NODE_OPTIONS or provider key cannot redirect, disable
# or extend it. Without an override the daemon uses its default HOME-derived
# root, the path the app takes on first launch.
#
# The daemon publishes discovery while startup admission is still
# recovery-only: a pass shows that the bundle loads, claims its root and binds
# its transports. It is not a normal-readiness or handshake check.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: boot-smoke.sh NODE ENTRY" >&2
  exit 2
fi
NODE="$1"
ENTRY="$2"

# Darwin limits Unix-domain socket paths to roughly 100 bytes. Keep the
# disposable HOME short so this smoke tests daemon boot, not mktemp's long
# /private/var/folders spelling.
SMOKE_HOME="$(cd "$(mktemp -d /tmp/claudexor-smoke.XXXXXX)" && pwd -P)"
# The one derivation of the observed root: the daemon's default for this HOME.
DAEMON_DIR="$SMOKE_HOME/.claudexor/v3/daemon"
STDERR_LOG="$SMOKE_HOME/smoke.err"

env -i HOME="$SMOKE_HOME" PATH="/usr/bin:/bin" "$NODE" "$ENTRY" >/dev/null 2>"$STDERR_LOG" &
# `env` execs NODE, so this is the daemon's own pid and a child of this shell.
PID=$!

alive() { kill -0 "$PID" 2>/dev/null; }

# Bash reaps the child when it exits, after which `alive` is false.
gone_within() {
  local steps="$1"
  while alive; do
    if [ "$steps" -le 0 ]; then return 1; fi
    sleep 0.2
    steps=$((steps - 1))
  done
  return 0
}

print_diagnostics() {
  echo "stderr:" >&2
  cat "$STDERR_LOG" >&2
  if [ -f "$DAEMON_DIR/claudexord.log" ]; then
    echo "daemon log (last 40 lines):" >&2
    tail -n 40 "$DAEMON_DIR/claudexord.log" >&2
  fi
}

PUBLISHED=0
for _ in $(seq 1 20); do
  if [ -f "$DAEMON_DIR/control-api.json" ]; then PUBLISHED=1; break; fi
  alive || break
  sleep 0.5
done

# Stop only the recorded child and reap it before deleting the root it writes.
# A scratch daemon that SIGTERM cannot end within 10 s is killed and fails.
STOPPED_BY=""
if alive; then
  STOPPED_BY=TERM
  kill -TERM "$PID" 2>/dev/null || true
  if ! gone_within 50; then
    STOPPED_BY=KILL
    kill -KILL "$PID" 2>/dev/null || true
    if ! gone_within 25; then
      echo "ERROR: bundled claudexord (pid $PID) is still running after SIGKILL; its scratch root $SMOKE_HOME is kept" >&2
      print_diagnostics
      exit 1
    fi
  fi
fi
STATUS=0
wait "$PID" || STATUS=$?

FAILURE=""
if [ "$PUBLISHED" != 1 ]; then
  if [ -z "$STOPPED_BY" ]; then
    FAILURE="exited with status $STATUS before publishing control-api discovery"
  else
    FAILURE="did not publish control-api discovery within 10 s"
  fi
elif [ -z "$STOPPED_BY" ]; then
  FAILURE="exited with status $STATUS after publishing discovery, before the smoke stopped it"
elif [ "$STOPPED_BY" = KILL ]; then
  FAILURE="did not exit within 10 s of SIGTERM and was killed"
fi
# The status after our SIGTERM is not judged: discovery precedes the daemon's
# own transport proof, and a stop that interrupts that proof may report the
# unfinished startup as a failure.

if [ -n "$FAILURE" ]; then
  echo "ERROR: bundled claudexord $FAILURE" >&2
  print_diagnostics
  rm -rf "$SMOKE_HOME"
  exit 1
fi
rm -rf "$SMOKE_HOME"
