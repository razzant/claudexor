#!/usr/bin/env node
/**
 * #672 TEST-ONLY native-Windows qualification of the rename-failure capture,
 * run BEFORE acceptance. NOT a product gate. It proves the one thing an offline
 * reachability check and the QA calibration cannot: that the preload, attached
 * with `--require` to the REAL built `cli.js`, catches the REAL Copilot
 * conversion's hide rename when a known holder makes it fail, names that holder,
 * keeps the product's own error, and stays silent on the healthy path.
 *
 * It reuses the smoke's CLI entry, verbs and preload, but copies the launch:
 * env is inherited without the smoke's HOME/config/credential filtering, and
 * cwd/timeouts differ. Only the actual Windows smoke CI proves its native
 * healthy integration. The vendor is a real winget install; the holder is
 * synthetic. One
 * `--case` runs per invocation so a workflow matrix keeps each on its own fresh
 * runner:
 *
 *   control         no holder: the conversion SUCCEEDS and actually retires the
 *                   npm copy (package + owned .cmd gone, no hidden sibling, receipt
 *                   changed/applied) and NO capture file is written.
 *   held-file       a process holds a file in the npm package without delete
 *                   sharing: the hide rename throws the exact EPERM, the product
 *                   keeps that cause, and the capture names the holder.
 *   held-cwd        a process whose current directory is a synthetic subdirectory
 *                   inside the npm package (calibrated shape), named by handle64.
 *   broken-observer held-file with a tools manifest pointing at absent observers:
 *                   the capture records the gap, the product error is still the
 *                   original EPERM, nothing crashes.
 *
 * No process.exit runs inside a holder's lifetime: every path records a result,
 * releases the measured child with an acknowledged exit, records cleanup
 * separately, and exits once at the end. No broad cleanup and no name/pattern
 * process control: only the child this driver started is ever stopped.
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlFailure,
  conversionPreconditionFailure,
  heldCaptureFailure,
  receiptCauseIsConversionEperm,
  settleHolderExit,
  retainCliResult,
  retainQualification,
} from "./capture-qualification.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error(
    "Qualification runs real vendor installers on a disposable Windows Actions runner only.",
  );

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const preload = join(here, "c672-rename-capture.cjs");
const cliJs = join(repo, "packages/cli/dist/cli.js");

const caseName = (() => {
  const i = process.argv.indexOf("--case");
  return i > 0 ? process.argv[i + 1] : null;
})();
const CASES = new Set(["control", "held-file", "held-cwd", "broken-observer"]);
if (!CASES.has(caseName))
  throw new Error(`usage: qualify-rename-capture.mjs --case ${[...CASES].join("|")}`);

const home = realpathSync.native(process.env.USERPROFILE);
const prefix = join(home, ".claudexor", "node");
const packageRoot = join(prefix, "node_modules", "@github", "copilot");
const hiddenSibling = `${packageRoot}.claudexor-converted`;
const base = mkdtempSync(join(home, "c672-qual-"));
const evidence = process.env.C672_CAPTURE_DIR ?? join(base, "evidence");
mkdirSync(evidence, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { case: caseName, qualified: false, reason: null, details: {}, cleanup: {} };
let cliSequence = 0;

function runCli(args, { capture = false, brokenTools = false } = {}) {
  const env = { ...process.env, CI: "true" };
  if (capture) {
    env.C672_CAPTURE_DIR = evidence;
    env.C672_CAPTURE_TOOLS = brokenTools ? writeBrokenTools() : process.env.C672_CAPTURE_TOOLS;
  } else {
    delete env.C672_CAPTURE_DIR;
  }
  const nodeArgs = capture ? ["--require", preload] : [];
  const argv = [...nodeArgs, cliJs, ...args, "--json"];
  const r = spawnSync(process.execPath, argv, {
    env,
    cwd: base,
    timeout: 20 * 60_000,
    maxBuffer: 16 << 20,
  });
  return retainCliResult(evidence, `cli-${++cliSequence}`, argv, r);
}

function writeBrokenTools() {
  const broken = join(base, "broken-tools.json");
  writeFileSync(
    broken,
    JSON.stringify({
      helper: { path: join(base, "absent-c672obs.exe"), sha256: "0".repeat(64) },
      handle: { path: join(base, "absent-handle64.exe"), sha256: "0".repeat(64), signer: "none" },
      gaps: ["synthetic broken-observer manifest"],
    }),
  );
  return broken;
}

function npm(args) {
  const r = spawnSync(
    process.execPath,
    [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args],
    {
      env: { ...process.env, CI: "true" },
      cwd: base,
      encoding: "utf8",
      timeout: 15 * 60_000,
      maxBuffer: 16 << 20,
    },
  );
  if (r.status !== 0)
    throw new Error(`npm ${args.join(" ")} failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function captureFiles() {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name === "capture.json") out.push(p);
    }
  };
  if (existsSync(evidence)) walk(evidence);
  return out;
}

function ensureVendorInstalled() {
  const inspect = runCli(["harness", "inspect", "copilot"]);
  const selected = inspect.receipt?.harnesses?.[0]?.selection;
  if (selected?.path && !selected.path.startsWith(prefix)) return;
  const install = runCli(["harness", "install", "copilot", "--yes"]);
  if (!install.receipt?.after?.path)
    throw new Error(`vendor install did not establish a program: ${install.stdout}`);
}

/** A fresh runner has no product prefix. Refuse an unexpected pre-existing one
 * rather than deleting user data; then let real npm create the copy. */
function establishNpmCopy() {
  if (existsSync(prefix))
    throw new Error(
      `refusing to touch a pre-existing product prefix at ${prefix}; qualification expects a fresh runner`,
    );
  const versions = JSON.parse(npm(["view", "@github/copilot", "versions", "--json"]));
  const released = [versions].flat().filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const old = released.at(-2) ?? released.at(-1);
  npm([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    `@github/copilot@${old}`,
  ]);
  if (!existsSync(packageRoot)) throw new Error("npm copy was not created");
  return old;
}

function startFileHolder() {
  const toolsPath = process.env.C672_CAPTURE_TOOLS;
  const helper =
    toolsPath && existsSync(toolsPath) ? JSON.parse(readFileSync(toolsPath, "utf8")).helper : null;
  if (!helper?.path) throw new Error("file holder needs the compiled c672obs helper");
  const id = `c672-qual-${process.pid}-${Date.now()}`;
  const ready = join(base, `${id}.ready`);
  const released = join(base, `${id}.released`);
  const child = spawn(
    helper.path,
    ["hold", join(packageRoot, "package.json"), "no-delete", ready, released, id],
    {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  return { kind: "file", child, ready, released, pipe: `\\\\.\\pipe\\${id}` };
}

function startCwdHolder() {
  // Synthetic fixture content on this fresh runner, matching the calibrated
  // descendant-directory holder rather than holding the rename target itself.
  const cwd = mkdtempSync(join(packageRoot, "c672-cwd-"));
  const ready = join(base, `cwd-${process.pid}-${Date.now()}.ready`);
  const code = `require("fs").writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.stdin.on("end",()=>process.exit(0));process.stdin.resume();`;
  const child = spawn(process.execPath, ["-e", code], {
    cwd,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  return { kind: "cwd", child, ready };
}

async function waitFor(test, label, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (test()) return true;
    await sleep(100);
  }
  throw new Error(`${label} not observed within ${timeoutMs}ms`);
}

/** Release the measured child with an acknowledged exit; record cleanup
 * separately as ok, unknown or failed. Never a blind kill-and-declare-done. */
async function releaseHolder(holder) {
  let cleanup = { kind: holder.kind };
  try {
    if (holder.kind === "file") {
      await new Promise((resolve) => {
        const socket = connect(holder.pipe, () => socket.end(Buffer.from([1])));
        socket.setTimeout(15_000, () => socket.destroy());
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
    } else {
      holder.child.stdin.end();
    }
    cleanup = await settleHolderExit(holder);
  } catch (error) {
    cleanup.status = "failed";
    cleanup.error = error instanceof Error ? error.message : String(error);
  }
  result.cleanup = cleanup;
}

async function qualifyControl() {
  if (captureFiles().length !== 0) {
    result.reason = "evidence present before the conversion";
    return;
  }
  const run = runCli(["harness", "update", "copilot", "--yes"], { capture: true });
  result.details.cliArtifact = `cli-${cliSequence}.json`;
  const remainingLaunchers = ["copilot.cmd", "copilot.ps1", "copilot"].filter((n) =>
    existsSync(join(prefix, n)),
  );
  const facts = {
    packagePresent: existsSync(packageRoot),
    hiddenPresent: existsSync(hiddenSibling),
    remainingLaunchers,
    captureCount: captureFiles().length,
  };
  Object.assign(result.details, facts);
  result.reason = controlFailure({ run, ...facts });
  result.qualified = result.reason === null;
}

async function qualifyHeld(holder) {
  if (holder.kind === "file") await waitFor(() => existsSync(holder.ready), "file holder ready");
  else {
    await waitFor(() => existsSync(holder.ready), "cwd holder ready");
    result.details.holderCwd = JSON.parse(readFileSync(holder.ready, "utf8")).cwd;
  }
  const run = runCli(["harness", "update", "copilot", "--yes"], {
    capture: true,
    brokenTools: caseName === "broken-observer",
  });
  result.details.cliArtifact = `cli-${cliSequence}.json`;

  const caps = captureFiles();
  // A held conversion must produce exactly one capture.
  if (caps.length !== 1) {
    result.reason =
      conversionPreconditionFailure(run.receipt, caps.length) ??
      `expected exactly one capture file, found ${caps.length}; see full CLI receipt`;
    return;
  }
  const record = JSON.parse(readFileSync(caps[0], "utf8"));
  result.details.captured = {
    code: record.error?.code ?? null,
    from: record.from,
    status: record.status,
  };
  if (
    run.error ||
    run.signal ||
    run.status === null ||
    !receiptCauseIsConversionEperm(run.receipt, record, packageRoot)
  ) {
    result.reason = "product receipt did not keep the captured Copilot hide EPERM cause";
    return;
  }

  const captureFailure = heldCaptureFailure(record, caseName);
  if (captureFailure) {
    result.reason = captureFailure;
    return;
  }
  if (caseName === "broken-observer") {
    result.details.gaps = record.gaps;
    result.qualified = true;
    result.details.note = "original EPERM preserved; complete capture records observer gap";
    return;
  }

  const holderPid = holder.child.pid;
  const dir = dirname(caps[0]);
  const rmFile = record.observers?.restartManager?.stdout?.file;
  const handleFile = record.observers?.handle64?.stdout?.file;
  const rmStdout = rmFile ? readFileSync(join(dir, rmFile), "utf8") : "";
  const handleStdout = handleFile ? readFileSync(join(dir, handleFile), "utf8") : "";
  const named =
    new RegExp(`"pid":${holderPid}\\b`).test(rmStdout) ||
    new RegExp(`\\bpid:\\s*${holderPid}\\b`).test(handleStdout);
  result.details.holderPid = holderPid;
  if (!named) {
    result.reason = "no observer named the holder PID";
    result.details.rmPreview = rmStdout.slice(0, 400);
    result.details.handlePreview = handleStdout.slice(0, 400);
    return;
  }
  result.qualified = true;
  result.details.note = "capture named the holder and the product kept its EPERM";
}

const main = async () => {
  ensureVendorInstalled();
  establishNpmCopy();
  if (caseName === "control") {
    result.cleanup = { status: "not_needed", reason: "no holder started" };
    await qualifyControl();
    return;
  }
  const holder = caseName === "held-cwd" ? startCwdHolder() : startFileHolder();
  try {
    await qualifyHeld(holder);
  } finally {
    await releaseHolder(holder);
  }
};

main()
  .catch((error) => {
    result.qualified = false;
    result.reason = `qualification threw: ${error instanceof Error ? error.message : String(error)}`;
  })
  .finally(() => {
    const exitCode = retainQualification(evidence, result);
    console.log(JSON.stringify(result));
    process.exit(exitCode);
  });
