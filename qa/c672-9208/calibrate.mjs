#!/usr/bin/env node
/**
 * #672 QA calibration on the disposable Windows runner, before any vendor
 * program runs. Every holder is a process this script starts; only these
 * holders may be signalled or stopped. Observers retain their coverage gaps.
 *
 * 1. Reachability: the pass-through rename observer must see a failure of the
 *    freshly built product `hideProgramPaths` (packages/core/dist).
 * 2. Holders on a synthetic package directory, one at a time: none (control),
 *    a file opened without delete sharing, the same with delete sharing, a
 *    running executable image inside the directory, a process whose current
 *    directory is inside it, and a probe-shaped parent that prints a version
 *    and exits 0 while its detached child keeps a file open.
 *    For each: the product rename's own error, which observers named the
 *    holder, then release by event and the same rename again.
 *
 * The synthetic package lives in a run-owned directory under %USERPROFILE%,
 * the volume of the product's npm prefix, not under RUNNER_TEMP (another
 * volume on hosted runners). Both volumes are recorded.
 *
 * Observers are qualified against these known holders: at least one holder
 * class must make the product rename fail, and for every class whose rename
 * failed at least one observer must name that holder's PID. One capable
 * observer per class is enough; which one names which class is measured here.
 *
 * Measures what each holder class does to the rename and what each observer
 * can see. It does not show that a real short episode would be caught.
 * Exit 0: reachability proven, every holder ready then released and the
 * directory restored, and the observers qualified (holder outcomes are data).
 * Exit 3: reachability, a holder lifecycle, restore or observer qualification
 * failed.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, parse } from "node:path";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installRenameObserver } from "./lib/hooks.mjs";
import {
  evidenceWriter,
  present,
  sha256File,
  calibrationComplete,
  namedHolder,
  observersQualified,
} from "./lib/evidence.mjs";
import { observeHolders, prepareObservers } from "./lib/observers.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Calibration runs on a disposable Windows Actions runner only.");

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = process.cwd();
const out = process.env.C672_EVIDENCE ?? join(process.env.RUNNER_TEMP, "c672-9208-evidence");
const tools = join(process.env.RUNNER_TEMP, "c672-9208-tools");
const ev = evidenceWriter(join(out, "calibration"));
const SUFFIX = ".claudexor-converted";

const prep = prepareObservers({
  source: join(here, "win", "c672obs.cs"),
  workDir: tools,
  evidence: ev,
});
writeFileSync(join(tools, "tools.json"), JSON.stringify(prep, null, 1));
ev.record({ phase: "observers", prep });

let current = null; // { root, roots, label } of the rename under test
const hook = installRenameObserver({
  isTarget: (_from, to) => to.endsWith(SUFFIX),
  onFailure: (event) =>
    current
      ? observeHolders({
          prep,
          root: current.root,
          roots: current.roots,
          failedAtMs: event.atMs,
          listDir: join(tools, "lists"),
          label: current.label,
          evidence: ev,
        })
      : null,
});
const { hideProgramPaths } = await import(
  pathToFileURL(join(repo, "packages/core/dist/index.js")).href
);

let exitCode = 0;
// Run-owned and unique, on the product prefix's volume (%USERPROFILE%\.claudexor\node).
const profile = realpathSync.native(process.env.USERPROFILE);
const base = mkdtempSync(join(profile, "c672-9208-cal-"));
const volumes = {
  calibration: parse(base).root,
  productPrefix: parse(profile).root,
  runnerTemp: parse(realpathSync.native(process.env.RUNNER_TEMP)).root,
};
volumes.sameAsProduct = volumes.calibration.toLowerCase() === volumes.productPrefix.toLowerCase();
ev.record({ phase: "volumes", base, ...volumes });

// 1. Reachability through the built product module.
{
  const missing = join(mkdtempSync(join(base, "reach-")), "absent");
  current = null;
  let code = null;
  try {
    hideProgramPaths([{ path: missing, hidden: `${missing}${SUFFIX}` }]);
  } catch (error) {
    code = error.code ?? String(error);
  }
  const seen = hook.state.failures.at(-1);
  const reached = code === "ENOENT" && seen?.from === missing && seen.error.code === "ENOENT";
  ev.record({ phase: "reachability", reached, productError: code, observed: seen ?? null });
  if (!reached) {
    exitCode = 3;
    ev.record({
      phase: "verdict",
      exitCode,
      reason: "rename observer did not see the product rename",
    });
    process.exit(exitCode);
  }
}

// 2. Holders.
const pkg = join(base, "pkg");
mkdirSync(join(pkg, "sub"), { recursive: true });
mkdirSync(join(pkg, "bin"), { recursive: true });
const file = join(pkg, "sub", "file.bin");
writeFileSync(file, "calibration");
const innerNode = join(pkg, "bin", "holder-node.exe");
copyFileSync(process.execPath, innerNode);
ev.record({ phase: "fixture", base, pkg, innerNode, innerNodeSha256: sha256File(innerNode) });

const WAIT_STDIN = `process.stdin.on("data",()=>process.exit(0));process.stdin.on("end",()=>process.exit(0));`;
const holders = {
  none: null,
  "file-no-share-delete": "no-delete",
  "file-share-delete": "delete",
  "image-inside": {
    binary: innerNode,
    args: ["-e", `console.log("ready");${WAIT_STDIN}`],
  },
  "cwd-inside": {
    binary: process.execPath,
    args: ["-e", `console.log("ready");${WAIT_STDIN}`],
    cwd: join(pkg, "sub"),
  },
  "probe-shaped-detached-child": "detached",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "ESRCH" ? false : null;
  }
};
async function waitFor(test, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (test()) return;
    await sleep(25);
  }
  throw new Error(`${label} not confirmed within ${timeout}ms`);
}
function readMarker(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function startHolder(spec) {
  const child = spawn(spec.binary, spec.args, {
    cwd: spec.cwd ?? base,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = {
    child,
    stdout: "",
    stderr: "",
    error: null,
    closed: false,
    code: null,
    signal: null,
  };
  child.stdout.on("data", (d) => {
    state.stdout += d;
  });
  child.stderr.on("data", (d) => {
    state.stderr += d;
  });
  child.on("error", (error) => {
    state.error = String(error);
  });
  child.stdin.on("error", (error) => {
    state.error = String(error);
  });
  child.on("close", (code, signal) => {
    state.closed = true;
    state.code = code;
    state.signal = signal;
  });
  return state;
}

/** The same compiled FileStream holder runs directly or behind an exited,
 * probe-shaped Node parent. The parent succeeds only after the child's ready
 * marker matches the child it spawned. Missing readiness is never success. */
function startFileHolder(mode, detached) {
  if (!prep.helper) throw new Error("compiled Windows FileStream holder unavailable");
  const id = `c672-9208-${process.pid}-${Date.now()}`;
  const marker = join(base, `${id}.ready`);
  const released = join(base, `${id}.released`);
  const args = ["hold", file, mode, marker, released, id];
  const stdoutFile = join(base, `${id}.stdout`);
  const stderrFile = join(base, `${id}.stderr`);
  const state = {
    marker,
    released,
    pipe: `\\\\.\\pipe\\${id}`,
    pid: null,
    direct: null,
    probe: null,
    mode,
    stdoutFile,
    stderrFile,
  };
  if (detached) {
    const parentCode = `const {spawn}=require("child_process"),fs=require("fs");
      const out=fs.openSync(${JSON.stringify(stdoutFile)},"wx"),err=fs.openSync(${JSON.stringify(stderrFile)},"wx");
      const c=spawn(${JSON.stringify(prep.helper.path)},${JSON.stringify(args)},{detached:true,stdio:["ignore",out,err],windowsHide:true});
      fs.closeSync(out);fs.closeSync(err);
      c.on("error",e=>{console.error(e);process.exit(3)});c.unref();
      const until=Date.now()+15000;
      const timer=setInterval(()=>{let ready=null;try{ready=JSON.parse(fs.readFileSync(${JSON.stringify(marker)},"utf8"))}catch{}
        if(ready?.pid===c.pid){clearInterval(timer);console.log("GitHub Copilot CLI 0.0.0-calibration.");process.exit(0)}
        if(Date.now()>until){clearInterval(timer);console.error("child readiness missing");process.exit(3)}},25);`;
    const start = performance.now();
    const r = spawnSync(process.execPath, ["-e", parentCode], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    state.probe = {
      status: r.status,
      signal: r.signal,
      error: r.error ? String(r.error) : null,
      stdout: r.stdout,
      stderr: r.stderr,
      pid: r.pid,
      ms: performance.now() - start,
    };
    state.pid = readMarker(marker)?.pid ?? null;
  } else {
    state.direct = startHolder({ binary: prep.helper.path, args });
    state.pid = state.direct.child.pid;
  }
  return state;
}
async function releaseFileHolder(holder) {
  // Connecting without a ready acknowledgement cannot establish release.
  await waitFor(
    () => readMarker(holder.marker)?.pid === holder.pid && Number.isInteger(holder.pid),
    "holder ready for release",
  );
  await new Promise((resolve, reject) => {
    const socket = connect(holder.pipe, () => socket.end(Buffer.from([1])));
    socket.setTimeout(15_000, () => socket.destroy(new Error("release pipe timeout")));
    socket.on("error", reject);
    socket.on("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
  await waitFor(() => {
    const ack = readMarker(holder.released);
    return ack?.pid === holder.pid && ack.released === true && ack.requested === true;
  }, "file handle disposal acknowledgement");
  await waitFor(
    () => (holder.direct ? holder.direct.closed : alive(holder.pid) === false),
    "holder exit",
  );
  if (holder.direct && (holder.direct.code !== 0 || holder.direct.signal || holder.direct.error))
    throw new Error("holder exit failed");
  return readMarker(holder.released);
}

const measured = [];
for (const [name, spec] of Object.entries(holders)) {
  const row = { phase: "holder", name };
  let child = null;
  let fileHolder = null;
  row.ready = spec === null;
  row.released = spec === null;
  try {
    if (typeof spec === "string") {
      fileHolder = startFileHolder(spec === "delete" ? "delete" : "no-delete", spec === "detached");
      row.probe = fileHolder.probe;
      row.holderPid = fileHolder.pid;
      await waitFor(
        () =>
          readMarker(fileHolder.marker)?.pid === fileHolder.pid && Number.isInteger(fileHolder.pid),
        "FileStream holder ready",
      );
      row.readyMarker = readMarker(fileHolder.marker);
      if (
        row.readyMarker.mode !== fileHolder.mode ||
        alive(fileHolder.pid) !== true ||
        (fileHolder.probe &&
          (fileHolder.probe.status !== 0 || fileHolder.probe.error || fileHolder.probe.signal))
      )
        throw new Error("holder readiness/probe exit not proved");
      row.ready = true;
    } else if (spec) {
      child = startHolder(spec);
      row.holderPid = child.child.pid;
      await waitFor(
        () => child.stdout.includes("ready") || child.closed || child.error,
        "holder readiness",
      );
      if (!child.stdout.includes("ready") || child.closed || child.error)
        throw new Error("holder exited or failed before readiness");
      row.ready = true;
    }
    current = { root: pkg, roots: [pkg], label: `cal-${name}` };
    const before = hook.state.failures.length;
    const t0 = performance.now();
    let hidden = null;
    try {
      hidden = hideProgramPaths([{ path: pkg, hidden: `${pkg}${SUFFIX}` }]);
      row.firstRename = { ok: true, ms: Math.round(performance.now() - t0) };
    } catch (error) {
      row.firstRename = {
        ok: false,
        code: error.code ?? null,
        errno: error.errno ?? null,
        message: String(error.message),
      };
    }
    const event = hook.state.failures.length > before ? hook.state.failures.at(-1) : null;
    if (event) {
      row.observation = event.observation ?? null;
      row.named = namedHolder(event.observation, row.holderPid, (file) =>
        readFileSync(join(ev.dir, file), "utf8"),
      );
    }
    if (hidden) hidden.restore();
  } catch (error) {
    row.error = String(error?.stack ?? error);
  } finally {
    current = null;
    try {
      if (child) {
        child.child.stdin.end();
        await waitFor(() => child.closed, "holder exit after release");
        row.released = child.code === 0 && !child.signal && !child.error;
        row.holderOutput = {
          stdout: child.stdout,
          stderr: child.stderr,
          code: child.code,
          error: child.error,
        };
      }
      if (fileHolder) {
        row.releaseAcknowledgement = await releaseFileHolder(fileHolder);
        row.released = true;
      }
    } catch (error) {
      row.releaseError = String(error?.stack ?? error);
    }
    if (fileHolder) {
      const readOutput = (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch (error) {
          return `unreadable: ${error.code ?? error}`;
        }
      };
      row.fileHolderOutput = {
        stdout: ev.raw(
          `${name}-holder-stdout`,
          fileHolder.direct?.stdout ?? readOutput(fileHolder.stdoutFile),
        ),
        stderr: ev.raw(
          `${name}-holder-stderr`,
          fileHolder.direct?.stderr ?? readOutput(fileHolder.stderrFile),
        ),
        error: fileHolder.direct?.error ?? null,
      };
    }
    try {
      const after = hideProgramPaths([{ path: pkg, hidden: `${pkg}${SUFFIX}` }]);
      after.restore();
      row.renameAfterRelease = "ok";
    } catch (error) {
      row.renameAfterRelease = error.code ?? String(error);
    }
    row.restored = present(pkg) && !present(`${pkg}${SUFFIX}`);
    row.complete = calibrationComplete(row);
    if (!row.complete) exitCode = 3;
    ev.record(row);
    measured.push(row);
  }
  if (exitCode) break; // a missing or unreleased holder invalidates calibration
}
hook.uninstall();
const observers = observersQualified(measured);
if (!observers.qualified) exitCode = 3;
ev.record({
  phase: "verdict",
  exitCode,
  volumes,
  observers,
  reading:
    "Holder outcomes and observer coverage are measurements of this runner, not expectations. A holder named here can be missed in a short real episode.",
});
process.exit(exitCode);
