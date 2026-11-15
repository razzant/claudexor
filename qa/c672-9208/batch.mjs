#!/usr/bin/env node
/**
 * #672 conversion batch on ONE disposable Windows Actions runner, after
 * calibrate.mjs. Fixed: the arm order in freeze.json (A,B,B,A,A,B,B,A); four
 * conversions per arm; no repetition until a colour appears.
 *
 * Setup (before any iteration): frozen inputs checked against the registry,
 * the platform tarball verified by npm and hashed, the vendor copy installed
 * at the frozen version and its own update run as the smoke does, the vendor
 * copy's answers with and without `--no-auto-update` recorded before and
 * after that update, then a snapshot S0 of ~/.copilot. The vendor setup must
 * qualify from evidence obtained here (exits, receipt, version answers without
 * auto-update, unchanged executable bytes) before S0.
 *
 * Every iteration starts from the same verified state: no matching process in
 * the bounded census scope (readable images under the observed roots, or
 * Toolhelp names containing Copilot; not handles or current directories), no
 * npm copy, ~/.copilot restored from S0 and compared by manifest, a fresh npm
 * copy whose bytes equal the verified tarball. Then iteration.mjs runs the
 * product. Afterwards, and only afterwards: a process census, the cache and
 * vendor-folder diffs and, only after a confirmed hide failure, one residual
 * QA rename if the package is still there. That QA rename is measurement after
 * a recorded product failure, never a product retry. npm dist-tags are read
 * once more after the batch.
 *
 * Exit 0: setup qualified, every iteration had a verified start and returned a
 * receipt whose product attempted the hiding rename, and npm latest did not
 * change (product outcomes, ok:false and EPERM included, are data).
 * 3: an input or setup did not qualify (registry, tarball, start state, vendor
 * setup, npm copy bytes, inspect precondition, an iteration without a complete
 * receipt), or the finished batch lacks paired comparability (a receipt without
 * a hiding rename, npm latest changed or unreadable after the batch).
 * 4: comparability could not be established or restored (a census unknown or
 * matching at the start, or still matching after the bounded wait before S0
 * or an iteration; S0 copy or restore differs; vendor folder drift; a previous
 * copy or QA sibling left behind; an unknown census after the product ran; an
 * invalid residual clock). 5: unexpected error.
 * Every record written stays.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { firstLine, pickEnv } from "./lib/hooks.mjs";
import {
  evidenceWriter,
  copyTree,
  manifest,
  manifestDiff,
  present,
  sha256File,
  parseCensus,
  requireEmptyCensus,
  requireEqualManifest,
  settleCensus,
  summarizeIteration,
  aggregateArm,
  batchVerdict,
  ranCleanly,
  qualifyVendorSetup,
  residualRename,
} from "./lib/evidence.mjs";
import { sinceArg } from "./lib/observers.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error(
    "This batch runs real vendor installers: disposable Windows Actions runner only.",
  );

class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.exit = code;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
const freeze = JSON.parse(readFileSync(join(here, "freeze.json"), "utf8"));
const out = process.env.C672_EVIDENCE ?? join(process.env.RUNNER_TEMP, "c672-9208-evidence");
const tools = join(process.env.RUNNER_TEMP, "c672-9208-tools");
const ev = evidenceWriter(join(out, "batch"));
const prep = JSON.parse(readFileSync(join(tools, "tools.json"), "utf8"));
const root = realpathSync.native(process.env.RUNNER_TEMP);
// Run-owned working directory: the smoke runs its CLI from a fresh temporary
// directory, and product probes inherit their parent's directory.
const workCwd = mkdtempSync(join(root, "c672-9208-cwd-"));
const home = process.env.USERPROFILE;
const prefix = join(home, ".claudexor", "node");
const pkg = join(prefix, "node_modules", "@github", "copilot");
const hidden = `${pkg}.claudexor-converted`;
const qaSibling = `${pkg}.c672-9208-probe`;
const launchers = ["copilot.cmd", "copilot.ps1", "copilot"].map((n) => join(prefix, n));
const dotCopilot = join(home, ".copilot");
const vendorDir = join(process.env.LOCALAPPDATA, "GitHubCopilotCLI");
const vendorExe = join(vendorDir, "copilot.exe");
const npmCache = join(tools, "npm-cache"); // run-owned, never the shared cache
const S0 = join(tools, "S0-dotcopilot");
const observedRoots = [pkg, dotCopilot, vendorDir];

const { harnessPrograms, harnessProgram } = await import(
  pathToFileURL(join(repo, "packages/cli/dist/harness-programs.js")).href
);
const { installerRuntime } = await import(
  pathToFileURL(join(repo, "packages/cli/dist/harness-install-runtime.js")).href
);
const program = harnessProgram("copilot");

// The smoke's environment for Windows, verbatim in effect (scripts/vendor-program-smoke.mjs).
const env = {
  ...process.env,
  HOME: home,
  CLAUDEXOR_CONFIG_DIR: join(root, "c672-9208-config"),
  CI: "true",
};
for (const p of harnessPrograms()) delete env[p.overrideEnv];
for (const key of Object.keys(env))
  if (
    /API_KEY|TOKEN|SECRET|PASSWORD/.test(key) ||
    /^(CODEX_HOME|CODEX_INSTALL_DIR|CLAUDE_CONFIG_DIR|CURSOR_CONFIG_DIR|COPILOT_HOME|COPILOT_CACHE_HOME|XDG_.*_HOME)$/.test(
      key,
    )
  )
    delete env[key];
mkdirSync(env.CLAUDEXOR_CONFIG_DIR, { recursive: true });
// What a product probe child receives (installerRuntime's clean environment).
const probeEnv = installerRuntime(program, { sourceEnv: env }).environment;

function run(label, binary, args, options = {}) {
  const start = performance.now();
  const r = spawnSync(binary, args, {
    env: options.env ?? env,
    cwd: options.cwd ?? workCwd,
    encoding: "utf8",
    timeout: options.timeout ?? 15 * 60_000,
    maxBuffer: 64 << 20,
    windowsHide: true,
  });
  return {
    label,
    binary,
    args,
    status: r.status,
    signal: r.signal,
    pid: r.pid ?? null,
    error: r.error ? String(r.error) : null,
    ms: Math.round(performance.now() - start),
    versionLine: firstLine(r.stdout),
    stdout: ev.raw(`${label}-stdout`, r.stdout),
    stderr: ev.raw(`${label}-stderr`, r.stderr),
    rawStdout: r.stdout ?? "",
  };
}
const strip = ({ rawStdout, ...rest }) => rest;
const npm = (label, args) =>
  run(label, process.execPath, [
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...args,
    "--cache",
    npmCache,
  ]);
const readLatest = (r) => {
  try {
    return ranCleanly(r) ? (JSON.parse(r.rawStdout).latest ?? null) : null;
  } catch {
    return null;
  }
};
const census = (label, sinceEpochMs = null) => {
  const since = sinceArg(sinceEpochMs);
  const command = prep.helper
    ? run(label, prep.helper.path, ["ps", ...(since ? [since] : []), ...observedRoots], {
        timeout: 60_000,
      })
    : null;
  const parsed = parseCensus(command, command?.rawStdout);
  ev.record({ phase: "census", label, command: command ? strip(command) : null, parsed });
  return parsed;
};
/** Vendor copy answers with and without the declared flag, product probe env. */
function nativeAnswers(label) {
  return ["--no-auto-update --version", "--version", "--no-auto-update --version"].map((a, i) => {
    const r = run(`${label}-${i}`, vendorExe, a.split(" "), { env: probeEnv, timeout: 60_000 });
    return {
      args: a,
      status: r.status,
      error: r.error,
      signal: r.signal,
      version: r.versionLine,
      ms: r.ms,
      pid: r.pid,
    };
  });
}
const hashOrNull = (path) => (present(path) ? sha256File(path) : null);

const rows = [];
let exitCode = 0;
let latestBefore;
let setupQualification = null;
try {
  // ---- context ------------------------------------------------------------
  const defender = run("defender", "powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-MpComputerStatus | Select-Object AMRunningMode,AntivirusEnabled,RealTimeProtectionEnabled,OnAccessProtectionEnabled,AMProductVersion | ConvertTo-Json -Compress",
  ]);
  ev.record({
    phase: "context",
    commit: process.env.GITHUB_SHA ?? null,
    node: process.version,
    nodeSha256: sha256File(process.execPath),
    image: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    freeze,
    qaFiles: Object.fromEntries(
      [
        "batch.mjs",
        "iteration.mjs",
        "calibrate.mjs",
        "lib/hooks.mjs",
        "lib/evidence.mjs",
        "lib/observers.mjs",
        "win/c672obs.cs",
        "freeze.json",
      ].map((f) => [f, sha256File(join(here, f))]),
    ),
    tools: prep,
    workCwd,
    defender: strip(defender),
    smokeEnv: pickEnv(env),
    smokeEnvKeys: Object.keys(env).sort(),
    probeEnv: pickEnv(probeEnv),
    probeEnvKeys: Object.keys(probeEnv).sort(),
    deviations: [
      "winget install adds --version 1.0.112 (the smoke installs the latest, which was 1.0.112 on 14 Nov)",
      "inspect runs in process through options.spawn (synchronous resolver); the smoke's CLI inspect used the asynchronous resolver",
      "agy, claude, codex and grok are not installed or converted first; calibrate.mjs ran its own synthetic holders on this runner before the batch",
      "setup asks the vendor copy six direct version questions (with and without --no-auto-update) around its update; the smoke asks none",
      "~/.copilot is restored from a snapshot before each iteration; the historical run had one conversion",
      "before each iteration QA reads and hashes the fresh npm copilot.exe, npm-loader.js, package.json and the vendor folder, so the package bytes are read (file cache, possible antivirus scan) before the product touches them",
      "the npm copy is installed with a run-owned npm cache and --prefer-offline; the smoke used the runner's default cache",
      "iteration.mjs requires the inspect selection to report a version; the smoke's conversion requires only the npm-copy path, so a missing answer here stops the batch as a precondition",
    ],
  });

  // ---- frozen inputs ------------------------------------------------------
  const tags = npm("npm-dist-tags", ["view", freeze.npm.package, "dist-tags", "--json"]);
  const integrity = npm("npm-integrity", [
    "view",
    `${freeze.npm.package}@${freeze.npm.version}`,
    "dist.integrity",
  ]);
  const platformIntegrity = npm("npm-platform-integrity", [
    "view",
    `${freeze.npm.platformPackage}@${freeze.npm.platformVersion}`,
    "dist.integrity",
  ]);
  latestBefore = readLatest(tags);
  const freezeCheck = {
    latest: latestBefore,
    latestMatches: latestBefore === freeze.expectedLatest,
    integrityMatches: ranCleanly(integrity) && integrity.rawStdout.trim() === freeze.npm.integrity,
    platformIntegrityMatches:
      ranCleanly(platformIntegrity) &&
      platformIntegrity.rawStdout.trim() === freeze.npm.platformIntegrity,
  };
  ev.record({ phase: "freeze-check", ...freezeCheck });
  if (!latestBefore) throw new Stop(3, "npm dist-tags could not be read");
  if (!freezeCheck.integrityMatches || !freezeCheck.platformIntegrityMatches)
    throw new Stop(3, "registry integrity differs from freeze.json or was not read");
  if (!freezeCheck.latestMatches && process.env.C672_ALLOW_LATEST_DRIFT !== "1")
    throw new Stop(
      3,
      `latest is ${latestBefore}, not ${freeze.expectedLatest}: auto-update targets differ from the frozen failure`,
    );

  const packDir = join(tools, "pack");
  mkdirSync(packDir, { recursive: true });
  const pack = npm("npm-pack-platform", [
    "pack",
    `${freeze.npm.platformPackage}@${freeze.npm.platformVersion}`,
    "--json",
    "--pack-destination",
    packDir,
  ]);
  let packed = {};
  try {
    packed = JSON.parse(pack.rawStdout || "[]")[0] ?? {};
  } catch {
    packed = {};
  }
  const unpack = join(packDir, "x");
  mkdirSync(unpack, { recursive: true });
  const untar = run("untar-platform", "tar.exe", [
    "-xzf",
    join(packDir, packed.filename ?? "missing.tgz"),
    "-C",
    unpack,
  ]);
  const packedExe = join(unpack, "package", "copilot.exe");
  const exeSha256 = ranCleanly(untar) ? hashOrNull(packedExe) : null;
  ev.record({
    phase: "platform-tarball",
    pack: strip(pack),
    integrity: packed.integrity ?? null,
    filename: packed.filename ?? null,
    untar: strip(untar),
    exeSha256,
  });
  if (!ranCleanly(pack) || packed.integrity !== freeze.npm.platformIntegrity || !exeSha256)
    throw new Stop(3, "platform tarball not verified");
  rmSync(unpack, { recursive: true, force: true });

  // ---- clean start --------------------------------------------------------
  const start = {
    npmCopy: present(pkg),
    hiddenSibling: present(hidden),
    qaSibling: present(qaSibling),
    launchers: launchers.filter(present),
    dotCopilot: manifest(dotCopilot, { hashMax: 1 << 20 }),
    vendorDir: present(vendorDir),
    processes: census("census-start"),
  };
  ev.record({ phase: "start-state", ...start });
  if (
    start.npmCopy ||
    start.hiddenSibling ||
    start.qaSibling ||
    start.launchers.length ||
    start.vendorDir
  )
    throw new Stop(3, "Copilot state of unknown origin before setup; nothing removed");

  requireEmptyCensus(start.processes);

  // ---- vendor copy, its update, native answers -----------------------------
  const install = run("winget-install", "winget", [
    "install",
    "--id",
    freeze.winget.id,
    "--exact",
    "--version",
    freeze.winget.batchVersion,
    "--accept-package-agreements",
    "--accept-source-agreements",
  ]);
  const vendorSha0 = hashOrNull(vendorExe);
  ev.record({ phase: "vendor-install", run: strip(install), vendorExeSha256: vendorSha0 });
  if (!ranCleanly(install) || !vendorSha0) throw new Stop(3, "vendor copy not installed");
  const dot0 = manifest(dotCopilot);
  const answersBefore = nativeAnswers("native-before-update");
  const dot1 = manifest(dotCopilot);
  const vendorShaBeforeUpdate = hashOrNull(vendorExe);
  const update = run("cli-update-vendor", process.execPath, [
    join(repo, "packages/cli/dist/cli.js"),
    "harness",
    "update",
    "copilot",
    "--yes",
    "--json",
  ]);
  let receipt = null;
  try {
    receipt = JSON.parse(update.rawStdout);
  } catch {
    receipt = null;
  }
  const vendorSha1 = hashOrNull(vendorExe);
  const dot2 = manifest(dotCopilot);
  const answersAfter = nativeAnswers("native-after-update");
  setupQualification = qualifyVendorSetup({
    version: freeze.winget.batchVersion,
    vendorExe,
    install,
    hashes: {
      afterInstall: vendorSha0,
      beforeUpdate: vendorShaBeforeUpdate,
      afterUpdate: vendorSha1,
    },
    answersBefore,
    update,
    receipt,
    answersAfter,
  });
  ev.record({
    phase: "vendor-update",
    update: strip(update),
    receipt: receipt
      ? {
          ok: receipt.ok ?? null,
          outcome: receipt.outcome ?? null,
          before: receipt.before ?? null,
          after: receipt.after ?? null,
          problem: receipt.problem ?? null,
          limitations: receipt.limitations ?? null,
        }
      : null,
    vendorExeSha256AfterInstall: vendorSha0,
    vendorExeSha256Before: vendorShaBeforeUpdate,
    vendorExeSha256After: vendorSha1,
    embeddedBytesChanged: vendorShaBeforeUpdate !== vendorSha1,
    answersBefore,
    answersAfter,
    dotCopilotAfterInstall: dot0,
    dotCopilotChangeByAnswers: manifestDiff(dot0, dot1),
    dotCopilotChangeByUpdate: manifestDiff(dot1, dot2),
    // Provenance only: winget checks its download against its own source
    // manifest; the MSI hash is not the installed copilot.exe hash.
    msiSha256Provenance: freeze.winget.provenance?.batchMsiSha256 ?? null,
    qualification: setupQualification,
  });
  if (!setupQualification.qualified)
    throw new Stop(3, `vendor setup not qualified: ${setupQualification.reasons.join("; ")}`);

  // ---- S0 -------------------------------------------------------------------
  const settle = await settleCensus(() => census("census-before-S0"));
  ev.record({ phase: "before-S0", first: settle.first, last: settle.last, looks: settle.looks });
  requireEmptyCensus(settle.last);
  if (present(dotCopilot)) copyTree(dotCopilot, S0);
  const s0 = manifest(S0);
  const v0 = manifest(vendorDir);
  ev.record({ phase: "S0", dotCopilot: s0, vendorDir: v0 });
  requireEqualManifest(manifestDiff(s0, manifest(dotCopilot)), "S0 copy");
  requireEqualManifest(manifestDiff(v0, v0), "vendor baseline coverage");

  // ---- iterations -------------------------------------------------------------
  for (const [n, arm] of freeze.order.entries()) {
    const i = n + 1;
    const row = { phase: "iteration", i, arm };
    try {
      // a. no observed match may carry over; census path gaps remain evidence
      const hygiene = await settleCensus(() => census(`census-pre-${i}`));
      row.preCensusFirst = hygiene.first;
      row.preCensus = hygiene.last;
      row.preCensusLooks = hygiene.looks;
      requireEmptyCensus(hygiene.last);
      row.vendorStart = manifestDiff(v0, manifest(vendorDir));
      requireEqualManifest(row.vendorStart, "vendor baseline before mutation");

      // b. remove the previous npm copy (recorded first)
      if (present(pkg) || present(hidden) || present(qaSibling) || launchers.some(present)) {
        row.leftover = {
          pkg: present(pkg) ? manifest(pkg, { hashMax: 1 << 20 }) : null,
          hidden: present(hidden) ? manifest(hidden, { hashMax: 1 << 20 }) : null,
          qaSibling: present(qaSibling),
          launchers: launchers.filter(present),
        };
        if (row.leftover.qaSibling) throw new Stop(4, "a QA rename sibling was not restored");
        if (present(pkg))
          row.uninstall = strip(
            npm(`npm-uninstall-${i}`, [
              "uninstall",
              "--global",
              "--prefix",
              prefix,
              "--no-audit",
              "--no-fund",
              freeze.npm.package,
            ]),
          );
        for (const l of launchers) if (present(l)) rmSync(l);
        if (present(hidden)) rmSync(hidden, { recursive: true });
        if (present(pkg) || present(hidden) || launchers.some(present))
          throw new Stop(4, "previous npm copy could not be removed");
      }

      // c. ~/.copilot back to S0
      rmSync(dotCopilot, { recursive: true, force: true });
      if (present(S0)) copyTree(S0, dotCopilot);
      row.dotCopilotStart = manifestDiff(s0, manifest(dotCopilot));
      requireEqualManifest(row.dotCopilotStart, "~/.copilot after restore");

      // d. fresh npm copy with the verified bytes
      const inst = npm(`npm-install-${i}`, [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        `${freeze.npm.package}@${freeze.npm.version}`,
      ]);
      row.install = strip(inst);
      const platformDir = join(pkg, "node_modules", "@github", "copilot-win32-x64");
      const pj = (d) => {
        try {
          return JSON.parse(readFileSync(join(d, "package.json"), "utf8")).version;
        } catch {
          return null;
        }
      };
      row.fixture = {
        version: pj(pkg),
        platformVersion: pj(platformDir),
        loaderSha256: hashOrNull(join(pkg, "npm-loader.js")),
        packageJsonSha256: hashOrNull(join(pkg, "package.json")),
        exeSha256: hashOrNull(join(platformDir, "copilot.exe")),
        launchers: launchers.filter(present),
      };
      const f = row.fixture;
      if (
        !ranCleanly(inst) ||
        f.version !== freeze.npm.version ||
        f.platformVersion !== freeze.npm.platformVersion ||
        f.loaderSha256 !== freeze.npm.files["npm-loader.js"] ||
        f.packageJsonSha256 !== freeze.npm.files["package.json"] ||
        f.exeSha256 !== exeSha256 ||
        !f.launchers.includes(join(prefix, "copilot.cmd"))
      )
        throw new Stop(3, "npm copy differs from the frozen bytes");

      // e. the product iteration, from the run-owned working directory
      const iterDir = join(ev.dir, `iter-${i}-${arm}`);
      row.startedEpochMs = Date.now();
      const child = run(`iteration-${i}-${arm}`, process.execPath, [
        join(here, "iteration.mjs"),
        "--arm",
        arm,
        "--index",
        String(i),
        "--evidence",
        iterDir,
        "--package-root",
        pkg,
        "--tools",
        join(tools, "tools.json"),
        "--repo",
        repo,
        "--roots",
        JSON.stringify([dotCopilot, vendorDir]),
      ]);
      row.child = strip(child);

      // f. only now: retain the full result, then a bounded census and at
      // most one residual rename. No observers are repeated for that check.
      let result = null;
      try {
        result = JSON.parse(readFileSync(join(iterDir, "result.json"), "utf8"));
      } catch (error) {
        row.resultError = String(error);
      }
      row.result = summarizeIteration(result, child);
      row.resultFile = join(iterDir, "result.json");
      row.postCensus = census(`census-post-${i}`, row.startedEpochMs);
      row.packageAfter = present(pkg);
      row.residual =
        row.packageAfter && row.postCensus.known
          ? residualRename(result, {
              now: () => performance.timeOrigin + performance.now(),
              rename: renameSync,
              from: pkg,
              to: qaSibling,
            })
          : null;
      row.dotCopilotChange = manifestDiff(s0, manifest(dotCopilot));
      row.vendorChange = manifestDiff(v0, manifest(vendorDir));
      if (child.status !== 0) row.iterationExit = child.status;
      if (row.residual?.incomplete) throw new Stop(4, "residual check has no valid failure clock");
      if (row.residual?.restored === false)
        throw new Stop(4, "residual rename sibling could not be restored");
      if (!row.result.complete)
        throw new Stop(3, "iteration did not return a complete product receipt");
      if (!row.postCensus.known) throw new Stop(4, `post-census unknown: ${row.postCensus.reason}`);
      requireEqualManifest(row.vendorChange, "vendor baseline after iteration");
      // A receipt without the hiding rename is recorded and the fixed order
      // continues; it withholds paired comparability at the end.
    } catch (error) {
      row.error = String(error?.stack ?? error);
      throw error;
    } finally {
      ev.record(row);
      rows.push(row);
    }
  }
} catch (error) {
  exitCode = error instanceof Stop ? error.exit : error.incomplete ? 4 : 5;
  ev.record({ phase: "stopped", exitCode, reason: String(error?.stack ?? error) });
} finally {
  // One more registry read, after the batch or its stop: did latest move?
  let latestAfter = null;
  if (latestBefore !== undefined)
    try {
      const tagsAfter = npm("npm-dist-tags-after", [
        "view",
        freeze.npm.package,
        "dist-tags",
        "--json",
      ]);
      latestAfter = readLatest(tagsAfter);
      ev.record({ phase: "freeze-recheck", run: strip(tagsAfter), latestBefore, latestAfter });
    } catch (error) {
      ev.record({ phase: "freeze-recheck", error: String(error?.stack ?? error) });
    }
  const verdict = batchVerdict(rows, freeze.order, {
    latestBefore: latestBefore ?? null,
    latestAfter,
  });
  if (exitCode === 0 && !verdict.comparable) {
    exitCode = 3;
    ev.record({ phase: "incomplete", reasons: verdict.reasons });
  }
  const summary = {
    exitCode,
    completeBatch: exitCode === 0 && verdict.comparable,
    comparability: verdict,
    latest: {
      before: latestBefore ?? null,
      after: latestAfter,
      frozen: freeze.expectedLatest,
      driftAllowedLabel: process.env.C672_ALLOW_LATEST_DRIFT === "1",
    },
    vendorSetup: setupQualification,
    A: aggregateArm(rows, "A"),
    B: aggregateArm(rows, "B"),
    reading: [
      "Per arm, hideAttempts (receipts whose product attempted the hiding rename) is the denominator; receipts without that rename, precondition stops and incomplete outcomes are listed separately.",
      "No hide failure in an arm means the condition was not caught in that arm; it does not show the arm is free of it.",
      "Failures in both arms do not show that auto-update is irrelevant: the flag also changes the executed version, cache use and timing, and equal errors can have different holders.",
      "An empty Restart Manager, census or handle list is a later bounded look, not proof that no holder existed.",
      "Process counts cover readable images under the observed roots and Copilot names only. Recent rows list up to 64 processes created since the iteration started that were still present after it returned; neither shows handles or current directories.",
      "A named holder supports a cause only together with its resource and its link to a probe.",
    ],
  };
  ev.json("summary.json", summary);
  ev.record({ phase: "summary", ...summary });
  writeFileSync(join(out, "batch-exit.txt"), String(exitCode));
  process.exit(exitCode);
}
