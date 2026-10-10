import type { SetupJobStore } from "./setup-job-store.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import {
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
import { killWindowsProcessTree } from "@claudexor/core";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { daemonDir, defaultSocketPath, ensureToken } from "@claudexor/daemon";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import { registerConfigDirProfile } from "./profile-registration.js";
import { setupJobControlServices } from "./setup-job-control-services.js";
import { createSetupJobManager } from "./setup-jobs.js";

// Real Windows console, built CLI/runner, control API and lifecycle manager.
// Only vendor commands and the daemon socket-health facade are offline fixtures.
// This proves explicit CLI cancellation, not keyboard Ctrl-C or real OAuth.
const vendor = await vi.hoisted(async () => {
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(
    new URL("../../core/dist/native-test/claudexor-conpty-test-child.exe", import.meta.url),
  );
  for (const harness of ["CODEX", "CLAUDE", "AGY", "OPENCODE"])
    process.env[`CLAUDEXOR_${harness}_BIN`] = `${path}.nonexistent-${harness}`;
  process.env.CLAUDEXOR_CURSOR_BIN = path;
  return path;
});
const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const RUNNER = resolve(import.meta.dirname, "../dist/setup-login-runner.js");
const HELPER = resolve(import.meta.dirname, "../../core/dist/native/claudexor-conpty-helper.exe");
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted_unknown"]);

async function until(label: string, predicate: () => boolean, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 25));
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

function startClient(args = ["profiles", "login", "cursor", "work"], tty = true) {
  const child = spawn(
    tty ? HELPER : process.execPath,
    tty ? ["--", process.execPath, CLI, ...args] : [CLI, ...args],
    {
      env: { ...process.env },
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    },
  );
  let output = "";
  let error = "";
  let closed = false;
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    error += chunk.toString();
  });
  const done = new Promise<number>((resolveDone, reject) => {
    const deadline = setTimeout(() => {
      if (!closed && child.pid) killWindowsProcessTree(child.pid);
      reject(new Error(`fixture CLI exceeded its 40s test deadline:\n${output}\n${error}`));
    }, 40_000);
    child.once("error", (failure) => {
      clearTimeout(deadline);
      reject(failure);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      closed = true;
      resolveDone(code ?? 1);
    });
  });
  void done.catch(() => {});
  return {
    done,
    output: () => output,
    error: () => error,
    stop: async () => {
      if (!closed && child.pid) killWindowsProcessTree(child.pid);
      await done.catch(() => {});
    },
  };
}

async function withFixture(
  run: (ctx: {
    manager: ReturnType<typeof createSetupJobManager>;
    clients: ReturnType<typeof startClient>[];
    marker: (name: string) => string;
    starts: () => number[][];
    job: () => ReturnType<ReturnType<typeof createSetupJobManager>["list"]>[number];
  }) => Promise<void>,
) {
  for (const path of [CLI, RUNNER, HELPER, vendor])
    expect(
      existsSync(path),
      `build CLI and native Windows fixtures before this test: ${path}`,
    ).toBe(true);
  const keys = [
    "CLAUDEXOR_CONFIG_DIR",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "c363-win32-")));
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  const home = join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  const profile = registerConfigDirProfile({ harnessId: "cursor", profileId: "work" }).profile;
  const marker = (name: string) =>
    join(profile.isolation_locator!, `.claudexor-cursor-fake-${name}`);
  writeFileSync(marker("enabled"), "offline fixture");
  const starts = () =>
    existsSync(marker("starts"))
      ? readFileSync(marker("starts"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [kind, ...values] = line.split("|");
            expect(kind).toBe("LOGIN");
            return values.map(Number);
          })
      : [];
  const cursor = createCursorAdapter();
  const token = ensureToken();
  const manager = createSetupJobManager({
    rootDir: daemonDir(),
    runnerPath: RUNNER,
    monitorPollMs: 50,
    verifyPollMs: 50,
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
  await new Promise<void>((done, reject) => {
    health.once("error", reject);
    health.listen(defaultSocketPath(), done);
  });
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
    await run({
      manager,
      clients,
      marker,
      starts,
      job: () => manager.list({ harness: "cursor" }).at(-1)!,
    });
  } finally {
    // Stop the exact captured client trees even if the assertion failed before
    // the manager had a handle. Never leave a console or fake vendor behind.
    try {
      for (const job of manager.list({ active: true })) await manager.cancel({ jobId: job.jobId });
      await Promise.all(clients.map((client) => client.stop()));
      await until("fixture login drain", () => manager.list({ active: true }).length === 0);
    } finally {
      await manager.shutdown();
      (manager._store as SetupJobStore).journal.close();
      await server.stop();
      await new Promise<void>((done) => health.close(() => done()));
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

describe.skipIf(process.platform !== "win32")(
  "built Cursor profile login in real Win32 ConPTY",
  () => {
    it("preserves console handles and waits for vendor death plus profile verification", async () => {
      await withFixture(async ({ manager, clients, marker, starts, job }) => {
        const client = startClient();
        clients.push(client);
        await until("fixture vendor start", () => starts().length === 1);
        const [pid, ...facts] = starts()[0]!;
        expect(facts).toEqual([1, 1, 1, 1, 1, 1]); // stdin/out/err console, scoped HOME, file store, no keys
        expect(alive(pid!)).toBe(true);
        expect(terminal.has(job().state)).toBe(false);
        expect(manager.credentialMutationOpen("cursor")).toBe(true);
        writeFileSync(marker("release"), "");
        expect(await client.done, client.error()).toBe(0);
        expect(client.output()).toContain("FAKE_CURSOR_TTY_READY");
        expect(job()).toMatchObject({
          state: "succeeded",
          nativeCommand: { commandStarted: true, exitCode: 0 },
        });
        expect(alive(pid!)).toBe(false);
        expect(manager.credentialMutationOpen("cursor")).toBe(false);
      });
    }, 60_000);

    it("explicit built CLI cancellation proves vendor death and permits a healthy retry", async () => {
      await withFixture(async ({ manager, clients, marker, starts, job }) => {
        const client = startClient();
        clients.push(client);
        await until("first fixture vendor", () => starts().length === 1);
        const original = job().jobId;
        const pid = starts()[0]![0]!;
        const cancel = startClient(["setup", "cancel", original, "--json"], false);
        clients.push(cancel);
        expect(await cancel.done, cancel.error()).toBe(0);
        expect(JSON.parse(cancel.output())).toMatchObject({ ok: true, job: { jobId: original } });
        await until("cancelled vendor", () => job().state === "cancelled");
        expect(await client.done, client.error()).toBe(1);
        expect(alive(pid)).toBe(false);
        expect(manager.credentialMutationOpen("cursor")).toBe(false);
        const next = startClient();
        clients.push(next);
        await until("retry fixture vendor", () => starts().length === 2);
        expect(manager.list({ harness: "cursor" })).toHaveLength(2);
        expect(job().jobId).not.toBe(original);
        expect(starts()[1]!.slice(1)).toEqual([1, 1, 1, 1, 1, 1]);
        writeFileSync(marker("release"), "");
        expect(await next.done, next.error()).toBe(0);
        expect(job().state).toBe("succeeded");
        expect(alive(starts()[1]![0]!)).toBe(false);
        expect(manager.credentialMutationOpen("cursor")).toBe(false);
      });
    }, 90_000);
  },
);
