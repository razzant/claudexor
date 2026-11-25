#!/usr/bin/env bash
# Disposable-host E2E of controller-side first install (`claudexor remote
# preflight` / `remote install`) in a fresh local Ubuntu SSH container on Linux
# CI (`ssh://remote@127.0.0.1:<port>`, isolated key and container host key, no
# user ssh-agent or ~/.ssh). It checks the preflight's host key fingerprint
# against the container's own, that install started no daemon, then the
# separate connect: `remote probe`, `remote bootstrap`, bearer absence from
# every wizard answer, and the Control handshake over an SSH forward. The CLI
# and the driver run with an empty environment plus what they need; the
# daemon bearer never appears in an argv.
#
# usage (after `pnpm build`, Linux CI only):
#   smoke-remote-install-ssh.sh --published
#   smoke-remote-install-ssh.sh [--candidate-assets] RELEASE_ASSETS_DIR
set -euo pipefail
unset SSH_AUTH_SOCK SSH_AGENT_PID CLAUDEXOR_CONFIG_DIR \
  DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH

usage() {
  printf 'usage:\n  smoke-remote-install-ssh.sh --published\n  smoke-remote-install-ssh.sh [--candidate-assets] RELEASE_ASSETS_DIR\n' >&2
  exit "${1:-64}"
}

mode="" assets=""
case "$#:${1:-}" in
  1:-h|1:--help) usage 0 ;;
  1:--published) mode=published ;;
  1:|1:-*) usage 64 ;;
  1:*) mode=candidate-assets; assets=$1 ;;
  2:--candidate-assets)
    test -n "$2" && test "${2#-}" = "$2" || usage 64
    mode=candidate-assets; assets=$2 ;;
  *) usage 64 ;;
esac

case "$(uname -s):${CI:-}:${GITHUB_ACTIONS:-}" in
  Linux:true:*|Linux:1:*|Linux:*:true) ;;
  *) echo "remote install smoke: Linux CI only" >&2; exit 1 ;;
esac
test -S /var/run/docker.sock || { echo "remote install smoke: /var/run/docker.sock missing" >&2; exit 1; }
command -v jq >/dev/null || { echo "remote install smoke: jq is required" >&2; exit 1; }

docker_ci() { env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH DOCKER_HOST=unix:///var/run/docker.sock docker -H unix:///var/run/docker.sock "$@"; }

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cli_entry="" cli_ver=""
if test "$mode" = "candidate-assets"; then
  test -f "$assets/remote-runtime-manifest.json"
  test -f "$repo/packages/cli/dist/remote-host-install.js"
else
  cli_rel=$(jq -er '(if (.bin | type) == "object" then .bin.claudexor else .bin end) | select(type == "string" and length > 0)' "$repo/packages/claudexor/package.json")
  cli_ver=$(jq -er '.version | select(type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$repo/packages/claudexor/package.json")
  cli_entry="$repo/packages/claudexor/$cli_rel"
  test -f "$cli_entry" && test -f "$repo/packages/cli/dist/cli.js"
fi

work=$(cd -- "$(mktemp -d)" && pwd -P)
container_id="" dest="" key="$work/id_ed25519" control="$work/control"
cleanup() {
  test -n "${dest:-}" && test -S "$control" && test -x "$work/bin/ssh" && "$work/bin/ssh" -S "$control" -O exit -- "$dest" >/dev/null 2>&1 || true
  test -n "${container_id:-}" && docker_ci rm -f "$container_id" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

ssh-keygen -q -t ed25519 -N '' -f "$key"
# The same pinned Ubuntu 24.04 amd64 image as smoke-remote-runtime-ssh.sh.
container_id=$(docker_ci run --detach --rm -p 127.0.0.1::22 mcr.microsoft.com/mirror/docker/library/ubuntu@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b sleep infinity)
[[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || { container_id=""; echo "remote install smoke: docker run did not return a container ID" >&2; exit 1; }
docker_ci exec "$container_id" bash -ceu '
  export DEBIAN_FRONTEND=noninteractive
  acquire=(-o Acquire::Retries=5)
  apt-get "${acquire[@]}" --error-on=any update -qq
  apt-get "${acquire[@]}" install -y -qq --no-install-recommends openssh-server ca-certificates
  useradd --create-home --shell /bin/bash remote
  install -d -m 0700 -o remote -g remote /home/remote/.ssh
  install -d -m 0755 /run/sshd
' >/dev/null
docker_ci cp "$key.pub" "$container_id:/tmp/authorized_keys"
docker_ci exec "$container_id" bash -ceu '
  install -m 0600 -o remote -g remote /tmp/authorized_keys /home/remote/.ssh/authorized_keys
  ssh-keygen -A >/dev/null
  /usr/sbin/sshd
'
docker_ci exec "$container_id" test ! -e /home/remote/.claudexor
port_mapping=$(docker_ci port "$container_id" 22/tcp | sed -n '1p')
[[ "$port_mapping" =~ ^127\.0\.0\.1:([0-9]+)$ ]] \
  || { echo "remote install smoke: container SSH port is not bound to 127.0.0.1" >&2; exit 1; }
port="${BASH_REMATCH[1]}"
(( port >= 1 && port <= 65535 ))
dest="ssh://remote@127.0.0.1:${port}"

mkdir "$work/bin" "$work/out" "$work/controller-home"
docker_ci exec "$container_id" awk -v p="$port" 'NF >= 2 { print "[127.0.0.1]:" p, $1, $2 }' \
  /etc/ssh/ssh_host_ed25519_key.pub > "$work/known_hosts"
test -s "$work/known_hosts"
real_ssh=$(command -v ssh)
# Identity and trust come from a config file, which command-line options
# outrank: the installer's pinned calls replace only the known-hosts check.
printf '%s\n' "IdentityFile $key" 'IdentitiesOnly yes' 'IdentityAgent none' \
  'StrictHostKeyChecking yes' "UserKnownHostsFile $work/known_hosts" \
  'GlobalKnownHostsFile /dev/null' 'ProxyCommand none' > "$work/ssh_config"
printf '#!/bin/sh\nset -eu\nunset SSH_AUTH_SOCK SSH_AGENT_PID\nHOME="%s" exec "%s" -F "%s" "$@"\n' \
  "$work/controller-home" "$real_ssh" "$work/ssh_config" > "$work/bin/ssh"
chmod 0755 "$work/bin/ssh"
remote_ssh() { "$work/bin/ssh" -o BatchMode=yes -- "$dest" "$@"; }
remote_ssh true

if test "$mode" = "candidate-assets"; then
  env -i PATH="$work/bin:$PATH" HOME="$work/controller-home" \
    CI="${CI:-}" GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" \
    CLAUDEXOR_REMOTE_INSTALL_SMOKE_WORK="$work" \
    node "$repo/scripts/smoke-remote-install-driver.mjs" "$assets" "$port"
else
  run_cli() { env -i PATH="$work/bin:$PATH" HOME="$work/controller-home" node "$cli_entry" "$@"; }
  read_marker() { docker_ci exec "$container_id" sh -eu -c 'r=/home/remote/.claudexor/remote; printf "%s\t%s\n" "$(readlink "$r/current")" "$(cat "$r/current/.archive-sha256")"'; }
  test "$(run_cli --version)" = "$cli_ver"

  run_cli remote preflight "$dest" --json > "$work/out/preflight-empty.json" 2>/dev/null \
    || { echo "remote install smoke: preflight failed" >&2; exit 1; }
  docker_ci exec "$container_id" test ! -e /home/remote/.claudexor

  manifest_url="https://github.com/razzant/claudexor/releases/download/v${cli_ver}/remote-runtime-manifest.json"
  if jq -e --arg v "$cli_ver" --arg u "$manifest_url" '
    .ok == true and .state == "blocked" and .runtime == null and .install == null and .digest == null
    and .problem.code == "release_unavailable"
    and .problem.message == ("Claudexor " + $v + " has no published signed remote runtime (" + $u + ")")
  ' "$work/out/preflight-empty.json" >/dev/null 2>&1; then
    echo "remote install smoke: no published signed remote runtime for $cli_ver ($manifest_url)" >&2
    exit 69
  fi
  jq -e --arg d "$dest" --arg v "$cli_ver" '
    .ok == true and .state == "empty" and .destination == $d and .runtime == null and .problem == null
    and .server.user == "remote" and .server.home == "/home/remote" and .server.target == "linux-x64"
    and (.server.hostKeys | type == "array" and length > 0)
    and .install.version == $v and .install.sudo == false
    and (.install.buildSha | type == "string" and test("^[0-9a-f]{40}$"))
    and (.install.archiveSha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.digest | type == "string" and test("^[0-9a-f]{64}$"))
  ' "$work/out/preflight-empty.json" >/dev/null 2>&1 \
    || { echo "remote install smoke: unexpected empty preflight" >&2; exit 1; }
  digest=$(jq -r .digest "$work/out/preflight-empty.json")

  run_cli remote install "$dest" --digest "$digest" --json > "$work/out/install.json" 2>/dev/null \
    || { echo "remote install smoke: install failed" >&2; exit 1; }
  marker_before=$(read_marker)
  run_cli remote preflight "$dest" --json > "$work/out/preflight-installed.json" 2>/dev/null \
    || { echo "remote install smoke: post-install preflight failed" >&2; exit 1; }
  test "$marker_before" = "$(read_marker)"

  jq -ne --slurpfile pre "$work/out/preflight-empty.json" \
    --slurpfile inst "$work/out/install.json" --slurpfile post "$work/out/preflight-installed.json" \
    --arg d "$dest" --arg v "$cli_ver" --arg m "$marker_before" '
    ($pre[0].install) as $o | ($inst[0]) as $i | ($post[0]) as $p |
    ("versions/" + $v + "-" + $o.archiveSha256 + "-") as $prefix |
    $i.ok == true and $i.outcome == "installed" and $i.destination == $d
    and $i.runtime.version == $v and $i.runtime.buildSha == $o.buildSha
    and ($i.runtime.pointer | startswith($prefix) and test("-[0-9a-f]{32}$"))
    and $m == ($i.runtime.pointer + "\t" + $o.archiveSha256)
    and $p.ok == true and $p.state == "installed" and $p.destination == $d
    and $p.install == null and $p.digest == null and $p.problem == null and $p.runtime == $i.runtime
  ' >/dev/null 2>&1 || { echo "remote install smoke: installed runtime mismatch" >&2; exit 1; }
  if grep -Eq '"(token|endpoint)"' \
    "$work/out/preflight-empty.json" "$work/out/install.json" "$work/out/preflight-installed.json"; then
    echo "remote install smoke: wizard answer carries a daemon endpoint" >&2
    exit 1
  fi
fi

# The confirmation named this server: its own ed25519 key, as OpenSSH prints it.
host_fp=$(docker_ci exec "$container_id" ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')
jq -e --arg fp "$host_fp" 'any(.server.hostKeys[]?; .fingerprint == $fp)' \
  "$work/out/preflight-empty.json" >/dev/null 2>&1 \
  || { echo "remote install smoke: preflight does not show the server's host key" >&2; exit 1; }
# Install started nothing: no daemon process or socket before the separate connect.
procs=$(docker_ci top "$container_id")
case "$procs" in
  *claudexord*) echo "remote install smoke: a daemon runs before connect" >&2; exit 1 ;;
esac
docker_ci exec "$container_id" test ! -e /home/remote/.claudexor/v3/daemon/claudexord.sock \
  || { echo "remote install smoke: a daemon socket exists before connect" >&2; exit 1; }

probe=$(remote_ssh '~/.claudexor/remote/current/bin/claudexor remote probe --json' 2>/dev/null)
jq -e --slurpfile inst "$work/out/install.json" '
  .ok == true and .target == "linux-x64" and .protocolMajor == 3
  and .version == $inst[0].runtime.version and .buildSha == $inst[0].runtime.buildSha
' <<< "$probe" >/dev/null 2>&1 || { echo "remote install smoke: remote probe mismatch" >&2; exit 1; }

# The bootstrap answer carries the daemon bearer: no shell trace from here on.
set +x
bootstrap=$(remote_ssh '~/.claudexor/remote/current/bin/claudexor remote bootstrap --json' 2>/dev/null)
jq -e --slurpfile inst "$work/out/install.json" '
  .ok == true and .target == "linux-x64" and .protocolMajor == 3
  and .version == $inst[0].runtime.version and .buildSha == $inst[0].runtime.buildSha
  and .engineVersion == $inst[0].runtime.version and .engineBuildSha == $inst[0].runtime.buildSha
  and .endpoint.host == "127.0.0.1"
  and (.endpoint.port | type == "number" and floor == . and . >= 1 and . <= 65535)
  and (.endpoint.token | type == "string" and length > 0)
' <<< "$bootstrap" >/dev/null 2>&1 || { echo "remote install smoke: remote bootstrap mismatch" >&2; exit 1; }
remote_port=$(jq -r .endpoint.port <<< "$bootstrap")
token=$(jq -r .endpoint.token <<< "$bootstrap")
# The bearer reaches grep and curl through file descriptors, never an argv.
if grep -rqF -f <(printf '%s\n' "$token") "$work/out"; then
  echo "remote install smoke: a wizard answer carries the daemon bearer" >&2
  exit 1
fi

local_port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')
"$work/bin/ssh" -M -N -f -S "$control" -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" -- "$dest"
curl --disable --noproxy '*' --fail --silent \
  -H @<(printf 'Authorization: Bearer %s\n' "$token") \
  -H "X-Claudexor-Protocol-Major: 3" \
  -H "X-Claudexor-Capabilities: 1" \
  -H 'Content-Type: application/json' \
  -d '{"protocolMajor":3,"client":"remote-install-smoke"}' \
  "http://127.0.0.1:${local_port}/v2/handshake" > "$work/handshake.json" 2>/dev/null \
  || { echo "remote install smoke: handshake HTTP request failed" >&2; exit 1; }
deadline_note=$(jq -er --slurpfile inst "$work/out/install.json" '
  select(
    .compatible == true and .protocolMajor == 3 and ((.servingMode // "normal") == "normal")
    and .engine.version == $inst[0].runtime.version and .engine.sha == $inst[0].runtime.buildSha
    and ((has("capabilities") | not) or (.capabilities | type == "array"))
  ) |
  ((.capabilities // []) | map(select(type == "object" and .name == "run-deadline/1")) | .[0]) as $cap |
  if $cap == null then "run-deadline/1=absent"
  else
    select(
      ($cap.boundary == "cgroup" or $cap.boundary == "marker")
      and ($cap.stopGraceSec | type == "number" and floor == . and . >= 1 and . <= 30)
    ) | "run-deadline/1=observed(" + $cap.boundary + ",not-stop-proof)"
  end
' "$work/handshake.json" 2>/dev/null) || { echo "remote install smoke: handshake mismatch" >&2; exit 1; }
installed_ver=$(jq -er '.runtime.version | select(type == "string" and length > 0)' "$work/out/install.json") \
  || { echo "remote install smoke: install answer names no runtime version" >&2; exit 1; }
# 6.3.0 predates run-deadline/1 and stays a historical install-only check;
# every other runtime must advertise it with a valid boundary.
case "$deadline_note:$installed_ver" in
  run-deadline/1=observed*) ;;
  run-deadline/1=absent:6.3.0) deadline_note="run-deadline/1=absent(historical 6.3.0, install-only)" ;;
  *) echo "remote install smoke: runtime $installed_ver does not advertise run-deadline/1" >&2; exit 1 ;;
esac

if test "$mode" = "published"; then
  jq -c '{version: .install.version, buildSha: .install.buildSha, archiveSha256: .install.archiveSha256}' \
    "$work/out/preflight-empty.json"
fi
echo "remote install SSH smoke passed ($mode, $deadline_note)"
