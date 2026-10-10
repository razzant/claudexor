import type { SetupJobStore } from "./setup-job-store.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { daemonDir, defaultSocketPath, ensureToken } from "@claudexor/daemon";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import { registerConfigDirProfile } from "./profile-registration.js";
import { setupJobControlServices } from "./setup-job-control-services.js";
import { createSetupJobManager } from "./setup-jobs.js";

// This is the built CLI, real terminal, Control API, lifecycle, runner and
// process-group owner. Only the vendor and socket health facade are fixtures.
// No real credentials, vendor calls, or installed daemon are used. Cursor's
// declared managed stdin class is none; its TTY output is still preserved.
const fixture = vi.hoisted(() => {
  const root = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/cx363-pty-${process.pid}`;
  for (const harness of ["CODEX", "CLAUDE", "AGY", "OPENCODE"])
    process.env[`CLAUDEXOR_${harness}_BIN`] = `/nonexistent/cursor363-pty/${harness}`;
  process.env.CLAUDEXOR_CURSOR_BIN = `${root}/cursor-agent`;
  return { root, bin: `${root}/cursor-agent` };
});
const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const RUNNER = resolve(import.meta.dirname, "../dist/setup-login-runner.js");
const DRIVER = resolve(import.meta.dirname, "fixtures/setup-pty.py");
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted_unknown"]);
const file = (name: string) => join(fixture.root, name);
async function until(label: string, predicate: () => boolean, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function startClient(args = ["profiles", "login", "cursor", "work"]) {
  const driver = spawn("python3", [DRIVER, process.execPath, CLI, ...args], {
    env: { ...process.env },
    stdio: "pipe",
  });
  let output = "",
    metadata = "";
  driver.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  driver.stderr.on("data", (chunk) => {
    metadata += chunk.toString();
  });
  let finished = false;
  const done = new Promise<number>((resolve, reject) => {
    driver.once("error", reject);
    driver.once("close", (code) => {
      finished = true;
      const result = metadata
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { pid?: number; exit?: number };
          } catch {
            return {};
          }
        })
        .find((item) => item.exit !== undefined);
      if (result?.exit === undefined)
        reject(new Error(`PTY driver exited ${code}: ${metadata}\n${output}`));
      else resolve(result.exit);
    });
  });
  // Keep failure visible even when fixture cleanup must run before awaiting it.
  void done.catch(() => {});
  return {
    done,
    output: () => output,
    send: (command: object) => driver.stdin.write(`${JSON.stringify(command)}\n`),
    stop: async () => {
      if (!finished) driver.stdin.write(`${JSON.stringify({ op: "signal", signal: "SIGKILL" })}\n`);
      await done.catch(() => {});
      driver.stdin.end();
    },
  };
}

async function withFixture(
  run: (ctx: {
    manager: ReturnType<typeof createSetupJobManager>;
    clients: ReturnType<typeof startClient>[];
    job: () => ReturnType<ReturnType<typeof createSetupJobManager>["list"]>[number];
  }) => Promise<void>,
) {
  expect(existsSync(CLI), "build the real CLI before this acceptance test").toBe(true);
  const keys = ["CLAUDEXOR_CONFIG_DIR", "HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "c363-pty-")));
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  const home = join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  mkdirSync(fixture.root, { recursive: true });
  for (const name of ["login.json", "release", "finished", "starts"])
    rmSync(file(name), { force: true });
  writeFileSync(
    fixture.bin,
    `#!${process.execPath}\n` +
      `
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(fixture.root)};
const file = name => path.join(root,name);
if (process.argv[2] === 'status') {
  console.log(JSON.stringify({authenticated: fs.existsSync(file('finished')), email:'fixture@example.test'}));
  process.exit(0);
}
if (process.argv[2] !== 'login') process.exit(2);
fs.appendFileSync(file('starts'), 'start\\n');
fs.writeFileSync(file('login.json.tmp'), JSON.stringify({pid:process.pid, stdin:!!process.stdin.isTTY, stdout:!!process.stdout.isTTY, stderr:!!process.stderr.isTTY,home:process.env.HOME,credentialStore:process.env.AGENT_CLI_CREDENTIAL_STORE}));
fs.renameSync(file('login.json.tmp'), file('login.json'));
console.log('FAKE_CURSOR_TTY ' + !!process.stdout.isTTY);
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {
  if (fs.existsSync(file('release'))) {
    fs.writeFileSync(file('finished'), 'synthetic login completed');
    process.exit(0);
  }
}, 20);
`,
  );
  chmodSync(fixture.bin, 0o755);
  const profile = registerConfigDirProfile({ harnessId: "cursor", profileId: "work" }).profile;
  const cursor = createCursorAdapter();
  const token = ensureToken();
  const manager = createSetupJobManager({
    rootDir: daemonDir(),
    runnerPath: RUNNER,
    monitorPollMs: 20,
    verifyPollMs: 20,
    terminationGraceMs: 200,
  });
  await manager.start();
  const health = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as { id: number; method: string; token: string };
      expect(request.method).toBe("claudexor.health");
      expect(request.token).toBe(token);
      socket.end(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
    });
  });
  await new Promise<void>((resolve) => health.listen(defaultSocketPath(), resolve));
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async () => ({ id: "unused", state: "failed" }),
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
    } as never,
    services: {
      ...setupJobControlServices(() => manager),
      credentialProfiles: async () => ({
        profiles: [
          { profile, status: await cursor.probeCredentialProfile!(profile), identity: null },
        ],
        harnessAccounts: [],
        accountPools: [],
      }),
    },
  });
  const { host, port } = await server.start();
  writeFileSync(join(daemonDir(), "control-api.json"), JSON.stringify({ host, port }));
  const clients: ReturnType<typeof startClient>[] = [];
  try {
    await run({ manager, clients, job: () => manager.list({ harness: "cursor" }).at(-1)! });
  } finally {
    for (const job of manager.list({ active: true })) await manager.cancel({ jobId: job.jobId });
    // Cancellation is asynchronous; do not remove process evidence before drain.
    await until("fixture login drain", () => manager.list({ active: true }).length === 0);
    await Promise.all(clients.map((client) => client.stop()));
    await manager.shutdown();
    (manager._store as SetupJobStore).journal.close();
    await server.stop();
    await new Promise<void>((resolve) => health.close(() => resolve()));
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("built profile login in a real POSIX PTY", () => {
  it("preserves vendor TTY output and waits for vendor death and terminal verification", async () => {
    await withFixture(async ({ clients, job }) => {
      const client = startClient();
      clients.push(client);
      await until("vendor terminal", () => existsSync(file("login.json")));
      const vendor = JSON.parse(readFileSync(file("login.json"), "utf8"));
      expect(vendor).toMatchObject({
        stdin: true,
        stdout: true,
        stderr: true,
        credentialStore: "file",
      });
      expect(vendor.home).toContain("profiles/cursor-work");
      expect(alive(vendor.pid)).toBe(true);
      expect(terminal.has(job().state)).toBe(false);
      writeFileSync(file("release"), "");
      expect(await client.done).toBe(0);
      expect(client.output()).toContain("FAKE_CURSOR_TTY true");
      expect(job().state).toBe("succeeded");
      expect(alive(vendor.pid)).toBe(false);
      expect(job().nativeCommand).toMatchObject({ commandStarted: true, exitCode: 0 });
    });
  });
  it.each(["control-byte", "terminal-close", "SIGTERM"])(
    "%s cancels via the daemon and permits a clean retry",
    async (action) => {
      await withFixture(async ({ manager, clients, job }) => {
        const client = startClient();
        clients.push(client);
        await until("vendor login", () => existsSync(file("login.json")));
        const vendor = JSON.parse(readFileSync(file("login.json"), "utf8"));
        if (action === "control-byte") client.send({ op: "write", data: "\u0003" });
        else if (action === "terminal-close") client.send({ op: "close" });
        else client.send({ op: "signal", signal: action });
        await until("cancelled vendor", () => terminal.has(job().state));
        expect(job().state).toBe("cancelled");
        expect(alive(vendor.pid)).toBe(false);
        const exit = await client.done;
        if (action !== "terminal-close") expect(exit).toBe(130);
        const next = startClient();
        clients.push(next);
        await until(
          "retry vendor",
          () =>
            manager.list({ harness: "cursor" }).length === 2 &&
            readFileSync(file("starts"), "utf8").split("\n").filter(Boolean).length === 2,
        );
        writeFileSync(file("release"), "");
        expect(await next.done).toBe(0);
        expect(job().state).toBe("succeeded");
      });
    },
  );
  it("client death and retry cannot launch a duplicate survivor; CLI cancellation recovers it", async () => {
    await withFixture(async ({ manager, clients, job }) => {
      const client = startClient();
      clients.push(client);
      await until("vendor login", () => existsSync(file("login.json")));
      const original = job().jobId;
      const vendor = JSON.parse(readFileSync(file("login.json"), "utf8"));
      client.send({ op: "signal", signal: "SIGKILL" });
      expect(await client.done).toBe(-9);
      expect(alive(vendor.pid)).toBe(true);
      const retry = startClient();
      clients.push(retry);
      expect(await retry.done).toBe(1);
      expect(retry.output()).toContain(`setup cancel ${original}`);
      expect(retry.output()).toContain(`setup reconcile ${original}`);
      expect(manager.list({ harness: "cursor" })).toHaveLength(1);
      expect(readFileSync(file("starts"), "utf8")).toBe("start\n");
      const cancel = startClient(["setup", "cancel", original, "--json"]);
      clients.push(cancel);
      expect(await cancel.done).toBe(0);
      await until("cancelled survivor", () => job().state === "cancelled");
      expect(alive(vendor.pid)).toBe(false);
    });
  });
  it("client and runner-group death without a receipt settles honestly and allows retry", async () => {
    await withFixture(async ({ manager, clients, job }) => {
      const client = startClient();
      clients.push(client);
      await until("vendor login", () => existsSync(file("login.json")));
      const original = job().jobId;
      const group = job().execution!.processGroup.pgid;
      const vendor = JSON.parse(readFileSync(file("login.json"), "utf8"));
      client.send({ op: "signal", signal: "SIGKILL" });
      expect(await client.done).toBe(-9);
      process.kill(-group, "SIGKILL");
      await until("empty group settlement", () => terminal.has(job().state));
      expect(job()).toMatchObject({ state: "failed", outcome: { reason: "interrupted" } });
      expect(alive(vendor.pid)).toBe(false);
      expect(existsSync(join(daemonDir(), "setup-artifacts", original, "runner-result.json"))).toBe(
        false,
      );
      expect(manager.credentialMutationOpen("cursor")).toBe(false);
      const retry = startClient();
      clients.push(retry);
      await until(
        "retry vendor",
        () =>
          manager.list({ harness: "cursor" }).length === 2 &&
          readFileSync(file("starts"), "utf8").split("\n").filter(Boolean).length === 2,
      );
      writeFileSync(file("release"), "");
      expect(await retry.done).toBe(0);
      expect(job().state).toBe("succeeded");
    });
  });
});
