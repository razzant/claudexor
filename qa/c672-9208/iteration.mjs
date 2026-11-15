#!/usr/bin/env node
/**
 * One #672 conversion iteration, started by batch.mjs with the smoke's
 * environment. It runs the built product in process: `inspectHarness` (the
 * smoke's `harness inspect`) and then `runHarnessUpdate("copilot")`, through
 * the product's own `options.spawn` seam. The product's sequence is unchanged:
 * npm-copy probes, vendor probes, winget, the probe at
 * harness-npm-conversion.ts:137, then the hiding rename.
 *
 *   --arm A   every argv exactly as the product builds it
 *   --arm B   Copilot `--version` probes get the declared childUpdateArgs
 *
 * Nothing is written to disk between the probes and the first rename. A
 * failed hiding rename is captured with its own error and clock first; the
 * post-failure observers run next; the product then continues and reports.
 *
 * The product's probes inherit this process's working directory (they pass no
 * cwd). batch.mjs starts it in a run-owned temporary directory, as the smoke
 * runs its CLI from one; the checkout is passed as --repo for the built modules.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { firstLine, installRenameObserver, makeSpawnSeam } from "./lib/hooks.mjs";
import { evidenceWriter } from "./lib/evidence.mjs";
import { observeHolders } from "./lib/observers.mjs";

const startedEpochMs = Date.now();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const arm = arg("arm");
const index = Number(arg("index"));
const dir = arg("evidence");
const packageRoot = arg("package-root");
const toolsFile = arg("tools");
const repo = arg("repo");
const extraRoots = JSON.parse(arg("roots") ?? "[]");
if (!["A", "B"].includes(arm) || !dir || !packageRoot || !toolsFile || !repo)
  throw new Error(
    "usage: iteration.mjs --arm A|B --index N --evidence DIR --package-root P --tools F --repo R --roots JSON",
  );

const ev = evidenceWriter(dir);
const prep = JSON.parse(readFileSync(toolsFile, "utf8"));
const SUFFIX = ".claudexor-converted";
const t0 = performance.now();
const rel = (ms) => (ms == null ? null : Math.round((ms - t0) * 10) / 10);

const hook = installRenameObserver({
  // Windows paths compare without case; the product joins the same segments.
  isTarget: (from, to) =>
    from.toLowerCase() === packageRoot.toLowerCase() &&
    to.toLowerCase() === `${packageRoot}${SUFFIX}`.toLowerCase(),
  onFailure: (event) =>
    observeHolders({
      prep,
      root: packageRoot,
      roots: [packageRoot, ...extraRoots],
      failedAtMs: event.atMs,
      listDir: join(dir, "lists"),
      label: `iter${index}-${arm}-hide-failure`,
      evidence: ev,
      sinceEpochMs: startedEpochMs,
    }),
});
const { inspectHarness, runHarnessUpdate } = await import(
  pathToFileURL(join(repo, "packages/cli/dist/harness-maintenance.js")).href
);
const { harnessProgram } = await import(
  pathToFileURL(join(repo, "packages/cli/dist/harness-programs.js")).href
);
const program = harnessProgram("copilot");
const { seam, calls } = makeSpawnSeam({
  arm,
  realSpawn: spawnSync,
  childUpdateArgs: program.childUpdateArgs ?? [],
});

let inspection = null;
let receipt = null;
let thrown = null;
let conversionAttempted = false;
try {
  inspection = await inspectHarness("copilot", { spawn: seam });
  const selection = inspection?.selection;
  if (
    !selection?.realPath?.toLowerCase().startsWith(`${packageRoot.toLowerCase()}\\`) ||
    !selection.version
  )
    throw Object.assign(
      new Error(`npm copy is not the selected answering program: ${JSON.stringify(selection)}`),
      {
        precondition: true,
      },
    );
  conversionAttempted = true;
  receipt = await runHarnessUpdate("copilot", undefined, { spawn: seam });
} catch (error) {
  thrown = { message: String(error?.message ?? error), precondition: !!error?.precondition };
}
const returnedMs = performance.now();
hook.uninstall();

// Everything below runs after the product returned.
const callRows = calls.map((c) => ({
  ...c,
  startedMs: rel(c.startedMs),
  endedMs: rel(c.endedMs),
  versionLine: c.probe ? firstLine(c.stdout) : null,
  stdout: ev.raw(`iter${index}-${arm}-spawn${c.seq}-stdout`, c.stdout),
  stderr: ev.raw(`iter${index}-${arm}-spawn${c.seq}-stderr`, c.stderr),
}));
const hide = {
  successes: hook.state.successes.map((s) => ({ ...s, atMs: rel(s.atMs) })),
  failures: hook.state.failures.map((f) => ({
    ...f,
    atMs: rel(f.atMs),
    atEpochMs: performance.timeOrigin + f.atMs,
  })),
  observerErrors: hook.state.observerErrors,
};
// Chronologically first watched rename; the product attempts one per conversion.
const firstHide =
  [hide.failures[0], hide.successes[0]].filter(Boolean).sort((a, b) => a.atMs - b.atMs)[0] ?? null;
const npmProbes = callRows.filter((c) => c.probe === "npm-copy");
const lastNpmBefore = firstHide
  ? npmProbes.filter((c) => c.endedMs <= firstHide.atMs).at(-1)
  : null;
const result = {
  arm,
  index,
  pid: process.pid,
  cwd: process.cwd(),
  startedEpochMs,
  childUpdateArgs: program.childUpdateArgs ?? [],
  inspection: inspection ? { selection: inspection.selection } : null,
  receipt,
  conversionAttempted,
  receiptRaw: receipt
    ? ev.raw(`iter${index}-${arm}-receipt`, JSON.stringify(receipt, null, 1))
    : null,
  thrown,
  spawns: callRows,
  hide,
  timing: {
    returnedMs: rel(returnedMs),
    firstHideAtMs: firstHide?.atMs ?? null,
    // Restore renames go the other way and are not watched. More than one
    // watched rename would be unexpected and stays visible here.
    hideRenamesSeen: hide.successes.length + hide.failures.length,
    firstHideOk: firstHide ? firstHide === hide.successes[0] : null,
    lastNpmProbeEndedBeforeHideMs: lastNpmBefore?.endedMs ?? null,
    gapLastNpmProbeToHideMs:
      firstHide && lastNpmBefore
        ? Math.round((firstHide.atMs - lastNpmBefore.endedMs) * 10) / 10
        : null,
  },
  answers: {
    npmCopy: npmProbes.map((c) => ({
      seq: c.seq,
      args: c.effectiveArgs.slice(-2),
      version: c.versionLine,
      status: c.status,
    })),
    native: callRows
      .filter((c) => c.probe === "native")
      .map((c) => ({ seq: c.seq, version: c.versionLine, status: c.status })),
  },
};
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
ev.record({
  phase: "iteration-result",
  arm,
  index,
  ok: receipt?.ok ?? null,
  hideFailures: hide.failures.map((f) => f.error.code),
  timing: result.timing,
  answers: result.answers,
  thrown,
});
process.exit(thrown?.precondition ? 3 : receipt ? 0 : 5);
