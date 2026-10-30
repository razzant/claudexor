import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop as stopBundler } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The driver creates only worker threads. Its bounded process group also makes
 * a broken packaged entry harmless on timeout, on Windows as well as POSIX. */
function runDriver(driver: string, root: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolveRun, reject) => {
      const child = spawn(process.execPath, [driver], {
        detached: process.platform !== "win32",
        windowsHide: true,
        env: {
          ...process.env,
          CLAUDEXOR_CONFIG_DIR: join(root, "config-must-stay-absent"),
          HOME: join(root, "home-must-stay-absent"),
          USERPROFILE: join(root, "home-must-stay-absent"),
          XDG_CONFIG_HOME: join(root, "xdg-must-stay-absent"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid === undefined) return;
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            timeout: 5_000,
            windowsHide: true,
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 45_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolveRun({ code, stdout, stderr, timedOut });
      });
    },
  );
}

describe("bulk worker in portable engine bundles", () => {
  it("runs detail, artifact, summary and finite replay from the shipped CJS entry and fallback bundle", async () => {
    const daemonEntry = join(repoRoot, "packages", "cli", "dist", "claudexord.js");
    const controlDist = join(repoRoot, "packages", "control-api", "dist");
    expect(existsSync(daemonEntry), "run pnpm build first").toBe(true);
    const root = mkdtempSync(join(realpathSync(tmpdir()), "cx-bulk-bundle-"));
    roots.push(root);
    const daemonBundle = join(root, "claudexord.bundle.cjs");
    const minimalEntry = join(root, "bulk-entry.mjs");
    const minimalBundle = join(root, "bulk.bundle.cjs");
    writeFileSync(
      minimalEntry,
      `export { BulkExecutor } from ${JSON.stringify(join(controlDist, "bulk-executor.js"))};\n`,
    );
    // Same CJS URL shim and target as scripts/build-engine-resources.sh. The
    // second bundle has no adjacent worker file: it exercises workerEntry's
    // actual packaged fallback, without a test-supplied factory.
    try {
      for (const [entry, outfile] of [
        [daemonEntry, daemonBundle],
        [minimalEntry, minimalBundle],
      ]) {
        await build({
          entryPoints: [entry!],
          outfile,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node24",
          banner: {
            js: "const CLAUDEXOR_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;",
          },
          define: {
            "import.meta.url": "CLAUDEXOR_BUNDLE_URL",
            "process.env.CLAUDEXOR_BUILD_SHA": JSON.stringify(
              "0123456789abcdef0123456789abcdef01234567",
            ),
          },
          logLevel: "silent",
        });
      }
    } finally {
      stopBundler();
    }
    const runDir = join(root, "run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const secret = "sk-proj-" + "a".repeat(48);
    writeFileSync(join(runDir, "final", "answer.md"), `Packaged output ${secret}\n`);
    writeFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({
        type: "run.started",
        seq: 1,
        run_id: "bundle-run",
        task_id: "bundle-task",
        ts: "2026-10-27T12:00:00.000Z",
        text: secret,
      }) + "\n",
    );
    const driver = join(root, "driver.mjs");
    writeFileSync(
      driver,
      `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { BulkExecutor } from ${JSON.stringify(pathToFileURL(join(controlDist, "bulk-executor.js")).href)};
import { BULK_WORKER_ROLE } from ${JSON.stringify(pathToFileURL(join(controlDist, "bulk-protocol.js")).href)};
const require = createRequire(import.meta.url);
const { BulkExecutor: BundledExecutor } = require(${JSON.stringify(minimalBundle)});
const record = { id: "bundle-job", runId: "bundle-run", taskId: "bundle-task", state: "running",
  runDir: ${JSON.stringify(runDir)}, params: { mode: "ask", scope: { kind: "none" } } };
const secret = ${JSON.stringify(secret)};
const facts = [];
for (const mode of ["shipped", "fallback"]) {
  let worker;
  const bulk = mode === "shipped"
    ? new BulkExecutor(() => worker = new Worker(${JSON.stringify(daemonBundle)}, { workerData: { role: BULK_WORKER_ROLE } }))
    : new BundledExecutor();
  try {
    const summary = await bulk.execute({ kind: "summary", input: { record } });
    assert.equal(summary.summary.jobId, record.id);
    assert.equal(summary.summary.state, "running");
    const detail = JSON.parse(await bulk.execute({ kind: "detail", input: {
      record, cursor: 1, pending: [], operator: null, children: [],
    } }));
    assert.equal(detail.summary.runId, record.runId);
    assert.equal(detail.lastSeq, 1);
    const artifact = await bulk.execute({ kind: "artifact", input: {
      kind: "fetch", root: record.runDir, relative: "final/answer.md", runArtifact: true,
    } });
    assert.equal(artifact.kind, "body");
    const body = Buffer.from(artifact.body).toString("utf8");
    assert.ok(body.includes("Packaged output"));
    // The shipped worker serves the exact answer (INV-146).
    assert.ok(body.includes(secret));
    let cursor;
    const frames = [];
    for (;;) {
      const batch = await bulk.execute({ kind: "event-replay", input: {
        path: ${JSON.stringify(join(runDir, "events.jsonl"))}, lastEventId: 0, cursor,
      } });
      cursor = batch.cursor;
      frames.push(...batch.frames);
      if (!batch.progressed) break;
    }
    assert.deepEqual(frames.map((frame) => frame.seq), [1]);
    assert.ok(frames[0].data.includes(secret));
    facts.push({ mode, summary: true, detail: true, artifact: true, replay: true });
  } finally {
    const exited = worker ? once(worker, "exit") : null;
    bulk.stop();
    if (exited) await exited;
  }
}
process.stdout.write(JSON.stringify(facts) + "\\n");
`,
    );
    const result = await runDriver(driver, root);
    expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      { mode: "shipped", summary: true, detail: true, artifact: true, replay: true },
      { mode: "fallback", summary: true, detail: true, artifact: true, replay: true },
    ]);
    // Loading the entire daemon bundle in a worker must not create config,
    // native state, or a second daemon. This assertion runs on Windows too.
    for (const path of ["config-must-stay-absent", "home-must-stay-absent", "xdg-must-stay-absent"])
      expect(existsSync(join(root, path)), path).toBe(false);
  }, 90_000);
});
