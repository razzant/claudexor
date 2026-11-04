import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hostLibuvPoolSize, LIBUV_POOL_MAX } from "./host-libuv-pool.js";

const repoRoot = join(import.meta.dirname, "../../..");
const poolModule = pathToFileURL(join(repoRoot, "packages/claudexor/bin/libuv-pool.js")).href;

function runApply(env: NodeJS.ProcessEnv): Promise<{ env: string | null; host: number }> {
  const childEnv = { ...env };
  const code = `
import { applyHostLibuvPool, hostLibuvPoolSize } from ${JSON.stringify(poolModule)};
applyHostLibuvPool();
process.stdout.write(JSON.stringify({ env: process.env.UV_THREADPOOL_SIZE ?? null, host: hostLibuvPoolSize() }));
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
      resolve(JSON.parse(out) as { env: string | null; host: number });
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

  it("sets the variable only when the operator has not", async () => {
    const unset = { ...process.env };
    delete unset.UV_THREADPOOL_SIZE;
    const assigned = await runApply(unset);
    expect(assigned.env).toBe(String(hostLibuvPoolSize()));
    expect(assigned.host).toBe(hostLibuvPoolSize());
    const kept = await runApply({ ...unset, UV_THREADPOOL_SIZE: "3" });
    expect(kept.env).toBe("3");
    const huge = await runApply({ ...unset, UV_THREADPOOL_SIZE: "5000" });
    expect(huge.env).toBe("5000");
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

  it("enlarges the pool before filesystem work, so six blocked reads still leave dns.lookup a thread", async () => {
    const unset = { ...process.env };
    delete unset.UV_THREADPOOL_SIZE;
    const code = `
import { applyHostLibuvPool, hostLibuvPoolSize } from ${JSON.stringify(poolModule)};
applyHostLibuvPool();
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
  process.stdout.write(JSON.stringify({ host: hostLibuvPoolSize(), ready, dnsOutcome, dnsMs: Date.now() - dnsStarted }) + "\\n");
  for (const holder of holders) { try { holder.stdin.write("\\n"); } catch { /* already gone */ } }
  await Promise.allSettled(reads);
} finally {
  for (const holder of holders) { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); }
  rmSync(dir, { recursive: true, force: true });
}
`;
    const result = await new Promise<{
      host: number;
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
        resolve(JSON.parse(out) as { host: number; ready: number; dnsOutcome: string; dnsMs: number });
      });
    });
    process.stdout.write(`HOST_POOL_PROBE ${JSON.stringify(result)}\n`);
    expect(result.host).toBe(hostLibuvPoolSize());
    expect(result.host).toBeGreaterThan(6);
    expect(result.ready).toBe(6);
    expect(result.dnsOutcome).toBe("ok");
    expect(result.dnsMs).toBeLessThan(2_000);
  });
});
