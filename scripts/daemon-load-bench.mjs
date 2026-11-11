#!/usr/bin/env node
/**
 * Compare a git base and working tree using identical, isolated store + HTTP
 * daemon compositions. No provider calls, credentials, managed roots or CLI
 * daemon discovery. pnpm install --offline first; then:
 *   node scripts/daemon-load-bench.mjs --base 0919faac4 --seconds 30 --rounds 4 --out results.json
 * Uses the installed esbuild to bundle each tree's source, with its own workspace
 * aliases. Identical benchmark-only observers label synchronous work and add
 * COMMIT percentiles to BOTH builds; they change no native calls or pragmas.
 * Each trial: 200 model-shaped transactions/s over nine partitions, a distinct
 * 200 KiB external body every twentieth write, four paced run-detail clients
 * totaling 60 reads/s, and status polling. Rounds count pairs, alternating AB/BA
 * (two rounds = ABBA). Waits for the last loop window; retains raw status samples.
 */
import { build } from "esbuild";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  benchmarkOptions,
  buildSummaries,
  instrumentSyncFunction,
  loopTail,
  runSummary,
  trialOrder,
} from "./lib/daemon-load-bench.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { base, seconds, rounds, out } = benchmarkOptions(process.argv.slice(2));
const scratch = mkdtempSync(join(tmpdir(), "cx-daemon-load-"));
const output = resolve(out);
const results = {
  base: execFileSync("git", ["rev-parse", base], { cwd: repo, encoding: "utf8" }).trim(),
  candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  // The candidate is bundled from the working tree, so HEAD alone does not name what ran.
  candidateDirty:
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repo,
      encoding: "utf8",
    }).trim() !== "",
  node: process.version,
  seconds,
  rate: 200,
  readsPerSecond: 60,
  rounds,
  instrumentation:
    "identical post-COMMIT histogram, BEGIN wait, external-write and run-detail timers on both builds; per-window maxima captured at the native loop roll via IPC",
  attribution:
    "worst labelled synchronous section in each loop window; temporal association, not proof of the exact cause of its maximum delay",
  trials: [],
};
const owned = new Set();

async function bundle(tree, label) {
  const aliases = { "@bench/sync-observer": join(repo, "scripts/lib/daemon-load-observer.mjs") };
  for (const directory of readdirSync(join(tree, "packages"))) {
    const location = join(tree, "packages", directory);
    try {
      aliases[JSON.parse(readFileSync(join(location, "package.json"), "utf8")).name] = join(
        location,
        "src",
        "index.ts",
      );
    } catch {
      /* not a package */
    }
  }
  for (const [name, path] of Object.entries({
    store: "daemon/src/store/store.ts",
    blobs: "daemon/src/store/blob-files.ts",
    partitions: "daemon/src/store/partitions.ts",
    events: "daemon/src/store/retention.ts",
    http: "control-api/src/daemon-server.ts",
    health: "daemon/src/daemon-health.ts",
    loop: "daemon/src/loop-facts.ts",
  }))
    aliases[`@fixture/${name}`] = join(tree, "packages", path);
  const outfile = join(scratch, `claudexord-${label}.mjs`);
  await build({
    entryPoints: [join(repo, "scripts/benchmarks/daemon-load-fixture.mjs")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    alias: aliases,
    banner: {
      js: 'import { createRequire as benchRequire } from "node:module"; const require = benchRequire(import.meta.url);',
    },
    nodePaths: [join(repo, "node_modules"), join(repo, "node_modules/.pnpm/node_modules")],
    plugins: [
      {
        name: "benchmark-sync-labels",
        setup(builder) {
          builder.onLoad({ filter: /[\\/](external-files|daemon-server)\.ts$/ }, ({ path }) => {
            const external = path.endsWith("external-files.ts");
            return {
              contents: instrumentSyncFunction(
                readFileSync(path, "utf8"),
                external ? "writeExternalFile" : "detailFor",
                external ? "store.external_write" : "control.run_detail",
              ),
              loader: "ts",
            };
          });
        },
      },
    ],
    logLevel: "warning",
  });
  return outfile;
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    owned.delete(child);
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM"); // exact ChildProcess PID owned by this trial
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
    owned.delete(child);
  }
}

async function trial(bundlePath, label, round) {
  const root = mkdtempSync(join(scratch, `${label}-${round}-`));
  const token = randomUUID();
  const config = { root, token, seconds, rate: results.rate };
  const child = fork(bundlePath, [JSON.stringify(config)], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDEXOR_CONFIG_DIR: root,
      HOME: join(root, "home"),
      CLAUDEXOR_BUILD_SHA: label === "base" ? results.base : results.candidate,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  owned.add(child);
  const loops = [];
  child.on("message", (value) => {
    if (value.loopWindow) loops.push(value.loopWindow);
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-16_384);
  });
  const message = (predicate) =>
    new Promise((resolveMessage, reject) => {
      const deadline = setTimeout(
        () => finish(new Error(`fixture message timed out: ${stderr}`)),
        (seconds + 30) * 1_000,
      );
      const onMessage = (value) => {
        if (predicate(value)) finish(null, value);
      };
      const onExit = () => finish(new Error(`fixture exited early: ${stderr}`));
      const onError = (error) => finish(error);
      const finish = (error, value) => {
        clearTimeout(deadline);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
        error ? reject(error) : resolveMessage(value);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  try {
    const ready = await message((value) => value.ready);
    console.error(`started ${label} round ${round}, owned PID ${child.pid}`);
    const origin = `http://${ready.host}:${ready.port}`;
    const headers = { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" };
    const get = async (path) => {
      const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(15_000) });
      if (response.status !== 200)
        throw new Error(`${path}: ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const samples = [];
    let poll = true;
    let pollError;
    const poller = (async () => {
      while (poll) {
        samples.push(await get("/v2/daemon/status"));
        await sleep(250);
      }
    })().catch((error) => {
      pollError = error;
      poll = false;
    });
    const loadStart = loadavg()[0];
    const began = performance.now();
    const done = message((value) => value.done);
    child.send("start");
    const clients = Array.from({ length: 4 }, (_, client) =>
      (async () => {
        for (let i = 0; i < (seconds * results.readsPerSecond) / 4; i++) {
          await sleep(
            Math.max(0, began + (i * 1_000) / (results.readsPerSecond / 4) - performance.now()),
          );
          const detail = await get(`/v2/runs/run-${(i + client) % 9}`);
          if (detail.lastSeq !== 100)
            throw new Error("run-detail projection did not read its event fixture");
        }
      })(),
    );
    let work;
    try {
      [work] = await Promise.all([done, ...clients]);
      if (work.writeFailure) throw new Error(work.writeFailure);
      const ended = Date.now();
      for (let i = 0; i < 80; i++) {
        const status = samples.at(-1);
        if (status?.loop && Date.parse(status.loop.windowEndedAt) >= ended) break;
        await sleep(250);
      }
      if (!samples.at(-1)?.loop || Date.parse(samples.at(-1).loop.windowEndedAt) < ended)
        throw new Error("final event-loop window did not complete");
    } finally {
      poll = false;
      await poller;
    }
    if (pollError) throw pollError;
    const last = samples.at(-1);
    if (!loops.length) throw new Error("no completed event-loop window");
    // IPC captures EVERY native window, including ones HTTP polling misses.
    // Cross-check the last observed status window against the capture.
    const capturedIndex = loops.findIndex(
      (window) => window.windowEndedAt === last.loop.windowEndedAt,
    );
    const captured = loops[capturedIndex];
    if (!captured || JSON.stringify(captured.delay) !== JSON.stringify(last.loop.delay))
      throw new Error("loop attribution does not match the status window");
    const completedLoops = loops.slice(0, capturedIndex + 1);
    const eventLoop = loopTail(completedLoops);
    const passes = samples.map((sample) => sample.store.flusher?.last_pass).filter(Boolean);
    const row = {
      label,
      round,
      pid: child.pid,
      pragmas: ready.pragmas,
      writes: work.writes,
      reads: seconds * results.readsPerSecond,
      elapsedMs: work.elapsedMs,
      loadStart,
      loadEnd: loadavg()[0],
      commit: last.store.commit,
      eventLoop,
      loopMaxMs: eventLoop.maxMs,
      walMaxMiB: Math.max(...passes.map((pass) => pass.wal_bytes ?? 0)) / (1024 * 1024),
      flusher: last.store.flusher.counters,
      busyWaits: last.store.busy_waits,
      loops: completedLoops,
      timing: last.timing ?? null,
    };
    writeFileSync(
      join(dirname(output), `${label}-${round}-status.json`),
      JSON.stringify(samples, null, 2) + "\n",
    );
    return row;
  } finally {
    await stop(child);
    console.error(`stopped owned PID ${child.pid}`);
  }
}

try {
  const source = join(scratch, "base-source");
  mkdirSync(source);
  const archive = join(scratch, "base.tar");
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      results.base,
      "packages",
      "tsconfig.base.json",
      "package.json",
      "pnpm-lock.yaml",
    ],
    { cwd: repo },
  );
  execFileSync("tar", ["-xf", archive, "-C", source], { cwd: repo });
  if (
    readFileSync(join(source, "pnpm-lock.yaml"), "utf8") !==
    readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")
  )
    throw new Error("benchmark requires the same installed lockfile for base and candidate");
  const bundles = {
    base: await bundle(source, "base"),
    candidate: await bundle(repo, "candidate"),
  };
  mkdirSync(dirname(output), { recursive: true });
  for (const { label, round } of trialOrder(rounds)) {
    const row = await trial(bundles[label], label, round);
    results.trials.push(row);
    results.buildSummaries = buildSummaries(results.trials);
    writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(runSummary(row)));
  }
  for (const summary of results.buildSummaries) console.log(JSON.stringify(summary));
} finally {
  for (const child of owned) await stop(child);
  rmSync(scratch, { recursive: true, force: true });
}
