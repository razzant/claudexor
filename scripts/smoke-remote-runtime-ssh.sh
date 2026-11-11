#!/usr/bin/env bash
set -euo pipefail

archive=${1:?usage: smoke-remote-runtime-ssh.sh ARCHIVE}
test -f "$archive"
case "$(basename "$archive")" in
  *-linux-x64.tar.gz) ;;
  *) echo "Linux SSH smoke requires a linux-x64 runtime archive" >&2; exit 64 ;;
esac

work=$(mktemp -d)
container="claudexor-ssh-smoke-$$"
control="$work/control"
key="$work/id_ed25519"
cleanup() {
  if test -S "$control"; then
    ssh -S "$control" -O exit remote@127.0.0.1 >/dev/null 2>&1 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

ssh-keygen -q -t ed25519 -N '' -f "$key"
# Identical Docker Official Ubuntu 24.04 amd64 bytes via Microsoft's mirror, outside Docker Hub and ECR Public pull quotas.
docker run --detach --rm --name "$container" -p 127.0.0.1::22 mcr.microsoft.com/mirror/docker/library/ubuntu@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b sleep infinity >/dev/null
docker exec "$container" bash -ceu '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends openssh-server ca-certificates curl python3
  useradd --create-home --shell /bin/bash remote
  install -d -m 0700 -o remote -g remote /home/remote/.ssh
  install -d -m 0755 /run/sshd
'
docker cp "$key.pub" "$container:/tmp/authorized_keys"
docker exec "$container" bash -ceu '
  install -m 0600 -o remote -g remote /tmp/authorized_keys /home/remote/.ssh/authorized_keys
  ssh-keygen -A
  /usr/sbin/sshd
'
port=$(docker port "$container" 22/tcp | awk -F: 'NR == 1 { print $NF }')
test -n "$port"

ssh_opts=(
  -p "$port"
  -i "$key"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=$work/known_hosts"
  -o "ControlPath=$control"
)
ssh "${ssh_opts[@]}" -M -N -f remote@127.0.0.1

ssh "${ssh_opts[@]}" remote@127.0.0.1 \
  'set -eu; root="$HOME/.claudexor/remote"; mkdir -p "$root/versions/smoke"; tar -xzf - -C "$root/versions/smoke"; ln -sfn versions/smoke "$root/current"; mkdir -p "$HOME/project"' \
  < "$archive"

probe=$(ssh "${ssh_opts[@]}" remote@127.0.0.1 \
  '~/.claudexor/remote/current/bin/claudexor remote probe --json')
node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || value.target !== "linux-x64" || value.protocolMajor !== 3) process.exit(1);
' "$probe"

bootstrap=$(ssh "${ssh_opts[@]}" remote@127.0.0.1 \
  '~/.claudexor/remote/current/bin/claudexor remote bootstrap --json')
remote_port=$(node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || value.endpoint?.host !== "127.0.0.1") process.exit(1);
  process.stdout.write(String(value.endpoint.port));
' "$bootstrap")
token=$(node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.endpoint?.token) process.exit(1);
  process.stdout.write(value.endpoint.token);
' "$bootstrap")

free_port() {
  python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

local_control_port=$(free_port)
ssh "${ssh_opts[@]}" -O forward \
  -L "127.0.0.1:${local_control_port}:127.0.0.1:${remote_port}" remote@127.0.0.1
api="http://127.0.0.1:${local_control_port}"
headers=(
  -H "Authorization: Bearer $token"
  -H "X-Claudexor-Protocol-Major: 3"
)
curl --fail --silent --show-error "${headers[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"protocolMajor":3,"client":"release-ssh-smoke"}' \
  "$api/v2/handshake" |
  node -e '
    let raw = ""; process.stdin.on("data", x => raw += x);
    process.stdin.on("end", () => {
      const value = JSON.parse(raw);
      if (!value.compatible || value.protocolMajor !== 3) process.exit(1);
    });
  '
curl --fail --silent --show-error "${headers[@]}" \
  --get --data-urlencode 'path=/home/remote' \
  "$api/v2/filesystem/directories" |
  node -e '
    let raw = ""; process.stdin.on("data", x => raw += x);
    process.stdin.on("end", () => {
      const value = JSON.parse(raw);
      if (value.path !== "/home/remote" || !Array.isArray(value.entries)) process.exit(1);
    });
  '
curl --fail --silent --show-error "${headers[@]}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-ssh-project' \
  -d '{"root":"/home/remote/project"}' \
  "$api/v2/projects" >/dev/null
curl --fail --silent --show-error "${headers[@]}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-ssh-thread' \
  -d '{"title":"SSH smoke","scope":{"kind":"project","root":"/home/remote/project"},"workspace":"in_place"}' \
  "$api/v2/threads" |
  node -e '
    let raw = ""; process.stdin.on("data", x => raw += x);
    process.stdin.on("end", () => { if (!JSON.parse(raw).id) process.exit(1); });
  '

preview_remote_port=18765
ssh "${ssh_opts[@]}" remote@127.0.0.1 \
  "printf remote-preview > \"\$HOME/project/index.html\"; cd \"\$HOME/project\"; nohup python3 -m http.server $preview_remote_port --bind 127.0.0.1 >/tmp/claudexor-preview.log 2>&1 &"
preview_local_port=$(free_port)
ssh "${ssh_opts[@]}" -O forward \
  -L "127.0.0.1:${preview_local_port}:127.0.0.1:${preview_remote_port}" remote@127.0.0.1
for _ in 1 2 3 4 5; do
  if test "$(curl --silent --max-time 2 "http://127.0.0.1:${preview_local_port}/")" = remote-preview; then
    break
  fi
  sleep 1
done
test "$(curl --fail --silent "http://127.0.0.1:${preview_local_port}/")" = remote-preview

# A new OpenSSH master must reconnect to the still-running daemon and expose
# the same loopback-only control plane without copying its bearer token to disk.
ssh "${ssh_opts[@]}" -O exit remote@127.0.0.1 >/dev/null
rm -f "$control"
ssh "${ssh_opts[@]}" -M -N -f remote@127.0.0.1
reconnected=$(ssh "${ssh_opts[@]}" remote@127.0.0.1 \
  '~/.claudexor/remote/current/bin/claudexor remote bootstrap --json')
node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value.ok || value.endpoint?.host !== "127.0.0.1") process.exit(1);
' "$reconnected"

echo "remote SSH runtime smoke passed"
