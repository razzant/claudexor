import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { composeSpawnEnv } from "@claudexor/core";
import { applyHostLibuvPool, hostLibuvPoolSize, LIBUV_POOL_MAX } from "./host-libuv-pool.js";

const repoRoot = join(import.meta.dirname, "../../..");
const APPLIED_POOL = Symbol.for("claudexor.libuvPoolSize");

/** The npm bin and the built entry (`dist/claudexord.js`, the bundle) each carry a copy. */
const twins = [
  { name: "npm bin", path: join(repoRoot, "packages/claudexor/bin/libuv-pool.js") },
  { name: "built entry", path: join(import.meta.dirname, "../dist/host-libuv-pool.js") },
];
function moduleUrl(path: string): string {
  if (!existsSync(path)) throw new Error(`build @claudexor/cli before this test: ${path}`);
  return pathToFileURL(path).href;
}

interface Applied {
  env: string | null;
  applied: number | null;
  host: number;
}

function runApply(poolModule: string, env: NodeJS.ProcessEnv): Promise<Applied> {
  const childEnv = { ...env };
  const code = `
import { applyHostLibuvPool, hostLibuvPoolSize } from ${JSON.stringify(poolModule)};
applyHostLibuvPool();
process.stdout.write(JSON.stringify({
  env: process.env.UV_THREADPOOL_SIZE ?? null,
  applied: globalThis[Symbol.for("claudexor.libuvPoolSize")] ?? null,
  host: hostLibuvPoolSize(),
}));
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.once("error", reject);
    child.once("exit", (status) => {
      if (status !== 0) {
        reject(new Error(`pool apply exited ${status}: ${err}`));
        return;
      }
      resolve(JSON.parse(out) as Applied);
    });
  });
}

describe("host libuv pool", () => {
  it("derives the same size as the daemon bin, inside libuv's maximum", () => {
    const expected = Math.min(LIBUV_POOL_MAX, Math.max(8, os.availableParallelism() + 4));
    expect(hostLibuvPoolSize()).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(8);
    expect(expected).toBeLessThanOrEqual(1024);
  });

  it.each(twins)(
    "sizes the pool only when the operator has not, and removes its own assignment ($name)",
    async (twin) => {
      const poolModule = moduleUrl(twin.path);
      const unset = { ...process.env };
      delete unset.UV_THREADPOOL_SIZE;
      const assigned = await runApply(poolModule, unset);
      expect(assigned).toEqual({
        env: null,
        applied: hostLibuvPoolSize(),
        host: hostLibuvPoolSize(),
      });
      const kept = await runApply(poolModule, { ...unset, UV_THREADPOOL_SIZE: "3" });
      expect(kept).toMatchObject({ env: "3", applied: null });
      const huge = await runApply(poolModule, { ...unset, UV_THREADPOOL_SIZE: "5000" });
      expect(huge).toMatchObject({ env: "5000", applied: null });
    },
  );

  it("keeps the daemon's pool size out of harness children, and passes an operator value on", () => {
    const global = globalThis as Record<symbol, unknown>;
    const savedEnv = process.env.UV_THREADPOOL_SIZE;
    const savedApplied = global[APPLIED_POOL];
    try {
      delete process.env.UV_THREADPOOL_SIZE;
      delete global[APPLIED_POOL];
      applyHostLibuvPool();
      expect(global[APPLIED_POOL]).toBe(hostLibuvPoolSize());
      expect(process.env.UV_THREADPOOL_SIZE).toBeUndefined();
      expect(composeSpawnEnv("mirror_native")).not.toHaveProperty("UV_THREADPOOL_SIZE");
      // A second entry in the same process (the npm bin, then the built entry) keeps it so.
      applyHostLibuvPool();
      expect(composeSpawnEnv("mirror_native")).not.toHaveProperty("UV_THREADPOOL_SIZE");

      delete global[APPLIED_POOL];
      process.env.UV_THREADPOOL_SIZE = "3";
      applyHostLibuvPool();
      expect(global[APPLIED_POOL]).toBeUndefined();
      expect(composeSpawnEnv("mirror_native").UV_THREADPOOL_SIZE).toBe("3");
    } finally {
      if (savedEnv === undefined) delete process.env.UV_THREADPOOL_SIZE;
      else process.env.UV_THREADPOOL_SIZE = savedEnv;
      if (savedApplied === undefined) delete global[APPLIED_POOL];
      else global[APPLIED_POOL] = savedApplied;
    }
  });

  it("assigns the pool before either daemon entry imports the graph", () => {
    const bin = readFileSync(join(repoRoot, "packages/claudexor/bin/claudexord.js"), "utf8");
    const applyAt = bin.indexOf("applyHostLibuvPool()");
    const graphAt = bin.indexOf('import("@claudexor/cli/claudexord")');
    expect(applyAt).toBeGreaterThan(-1);
    expect(graphAt).toBeGreaterThan(applyAt);
    expect(bin).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"@claudexor\/cli\/claudexord"/m);
    const entry = readFileSync(join(import.meta.dirname, "claudexord.ts"), "utf8");
    const imports = [...entry.matchAll(/^import .+$/gm)].map((match) => match[0]);
    expect(imports[0]).toContain("./host-libuv-pool-boot.js");
    const boot = readFileSync(join(import.meta.dirname, "host-libuv-pool-boot.ts"), "utf8");
    expect(boot).toContain("applyHostLibuvPool()");
    expect(boot).not.toContain("node:fs");
  });

  it.each(twins)(
    "enlarges the pool before filesystem work, so six blocked reads still leave dns.lookup a thread ($name)",
    async (twin) => {
      const poolModule = moduleUrl(twin.path);
      const unset = { ...process.env };
      delete unset.UV_THREADPOOL_SIZE;
      const code = `
import { applyHostLibuvPool, hostLibuvPoolSize } from ${JSON.stringify(poolModule)};
applyHostLibuvPool();
const env = process.env.UV_THREADPOOL_SIZE ?? null;
const fs = await import("node:fs/promises");
const dns = await import("node:dns/promises");
const { spawn } = await import("node:child_process");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const count = 6;
const dir = mkdtempSync(join(tmpdir(), "cx-host-pool-"));
const fifos = Array.from({ length: count }, (_, index) => join(dir, "f" + index));
const holders = [];
try {
  await new Promise((resolve, reject) => {
    const maker = spawn("/usr/bin/mkfifo", fifos);
    maker.once("error", reject);
    maker.once("exit", (status) => (status === 0 ? resolve() : reject(new Error("mkfifo " + status))));
  });
  let ready = 0;
  for (const fifo of fifos) {
    const holder = spawn("/usr/bin/python3", ["-c", "import os,sys\\nfd=os.open(sys.argv[1], os.O_WRONLY)\\nsys.stdout.buffer.write(b'ready\\\\n'); sys.stdout.buffer.flush()\\nsys.stdin.buffer.read(1)\\nos.write(fd, b'x')\\nos.close(fd)\\n", fifo], { stdio: ["pipe", "pipe", "pipe"] });
    holders.push(holder);
    holder.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) ready += 1; });
  }
  const reads = fifos.map(async (fifo) => {
    const handle = await fs.open(fifo, fs.constants.O_RDONLY);
    try { await handle.read(Buffer.alloc(1), 0, 1, null); } finally { await handle.close(); }
  });
  const started = Date.now();
  while (ready < count && Date.now() - started < 4_000) await new Promise((resolve) => setTimeout(resolve, 20));
  const dnsStarted = Date.now();
  const dnsOutcome = await Promise.race([
    dns.lookup("localhost").then(() => "ok", () => "error"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
  ]);
  process.stdout.write(JSON.stringify({ host: hostLibuvPoolSize(), env, ready, dnsOutcome, dnsMs: Date.now() - dnsStarted }) + "\\n");
  for (const holder of holders) { try { holder.stdin.write("\\n"); } catch { /* already gone */ } }
  await Promise.allSettled(reads);
} finally {
  for (const holder of holders) { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); }
  rmSync(dir, { recursive: true, force: true });
}
`;
      const result = await new Promise<{
        host: number;
        env: string | null;
        ready: number;
        dnsOutcome: string;
        dnsMs: number;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
          env: unset,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          err += chunk;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (status) => {
          clearTimeout(timer);
          if (status !== 0) {
            reject(new Error(`host pool probe exited ${status}: ${err || out}`));
            return;
          }
          resolve(
            JSON.parse(out) as {
              host: number;
              env: string | null;
              ready: number;
              dnsOutcome: string;
              dnsMs: number;
            },
          );
        });
      });
      process.stdout.write(`HOST_POOL_PROBE ${JSON.stringify({ twin: twin.name, ...result })}\n`);
      expect(result.host).toBe(hostLibuvPoolSize());
      expect(result.host).toBeGreaterThan(6);
      // The variable is already gone; the pool libuv created from it stays enlarged.
      expect(result.env).toBeNull();
      expect(result.ready).toBe(6);
      expect(result.dnsOutcome).toBe("ok");
      expect(result.dnsMs).toBeLessThan(2_000);
    },
  );
});
