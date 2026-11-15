/**
 * #672 TEST-ONLY failure capture for the Windows Copilot npm->native conversion.
 *
 * This is NOT product code. It is attached with `node --require` to the CLI
 * child that `scripts/vendor-program-smoke.mjs` already spawns, so the capture
 * lives inside the exact process that performs the conversion — never through
 * NODE_OPTIONS (vendor child processes inherit that, and must stay untouched).
 *
 * What it does, and only this:
 *   - wraps `fs.renameSync` pass-through (calls the real function first);
 *   - the ONLY rename it watches is the product's known Copilot npm hide,
 *     `...\node_modules\@github\copilot` -> same path + `.claudexor-converted`
 *     (`packages/cli/src/harness-npm-conversion.ts` via
 *     `packages/core/src/hidden-program-paths.ts`). Every other rename, and a
 *     watched rename that SUCCEEDS, passes straight through: no observers, no
 *     files, nothing written;
 *   - only AFTER the first watched rename THROWS does it FIRST persist the exact
 *     error and clock, THEN run the already-prepared read-only observers
 *     (Restart Manager, a scoped process census, and a signed-then-hashed
 *     Sysinternals handle64) under a single finite diagnostic budget, update the
 *     same record with their raw output and any gaps, and re-throw the SAME
 *     error object. Writing the event first means a killed or timed-out observer
 *     cannot lose it. An observer failure is a recorded gap, never a substitute
 *     for the product error. No second rename, sleep, retry, kill, force-delete
 *     or workaround is attempted.
 *
 * Hook setup is in-memory and reads no disk (the tools manifest is read only at
 * failure time), so the product's conversion sequence up to the first rename is
 * unchanged. Nothing is written to stdout, so the CLI's JSON receipt stays
 * intact.
 *
 * Live mode auto-installs only when `C672_CAPTURE_DIR` is set (the CI prep step
 * and the smoke set it together). Observers come from `C672_CAPTURE_TOOLS`. With
 * tools missing the capture still persists the failure and its gaps and still
 * re-throws.
 */
"use strict";
const { spawnSync } = require("node:child_process");
const {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");

const HIDE_SUFFIX = ".claudexor-converted";
// One finite budget shared by all post-failure observers, so a hung observer
// cannot stall the product return indefinitely.
const DIAGNOSTIC_BUDGET_MS = 120_000;

/** The product's Copilot npm hide, and nothing else: the destination is exactly
 * the source plus the conversion suffix, and the source is the
 * `node_modules/@github/copilot` package directory (either path separator,
 * case-insensitively as Windows compares). Arbitrary rename failures never
 * match. */
function matchesCopilotHide(from, to) {
  const f = String(from);
  const t = String(to);
  if (t.toLowerCase() !== (f + HIDE_SUFFIX).toLowerCase()) return false;
  return /[\\/]node_modules[\\/]@github[\\/]copilot$/i.test(f);
}

/** Windows process-creation time filter for the census: processes created at or
 * after `epochMs` minus one second (creation times are tick-granular). */
function sinceArg(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const filetime = (BigInt(Math.floor(epochMs) - 1000) + 11644473600000n) * 10000n;
  return `--since=${filetime}`;
}

function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Pass-through wrapper around one fs object's `renameSync`. The real call runs
 * first; only a throw of the watched rename invokes `onFailure`, and the error
 * it threw is always the error the caller receives. `onFailure` is run once. */
function installRenameCapture({
  fs,
  matches = matchesCopilotHide,
  onFailure,
  recordObserverError,
  now = () => performance.now(),
  syncBuiltinESMExports,
}) {
  const real = fs.renameSync;
  let fired = false;
  function renameSync(from, to) {
    try {
      return real.call(fs, from, to);
    } catch (error) {
      if (fired || !matches(String(from), String(to))) throw error;
      fired = true;
      const atMs = now();
      try {
        onFailure({
          from: String(from),
          to: String(to),
          atMs,
          atEpochMs: performance.timeOrigin + atMs,
          error,
        });
      } catch (observerError) {
        try {
          recordObserverError && recordObserverError(observerError);
        } catch {
          /* recording must never mask the product error */
        }
      }
      throw error;
    }
  }
  fs.renameSync = renameSync;
  if (syncBuiltinESMExports) syncBuiltinESMExports();
  return {
    uninstall() {
      fs.renameSync = real;
      if (syncBuiltinESMExports) syncBuiltinESMExports();
    },
    get fired() {
      return fired;
    },
  };
}

/* ----- live observer runner (Windows only; synchronous; bounded) ----- */

function loadTools(toolsPath) {
  if (!toolsPath) return { helper: null, handle: null, gaps: ["C672_CAPTURE_TOOLS not set"] };
  try {
    const tools = JSON.parse(readFileSync(toolsPath, "utf8"));
    return {
      helper: tools.helper ?? null,
      handle: tools.handle ?? null,
      gaps: Array.isArray(tools.gaps) ? [...tools.gaps] : [],
    };
  } catch (error) {
    return {
      helper: null,
      handle: null,
      gaps: [`tools manifest unreadable: ${error && error.code ? error.code : String(error)}`],
    };
  }
}

/** Bounded traversal that keeps its own read gaps rather than treating an
 * unreadable directory as empty. Bounds on depth AND file count. */
function filesBelow(root, { limit = 600, maxDepth = 64, maxGaps = 50 } = {}) {
  const files = [];
  const gaps = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      if (gaps.length < maxGaps) gaps.push({ path: dir, reason: "max-depth" });
      return;
    }
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (gaps.length < maxGaps)
        gaps.push({ path: dir, reason: `readdir:${error && error.code ? error.code : error}` });
      return;
    }
    for (const name of names) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (gaps.length < maxGaps)
          gaps.push({ path, reason: `lstat:${error && error.code ? error.code : error}` });
        continue;
      }
      if (stat.isDirectory()) walk(path, depth + 1);
      else files.push(path);
    }
  };
  walk(root, 0);
  return { files, gaps, truncated };
}

/** Spawn an observer within whatever remains of the shared diagnostic budget. */
function runObserver(binary, args, deadlineMs, perCapMs = 60_000) {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0)
    return { skipped: "diagnostic budget exhausted", status: null, ms: 0, stdout: "", stderr: "" };
  const started = performance.now();
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: Math.min(remaining, perCapMs),
    windowsHide: true,
    maxBuffer: 16 << 20,
  });
  return {
    binary,
    args,
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.code ?? result.error.message ?? result.error) : null,
    ms: Math.round(performance.now() - started),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Persist the failure FIRST, then observe, then update. One record, no ledger. */
function observeAndRecord(event, config) {
  const { captureDir, toolsPath, sinceEpochMs } = config;
  const dir = join(captureDir, `capture-${process.pid}-${Date.now()}`);
  mkdirSync(join(dir, "raw"), { recursive: true });
  const recordPath = join(dir, "capture.json");
  let seq = 0;
  const raw = (label, text) => {
    const name = `raw/${String(++seq).padStart(3, "0")}-${String(label).replace(/[^a-z0-9.-]+/gi, "_")}.txt`;
    writeFileSync(join(dir, name), text ?? "");
    return {
      file: name,
      bytes: Buffer.byteLength(text ?? ""),
      sha256: createHash("sha256")
        .update(text ?? "")
        .digest("hex"),
    };
  };

  const record = {
    kind: "c672-rename-failure-capture",
    status: "event-recorded-observers-pending",
    pid: process.pid,
    cwd: safe(() => process.cwd()),
    from: event.from,
    to: event.to,
    atEpochMs: event.atEpochMs,
    error: {
      code: safe(() => event.error.code) ?? null,
      errno: safe(() => event.error.errno) ?? null,
      syscall: safe(() => event.error.syscall) ?? null,
      path: safe(() => event.error.path) ?? null,
      dest: safe(() => event.error.dest) ?? null,
      message: String((event.error && event.error.message) || event.error),
    },
    gaps: [],
    observers: {},
    reading:
      "Each observer is a later, bounded look. An empty list does not prove that no holder existed at the instant of failure.",
  };
  // ORIGINAL EVENT ON DISK BEFORE ANY OBSERVER RUNS.
  writeFileSync(recordPath, JSON.stringify(record, null, 1));

  const tools = loadTools(toolsPath);
  record.tools = { helper: tools.helper, handle: tools.handle };
  record.gaps.push(...tools.gaps);
  const deadline = Date.now() + DIAGNOSTIC_BUDGET_MS;
  const root = event.from;

  if (tools.helper && tools.helper.path) {
    try {
      if (sha256File(tools.helper.path) !== tools.helper.sha256)
        throw new Error("helper sha256 changed since prep");
      const listed = filesBelow(root);
      for (const gap of listed.gaps) record.gaps.push(`file list: ${gap.reason} at ${gap.path}`);
      if (listed.truncated) record.gaps.push("Restart Manager file list truncated at the bound");
      const list = join(dir, "rm-files.txt");
      writeFileSync(list, listed.files.join("\r\n"), "utf8");
      const rm = runObserver(tools.helper.path, ["rm", `@${list}`], deadline);
      record.observers.restartManager = rm.skipped
        ? { skipped: rm.skipped }
        : {
            status: rm.status,
            ms: rm.ms,
            error: rm.error,
            registeredFiles: listed.files.length,
            stdout: raw("rm", rm.stdout),
            stderr: rm.stderr || null,
          };
      const since = sinceArg(sinceEpochMs);
      const ps = runObserver(tools.helper.path, ["ps", ...(since ? [since] : []), root], deadline);
      record.observers.census = ps.skipped
        ? { skipped: ps.skipped }
        : {
            status: ps.status,
            ms: ps.ms,
            error: ps.error,
            stdout: raw("ps", ps.stdout),
            stderr: ps.stderr || null,
          };
    } catch (error) {
      record.gaps.push(
        `helper observers unavailable: ${error && error.message ? error.message : String(error)}`,
      );
    }
  } else {
    record.gaps.push("Restart Manager and process census unavailable (helper not prepared)");
  }

  if (tools.handle && tools.handle.path) {
    try {
      if (sha256File(tools.handle.path) !== tools.handle.sha256)
        throw new Error("handle64 sha256 changed since prep");
      const handle = runObserver(
        tools.handle.path,
        ["-accepteula", "-nobanner", "-u", root],
        deadline,
      );
      record.observers.handle64 = handle.skipped
        ? { skipped: handle.skipped }
        : {
            status: handle.status,
            ms: handle.ms,
            error: handle.error,
            signer: tools.handle.signer ?? null,
            stdout: raw("handle64", handle.stdout),
            stderr: handle.stderr || null,
          };
    } catch (error) {
      record.gaps.push(
        `handle64 unavailable: ${error && error.message ? error.message : String(error)}`,
      );
    }
  } else {
    record.gaps.push(
      "handle64 unavailable (not prepared or not Microsoft-signed): directory handles cannot be named",
    );
  }

  record.status = "complete";
  writeFileSync(recordPath, JSON.stringify(record, null, 1));
  // Best-effort stderr marker; refused smoke calls can discard stderr.
  // The uploaded capture artifact is the evidence; stdout stays the CLI receipt.
  try {
    process.stderr.write(`C672_RENAME_CAPTURE ${recordPath}\n`);
  } catch {
    /* ignore */
  }
  return dir;
}

/** Live installation: patch node:fs for every importer (including the product's
 * ESM `import { renameSync }`) and route a watched failure to the observers. No
 * disk is read here; the tools manifest is read in observeAndRecord. */
function installLiveCapture() {
  const fs = require("node:fs");
  const mod = require("node:module");
  const captureDir = process.env.C672_CAPTURE_DIR;
  const config = {
    captureDir,
    toolsPath: process.env.C672_CAPTURE_TOOLS,
    sinceEpochMs: Date.now(),
  };
  const gapLog = join(captureDir, `observer-errors-${process.pid}.log`);
  return installRenameCapture({
    fs,
    onFailure: (event) => observeAndRecord(event, config),
    recordObserverError: (error) => {
      try {
        mkdirSync(captureDir, { recursive: true });
        appendFileSync(
          gapLog,
          `${new Date().toISOString()} ${String(error && error.stack ? error.stack : error)}\n`,
        );
      } catch {
        /* never mask the product error */
      }
    },
    syncBuiltinESMExports: () => mod.syncBuiltinESMExports(),
  });
}

// Auto-install only in live mode. Required as a bare preload with the env unset
// (any ordinary test import) it installs nothing and spawns nothing.
if (process.env.C672_CAPTURE_DIR) {
  try {
    installLiveCapture();
  } catch (error) {
    try {
      process.stderr.write(
        `C672_RENAME_CAPTURE_SETUP_FAILED ${String(error && error.message ? error.message : error)}\n`,
      );
    } catch {
      /* the product run must continue regardless */
    }
  }
}

module.exports = {
  HIDE_SUFFIX,
  DIAGNOSTIC_BUDGET_MS,
  matchesCopilotHide,
  sinceArg,
  installRenameCapture,
  loadTools,
  filesBelow,
};
