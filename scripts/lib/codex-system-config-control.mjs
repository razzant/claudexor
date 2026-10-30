/** Installs and removes Codex's system config layer, /etc/codex/config.toml, on a disposable
 * runner only, for the Linux Codex app-server probe's daemon cells. Codex 0.162.1 loads that
 * layer below `${CODEX_HOME}/config.toml` (codex-rs/config/src/loader/mod.rs:80,127 at
 * rust-v0.162.1), so the fresh CODEX_HOME of Claudexor's api_key route, which holds only an
 * auth.json, picks the loopback provider from it. Nothing in Claudexor is changed or bypassed.
 *
 * Effects are injected so the order and the restore are testable without root:
 * `fileState(path)` -> {exists:false} | {exists:true, type, sha256, mode, uid, gid};
 * `sudo(step, args)` -> {status, signal, error}; `persist(record)` keeps the restore record.
 * Decisions come from read-back state, never from a command's exit status, so `restore` can
 * run any number of times. A host that already has a Codex system config is never touched. */

export const CODEX_SYSTEM_DIR = "/etc/codex";
export const CODEX_SYSTEM_CONFIG = "/etc/codex/config.toml";

function record(steps, sudo, step, args) {
  const result = sudo(step, args);
  steps.push({
    step,
    argv: ["sudo", ...args],
    status: result?.status ?? null,
    error: result?.error ?? null,
  });
}

/** Copies `configFile` to /etc/codex/config.toml as root:root 0644, creating /etc/codex when
 * absent. Refuses, changing nothing, when the config or a non-directory /etc/codex exists. */
export function applySystemConfig({ configFile, fileState, sudo, persist = () => {} }) {
  const applied = {
    path: CODEX_SYSTEM_CONFIG,
    before: fileState(CODEX_SYSTEM_CONFIG),
    dirBefore: fileState(CODEX_SYSTEM_DIR),
    steps: [],
  };
  if (applied.before.exists)
    applied.refused = `${CODEX_SYSTEM_CONFIG} already exists; a host's Codex config is never replaced`;
  else if (applied.dirBefore.exists && applied.dirBefore.type !== "directory")
    applied.refused = `${CODEX_SYSTEM_DIR} exists as a ${applied.dirBefore.type}`;
  if (applied.refused) return applied;
  persist(applied);
  record(applied.steps, sudo, "install-codex-system-config", [
    "-n",
    "install",
    "-D",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    configFile,
    CODEX_SYSTEM_CONFIG,
  ]);
  applied.after = fileState(CODEX_SYSTEM_CONFIG);
  return applied;
}

/** Whether the installed file is exactly `sha256` as root:root 0644. */
export function systemConfigInstalled(state, sha256) {
  return (
    state?.exists === true &&
    state.type === "file" &&
    state.sha256 === sha256 &&
    state.mode === 0o644 &&
    state.uid === 0 &&
    state.gid === 0
  );
}

/** Removes what `applied` added: the file, then /etc/codex when it did not exist before. */
export function restoreSystemConfig({ applied, fileState, sudo }) {
  const steps = [];
  if (!applied || applied.refused) return { steps, restored: true, gaps: [] };
  if (fileState(CODEX_SYSTEM_CONFIG).exists)
    record(steps, sudo, "remove-codex-system-config", [
      "-n",
      "rm",
      "-f",
      "--",
      CODEX_SYSTEM_CONFIG,
    ]);
  if (!applied.dirBefore.exists && fileState(CODEX_SYSTEM_DIR).exists)
    record(steps, sudo, "remove-codex-system-dir", ["-n", "rmdir", "--", CODEX_SYSTEM_DIR]);
  const after = fileState(CODEX_SYSTEM_CONFIG);
  const dirAfter = fileState(CODEX_SYSTEM_DIR);
  const gaps = [];
  if (after.exists) gaps.push(`${CODEX_SYSTEM_CONFIG} still exists`);
  if (Boolean(dirAfter.exists) !== Boolean(applied.dirBefore.exists))
    gaps.push(`${CODEX_SYSTEM_DIR} does not match its recorded start`);
  return { steps, after, dirAfter, restored: gaps.length === 0, gaps };
}
