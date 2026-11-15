/**
 * #672 QA hooks. Platform-neutral and free of vendor programs so selftest.mjs
 * can exercise them deterministically.
 *
 * Two seams, both passive until they matter:
 * - the product's existing `options.spawn` seam (MaintenanceOptions) records
 *   every spawn in memory and, in arm B only, gives the Copilot `--version`
 *   probe the program's declared childUpdateArgs;
 * - a pass-through `fs.renameSync`. It calls the real function first. Only when
 *   that real call throws for a watched rename does it capture the error and
 *   the clock, run the post-failure observer, and rethrow the SAME error
 *   object. Success adds one in-memory timestamp and no I/O.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);

/** Copilot version probes as the product builds them: the npm copy runs as
 * `node <...>\@github\copilot\npm-loader.js --version`, the vendor copy as
 * `<...>\copilot.exe --version`. Installer and `update` commands do not match. */
export function copilotProbe(binary, args) {
  if (!Array.isArray(args) || args.at(-1) !== "--version") return null;
  const loader = args.find((a) => /[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/i.test(String(a)));
  if (loader) return { kind: "npm-copy", entry: loader };
  if (/[\\/]copilot(\.exe)?$/i.test(String(binary)) && args.length === 1)
    return { kind: "native", entry: String(binary) };
  return null;
}

/** Arm B inserts the declared flags immediately before the final `--version`;
 * every other invocation, and every arm-A invocation, keeps its exact argv. */
export function adaptArgs(arm, binary, args, childUpdateArgs) {
  const probe = copilotProbe(binary, args);
  if (arm !== "B" || !probe) return { args, probe, adapted: false };
  return {
    args: [...args.slice(0, -1), ...childUpdateArgs, "--version"],
    probe,
    adapted: true,
  };
}

/** A recorder around the real spawnSync. Records stay in memory until the
 * caller flushes them after the iteration; no file I/O inside the race window. */
export function makeSpawnSeam({ arm, realSpawn, childUpdateArgs, now = () => performance.now() }) {
  const calls = [];
  function seam(binary, args, options) {
    const { args: effective, probe, adapted } = adaptArgs(arm, binary, args, childUpdateArgs);
    const startedMs = now();
    const result = realSpawn(binary, effective, options);
    const endedMs = now();
    calls.push({
      seq: calls.length + 1,
      binary,
      builtArgs: args,
      effectiveArgs: effective,
      adapted,
      probe: probe?.kind ?? null,
      cwd: options?.cwd ?? null,
      envKeys: options?.env ? Object.keys(options.env).sort() : null,
      env: options?.env ? pickEnv(options.env) : null,
      startedMs,
      endedMs,
      pid: result?.pid ?? null,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      error: result?.error ? { code: result.error.code ?? null, message: String(result.error.message) } : null,
      stdout: result?.stdout == null ? null : String(result.stdout),
      stderr: result?.stderr == null ? null : String(result.stderr),
    });
    return result;
  }
  return { seam, calls };
}

/** Variables that can change Copilot's update or cache behaviour, recorded by
 * value; everything else only by name. */
export function pickEnv(env) {
  const keep = /^(CI|GITHUB_ACTIONS|COPILOT_.*|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|XDG_.*|NODE_OPTIONS|PATH)$/i;
  return Object.fromEntries(Object.entries(env).filter(([k]) => keep.test(k)));
}

/**
 * Wrap fs.renameSync for every importer of node:fs, including ESM named
 * imports, through syncBuiltinESMExports. `isTarget(from, to)` selects the
 * watched renames; `onFailure(event)` runs only after the real call threw.
 */
export function installRenameObserver({ isTarget, onFailure, now = () => performance.now() }) {
  const fs = require("node:fs");
  const real = fs.renameSync;
  const state = { successes: [], failures: [], observerErrors: [] };
  function renameSync(from, to) {
    let watched = false;
    try {
      const value = real(from, to);
      if (isTarget(String(from), String(to)))
        state.successes.push({ from: String(from), to: String(to), atMs: now() });
      return value;
    } catch (error) {
      const atMs = now();
      watched = isTarget(String(from), String(to));
      if (!watched) throw error;
      const event = {
        from: String(from),
        to: String(to),
        atMs,
        error: {
          code: error?.code ?? null,
          errno: error?.errno ?? null,
          syscall: error?.syscall ?? null,
          path: error?.path ?? null,
          dest: error?.dest ?? null,
          message: String(error?.message ?? error),
        },
        failureOrdinal: state.failures.length + 1,
      };
      state.failures.push(event);
      try {
        event.observation = onFailure(event);
      } catch (observerError) {
        state.observerErrors.push(String(observerError?.stack ?? observerError));
      }
      throw error;
    }
  }
  fs.renameSync = renameSync;
  syncBuiltinESMExports();
  return {
    state,
    real,
    uninstall() {
      fs.renameSync = real;
      syncBuiltinESMExports();
    },
  };
}

/** Bounded preview beside full bytes kept elsewhere. */
export function preview(text, n = 400) {
  if (text == null) return null;
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s;
}

/** First line of a version answer, as the product records it. */
export function firstLine(text) {
  return text == null ? null : String(text).trim().split(/\r?\n/)[0]?.slice(0, 256) ?? null;
}
