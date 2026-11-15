/** Evidence writing shared by the #672 QA scripts: JSONL records, full raw
 * bytes beside bounded previews, file manifests and hashes. */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { preview } from "./hooks.mjs";

export function sha256Text(text) {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex");
}

/** Chunked read so a 195 MB executable is hashed without holding it in memory. */
export function sha256File(path) {
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

export function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Every entry below `dir`: size, mtime and SHA-256 (files up to `hashMax`
 * bytes, or all when hashMax is Infinity). Bounded and never silent. */
export function manifest(dir, { limit = 2000, hashMax = Infinity } = {}) {
  const rows = [];
  let truncated = false;
  const errors = [];
  let root;
  try {
    root = lstatSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { dir, exists: false, rows, truncated, errors };
    return {
      dir,
      exists: null,
      rows,
      truncated,
      errors: [{ path: ".", code: error.code ?? String(error) }],
    };
  }
  if (!root.isDirectory())
    return { dir, exists: true, rows, truncated, errors: [{ path: ".", code: "not-directory" }] };
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d).sort();
    } catch (error) {
      errors.push({ path: relative(dir, d), code: error.code ?? String(error) });
      return;
    }
    for (const name of names) {
      if (rows.length >= limit) {
        truncated = true;
        return;
      }
      const p = join(d, name);
      let s;
      try {
        s = lstatSync(p);
      } catch (error) {
        errors.push({ path: relative(dir, p), code: error.code ?? String(error) });
        continue;
      }
      if (s.isDirectory()) {
        rows.push({ path: relative(dir, p), dir: true });
        walk(p);
      } else if (s.isSymbolicLink()) {
        try {
          rows.push({ path: relative(dir, p), symlink: true, target: readlinkSync(p) });
        } catch (error) {
          errors.push({ path: relative(dir, p), code: error.code ?? String(error) });
        }
      } else {
        let sha256 = null;
        if (s.size <= hashMax)
          try {
            sha256 = sha256File(p);
          } catch (error) {
            sha256 = `unreadable:${error.code ?? error}`;
          }
        rows.push({ path: relative(dir, p), size: s.size, mtimeMs: s.mtimeMs, sha256 });
      }
    }
  };
  walk(dir);
  return { dir, exists: true, rows, truncated, errors };
}

/** The S0 snapshot and every restore. Symlink targets are copied verbatim:
 * without this, cpSync rewrites a relative link into an absolute one pointing
 * into the source tree, and the manifest comparison fails on a faithful copy. */
export function copyTree(from, to) {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

/** A partial inventory cannot establish equality. Retain coverage gaps even
 * when a visible difference already proves inequality. */
export function manifestDiff(before, after) {
  const gaps = [];
  for (const [side, m] of [
    ["before", before],
    ["after", after],
  ]) {
    if (!m || typeof m.exists !== "boolean" || !Array.isArray(m.rows) || !Array.isArray(m.errors)) {
      gaps.push({ side, reason: "missing-or-malformed-manifest" });
      continue;
    }
    if (m.truncated) gaps.push({ side, reason: "truncated" });
    for (const error of m.errors) gaps.push({ side, reason: "read-error", ...error });
    for (const r of m.rows) {
      if (
        (!r.dir && !r.symlink && !/^[a-f0-9]{64}$/.test(r.sha256 ?? "")) ||
        (r.symlink && typeof r.target !== "string")
      )
        gaps.push({ side, path: r.path, reason: "unhashed-or-unreadable" });
    }
  }
  const a = new Map((before?.rows ?? []).map((r) => [r.path, r]));
  const b = new Map((after?.rows ?? []).map((r) => [r.path, r]));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter(
    (k) =>
      a.has(k) &&
      ["dir", "symlink", "target", "size", "sha256"].some((f) => a.get(k)[f] !== b.get(k)[f]),
  );
  const existenceChanged =
    typeof before?.exists === "boolean" &&
    typeof after?.exists === "boolean" &&
    before.exists !== after.exists;
  const differs = existenceChanged || added.length > 0 || removed.length > 0 || changed.length > 0;
  return {
    added,
    removed,
    changed,
    existenceChanged,
    gaps,
    complete: !gaps.length,
    equal: differs ? false : gaps.length ? null : true,
  };
}

/** Hygiene covers readable images under the supplied roots and Toolhelp names
 * containing Copilot. Nonmatching names with unreadable paths remain explicit
 * coverage gaps; they cannot establish universal absence under those roots.
 * PID 0 never yields an image path, so no census covers every process: only
 * the scoped count is reported. `recent` lists processes the same enumeration
 * found created at or after `since` (helper's own rows excluded), up to 64. */
export function parseCensus(command, text) {
  const scope = "readable-root-images-or-toolhelp-copilot-names";
  const unknown = (reason, parsed = null) => ({
    scope,
    known: false,
    matches: null,
    count: null,
    reason,
    parsed,
  });
  if (!command || command.status !== 0 || command.error || command.signal)
    return unknown("census-command-failed");
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return unknown("census-json-invalid");
  }
  if (
    !p ||
    p.mode !== "ps" ||
    p.error ||
    !Array.isArray(p.matches) ||
    !Number.isInteger(p.total) ||
    p.total < 0 ||
    !Number.isInteger(p.imageUnreadable) ||
    p.imageUnreadable < 0 ||
    p.imageUnreadable > p.total ||
    !Array.isArray(p.unreadableImages) ||
    p.unreadableImages.length !== p.imageUnreadable ||
    p.unreadableImages.some(
      (r) =>
        !r ||
        !Number.isInteger(r.pid) ||
        r.pid < 0 ||
        (r.exe !== null && typeof r.exe !== "string") ||
        !Number.isInteger(r.error),
    ) ||
    p.matches.some(
      (r) =>
        !r ||
        !Number.isInteger(r.pid) ||
        r.pid <= 0 ||
        typeof r.exe !== "string" ||
        (r.image !== null && typeof r.image !== "string") ||
        typeof r.belowRoot !== "boolean" ||
        (!r.belowRoot && !/copilot/i.test(r.exe)),
    ) ||
    p.matches.length > p.total ||
    (p.recent !== undefined &&
      (!Array.isArray(p.recent) ||
        !Number.isInteger(p.recentTotal) ||
        p.recentTotal < p.recent.length ||
        !Number.isFinite(p.since) ||
        p.recent.some(
          (r) =>
            !r ||
            !Number.isInteger(r.pid) ||
            r.pid <= 0 ||
            !Number.isInteger(r.ppid) ||
            r.ppid < 0 ||
            typeof r.exe !== "string" ||
            (r.image !== null && typeof r.image !== "string") ||
            !Number.isFinite(r.created) ||
            r.created < p.since,
        )))
  )
    return unknown("census-shape-invalid", p);
  if (
    p.matches.some((r) => r.image === null) ||
    p.unreadableImages.some((r) => !r.exe?.trim() || /copilot/i.test(r.exe))
  )
    return unknown("census-relevant-or-unnamed-image-unreadable", p);
  return {
    scope,
    known: true,
    matches: p.matches,
    count: p.matches.length,
    imageUnreadable: p.imageUnreadable,
    unreadableImages: p.unreadableImages,
    recent: p.recent ?? null,
    recentTotal: p.recentTotal ?? null,
    reason: null,
  };
}

export function requireEmptyCensus(census) {
  if (!census?.known)
    throw Object.assign(new Error(`census unknown: ${census?.reason ?? "missing"}`), {
      incomplete: true,
    });
  if (census.count !== 0)
    throw Object.assign(
      new Error("the census still matches processes in its scope; nothing was stopped"),
      { incomplete: true },
    );
}

/** Bounded settling before S0 and before every iteration. `read` records each
 * look; the first look is returned beside the last. Nothing is stopped and no
 * product call is repeated. An unknown census ends the wait and stays unknown. */
export async function settleCensus(
  read,
  {
    timeoutMs = 60_000,
    intervalMs = 2_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = {},
) {
  const first = read();
  let last = first;
  let looks = 1;
  const until = now() + timeoutMs;
  while (last?.known && last.count > 0 && now() < until) {
    await sleep(intervalMs);
    last = read();
    looks++;
  }
  return { first, last, looks };
}

export function requireEqualManifest(diff, label) {
  if (diff?.equal !== true || diff?.complete !== true)
    throw Object.assign(new Error(`${label} differs or is incompletely observed`), {
      incomplete: true,
    });
}

/** Shared by the batch and offline controls. A file on disk is not a receipt,
 * and a receipt is not a conversion: the product can refuse before its hiding
 * rename (conversion_verification_failed, conversion_older_program,
 * conversion_source_changed). Only a rename the observer saw, successful or
 * failed (boolean firstHideOk), counts as an attempted hide. */
export function summarizeIteration(result, child) {
  const attempted = result?.conversionAttempted === true;
  const receipt =
    attempted && result?.receipt && typeof result.receipt.ok === "boolean" ? result.receipt : null;
  const complete =
    !!receipt && !result.thrown && child?.status === 0 && !child.error && !child.signal;
  const firstHideOk = result?.timing?.firstHideOk;
  const seen = firstHideOk ? result?.hide?.successes : result?.hide?.failures;
  const hideAttempted = typeof firstHideOk === "boolean" && Array.isArray(seen) && seen.length > 0;
  return {
    attempted,
    precondition: result?.thrown?.precondition === true,
    complete,
    hideAttempted,
    receipt,
    ok: receipt?.ok ?? null,
    thrown: result?.thrown ?? null,
    hideFailures: Array.isArray(result?.hide?.failures) ? result.hide.failures : [],
    timing: result?.timing ?? null,
    answers: result?.answers ?? null,
  };
}

/** Counts stay separate: inspect preconditions that stopped before Update,
 * Update calls, real receipts (ok true or false), and receipts whose product
 * attempted the hiding rename. Only the last is the per-arm denominator. */
export function aggregateArm(rows, arm) {
  const selected = rows.filter((r) => r.arm === arm);
  const receipts = selected.filter((r) => r.result?.complete);
  const hides = receipts.filter((r) => r.result.hideAttempted);
  return {
    iterations: selected.length,
    preconditionFailures: selected.filter((r) => r.result?.precondition).length,
    updateCalls: selected.filter((r) => r.result?.attempted).length,
    receiptCount: receipts.length,
    hideAttempts: hides.length,
    receiptsWithoutRename: receipts
      .filter((r) => !r.result.hideAttempted)
      .map((r) => ({
        i: r.i,
        ok: r.result.ok,
        problem: r.result.receipt?.problem?.code ?? null,
      })),
    incomplete: selected
      .filter((r) => !r.result?.complete)
      .map((r) => ({
        i: r.i,
        precondition: r.result?.precondition ?? null,
        thrown: r.result?.thrown ?? null,
        error: r.resultError ?? r.error ?? null,
      })),
    receipts: receipts.map((r) => ({
      i: r.i,
      hideAttempted: r.result.hideAttempted,
      receipt: r.result.receipt,
    })),
    hideFailures: hides
      .filter((r) => r.result.hideFailures.length)
      .map((r) => ({ i: r.i, codes: r.result.hideFailures.map((f) => f.error?.code ?? null) })),
    npmCopyAnswers: selected.map((r) => ({
      i: r.i,
      versions: r.result?.answers?.npmCopy?.map((a) => a.version) ?? null,
    })),
    observedMatchingProcessesAfter: selected.map((r) => r.postCensus?.count ?? null),
    processCountScope:
      "readable-root-images-or-toolhelp-copilot-names; not open handles, modules or current directories",
    processImageGapsAfter: selected.map(
      (r) => r.postCensus?.unreadableImages ?? r.postCensus?.parsed?.unreadableImages ?? null,
    ),
    recentProcessesAfter: selected.map((r) =>
      r.postCensus?.known ? { listed: r.postCensus.recent, total: r.postCensus.recentTotal } : null,
    ),
    cacheChanged: selected.map((r) =>
      typeof r.dotCopilotChange?.equal === "boolean" ? !r.dotCopilotChange.equal : null,
    ),
    gapLastNpmProbeToHideMs: hides.map((r) => ({
      i: r.i,
      ms: r.result.timing?.gapLastNpmProbeToHideMs ?? null,
    })),
  };
}

export function batchComplete(rows, order) {
  return (
    rows.length === order.length &&
    rows.every(
      (r, n) =>
        r.i === n + 1 &&
        r.arm === order[n] &&
        r.result?.complete === true &&
        r.result?.hideAttempted === true,
    )
  );
}

/** Paired comparability of the fixed batch: every predetermined iteration
 * returned a receipt whose product attempted the hiding rename, and npm
 * `latest` (the auto-update target) read once more after the batch still
 * equals the value read before setup. */
export function batchVerdict(rows, order, { latestBefore, latestAfter }) {
  const reasons = [];
  if (!batchComplete(rows, order)) {
    const short = order
      .map((arm, n) => ({ i: n + 1, arm, r: rows[n] }))
      .filter(
        ({ i, arm, r }) =>
          !(r?.i === i && r.arm === arm && r.result?.complete && r.result?.hideAttempted),
      )
      .map(({ i }) => i);
    reasons.push(
      `iterations without a receipt and an attempted hiding rename: ${short.join(",") || "extra rows"}`,
    );
  }
  if (typeof latestBefore !== "string" || !latestBefore)
    reasons.push("npm latest before the batch is unknown");
  if (typeof latestAfter !== "string" || !latestAfter)
    reasons.push("npm latest could not be read again after the batch");
  else if (latestAfter !== latestBefore)
    reasons.push(`npm latest changed during the batch: ${latestBefore} -> ${latestAfter}`);
  return { comparable: !reasons.length, reasons };
}

/** The first version token of an answer, read as the product reads it
 * (packages/core/src/selected-program.ts, withVersion); null when absent. */
export function versionOf(line) {
  return (
    String(line ?? "").match(
      /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$|[.,;:!?)](?![0-9A-Za-z]))/,
    )?.[1] ?? null
  );
}

/** A command ran to its own exit 0: no spawn error, timeout or signal. */
export function ranCleanly(run) {
  return !!run && run.status === 0 && !run.error && !run.signal;
}

/** A vendor answer qualifies a version only when it ran cleanly and its first
 * line carries exactly that version. */
export function answerReports(answer, version) {
  return ranCleanly(answer) && versionOf(answer.version) === version;
}

const sameWindowsPath = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** The batch's vendor baseline from evidence actually obtained: winget's own
 * exit, the installed copilot.exe hash, its answer to `--no-auto-update
 * --version` before and after the product's Update, that Update's receipt and
 * selected program, and unchanged executable bytes across it. The winget
 * manifest's MSI SHA-256 is provenance, not the installed executable's hash,
 * and is not compared here. */
export function qualifyVendorSetup({
  version,
  vendorExe,
  install,
  hashes,
  answersBefore,
  update,
  receipt,
  answersAfter,
}) {
  const reasons = [];
  const installed = hashes?.afterInstall;
  if (!ranCleanly(install)) reasons.push("winget install did not exit 0");
  if (!/^[a-f0-9]{64}$/.test(installed ?? ""))
    reasons.push("the installed copilot.exe was not hashed");
  if (!answerReports(answersBefore?.[0], version))
    reasons.push(`the installed copy did not answer ${version} to --no-auto-update --version`);
  if (hashes?.beforeUpdate !== installed)
    reasons.push("the vendor copilot.exe bytes changed during the version questions");
  if (!ranCleanly(update)) reasons.push("the product's Update of the vendor copy did not exit 0");
  if (receipt?.ok !== true || !["changed", "not_changed"].includes(receipt?.outcome))
    reasons.push("the product's Update receipt is not a verified success");
  else if (receipt.after?.version !== version)
    reasons.push(`the product's Update selected ${receipt.after?.version ?? "no version"}`);
  if (![receipt?.after?.realPath, receipt?.after?.path].some((p) => sameWindowsPath(p, vendorExe)))
    reasons.push("the product's Update did not select the hashed vendor copy");
  if (hashes?.afterUpdate !== installed)
    reasons.push("the vendor copilot.exe bytes changed across the product's Update");
  if (!answerReports(answersAfter?.[0], version))
    reasons.push(`after Update the copy did not answer ${version} to --no-auto-update --version`);
  return {
    qualified: !reasons.length,
    reasons,
    baseline: { version, exeSha256: installed ?? null },
  };
}

/** What one post-failure observation says about a known holder PID: true when
 * an observer named it; false when that observer answered usably without it;
 * null when it gave no usable answer. handle64 documents no exit codes, so its
 * unmatched answer counts as a usable negative only after exit 0. */
export function namedHolder(observation, pid, readRaw) {
  const none = { restartManager: null, imageCensus: null, handle64: null };
  if (!observation || !Number.isInteger(pid) || pid <= 0) return none;
  const o = observation;
  const rmUsable = ranCleanly(o.rm) && Array.isArray(o.rmParsed?.processes) && !o.rmParsed.error;
  const census = parseCensus(o.ps, JSON.stringify(o.psParsed));
  let handleText = null;
  if (o.handle?.stdout?.file && !o.handle.error && !o.handle.signal)
    try {
      handleText = readRaw(o.handle.stdout.file);
    } catch {
      handleText = null;
    }
  const handleNamed =
    typeof handleText === "string" && new RegExp(`\\bpid:\\s*${pid}\\b`).test(handleText);
  return {
    restartManager: rmUsable ? o.rmParsed.processes.some((p) => p.pid === pid) : null,
    imageCensus:
      census.known && !census.unreadableImages.some((p) => p.pid === pid)
        ? census.matches.some((p) => p.pid === pid)
        : null,
    handle64:
      typeof handleText !== "string"
        ? null
        : handleNamed
          ? true
          : o.handle.status === 0
            ? false
            : null,
  };
}

/** Observers qualify only against holders that calibration itself made: at
 * least one holder class must make the product rename fail, and for every
 * class whose rename failed, at least one observer must name that holder's
 * PID. One capable observer per class suffices; redundancy is not required. */
export function observersQualified(rows) {
  const failed = rows.filter((r) => r?.firstRename?.ok === false);
  const unnamed = failed.filter((r) => !Object.values(r.named ?? {}).some((v) => v === true));
  const reasons = [];
  if (!failed.length)
    reasons.push("no synthetic holder made the product rename fail; observers were not exercised");
  if (unnamed.length)
    reasons.push(`no observer named the holder of: ${unnamed.map((r) => r.name).join(", ")}`);
  return {
    qualified: !reasons.length,
    exercised: failed.map((r) => r.name),
    unnamed: unnamed.map((r) => r.name),
    reasons,
  };
}

/** Cross-process monotonic clocks use performance.timeOrigin + performance.now.
 * Eligible only after the product's first hide attempt is confirmed failed. */
export function residualRename(result, { now, rename, from, to }) {
  const failure = result?.hide?.failures?.[0];
  if (result?.timing?.firstHideOk !== false || !Number.isFinite(failure?.atEpochMs)) return null;
  const elapsedSinceFirstFailureMs = now() - failure.atEpochMs;
  if (!Number.isFinite(elapsedSinceFirstFailureMs) || elapsedSinceFirstFailureMs < 0)
    return { kind: "single-residual-rename", incomplete: true, reason: "failure-clock-invalid" };
  const row = { kind: "single-residual-rename", elapsedSinceFirstFailureMs };
  let renamed = false;
  try {
    rename(from, to);
    renamed = true;
    rename(to, from);
    return { ...row, ok: true, restored: true };
  } catch (error) {
    return {
      ...row,
      ok: false,
      restored: !renamed,
      stage: renamed ? "restore" : "rename",
      error: {
        code: error.code ?? null,
        errno: error.errno ?? null,
        message: String(error.message ?? error),
      },
    };
  }
}

export function calibrationComplete(row) {
  return (
    row.ready === true &&
    row.released === true &&
    !row.error &&
    !row.releaseError &&
    row.restored === true &&
    row.renameAfterRelease === "ok"
  );
}

/** One evidence directory: records.jsonl plus numbered raw files. */
export function evidenceWriter(dir) {
  mkdirSync(join(dir, "raw"), { recursive: true });
  const jsonl = join(dir, "records.jsonl");
  let seq = 0;
  const started = Date.now();
  return {
    dir,
    record(entry) {
      const line = JSON.stringify({
        wallMs: Date.now() - started,
        at: new Date().toISOString(),
        ...entry,
      });
      appendFileSync(jsonl, line + "\n");
      console.log(line.length > 4000 ? `${line.slice(0, 4000)}…` : line);
    },
    raw(label, text) {
      const file = `raw/${String(++seq).padStart(3, "0")}-${String(label).replace(/[^a-z0-9.-]+/gi, "_")}.txt`;
      writeFileSync(join(dir, file), text ?? "");
      return {
        file,
        bytes: Buffer.byteLength(text ?? ""),
        sha256: sha256Text(text),
        preview: preview(text),
      };
    },
    json(name, value) {
      writeFileSync(join(dir, name), JSON.stringify(value, null, 1));
      return name;
    },
  };
}
