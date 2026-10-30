/** Installs and removes Ubuntu noble's packaged `bwrap-userns-restrict` AppArmor profile the
 * way its documentation tells an administrator to (copy it into /etc/apparmor.d, then
 * `apparmor_parser -r`), on a disposable runner only, for the Linux Codex app-server probe.
 *
 * Effects are injected so the order and the restore are testable without root:
 * `fileState(path)` -> {exists:false} | {exists:true, type, sha256, mode, uid, gid};
 * `readBytes(path)` -> Buffer; `saveBackup(bytes)` -> path of the kept copy;
 * `sudo(step, args)` -> {status, signal, error}; `loadedProfiles()` -> sorted
 * "name (mode)" lines of /sys/kernel/security/apparmor/profiles, or null.
 *
 * Decisions come from read-back state, never from a command's exit status, so `restore`
 * can run any number of times: it acts only on what still differs from the recorded start. */

/** The exact distro remedy: apparmor-profiles 4.0.1really4.0.1-0ubuntu0.24.04.9 (noble). The
 * file ships only in the package's extra-profiles, disabled by default. */
export const DISTRO_PROFILE = {
  package: "apparmor-profiles",
  version: "4.0.1really4.0.1-0ubuntu0.24.04.9",
  /** The archive pool, then Launchpad's permanent copy should a later SRU retire it. */
  debUrls: [
    "http://archive.ubuntu.com/ubuntu/pool/main/a/apparmor/apparmor-profiles_4.0.1really4.0.1-0ubuntu0.24.04.9_all.deb",
    "https://launchpad.net/ubuntu/+archive/primary/+files/apparmor-profiles_4.0.1really4.0.1-0ubuntu0.24.04.9_all.deb",
  ],
  debSha256: "90b02aa006eea7702cd4e851343e469e41365dda42145a3cb035de1d6c773b8c",
  member: "usr/share/apparmor/extra-profiles/bwrap-userns-restrict",
  sha256: "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9",
  installPath: "/etc/apparmor.d/bwrap-userns-restrict",
};

export const APPARMOR_PARSER = "/usr/sbin/apparmor_parser";
/** `-K` (--skip-cache): load into the kernel without writing a binary cache file, so the
 * only file the change leaves is the one it restores. */
const PARSER_FLAGS = ["-K"];

/** The profile names a profile file defines, e.g. ["bwrap", "unpriv_bwrap"]. */
export function profileNames(text) {
  return [...String(text).matchAll(/^\s*profile\s+([^\s{]+)/gm)].map((match) => match[1]);
}

export function loadedNamed(profiles, names) {
  return (profiles ?? []).filter((line) => names.some((name) => line.startsWith(`${name} (`)));
}

function sameFile(a, b) {
  if (!a?.exists || !b?.exists) return Boolean(a?.exists) === Boolean(b?.exists);
  return (
    a.type === b.type &&
    a.sha256 === b.sha256 &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
}

function octal(mode) {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** Copies the pinned file over `installPath` after keeping whatever was there, then loads it.
 * `persist(record)` stores the record `restore` needs before the first host change, so a
 * later, separate restore can still undo a run that died. Whether the change took effect is
 * the caller's kernel read-back, never this function's verdict. */
export function applyProfile({
  pinnedFile,
  installPath,
  fileState,
  readBytes,
  saveBackup,
  sudo,
  persist = () => {},
}) {
  const record = { installPath, before: fileState(installPath), backup: null, steps: [] };
  const run = (step, args) => {
    const result = sudo(step, args);
    record.steps.push({
      step,
      argv: ["sudo", ...args],
      status: result?.status ?? null,
      error: result?.error ?? null,
    });
    return result;
  };
  if (record.before.exists) {
    if (record.before.type !== "file") {
      record.refused = `${installPath} exists as a ${record.before.type}, not a regular file`;
      return record;
    }
    record.backup = saveBackup(readBytes(installPath));
  }
  persist(record);
  run("install-profile", [
    "-n",
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    pinnedFile,
    installPath,
  ]);
  run("load-profile", ["-n", APPARMOR_PARSER, ...PARSER_FLAGS, "-r", installPath]);
  return record;
}

/** Loads a profile file straight into the kernel without installing it anywhere, as
 * bdd217377a9f loaded its minimal control (`apparmor_parser -K -r FILE`). `persist(record)`
 * stores the restore record before the host changes. */
export function loadProfileFile({ profileFile, sudo, persist = () => {} }) {
  const record = { installPath: null, profileFile, before: null, backup: null, steps: [] };
  persist(record);
  const args = ["-n", APPARMOR_PARSER, ...PARSER_FLAGS, "-r", profileFile];
  const result = sudo("load-profile", args);
  record.steps.push({
    step: "load-profile",
    argv: ["sudo", ...args],
    status: result?.status ?? null,
    error: result?.error ?? null,
  });
  return record;
}

/** Brings the kernel and `installPath` back to the state `applied` recorded. Unloads the
 * pinned file's profiles while any is loaded (parsing the pinned copy, which always exists),
 * then removes or rewrites the installed file; a load-only record (`installPath: null`) has
 * no file to restore. Safe to repeat. */
export function restoreProfile({ applied, pinnedFile, names, fileState, sudo, loadedProfiles }) {
  const steps = [];
  const run = (step, args) => {
    const result = sudo(step, args);
    steps.push({
      step,
      argv: ["sudo", ...args],
      status: result?.status ?? null,
      error: result?.error ?? null,
    });
  };
  const { installPath, before, backup } = applied;
  // An unreadable list may still hold the profiles, so it is unloaded too (a repeat is harmless).
  const loaded = loadedProfiles();
  if (loaded === null || loadedNamed(loaded, names).length)
    run("unload-profile", ["-n", APPARMOR_PARSER, ...PARSER_FLAGS, "-R", pinnedFile]);
  const current = installPath ? fileState(installPath) : null;
  if (installPath && !sameFile(current, before)) {
    if (!before.exists) run("remove-profile-file", ["-n", "rm", "-f", "--", installPath]);
    else
      run("restore-profile-file", [
        "-n",
        "install",
        "-m",
        octal(before.mode),
        "-o",
        String(before.uid),
        "-g",
        String(before.gid),
        backup,
        installPath,
      ]);
  }
  const after = installPath ? fileState(installPath) : null;
  const profiles = loadedProfiles();
  const stillLoaded = loadedNamed(profiles, names);
  const gaps = [];
  if (installPath && !sameFile(after, before))
    gaps.push(`${installPath} does not match its recorded start`);
  if (profiles === null) gaps.push("the loaded AppArmor profile list is unreadable");
  if (stillLoaded.length) gaps.push(`still loaded: ${stillLoaded.join(", ")}`);
  return { steps, after, stillLoaded, restored: gaps.length === 0, gaps };
}
