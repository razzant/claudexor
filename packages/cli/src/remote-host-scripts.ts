/**
 * Remote shell text for the controller-side SSH runtime install
 * (`claudexor remote preflight|install`).
 *
 * INSTALL_SCRIPT and ROLLBACK_SCRIPT are the ONE editable source of the SSH
 * runtime install transaction. The macOS app's `RemoteRuntimeInstaller`
 * literals (RemoteRuntimeScripts.swift) are generated from them by
 * scripts/gen-remote-runtime-scripts.ts and checked by `pnpm
 * fixtures:swift:check`, so the app and the CLI run the same bytes. Neither
 * uses sudo: everything stays under `$HOME/.claudexor/remote`. PREFLIGHT_SCRIPT
 * only reads.
 *
 * The app runs INSTALL_SCRIPT as `sh -s -- <5 args>` with the script on stdin,
 * after its own upload of the digest-named archive, which stays unless the
 * install completes. The CLI passes a sixth argument, its install's own random
 * token, in ONE writing step (installCommand): the step's command carries the
 * fixed script and its checked arguments, and its input is only the signed
 * archive, which the script itself writes into its token-named file. So the
 * archive, the directory and the pointer belong to this install alone, no
 * other client's upload is read or removed, and the one shell that owns the
 * archive from its first byte removes it whenever it ends.
 *
 * For either caller the script ends through one release of its own lock
 * (LOCK_STEPS, the same text ROLLBACK_SCRIPT uses), also on a signal or a
 * broken output stream, and prints one line about its candidate:
 * activationReceipt once `remote activate` succeeded, or refusalReceipt when
 * it stopped before starting activation. A stop while activating prints
 * neither, so that outcome stays unknown. The app reads neither line; it
 * settles through the pointer, as before.
 */

/**
 * The install lock as both transactions take and release it: the same text in
 * INSTALL_SCRIPT and ROLLBACK_SCRIPT, around each one's own `cleanup`. Only the
 * lock this script created is released, once: the release runs `cleanup`,
 * then removes that lock, ignoring any later signal so that none cuts it
 * short. A signal or a broken output stream ends the script through the
 * release (`stop_now`). While the lock is being taken a signal is only noted
 * (`stop_later`) and acted on once the lock is known as this script's or
 * another's, so a stop neither leaves this script's lock behind nor removes
 * another's. A lock it could not create is another install's (`busy`, which
 * the caller reports with exit 75) only when one is there; otherwise mkdir's
 * own reason stays on stderr and the caller fails with exit 73. It writes
 * nothing to stdout.
 */
const LOCK_STEPS = `held= stopped= busy=
release() {
  trap '' HUP INT PIPE TERM
  cleanup
  test -n "$held" || return 0
  held=
  rmdir "$lock" 2>/dev/null || :
}
stop_now() {
  release
  exit "$1"
}
stop_later() {
  stopped=\${stopped:-$1}
}
on_signals() {
  trap "$1 129" HUP
  trap "$1 130" INT
  trap "$1 141" PIPE
  trap "$1 143" TERM
}
take_lock() {
  on_signals stop_later
  if mkdir "$lock"; then held=1; fi
  on_signals stop_now
  test -z "$stopped" || stop_now "$stopped"
  test -z "$held" || return 0
  if test -e "$lock" || test -L "$lock"; then
    busy=1
    echo "another install holds the lock $lock; an install releases it when it ends or its connection drops, but a killed install or a removal the filesystem refused can leave it: remove that empty directory by hand only after checking that no install still runs as this user" >&2
  else
    echo "could not create the install lock $lock (the reason is above); nothing was activated or rolled back: free space or fix the permissions there, then read the server again" >&2
  fi
  return 1
}`;

export const INSTALL_SCRIPT = `set -eu
flow= archive= candidate= phase=prepare reason=failed
# This install's own files, which every end removes through the release: a
# token-named archive and its staging directory. A directory already moved to
# versions/ stays, whatever any pointer names. A stop before activation prints
# its refusal; a stop while activating prints nothing.
cleanup() {
  if test -n "$flow" && test -n "$archive"; then rm -f "$archive" || :; fi
  if test -n "$held"; then rm -rf "$staging" || :; fi
}
finish() {
  release
  test "$phase" = prepare && test -n "$candidate" || return 0
  printf '{"ok":false,"activated":false,"candidate":"%s","reason":"%s"}\\n' "$candidate" "$reason" || :
}
${LOCK_STEPS}
trap finish EXIT
on_signals stop_now
version=$1
expected=$2
expected_current=$3
previous_version=$4
previous_sha=$5
flow=\${6:-}
case "$version" in *[!0-9.]*|'') exit 64;; esac
case "$expected" in *[!0-9a-f]*|'') exit 64;; esac
test "\${#expected}" -eq 64
case "$flow" in *[!0-9a-f]*) exit 64;; esac
test -z "$flow" || test "\${#flow}" -eq 32
case "$expected_current" in
  -) test "$previous_version" = "-" && test "$previous_sha" = "-";;
  versions/*)
    case "$expected_current" in */*/*|*..*) exit 64;; esac
    case "$previous_version" in *[!0-9.]*|'') exit 64;; esac
    case "$previous_sha" in *[!0-9a-f]*|'') exit 64;; esac
    test "\${#previous_sha}" -eq 40;;
  *) exit 64;;
esac
root="$HOME/.claudexor/remote"
if test -n "$flow"; then
  archive="$root/incoming/$expected.$flow.tar.gz"
  candidate="versions/$version-$expected-$flow"
else
  archive="$root/incoming/$expected.tar.gz"
  candidate="versions/$version-$expected"
fi
staging="$root/.staging/$version-$$"
destination="$root/$candidate"
lock="$root/.install-lock"
umask 077
mkdir -p "$root/incoming" "$root/.staging" "$root/versions"
# The controller-side step's whole input is its signed archive: this script
# writes it, owns it from its first byte, and every end removes it (cleanup).
# A stream that broke off leaves a short file, which the digest refuses.
if test -n "$flow"; then
  cat > "$archive"
fi
take_lock || { test -z "$busy" || { reason=locked; exit 75; }; exit 73; }
actual_current=-
if test -L "$root/current"; then
  actual_current=$(readlink "$root/current")
elif test -e "$root/current"; then
  reason=changed
  exit 73
fi
test "$actual_current" = "$expected_current" || { reason=changed; exit 75; }
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{print $1}')
else
  exit 69
fi
test "$actual" = "$expected"
# Capture both listings through plain assignments: \`set -e\` propagates
# a tar failure out of \`x=$(...)\`, while a substitution inline in the
# heredoc body would silently truncate the listing on a corrupt
# archive. Heredoc expansion never field-splits or globs, and the
# anchored patterns are closed under raw-newline entry names: any
# \`..\` path component leaves \`..\`, \`../*\`, \`*/../*\` or \`*/..\` on at
# least one physical line no matter where the name is split.
listing=$(tar -tzf "$archive")
while IFS= read -r entry; do
  case "$entry" in /*|..|../*|*/../*|*/..) exit 65;; esac
done <<EOF
$listing
EOF
verbose=$(tar -tvzf "$archive")
while IFS= read -r detail; do
  case "$detail" in
    -*) ;;
    d*) ;;
    *) exit 65;;
  esac
done <<EOF
$verbose
EOF
mkdir "$staging"
tar -xzf "$archive" -C "$staging" --no-same-owner
test -x "$staging/bin/claudexor"
"$staging/bin/claudexor" remote probe --json >/dev/null
printf '%s\\n' "$expected" > "$staging/.archive-sha256"
if test -n "$flow"; then
  if test -e "$destination" || test -L "$destination"; then exit 73; fi
  mv "$staging" "$destination"
elif test -e "$destination"; then
  test -d "$destination" && test ! -L "$destination"
  test -f "$destination/.archive-sha256"
  test "$(cat "$destination/.archive-sha256")" = "$expected"
  test -x "$destination/bin/claudexor"
  "$destination/bin/claudexor" remote probe --json >/dev/null
else
  mv "$staging" "$destination"
fi
if test "$expected_current" != "-"; then
  "$root/$expected_current/bin/claudexor" remote stop "$previous_version" "$previous_sha" --json >/dev/null
  test -L "$root/current"
  test "$(readlink "$root/current")" = "$expected_current"
else
  test ! -e "$root/current"
fi
phase=activating
"$destination/bin/claudexor" remote activate "$expected_current" "$candidate" --json >/dev/null
phase=activated
printf '{"ok":true,"activated":"%s"}\\n' "$candidate"
rm -f "$archive"`;

export const ROLLBACK_SCRIPT = `set -eu
candidate=$1
previous=$2
candidate_version=$3
candidate_sha=$4
previous_version=$5
previous_sha=$6
case "$candidate" in versions/*) ;; *) exit 64;; esac
case "$candidate" in */*/*|*..*) exit 64;; esac
case "$previous" in
  -) test "$previous_version" = "-" && test "$previous_sha" = "-";;
  versions/*)
    case "$previous" in */*/*|*..*) exit 64;; esac
    case "$previous_version" in *[!0-9.]*|'') exit 64;; esac
    case "$previous_sha" in *[!0-9a-f]*|'') exit 64;; esac
    test "\${#previous_sha}" -eq 40;;
  *) exit 64;;
esac
case "$candidate_version" in *[!0-9.]*|'') exit 64;; esac
case "$candidate_sha" in *[!0-9a-f]*|'') exit 64;; esac
test "\${#candidate_sha}" -eq 40
root="$HOME/.claudexor/remote"
lock="$root/.install-lock"
umask 077
# A rollback leaves nothing of its own behind but its lock.
cleanup() { :; }
${LOCK_STEPS}
trap release EXIT
on_signals stop_now
take_lock || { test -z "$busy" || exit 75; exit 73; }
test -L "$root/current"
test "$(readlink "$root/current")" = "$candidate"
"$root/$candidate/bin/claudexor" remote stop "$candidate_version" "$candidate_sha" --json >/dev/null
test -L "$root/current"
test "$(readlink "$root/current")" = "$candidate"
"$root/$candidate/bin/claudexor" remote rollback "$candidate" "$previous" --json >/dev/null
if test "$previous" = "-"; then
  printf '%s\\n' '{"ok":true,"deactivated":true}'
else
  test -d "$root/$previous"
  test ! -L "$root/$previous"
  "$root/$previous/bin/claudexor" remote bootstrap --json
fi`;

/**
 * Read-only facts for `remote preflight`: who and where the SSH login lands,
 * the server's SSH host public keys, the platform, the install prerequisites,
 * the install lock and the runtime pointer. A pointer is followed only when it
 * names one directory under `versions/`; there (never through the movable
 * `current`) only two small regular files are read, `runtime.json` and the
 * `.archive-sha256` marker: all of a file's bytes as hex on one line when the
 * read completed, whatever they hold, `!` when the file is there and a read
 * failed, nothing when it is not a regular file there or is over its bound.
 * Nothing in that tree is run, so this says what the runtime declares, not
 * that it works. Markers let the reader ignore anything a login shell prints
 * around the answer.
 */
export const PREFLIGHT_SCRIPT = `set -u
root="$HOME/.claudexor/remote"
echo 'claudexor-preflight-v3'
printf 'user=%s\\n' "$(id -un 2>/dev/null)"
printf 'uid=%s\\n' "$(id -u 2>/dev/null)"
printf 'hostname=%s\\n' "$(uname -n 2>/dev/null)"
printf 'home=%s\\n' "$HOME"
printf 'os=%s\\n' "$(uname -s 2>/dev/null)"
printf 'machine=%s\\n' "$(uname -m 2>/dev/null)"
for key in /etc/ssh/ssh_host_*_key.pub; do
  kind= blob=
  test -f "$key" && test -r "$key" || continue
  { read -r kind blob rest || :; } < "$key"
  if test -n "$kind" && test -n "$blob"; then printf 'hostkey=%s %s\\n' "$kind" "$blob"; fi
done
tools=yes
for tool in tar awk; do command -v "$tool" >/dev/null 2>&1 || tools=no; done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || tools=no
printf 'tools=%s\\n' "$tools"
writable=no
for dir in "$root" "$HOME/.claudexor" "$HOME"; do
  if test -d "$dir"; then
    if test -w "$dir"; then writable=yes; fi
    break
  fi
done
printf 'writable=%s\\n' "$writable"
if test -e "$root/.install-lock" || test -L "$root/.install-lock"; then
  echo 'lock=present'
else
  echo 'lock=absent'
fi
if test -L "$root/current"; then
  target=$(readlink "$root/current" 2>/dev/null) || target=
  case "$target" in
    versions/*[!A-Za-z0-9._-]*|versions/|*..*) target= ;;
    versions/*) ;;
    *) target= ;;
  esac
  if test -z "$target"; then
    echo 'current=?'
  else
    printf 'current=%s\\n' "$target"
    dir="$root/$target"
    if test -d "$dir" && test ! -L "$dir"; then
      for kind in meta marker; do
        if test "$kind" = meta; then file="$dir/runtime.json" cap=4096; else file="$dir/.archive-sha256" cap=128; fi
        test -f "$file" && test ! -L "$file" || continue
        # A size or bytes that could not be read print ! for the file, never
        # nothing (no such file) or an empty line (an empty file).
        if ! size=$(wc -c < "$file") || ! test "$size" -ge 0 2>/dev/null; then printf '%s=!\\n' "$kind"; continue; fi
        test "$size" -le "$cap" || continue
        if bytes=$(od -An -v -tx1 < "$file") && hex=$(printf '%s' "$bytes" | tr -d ' \\n'); then
          printf '%s=%s\\n' "$kind" "$hex"
        else
          printf '%s=!\\n' "$kind"
        fi
      done
    fi
  fi
elif test -e "$root/current"; then
  echo 'current=!'
else
  echo 'current=-'
fi
echo 'claudexor-preflight-end'`;

/** POSIX single-quote encoding for the remote login shell (the SSH
 * remote-command protocol); the local side never invokes a shell. */
export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The runtime pointer one controller-side install activates: its version,
 * its archive digest and its own token, as INSTALL_SCRIPT names it. */
export function installPointer(version: string, archiveSha256: string, flow: string): string {
  return `versions/${version}-${archiveSha256}-${flow}`;
}

/** Why INSTALL_SCRIPT stopped before activating, as its refusal names it:
 * another install held the lock, `current` was not what the caller expected,
 * or any other step failed. */
export const INSTALL_REFUSALS = ["locked", "changed", "failed"] as const;
export type InstallRefusal = (typeof INSTALL_REFUSALS)[number];

/** The line INSTALL_SCRIPT prints once `remote activate` succeeded. */
export function activationReceipt(candidate: string): string {
  return JSON.stringify({ ok: true, activated: candidate });
}

/** The line INSTALL_SCRIPT prints when it stops before starting activation. */
export function refusalReceipt(candidate: string, reason: InstallRefusal): string {
  return JSON.stringify({ ok: false, activated: false, candidate, reason });
}

/** The server and OS account a confirmed preflight showed: `hostname`, `os`
 * and `machine` as `uname -n`, `-s` and `-m` print them. */
export interface ConfirmedRecipient {
  uid: number;
  user: string;
  home: string;
  hostname: string;
  os: string;
  machine: string;
}

/** What the writing step prints, with exit 77, when it does not run on the
 * confirmed server as the confirmed account; it has then read and written
 * nothing. */
export const RECIPIENT_MISMATCH = "claudexor-recipient-mismatch";

/** The writing step re-resolves the SSH destination and login, so it proves,
 * in its own shell and before anything else, that it runs as the confirmed
 * uid, user and home on the server with the confirmed hostname and platform;
 * `sh -c` keeps that check out of the login shell's own syntax. */
const RECIPIENT_GUARD =
  'test "$(id -u)" = "$1" && test "$(id -un)" = "$2" && test "$HOME" = "$3" && ' +
  'test "$(uname -n)" = "$4" && test "$(uname -s)" = "$5" && test "$(uname -m)" = "$6" || ' +
  `{ echo ${RECIPIENT_MISMATCH}; exit 77; }; shift 6; `;

function guarded(
  name: string,
  body: string,
  recipient: ConfirmedRecipient,
  args: string[],
): string {
  const { uid, user, home, hostname, os, machine } = recipient;
  const values = [String(uid), user, home, hostname, os, machine, ...args].map(posixQuote);
  return `sh -c ${posixQuote(RECIPIENT_GUARD + body)} ${name} ${values.join(" ")}`;
}

/** INSTALL_SCRIPT as `printf %b` turns it back, for a one-line command: each
 * byte a login shell would act on inside quotes or that would break the line
 * (backslash, newline, `!` and `'`) as an octal escape, every other byte as it
 * is. */
export const INSTALL_SCRIPT_ESCAPED = INSTALL_SCRIPT.replace(
  /[\\\n!']/g,
  (byte) => `\\0${byte.charCodeAt(0).toString(8).padStart(3, "0")}`,
);

/**
 * The one writing step of a first install (no previous pointer, so the
 * previous identity is `-`). After the recipient check, the step's shell turns
 * the fixed INSTALL_SCRIPT_ESCAPED its command carries back into INSTALL_SCRIPT
 * and replaces itself with it, given the checked arguments. It reads nothing,
 * so the script's input is exactly the signed archive, which the script owns
 * from its first byte. One line, so any login shell passes it to `sh -c`
 * intact.
 */
export function installCommand(
  recipient: ConfirmedRecipient,
  version: string,
  archiveSha256: string,
  flow: string,
): string {
  const body =
    `s=$(printf %b ${posixQuote(INSTALL_SCRIPT_ESCAPED)}) && test -n "$s" && ` +
    'exec sh -c "$s" claudexor-install "$@"; exit 1';
  const args = [version, archiveSha256, "-", "-", "-", flow];
  return guarded("claudexor-install", body, recipient, args);
}
