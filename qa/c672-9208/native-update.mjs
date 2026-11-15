#!/usr/bin/env node
/**
 * #672 QA, separate disposable Windows runner: what Copilot's own `update`
 * changes. The vendor copy is installed at the frozen older version, then
 * asked `--no-auto-update --version`, `--version`, `--no-auto-update
 * --version`; then its own `update` runs (the command the product's Update
 * route runs for an installed vendor copy); then the same three questions.
 *
 * The start is qualified before the update runs: winget exits 0, the installed
 * copilot.exe is hashed, and its first answer without auto-update reports the
 * frozen start version. The update's own result is data: whether it ran
 * cleanly, the bytes and the answers after it. No post-update version is
 * expected or required.
 *
 * Records executable hashes and cache differences around probes and update.
 * These intervals do not isolate effects of surviving probe descendants. No Claudexor code, no npm copy.
 * Exit 0: start qualified and the update command ran to exit 0, every step
 * recorded. 3: the start was not clean or not qualified (nothing updated).
 * 4: the update command did not run cleanly (its outcome and the answers after
 * it are still recorded). 5: unexpected error.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { firstLine, pickEnv } from "./lib/hooks.mjs";
import {
  answerReports,
  evidenceWriter,
  manifest,
  manifestDiff,
  present,
  ranCleanly,
  sha256File,
} from "./lib/evidence.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Real vendor installer: disposable Windows Actions runner only.");

const here = dirname(fileURLToPath(import.meta.url));
const freeze = JSON.parse(readFileSync(join(here, "freeze.json"), "utf8"));
const out = process.env.C672_EVIDENCE ?? join(process.env.RUNNER_TEMP, "c672-9208-evidence");
const ev = evidenceWriter(join(out, "native-update"));
const home = process.env.USERPROFILE;
const dotCopilot = join(home, ".copilot");
const vendorDir = join(process.env.LOCALAPPDATA, "GitHubCopilotCLI");
const vendorExe = join(vendorDir, "copilot.exe");
const startVersion = freeze.winget.nativeUpdateStartVersion;

// No CI marker, no Actions/runner variables, no Copilot overrides or secrets:
// the property of the product's clean probe environment that matters here.
const env = { ...process.env, HOME: home };
for (const key of Object.keys(env))
  if (
    /^(CI|GITHUB_.*|RUNNER_.*|ACTIONS_.*|COPILOT_.*|XDG_.*)$/i.test(key) ||
    /API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)
  )
    delete env[key];

function run(label, binary, args) {
  const start = performance.now();
  const r = spawnSync(binary, args, {
    env,
    encoding: "utf8",
    timeout: 10 * 60_000,
    windowsHide: true,
    maxBuffer: 16 << 20,
  });
  return {
    label,
    args,
    status: r.status,
    signal: r.signal,
    error: r.error ? String(r.error) : null,
    ms: Math.round(performance.now() - start),
    pid: r.pid ?? null,
    version: firstLine(r.stdout),
    stdout: ev.raw(`${label}-stdout`, r.stdout),
    stderr: ev.raw(`${label}-stderr`, r.stderr),
  };
}
function questions(label) {
  const rows = [];
  for (const [i, args] of [
    ["--no-auto-update", "--version"],
    ["--version"],
    ["--no-auto-update", "--version"],
  ].entries()) {
    const before = manifest(dotCopilot);
    const r = run(`${label}-${i}`, vendorExe, args);
    rows.push({ ...r, dotCopilotChange: manifestDiff(before, manifest(dotCopilot)) });
  }
  return rows;
}
const hashOrNull = (path) => (present(path) ? sha256File(path) : null);
const brief = (r) => ({ status: r.status, signal: r.signal, error: r.error, ms: r.ms });

let exitCode = 0;
let summary = { startVersion, startQualified: false };
try {
  const start = {
    vendorDir: present(vendorDir),
    dotCopilot: manifest(dotCopilot, { hashMax: 1 << 20 }),
  };
  ev.record({
    phase: "context",
    node: process.version,
    image: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    env: pickEnv(env),
    envKeys: Object.keys(env).sort(),
    start,
  });
  if (start.vendorDir) {
    exitCode = 3;
    throw new Error("vendor folder exists before install; nothing removed");
  }
  const install = run("winget-install", "winget", [
    "install",
    "--id",
    freeze.winget.id,
    "--exact",
    "--version",
    startVersion,
    "--accept-package-agreements",
    "--accept-source-agreements",
  ]);
  const sha0 = hashOrNull(vendorExe);
  const m0 = manifest(dotCopilot);
  ev.record({ phase: "install", install, exeSha256: sha0, dotCopilot: m0 });
  if (!ranCleanly(install) || !sha0) {
    exitCode = 3;
    throw new Error("frozen older vendor copy not installed");
  }
  const before = questions("before-update");
  ev.record({ phase: "answers-before-update", rows: before });
  // The first answer without auto-update qualifies the start; a different or
  // missing answer means this is not the frozen 1.0.111 experiment.
  if (!answerReports(before[0], startVersion)) {
    exitCode = 3;
    throw new Error(
      `start not qualified: the installed copy answered ${JSON.stringify(before[0].version)} (exit ${before[0].status}) to --no-auto-update --version, not ${startVersion}`,
    );
  }
  summary = { ...summary, startQualified: true, startExeSha256: sha0 };
  const m1 = manifest(dotCopilot);
  const shaBeforeUpdate = hashOrNull(vendorExe);
  const update = run("vendor-update", vendorExe, ["update"]);
  const updateRanCleanly = ranCleanly(update);
  const sha1 = hashOrNull(vendorExe);
  const m2 = manifest(dotCopilot);
  ev.record({
    phase: "vendor-update",
    update,
    updateRanCleanly,
    exeSha256AfterInstall: sha0,
    exeSha256Before: shaBeforeUpdate,
    exeSha256After: sha1,
    bytesChangedByQuestions: sha0 !== shaBeforeUpdate,
    embeddedBytesChanged: shaBeforeUpdate !== sha1,
    dotCopilotChange: manifestDiff(m1, m2),
    dotCopilotAfter: m2,
    vendorDir: manifest(vendorDir),
  });
  const after = questions("after-update");
  ev.record({ phase: "answers-after-update", rows: after });
  const winget = run("winget-list", "winget", [
    "list",
    "--id",
    freeze.winget.id,
    "--exact",
    "--accept-source-agreements",
  ]);
  summary = {
    ...summary,
    update: { ranCleanly: updateRanCleanly, ...brief(update) },
    answersBefore: before.map((r) => `${r.args.join(" ")} -> ${r.version} (${r.status})`),
    answersAfter: after.map((r) => `${r.args.join(" ")} -> ${r.version} (${r.status})`),
    bytesChangedByQuestions: sha0 !== shaBeforeUpdate,
    embeddedBytesChanged: shaBeforeUpdate !== sha1,
    bareVersionCacheDifference: before
      .filter((r) => r.args.length === 1)
      .map((r) => r.dotCopilotChange),
    updateCacheDifference: manifestDiff(m1, m2),
    // winget's table output is kept whole in raw; its first line is not a version.
    wingetList: { ...brief(winget), stdout: winget.stdout },
    reading:
      "Hashes immediately bracket the update command; cache differences bracket each probe or update interval. Earlier probes and their possible surviving children can also affect these intervals. Version answers alone establish neither executable origin nor an Update-only cache effect. The update's result is reported as observed; no post-update version is assumed.",
  };
  if (!updateRanCleanly) exitCode = 4;
} catch (error) {
  if (!exitCode) exitCode = 5;
  summary.stopped = String(error?.message ?? error);
  ev.record({ phase: "stopped", exitCode, reason: String(error?.stack ?? error) });
} finally {
  summary.exitCode = exitCode;
  try {
    ev.json("summary.json", summary);
    ev.record({ phase: "summary", ...summary });
  } finally {
    writeFileSync(join(out, "native-update-exit.txt"), String(exitCode));
    process.exit(exitCode);
  }
}
