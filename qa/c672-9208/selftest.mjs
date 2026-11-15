#!/usr/bin/env node
/**
 * Offline, deterministic self-test of the #672 QA hooks on any OS. Runs no
 * vendor program and installs nothing. Scratch goes to required C672_SCRATCH (the OS
 * temporary folder is never chosen implicitly). Exit 0 only if every check passes.
 *
 *   node qa/c672-9208/selftest.mjs [--mutate]
 *
 * --mutate replaces the hooks and the evidence reducers with deliberately
 * broken variants and requires each to be caught (the checks must be able to
 * fail). A check that is not run on this OS (the relative-symlink copy on
 * Windows) is reported SKIP, and so is the mutant it guards.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as hooks from "./lib/hooks.mjs";
import { manifest, manifestDiff, sha256File } from "./lib/evidence.mjs";
import * as evidence from "./lib/evidence.mjs";
import { sinceArg } from "./lib/observers.mjs";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
if (!process.env.C672_SCRATCH) throw new Error("C672_SCRATCH must name an owned scratch directory");
const scratch = mkdtempSync(join(process.env.C672_SCRATCH, "c672-9208-selftest-"));
const W = "C:\\Users\\u";
const LOADER = `${W}\\.claudexor\\node\\node_modules\\@github\\copilot\\npm-loader.js`;
const NATIVE = `${W}\\AppData\\Local\\GitHubCopilotCLI\\copilot.exe`;
const FLAGS = ["--no-auto-update"];

export async function checks(h) {
  const results = [];
  const check = (name, ok, detail) =>
    results.push({ name, ok: !!ok, detail: ok ? undefined : detail });

  // 1. argv adaptation
  const a = h.adaptArgs("A", "C:\\node\\node.exe", [LOADER, "--version"], FLAGS);
  check(
    "A keeps the npm-copy probe argv",
    !a.adapted && a.args.join(" ") === `${LOADER} --version`,
    a,
  );
  const b = h.adaptArgs("B", "C:\\node\\node.exe", [LOADER, "--version"], FLAGS);
  check(
    "B adds the declared flag before --version (npm copy)",
    b.adapted && b.args.join(" ") === `${LOADER} --no-auto-update --version`,
    b,
  );
  const bn = h.adaptArgs("B", NATIVE, ["--version"], FLAGS);
  check(
    "B adds the declared flag before --version (vendor copy)",
    bn.adapted && bn.args.join(" ") === "--no-auto-update --version",
    bn,
  );
  const bw = h.adaptArgs("B", "winget", ["install", "--id", "GitHub.Copilot", "--exact"], FLAGS);
  check("B leaves winget unchanged", !bw.adapted, bw);
  const bu = h.adaptArgs("B", NATIVE, ["update"], FLAGS);
  check("B leaves the vendor update unchanged", !bu.adapted && bu.args.join(" ") === "update", bu);
  const bc = h.adaptArgs("B", `${W}\\.local\\bin\\claude.exe`, ["--version"], FLAGS);
  check("B leaves other programs unchanged", !bc.adapted, bc);

  // 2. spawn seam records in memory and forwards the effective argv
  const seen = [];
  const { seam, calls } = h.makeSpawnSeam({
    arm: "B",
    childUpdateArgs: FLAGS,
    realSpawn: (bin, args, opts) => (
      seen.push(args),
      { pid: 7, status: 0, stdout: "GitHub Copilot CLI 1.0.111.\n", stderr: "" }
    ),
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
  });
  seam("C:\\node\\node.exe", [LOADER, "--version"], {
    env: { CI: "x", PATH: "p", OTHER: "o" },
    cwd: "c",
  });
  check(
    "seam forwards the adapted argv",
    seen[0]?.join(" ") === `${LOADER} --no-auto-update --version`,
    seen,
  );
  check(
    "seam records build/effective argv, pid, times and env by value only for update-relevant keys",
    calls.length === 1 &&
      calls[0].pid === 7 &&
      calls[0].builtArgs.at(-2) === LOADER &&
      calls[0].endedMs > calls[0].startedMs &&
      calls[0].env.CI === "x" &&
      !("OTHER" in calls[0].env) &&
      calls[0].envKeys.includes("OTHER"),
    calls,
  );

  // 3. rename observer: passive on success, after-the-fact on failure
  const dir = mkdtempSync(join(scratch, "rename-"));
  const pkg = join(dir, "copilot");
  mkdirSync(pkg);
  const target = (from, to) => to.endsWith(".claudexor-converted");
  let observed = 0;
  const early = join(dir, "early.mjs");
  writeFileSync(
    early,
    'import { renameSync } from "node:fs"; export const go = (a, b) => renameSync(a, b);\n',
  );
  const { go: goEarly } = await import(pathToFileURL(early).href);
  const hook = h.installRenameObserver({
    isTarget: target,
    onFailure: () => (observed++, { looked: true }),
  });
  try {
    const fs = await import("node:fs");
    fs.renameSync(pkg, `${pkg}.claudexor-converted`);
    check(
      "success: no observer call, one in-memory timestamp",
      observed === 0 && hook.state.successes.length === 1,
      hook.state,
    );
    fs.renameSync(`${pkg}.claudexor-converted`, pkg);
    check(
      "non-target rename is not recorded",
      hook.state.successes.length === 1 && hook.state.failures.length === 0,
      hook.state,
    );

    let thrown = null;
    try {
      fs.renameSync(join(dir, "absent"), join(dir, "absent.claudexor-converted"));
    } catch (error) {
      thrown = error;
    }
    const ev = hook.state.failures[0];
    check(
      "failure: original error rethrown after one observer call, error captured before it",
      thrown?.code === "ENOENT" &&
        observed === 1 &&
        ev?.error.code === "ENOENT" &&
        ev.error.message === thrown.message &&
        ev.observation?.looked === true,
      { thrown: String(thrown), ev, observed },
    );
    let nonTarget = null;
    try {
      fs.renameSync(join(dir, "absent"), join(dir, "elsewhere"));
    } catch (error) {
      nonTarget = error;
    }
    check(
      "non-target failure rethrown without observer",
      nonTarget?.code === "ENOENT" && observed === 1,
      { observed },
    );

    // ESM named imports, one loaded after install and one loaded earlier.
    const esm = join(dir, "named.mjs");
    writeFileSync(
      esm,
      'import { renameSync } from "node:fs"; export const go = (a, b) => renameSync(a, b);\n',
    );
    const { go } = await import(pathToFileURL(esm).href);
    try {
      go(join(dir, "absent2"), join(dir, "absent2.claudexor-converted"));
    } catch {
      /* expected */
    }
    check(
      "ESM named import loaded after install reaches the observer",
      hook.state.failures.length === 2 && observed === 2,
      hook.state.failures,
    );
    try {
      goEarly(join(dir, "absent4"), join(dir, "absent4.claudexor-converted"));
    } catch {
      /* expected */
    }
    check(
      "ESM named import loaded before install reaches the observer",
      hook.state.failures.length === 3 && observed === 3,
      hook.state.failures,
    );
  } finally {
    hook.uninstall();
  }
  const fs2 = await import("node:fs");
  check("uninstall restores the real renameSync", fs2.renameSync === hook.real, null);

  // 4. a throwing observer cannot change the product's error
  const hook2 = h.installRenameObserver({
    isTarget: target,
    onFailure: () => {
      throw new Error("observer broke");
    },
  });
  let kept = null;
  try {
    (await import("node:fs")).renameSync(
      join(dir, "absent3"),
      join(dir, "absent3.claudexor-converted"),
    );
  } catch (error) {
    kept = error;
  } finally {
    hook2.uninstall();
  }
  check(
    "observer failure keeps the original error and is recorded",
    kept?.code === "ENOENT" && hook2.state.observerErrors.length === 1,
    hook2.state,
  );

  // 5. reachability through the locally built product module, if present
  const dist = join(repo, "packages/core/dist/hidden-program-paths.js");
  if (existsSync(dist)) {
    const hook3 = h.installRenameObserver({ isTarget: target, onFailure: () => ({}) });
    try {
      const { hideProgramPaths } = await import(pathToFileURL(dist).href);
      const missing = join(dir, "product-absent");
      try {
        hideProgramPaths([{ path: missing, hidden: `${missing}.claudexor-converted` }]);
      } catch {
        /* expected */
      }
      check(
        "local dist hideProgramPaths is observed (dist may be older than HEAD)",
        hook3.state.failures.at(-1)?.from === missing,
        hook3.state,
      );
    } finally {
      hook3.uninstall();
    }
  } else
    console.log("SKIP local dist hideProgramPaths absent; Windows calibration remains required");

  // 6. manifests
  const m = join(dir, "m");
  mkdirSync(join(m, "pkg"), { recursive: true });
  writeFileSync(join(m, "pkg", "a"), "1");
  const m1 = manifest(m);
  writeFileSync(join(m, "pkg", "a"), "2");
  writeFileSync(join(m, "b"), "3");
  const d = manifestDiff(m1, manifest(m));
  check(
    "manifest diff names changed and added files",
    !d.equal && d.changed.includes(join("pkg", "a")) && d.added.includes("b"),
    d,
  );
  check(
    "sha256File matches a known digest",
    sha256File(join(m, "b")) === "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
    null,
  );
  return results;
}

const mutants = {
  "A also adapts": (h) => ({
    ...h,
    adaptArgs: (arm, bin, args, f) => h.adaptArgs("B", bin, args, f),
  }),
  "observer swallows the error": (h) => ({
    ...h,
    installRenameObserver: (o) => {
      const inner = h.installRenameObserver({ ...o, isTarget: () => false });
      return inner;
    },
  }),
  "flag appended after --version": (h) => ({
    ...h,
    adaptArgs: (arm, bin, args, f) => {
      const r = h.adaptArgs(arm, bin, args, f);
      return r.adapted ? { ...r, args: [...args, ...f] } : r;
    },
  }),
};

// Exercise the actual evidence reducers used by the QA scripts, in both directions.
async function evidenceChecks(e, work) {
  const rows = [];
  const check = (name, ok) => rows.push({ name, ok: !!ok });
  const skip = (name, why) => rows.push({ name, ok: true, skipped: why });
  const rejects = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const goodCensus = {
    mode: "ps",
    matches: [],
    total: 5,
    imageUnreadable: 0,
    unreadableImages: [],
  };
  const withGap = (exe, pid = 9) => ({
    ...goodCensus,
    imageUnreadable: 1,
    unreadableImages: [{ pid, exe, error: 5 }],
  });
  const command = { status: 0, error: null, signal: null };
  const empty = e.parseCensus(command, JSON.stringify(goodCensus));
  check(
    "successful empty census permits pre-mutation gate",
    !rejects(() => e.requireEmptyCensus(empty)) && empty.count === 0,
  );
  const censusCases = [
    [null, "{}"],
    [{ status: 2 }, JSON.stringify(goodCensus)],
    [{ ...command, error: "timeout" }, JSON.stringify(goodCensus)],
    [command, "{"],
    [command, "null"],
    [command, "{}"],
    [command, JSON.stringify({ ...goodCensus, error: "snapshot failed" })],
    [command, JSON.stringify({ ...goodCensus, matches: {} })],
    [command, JSON.stringify({ ...goodCensus, imageUnreadable: 1 })],
    [command, JSON.stringify(withGap("CoPiLoT.exe"))],
    [command, JSON.stringify(withGap(null))],
    [command, JSON.stringify(withGap("  "))],
    [
      command,
      JSON.stringify({ ...goodCensus, unreadableImages: [{ pid: 9, exe: "System", error: 5 }] }),
    ],
    [command, JSON.stringify({ ...withGap("System"), total: 0 })],
    [
      command,
      JSON.stringify({
        ...withGap("System"),
        unreadableImages: [{ pid: -1, exe: "System", error: 5 }],
      }),
    ],
    [
      command,
      JSON.stringify({ ...withGap("System"), unreadableImages: [{ pid: 9, exe: "System" }] }),
    ],
    [{ ...command, signal: "SIGTERM" }, JSON.stringify(goodCensus)],
    [command, JSON.stringify({ ...goodCensus, matches: [{ pid: 9 }] })],
  ];
  for (const [i, [c, text]] of censusCases.entries()) {
    const x = e.parseCensus(c, text);
    check(
      `unknown census ${i} blocks mutation and preserves unknown count`,
      x.count === null && rejects(() => e.requireEmptyCensus(x)),
    );
  }
  const matching = {
    pid: 9,
    exe: "copilot.exe",
    image: "C:\\vendor\\copilot.exe",
    belowRoot: true,
  };
  const nonempty = e.parseCensus(command, JSON.stringify({ ...goodCensus, matches: [matching] }));
  check(
    "known nonempty census blocks mutation",
    nonempty.count === 1 && rejects(() => e.requireEmptyCensus(nonempty)),
  );
  for (const [exe, pid] of [
    ["System", 4],
    ["[System Process]", 0],
    ["svchost.exe", 20],
    ["node.exe", 21],
  ]) {
    const scoped = e.parseCensus(command, JSON.stringify(withGap(exe, pid)));
    check(
      `nonmatching Toolhelp name ${exe} permits scoped empty but retains path gap`,
      !rejects(() => e.requireEmptyCensus(scoped)) &&
        scoped.count === 0 &&
        scoped.unreadableImages?.[0]?.pid === pid &&
        scoped.unreadableImages?.[0]?.error === 5 &&
        !!scoped.scope,
    );
  }
  const scoped = e.parseCensus(command, JSON.stringify(withGap("[System Process]", 0)));
  check(
    "no census output claims universal image coverage",
    !("imageCoverageComplete" in scoped) && !("imageCoverageComplete" in empty),
  );
  const mixed = e.parseCensus(
    command,
    JSON.stringify({ ...withGap("System", 4), matches: [matching] }),
  );
  check(
    "unrelated unreadable image cannot hide a readable relevant match",
    mixed.count === 1 && rejects(() => e.requireEmptyCensus(mixed)),
  );
  const namedOutside = e.parseCensus(
    command,
    JSON.stringify({ ...goodCensus, matches: [{ ...matching, belowRoot: false }] }),
  );
  check(
    "Copilot name outside roots still blocks hygiene",
    namedOutside.count === 1 && rejects(() => e.requireEmptyCensus(namedOutside)),
  );
  const rootImage = e.parseCensus(
    command,
    JSON.stringify({ ...goodCensus, matches: [{ ...matching, exe: "node.exe" }] }),
  );
  check(
    "readable non-Copilot image under owned root still blocks hygiene",
    rootImage.count === 1 && rejects(() => e.requireEmptyCensus(rootImage)),
  );

  // Recent rows come from the same enumeration and never change the scoped count.
  const recentRow = {
    pid: 31,
    ppid: 30,
    exe: "node.exe",
    image: "C:\\hostedtoolcache\\node.exe",
    created: 1300,
  };
  const withRecent = { ...goodCensus, since: 1000, recentTotal: 1, recent: [recentRow] };
  const r1 = e.parseCensus(command, JSON.stringify(withRecent));
  check(
    "recent rows are retained beside the scoped count",
    r1.known && r1.count === 0 && r1.recent?.[0]?.pid === 31 && r1.recentTotal === 1,
  );
  check("a census without recent rows keeps recent null", empty.recent === null);
  for (const [i, bad] of [
    { ...withRecent, recent: [{ ...recentRow, ppid: undefined }] },
    { ...withRecent, recent: [{ ...recentRow, created: 999 }] },
    { ...withRecent, recentTotal: 0 },
    { ...withRecent, recent: {} },
    { ...withRecent, since: undefined },
    { ...withRecent, recent: [{ ...recentRow, exe: null }] },
  ].entries()) {
    const x = e.parseCensus(command, JSON.stringify(bad));
    check(
      `malformed recent rows ${i} make the census unknown`,
      x.known === false && x.count === null,
    );
  }

  // Bounded settling before S0 and before every iteration.
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    };
  };
  const known = (count) => ({ known: true, count, matches: Array(count).fill(matching) });
  const sequence = (list) => {
    let n = 0;
    return () => list[Math.min(n++, list.length - 1)];
  };
  {
    const s = await e.settleCensus(sequence([known(0)]), clock());
    check(
      "settling: an empty first census proceeds at once",
      s.looks === 1 && s.last.count === 0 && !rejects(() => e.requireEmptyCensus(s.last)),
    );
  }
  {
    const s = await e.settleCensus(sequence([known(1), known(0)]), clock());
    check(
      "settling: a short-lived match is waited out and the first look is kept",
      s.looks === 2 &&
        s.first.count === 1 &&
        s.last.count === 0 &&
        !rejects(() => e.requireEmptyCensus(s.last)),
    );
  }
  {
    const s = await e.settleCensus(sequence([known(1)]), clock());
    check(
      "settling: a match outlasting 60 s stops the gate and nothing is killed",
      s.looks === 31 && s.last.count === 1 && rejects(() => e.requireEmptyCensus(s.last)),
    );
  }
  {
    let reads = 0;
    const s = await e.settleCensus(
      () => (reads++, { known: false, count: null, reason: "census-command-failed" }),
      clock(),
    );
    check(
      "settling: an unknown census is not re-polled and stays unknown",
      reads === 1 && s.looks === 1 && rejects(() => e.requireEmptyCensus(s.last)),
    );
  }

  const m = { exists: true, rows: [], errors: [], truncated: false };
  check(
    "verified equal manifest permits baseline",
    !rejects(() => e.requireEqualManifest(e.manifestDiff(m, m), "fixture")),
  );
  const incomplete = [
    null,
    { ...m, errors: [{ path: "x", code: "EACCES" }] },
    { ...m, truncated: true },
    { ...m, rows: [{ path: "x", size: 2, sha256: null }] },
    { ...m, rows: [{ path: "x", size: 2, sha256: "unreadable:EACCES" }] },
  ];
  for (const [i, x] of incomplete.entries()) {
    const diff = e.manifestDiff(x, x);
    check(
      `partial manifest ${i} never equals itself`,
      diff.equal === null &&
        diff.gaps.length > 0 &&
        rejects(() => e.requireEqualManifest(diff, "vendor")),
    );
  }
  const missing = { ...m, exists: false };
  check(
    "missing and empty directory differ in both directions",
    e.manifestDiff(m, missing).equal === false && e.manifestDiff(missing, m).equal === false,
  );
  const dir = { ...m, rows: [{ path: "x", dir: true }] };
  const file = { ...m, rows: [{ path: "x", size: 1, sha256: "a".repeat(64) }] };
  check(
    "type changes and vendor drift block comparability",
    e.manifestDiff(dir, file).changed.includes("x") &&
      rejects(() => e.requireEqualManifest(e.manifestDiff(dir, file), "vendor")),
  );
  check(
    "visible differences retain unreadable coverage",
    e.manifestDiff(m, incomplete[1]).gaps.length > 0,
  );

  // S0 snapshot and restore keep relative symlinks verbatim. Not run on
  // Windows: creating a symlink there needs a privilege, and a runner quirk
  // must not stop the native-update job, which copies nothing. On the runner
  // the S0 copy and every restore are compared by manifest and stop the batch
  // on any difference.
  const symlinkCheck = "S0 copy keeps a relative symlink verbatim and compares equal";
  if (process.platform === "win32") skip(symlinkCheck, "Windows: covered by the S0 manifest gate");
  else {
    const tree = mkdtempSync(join(work, "tree-"));
    const src = join(tree, "src");
    mkdirSync(join(src, "pkg"), { recursive: true });
    writeFileSync(join(src, "pkg", "a"), "1");
    symlinkSync(join("pkg", "a"), join(src, "rel"));
    e.copyTree(src, join(tree, "copy"));
    const d = e.manifestDiff(e.manifest(src), e.manifest(join(tree, "copy")));
    check(symlinkCheck, d.equal === true && d.complete === true);
  }

  // Iteration outcomes: a receipt is not a conversion without the hiding rename.
  const result = (ok, firstHideOk = true) => ({
    conversionAttempted: true,
    receipt: {
      ok,
      limitations: ["retained"],
      problem: ok ? null : { code: "conversion_verification_failed" },
    },
    thrown: null,
    hide:
      firstHideOk === null
        ? { successes: [], failures: [] }
        : firstHideOk
          ? { successes: [{ atMs: 5 }], failures: [] }
          : { successes: [], failures: [{ atMs: 5, atEpochMs: 100, error: { code: "EPERM" } }] },
    answers: { npmCopy: [] },
    timing: { firstHideOk },
  });
  const good = e.summarizeIteration(result(true), command);
  const refused = e.summarizeIteration(result(false, false), command);
  const noRename = e.summarizeIteration(result(false, null), command);
  const inconsistent = e.summarizeIteration(
    { ...result(true), hide: { successes: [], failures: [] } },
    command,
  );
  const precondition = e.summarizeIteration(
    {
      receipt: null,
      conversionAttempted: false,
      thrown: { precondition: true, message: "fixture missing" },
    },
    { status: 3 },
  );
  const thrown = e.summarizeIteration(
    { receipt: null, conversionAttempted: true, thrown: { message: "boom" } },
    { status: 5 },
  );
  const nullReceipt = e.summarizeIteration({ receipt: null, conversionAttempted: true }, command);
  const malformed = e.summarizeIteration({ receipt: {}, conversionAttempted: true }, command);
  const timeoutReceipt = e.summarizeIteration(result(true), { status: null, error: "timeout" });
  const asRow = (r, n, arm = "A") => ({ i: n, arm, result: r, postCensus: empty });
  const all = [
    good,
    refused,
    precondition,
    thrown,
    nullReceipt,
    malformed,
    timeoutReceipt,
    noRename,
  ].map((x, n) => asRow(x, n + 1));
  all[2].postCensus = e.parseCensus(null, "");
  const agg = e.aggregateArm(all, "A");
  check(
    "a real ok:false receipt after a failed rename counts as an attempted hide",
    refused.complete &&
      refused.ok === false &&
      refused.hideAttempted &&
      agg.hideFailures.some((h) => h.i === 2 && h.codes.includes("EPERM")),
  );
  check(
    "a receipt without the hiding rename is a receipt, not a conversion",
    noRename.complete &&
      !noRename.hideAttempted &&
      agg.receiptsWithoutRename.length === 1 &&
      agg.receiptsWithoutRename[0].i === 8 &&
      agg.receiptsWithoutRename[0].problem === "conversion_verification_failed",
  );
  check(
    "firstHideOk without a matching rename record is not an attempted hide",
    !inconsistent.hideAttempted,
  );
  check(
    "preconditions, Update calls, receipts and attempted renames stay separate",
    agg.preconditionFailures === 1 &&
      agg.updateCalls === 7 &&
      agg.receiptCount === 3 &&
      agg.hideAttempts === 2 &&
      agg.incomplete.length === 5,
  );
  check(
    "thrown precondition survives aggregation",
    agg.incomplete.some((r) => r.precondition === true && r.thrown?.precondition === true),
  );
  check(
    "ok:false receipts stay in the receipt list",
    agg.receipts.some((r) => r.receipt.ok === false),
  );
  check("no universal process count is emitted", !("lingeringProcessesAfter" in agg));
  const scopedSummary = e.aggregateArm([{ ...asRow(good, 1), postCensus: scoped }], "A");
  check(
    "scoped counts, path gaps and recent rows are retained",
    scopedSummary.observedMatchingProcessesAfter?.[0] === 0 &&
      scopedSummary.processImageGapsAfter?.[0]?.[0]?.exe === "[System Process]" &&
      !!scopedSummary.processCountScope &&
      scopedSummary.recentProcessesAfter?.[0]?.listed === null,
  );
  check(
    "a failed census leaves the scoped count and recent rows unknown",
    agg.observedMatchingProcessesAfter?.[2] === null && agg.recentProcessesAfter?.[2] === null,
  );
  const order = ["A", "B", "B", "A", "A", "B", "B", "A"];
  const complete = order.map((arm, n) => asRow(n % 2 ? refused : good, n + 1, arm));
  check(
    "eight ordered receipts with attempted renames complete the batch, refusals included",
    e.batchComplete(complete, order),
  );
  for (const [i, bad] of [
    precondition,
    thrown,
    nullReceipt,
    malformed,
    timeoutReceipt,
    noRename,
    inconsistent,
  ].entries()) {
    const partial = complete.map((r) => ({ ...r }));
    partial[3].result = bad;
    check(`incomplete conversion ${i} cannot complete batch`, !e.batchComplete(partial, order));
  }
  check(
    "missing and wrong-order iteration cannot complete batch",
    !e.batchComplete(complete.slice(1), order) && !e.batchComplete([...complete].reverse(), order),
  );
  const stable = { latestBefore: "1.0.112", latestAfter: "1.0.112" };
  check(
    "a complete batch with unchanged npm latest is comparable",
    e.batchVerdict(complete, order, stable).comparable === true,
  );
  const drift = e.batchVerdict(complete, order, { ...stable, latestAfter: "1.0.113" });
  check(
    "npm latest drift during the batch withholds comparability",
    drift.comparable === false && drift.reasons.some((r) => r.includes("1.0.113")),
  );
  check(
    "an unreadable latest after the batch withholds comparability",
    e.batchVerdict(complete, order, { ...stable, latestAfter: null }).comparable === false &&
      e.batchVerdict(complete, order, { ...stable, latestBefore: null }).comparable === false,
  );
  const withNoRename = complete.map((r) => ({ ...r }));
  withNoRename[3].result = noRename;
  const short = e.batchVerdict(withNoRename, order, stable);
  check(
    "a receipt without rename withholds comparability and names its iteration",
    short.comparable === false && short.reasons.some((r) => /: 4$/.test(r)),
  );

  // Vendor setup: evidence actually obtained, never the MSI hash.
  check(
    "versions are read as the product reads them",
    e.versionOf("GitHub Copilot CLI 1.0.112.") === "1.0.112" &&
      e.versionOf("GitHub Copilot CLI 1.0.112-0") === "1.0.112-0" &&
      e.versionOf("GitHub Copilot CLI 1.0.1120.") === "1.0.1120" &&
      e.versionOf("no version") === null &&
      e.versionOf(null) === null,
  );
  const answer = (v, status = 0, extra = {}) => ({
    status,
    error: null,
    signal: null,
    version: `GitHub Copilot CLI ${v}.`,
    ...extra,
  });
  check(
    "a version answer qualifies only after a clean exit with the exact version",
    e.answerReports(answer("1.0.112"), "1.0.112") &&
      !e.answerReports(answer("1.0.112", 1), "1.0.112") &&
      !e.answerReports(answer("1.0.112", null, { error: "ETIMEDOUT" }), "1.0.112") &&
      !e.answerReports(answer("1.0.112", null, { signal: "SIGTERM" }), "1.0.112") &&
      !e.answerReports(answer("1.0.113"), "1.0.112") &&
      !e.answerReports(null, "1.0.112"),
  );
  const exe = "C:\\Users\\runneradmin\\AppData\\Local\\GitHubCopilotCLI\\copilot.exe";
  const H = "b".repeat(64);
  const clean = { status: 0, error: null, signal: null };
  const three = (v) => [answer(v), answer(v), answer(v)];
  const setup = {
    version: "1.0.112",
    vendorExe: exe,
    install: clean,
    hashes: { afterInstall: H, beforeUpdate: H, afterUpdate: H },
    answersBefore: three("1.0.112"),
    update: clean,
    receipt: {
      ok: true,
      outcome: "not_changed",
      after: { path: exe.toUpperCase(), realPath: null, version: "1.0.112" },
    },
    answersAfter: three("1.0.112"),
  };
  check(
    "a vendor setup with clean exits, matching answers, receipt and bytes qualifies",
    e.qualifyVendorSetup(setup).qualified === true &&
      e.qualifyVendorSetup(setup).baseline.exeSha256 === H,
  );
  const variants = {
    "winget exit 1": { install: { ...clean, status: 1 } },
    "winget timeout": { install: { status: null, error: "ETIMEDOUT", signal: null } },
    "installed executable not hashed": { hashes: { ...setup.hashes, afterInstall: null } },
    "first answer reports another version": { answersBefore: three("1.0.111") },
    "first answer failed": {
      answersBefore: [answer("1.0.112", 1), answer("1.0.112"), answer("1.0.112")],
    },
    "bytes changed during the questions": {
      hashes: { ...setup.hashes, beforeUpdate: "c".repeat(64) },
    },
    "Update exit 1": { update: { ...clean, status: 1 } },
    "Update killed": { update: { status: null, error: null, signal: "SIGTERM" } },
    "receipt ok:false": { receipt: { ...setup.receipt, ok: false } },
    "receipt outcome unknown": { receipt: { ...setup.receipt, outcome: "unknown" } },
    "receipt missing": { receipt: null },
    "Update selected another version": {
      receipt: { ...setup.receipt, after: { ...setup.receipt.after, version: "1.0.113" } },
    },
    "Update selected another program": {
      receipt: {
        ...setup.receipt,
        after: { path: "C:\\other\\copilot.exe", realPath: null, version: "1.0.112" },
      },
    },
    "bytes changed by Update": { hashes: { ...setup.hashes, afterUpdate: "c".repeat(64) } },
    "answer after Update reports another version": { answersAfter: three("1.0.113") },
  };
  for (const [name, change] of Object.entries(variants)) {
    const q = e.qualifyVendorSetup({ ...setup, ...change });
    check(`vendor setup does not qualify: ${name}`, q.qualified === false && q.reasons.length > 0);
  }

  // Calibration lifecycle and observer qualification against a known holder.
  const ready = { ready: true, released: true, restored: true, renameAfterRelease: "ok" };
  check("complete calibration is accepted", e.calibrationComplete(ready));
  for (const [key, value] of [
    ["ready", false],
    ["released", false],
    ["error", "missing child"],
    ["releaseError", "pipe failure"],
  ])
    check(`calibration ${key} cannot pass`, !e.calibrationComplete({ ...ready, [key]: value }));
  const raw = {
    "h-yes":
      "node.exe           pid: 4242   type: File  1C4: C:\\Users\\u\\cal\\pkg\\sub\\file.bin",
    "h-no": "No matching handles found.",
  };
  const readRaw = (f) => {
    if (!(f in raw)) throw new Error(`missing ${f}`);
    return raw[f];
  };
  const observation = {
    rm: { ...clean },
    rmParsed: { processes: [{ pid: 4242 }] },
    ps: { ...clean },
    psParsed: { ...goodCensus },
    handle: { ...clean, stdout: { file: "h-yes" } },
  };
  const n1 = e.namedHolder(observation, 4242, readRaw);
  check(
    "observers name a known holder; a usable census without it answers false",
    n1.restartManager === true && n1.handle64 === true && n1.imageCensus === false,
  );
  const n2 = e.namedHolder(
    {
      rm: { status: 2, error: null, signal: null },
      rmParsed: { processes: [] },
      ps: { status: 2, error: null, signal: null },
      psParsed: {},
      handle: { status: 1, error: null, signal: null, stdout: { file: "h-no" } },
    },
    4242,
    readRaw,
  );
  check(
    "unusable observer answers stay null, not false",
    n2.restartManager === null && n2.imageCensus === null && n2.handle64 === null,
  );
  const n3 = e.namedHolder(
    { ...observation, rmParsed: { processes: [] }, handle: { ...clean, stdout: { file: "h-no" } } },
    4242,
    readRaw,
  );
  check(
    "usable observers that did not name the holder answer false",
    n3.restartManager === false && n3.handle64 === false,
  );
  const n4 = e.namedHolder(
    { ...observation, handle: { status: 1, error: null, signal: null, stdout: { file: "h-yes" } } },
    4242,
    readRaw,
  );
  check("handle64 naming the holder counts even after a nonzero exit", n4.handle64 === true);
  const n5 = e.namedHolder(
    { ...observation, handle: { ...clean, error: "ETIMEDOUT", stdout: { file: "h-yes" } } },
    4242,
    readRaw,
  );
  check("a timed-out handle64 gives no answer", n5.handle64 === null);
  check(
    "without a known holder PID nothing is named",
    Object.values(e.namedHolder(observation, undefined, readRaw)).every((v) => v === null),
  );
  const n7 = e.namedHolder(observation, 424, readRaw);
  check(
    "a PID prefix is not a match",
    n7.handle64 === false && n7.restartManager === false && n7.imageCensus === false,
  );
  const cal = (name, ok, named) => ({ name, firstRename: { ok }, named });
  const unusable = { restartManager: null, imageCensus: null, handle64: null };
  check(
    "observers qualify when every failing holder class is named by at least one observer",
    e.observersQualified([
      cal("none", true, undefined),
      cal("file", false, { ...unusable, handle64: true }),
      cal("cwd", false, { ...unusable, restartManager: false, handle64: true }),
    ]).qualified === true,
  );
  check(
    "three unusable observer answers on a failed rename do not qualify",
    e.observersQualified([cal("file", false, unusable)]).qualified === false,
  );
  check(
    "a failed rename without any observation does not qualify",
    e.observersQualified([cal("file", false, undefined)]).qualified === false,
  );
  check(
    "observers never exercised by a failing holder do not qualify",
    e.observersQualified([cal("none", true, undefined), cal("file", true, undefined)]).qualified ===
      false,
  );
  const partly = e.observersQualified([
    cal("file", false, { ...unusable, restartManager: true }),
    cal("cwd", false, { ...unusable, handle64: false }),
  ]);
  check(
    "one unnamed failing class withholds qualification and is named",
    partly.qualified === false && partly.unnamed.join() === "cwd",
  );

  const failed = {
    hide: { failures: [{ atEpochMs: 100, error: { code: "EPERM" } }] },
    timing: { firstHideOk: false },
  };
  let renames = 0;
  const options = {
    now: () => 451,
    rename: () => {
      renames++;
    },
    from: "pkg",
    to: "residual",
  };
  check(
    "no residual rename without confirmed first failure",
    e.residualRename(result(true), options) === null && renames === 0,
  );
  const residual = e.residualRename(failed, options);
  check(
    "one residual attempt plus restore uses original failure clock",
    renames === 2 &&
      residual.elapsedSinceFirstFailureMs === 351 &&
      residual.restored &&
      failed.hide.failures[0].error.code === "EPERM",
  );
  renames = 0;
  const denied = e.residualRename(failed, {
    ...options,
    rename: () => {
      renames++;
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
  });
  check(
    "residual failure is not retried",
    renames === 1 && denied.ok === false && denied.error.code === "EPERM",
  );
  return rows;
}

// Fixed inputs and the helper's time argument (not mutated).
function inputChecks() {
  const rows = [];
  const check = (name, ok) => rows.push({ name, ok: !!ok });
  const freeze = JSON.parse(
    readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "freeze.json"), "utf8"),
  );
  check(
    "winget MSI hashes are labelled provenance, not installed-executable pins",
    /^[A-F0-9]{64}$/.test(freeze.winget.provenance?.batchMsiSha256 ?? "") &&
      /^[A-F0-9]{64}$/.test(freeze.winget.provenance?.nativeUpdateStartMsiSha256 ?? "") &&
      !("batchMsiSha256" in freeze.winget) &&
      !("nativeUpdateStartMsiSha256" in freeze.winget),
  );
  check(
    "ps --since is a Windows FILETIME one second before the start",
    sinceArg(0) === "--since=116444735990000000" &&
      sinceArg(1000) === "--since=116444736000000000" &&
      sinceArg(null) === null,
  );
  return rows;
}

const evidenceMutants = {
  "unrelated OS image gap blocks every batch": (e) => ({
    ...e,
    parseCensus: (c, t) => {
      const r = e.parseCensus(c, t);
      return r.unreadableImages?.length > 0 ? { ...r, known: false, count: null } : r;
    },
  }),
  "scoped zero becomes universal zero": (e) => ({
    ...e,
    aggregateArm: (rows, arm) => ({
      ...e.aggregateArm(rows, arm),
      lingeringProcessesAfter: rows
        .filter((r) => r.arm === arm)
        .map((r) => r.postCensus?.count ?? null),
    }),
  }),
  "unknown census becomes empty": (e) => ({
    ...e,
    parseCensus: () => ({ known: true, matches: [], count: 0 }),
  }),
  "every result becomes a completed receipt": (e) => ({
    ...e,
    summarizeIteration: (r, c) => ({
      ...e.summarizeIteration(r, c),
      complete: true,
      receipt: r?.receipt ?? { ok: true },
    }),
  }),
  "ok:false receipts are dropped": (e) => ({
    ...e,
    summarizeIteration: (r, c) =>
      e.summarizeIteration(r?.receipt?.ok === false ? { ...r, receipt: null } : r, c),
  }),
  "a receipt without rename counts as a conversion": (e) => ({
    ...e,
    summarizeIteration: (r, c) => {
      const s = e.summarizeIteration(r, c);
      return { ...s, hideAttempted: s.complete };
    },
  }),
  "batch ignores the hiding rename": (e) => ({
    ...e,
    batchComplete: (rows, order) =>
      rows.length === order.length &&
      rows.every((r, n) => r.i === n + 1 && r.arm === order[n] && r.result?.complete === true),
  }),
  "batch counts any result": (e) => ({
    ...e,
    batchComplete: (rows, order) => rows.length === order.length && rows.every((r) => r.result),
  }),
  "npm latest drift is ignored": (e) => ({
    ...e,
    batchVerdict: (rows, order, registry) =>
      e.batchVerdict(rows, order, { ...registry, latestAfter: registry.latestBefore }),
  }),
  "census gate without bounded settling": (e) => ({
    ...e,
    settleCensus: async (read) => {
      const first = read();
      return { first, last: first, looks: 1 };
    },
  }),
  "partial manifests compare equal": (e) => ({
    ...e,
    manifestDiff: () => ({ equal: true, complete: true, gaps: [], changed: [] }),
  }),
  "S0 copy resolves symlinks": {
    needs: "S0 copy keeps a relative symlink verbatim and compares equal",
    mutate: (e) => ({
      ...e,
      copyTree: (from, to) => cpSync(from, to, { recursive: true, preserveTimestamps: true }),
    }),
  },
  "vendor setup ignores the Update receipt": (e) => ({
    ...e,
    qualifyVendorSetup: (s) =>
      e.qualifyVendorSetup({
        ...s,
        update: { status: 0, error: null, signal: null },
        receipt: {
          ok: true,
          outcome: "not_changed",
          after: { path: s.vendorExe, version: s.version },
        },
      }),
  }),
  "vendor setup ignores version answers": (e) => ({
    ...e,
    qualifyVendorSetup: (s) => {
      const fine = [{ status: 0, error: null, signal: null, version: s.version }];
      return e.qualifyVendorSetup({ ...s, answersBefore: fine, answersAfter: fine });
    },
  }),
  "vendor setup ignores executable bytes": (e) => ({
    ...e,
    qualifyVendorSetup: (s) => {
      const h = "a".repeat(64);
      return e.qualifyVendorSetup({
        ...s,
        hashes: { afterInstall: h, beforeUpdate: h, afterUpdate: h },
      });
    },
  }),
  "calibration ignores missing readiness": (e) => ({
    ...e,
    calibrationComplete: (r) => r.restored && r.renameAfterRelease === "ok",
  }),
  "unusable observers are accepted": (e) => ({
    ...e,
    observersQualified: (rows) => ({
      ...e.observersQualified(rows),
      qualified: rows.some((r) => r?.firstRename?.ok === false),
    }),
  }),
  "an unusable observer answer becomes a negative": (e) => ({
    ...e,
    namedHolder: (o, pid, read) =>
      Object.fromEntries(
        Object.entries(e.namedHolder(o, pid, read)).map(([k, v]) => [k, v ?? false]),
      ),
  }),
};

const main = [
  ...(await checks(hooks)),
  ...(await evidenceChecks(evidence, scratch)),
  ...inputChecks(),
];
let failed = main.filter((r) => !r.ok);
const skipped = new Set(main.filter((r) => r.skipped).map((r) => r.name));
for (const r of main)
  console.log(
    `${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"} ${r.name}${r.skipped ? ` (${r.skipped})` : ""}${r.ok ? "" : ` ${JSON.stringify(r.detail)}`}`,
  );
if (process.argv.includes("--mutate"))
  for (const [name, mutate] of Object.entries(mutants)) {
    const caught = (await checks(mutate(hooks))).some((r) => !r.ok);
    console.log(`${caught ? "CAUGHT" : "MISSED"} mutant: ${name}`);
    if (!caught) failed = [...failed, { name: `mutant ${name}` }];
  }
if (process.argv.includes("--mutate"))
  for (const [name, entry] of Object.entries(evidenceMutants)) {
    const { mutate, needs } = typeof entry === "function" ? { mutate: entry } : entry;
    if (needs && skipped.has(needs)) {
      console.log(`SKIPPED mutant: ${name} (its check was skipped)`);
      continue;
    }
    const caught = (await evidenceChecks(mutate(evidence), scratch)).some((r) => !r.ok);
    console.log(`${caught ? "CAUGHT" : "MISSED"} mutant: ${name}`);
    if (!caught) failed = [...failed, { name: `mutant ${name}` }];
  }
console.log(
  JSON.stringify({ checks: main.length, skipped: skipped.size, failed: failed.length, scratch }),
);
process.exit(failed.length ? 1 : 0);
