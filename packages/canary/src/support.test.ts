import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI, cli, makeSandbox } from "./support.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  realpathSync: Object.assign(
    vi.fn((path: string) => path),
    {
      native: vi.fn((path: string) => path),
    },
  ),
}));

const BASE = join(tmpdir(), "cx-unit-fixture");
const LEASE_PATH = join(BASE, "config", "daemon", "claudexord.sock.writer", "active.writer");
const ABSENT = { status: "absent", path: LEASE_PATH };
const ACTIVE = {
  status: "owned",
  path: LEASE_PATH,
  pid: 101,
  capability: "capable",
  reason: "identity_match",
};
const STALE = { ...ACTIVE, capability: "proven_stale", reason: "process_missing" };

function processResult(overrides: Partial<ReturnType<typeof spawnSync>> = {}) {
  return {
    pid: 42,
    output: [null, "", ""],
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  } as ReturnType<typeof spawnSync>;
}

function leaseResult(observation: unknown) {
  return processResult({ stdout: JSON.stringify(observation) });
}

function cleanupReceipt() {
  const call = vi
    .mocked(writeFileSync)
    .mock.calls.find(([path]) => path === join(BASE, "canary-cleanup.json"));
  expect(call, "cleanup failure must leave a root-addressed receipt").toBeDefined();
  return JSON.parse(String(call![1]));
}

beforeEach(() => {
  vi.mocked(mkdtempSync).mockReturnValue(BASE);
  vi.mocked(rmSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(spawnSync).mockReset().mockReturnValue(leaseResult(ABSENT));
});
afterEach(() => vi.unstubAllEnvs());

describe("canary candidate and endpoint ownership", () => {
  it("binds the built candidate and removes only the inherited socket override", () => {
    vi.stubEnv("CLAUDEXOR_DAEMON_ENTRY", "/foreign/claudexord.js");
    vi.stubEnv("CLAUDEXOR_DAEMON_SOCK", "/foreign/daemon.sock");
    vi.stubEnv("CLAUDEXOR_MAX_CONCURRENT", "2");
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "600000");
    const sb = makeSandbox();
    expect(sb.env.CLAUDEXOR_DAEMON_ENTRY).toBe(CLI.replace(/cli\.js$/, "claudexord.js"));
    expect(sb.env).not.toHaveProperty("CLAUDEXOR_DAEMON_SOCK");
    expect(sb.env.CLAUDEXOR_CONFIG_DIR).toBe(join(BASE, "config"));
    expect(sb.env.CLAUDEXOR_MAX_CONCURRENT).toBe("2");
    expect(sb.env.CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS).toBe("600000");
    cli(sb, ["agent", "fixture"], { env: { CLAUDEXOR_MAX_CONCURRENT: "3" } });
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.env).toMatchObject({
      CLAUDEXOR_DAEMON_ENTRY: sb.env.CLAUDEXOR_DAEMON_ENTRY,
      CLAUDEXOR_MAX_CONCURRENT: "3",
    });
    expect(process.env.CLAUDEXOR_DAEMON_ENTRY).toBe("/foreign/claudexord.js");
    expect(process.env.CLAUDEXOR_DAEMON_SOCK).toBe("/foreign/daemon.sock");
  });
});

describe("canary cleanup custody", () => {
  it.each([
    ["never started or already stopped", ABSENT],
    ["a proven-stale prior owner", STALE],
  ])("removes a fixture with %s and makes repeated disposal a no-op", (_label, lease) => {
    vi.mocked(spawnSync).mockReturnValue(leaseResult(lease));
    const sb = makeSandbox();
    sb.dispose();
    sb.dispose();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [node, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(node).toBe(process.execPath);
    expect(args?.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
    expect(options).toMatchObject({
      env: sb.env,
      cwd: sb.repo,
      timeout: process.platform === "win32" ? 65_000 : 10_000,
    });
    expect(rmSync).toHaveBeenCalledExactlyOnceWith(BASE, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  });

  it.each([ABSENT, { ...STALE, pid: 202 }])(
    "removes after successful stop only when the current lease is inactive: %j",
    (after) => {
      vi.mocked(spawnSync)
        .mockReturnValueOnce(leaseResult(ACTIVE))
        .mockReturnValueOnce(processResult())
        .mockReturnValueOnce(leaseResult(after));
      const sb = makeSandbox();
      sb.dispose();
      expect(spawnSync).toHaveBeenCalledTimes(3);
      expect(vi.mocked(spawnSync).mock.calls[1]).toEqual([
        process.execPath,
        [CLI, "daemon", "stop", "--json"],
        { env: sb.env, cwd: sb.repo, encoding: "utf8", timeout: 30_000 },
      ]);
      expect(rmSync).toHaveBeenCalledOnce();
      expect(
        vi
          .mocked(writeFileSync)
          .mock.calls.some(([path]) => String(path).endsWith("canary-cleanup.json")),
      ).toBe(false);
    },
  );

  it.each([
    ["nonzero exit", { status: 1 }],
    ["missing exit", { status: null }],
    ["signal", { status: 0, signal: "SIGTERM" as const }],
    ["timeout", { status: 0, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }],
  ])("retains the root and stop facts on %s, regardless of CLI prose", (_label, stop) => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(leaseResult(ACTIVE))
      .mockReturnValueOnce(processResult({ ...stop, stdout: "claudexord stopped" }));
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow(`Canary cleanup incomplete at ${BASE}`);
    expect(rmSync).not.toHaveBeenCalled();
    expect(cleanupReceipt()).toMatchObject({
      base: BASE,
      configDir: sb.configDir,
      daemonEntry: sb.env.CLAUDEXOR_DAEMON_ENTRY,
      before: ACTIVE,
      stop: {
        status: stop.status,
        signal: "signal" in stop ? stop.signal : null,
        ...("error" in stop ? { error: { code: "ETIMEDOUT", message: "timed out" } } : {}),
      },
    });
  });

  it("does not treat a missing-token CLI refusal as proof that the live lease is unused", () => {
    const output = JSON.stringify({ ok: false, message: "daemon not initialized" });
    vi.mocked(spawnSync)
      .mockReturnValueOnce(leaseResult(ACTIVE))
      .mockReturnValueOnce(processResult({ status: 1, stdout: output }));
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow("daemon stop did not complete successfully");
    expect(rmSync).not.toHaveBeenCalled();
    expect(cleanupReceipt()).toMatchObject({
      before: ACTIVE,
      stop: { status: 1, stdout: output },
    });
  });

  it("retains the root and records a thrown stop-launch error", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(leaseResult(ACTIVE))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("stop executable unavailable"), { code: "ENOENT" });
      });
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow("stop executable unavailable");
    expect(rmSync).not.toHaveBeenCalled();
    expect(cleanupReceipt().failure).toEqual({
      message: "stop executable unavailable",
      code: "ENOENT",
    });
  });

  it.each([
    { ...ACTIVE, pid: 202 },
    { ...ACTIVE, pid: 202, capability: "unknown", reason: "identity_unavailable" },
    { status: "unknown", path: LEASE_PATH, reason: "owner_malformed" },
  ])("retains a live/unknown successor after exit 0: %j", (after) => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(leaseResult(ACTIVE))
      .mockReturnValueOnce(processResult({ stdout: "claudexord stopped" }))
      .mockReturnValueOnce(leaseResult(after));
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow("writer-lease activity remains live or unknown");
    expect(rmSync).not.toHaveBeenCalled();
    expect(cleanupReceipt()).toMatchObject({ before: ACTIVE, after, stop: { status: 0 } });
    // Retention is retryable after a later independently confirmed stopped state.
    vi.mocked(spawnSync).mockReturnValue(leaseResult(ABSENT));
    sb.dispose();
    expect(rmSync).toHaveBeenCalledOnce();
  });

  it.each([
    processResult({ status: 1 }),
    processResult({ status: null, signal: "SIGKILL" }),
    processResult({ status: 0, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }),
    processResult({ stdout: "unreadable observation" }),
    leaseResult({ status: "absent" }),
  ])("retains the root when lease inspection cannot prove ownership: %j", (inspection) => {
    vi.mocked(spawnSync).mockReturnValue(inspection);
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow(`Canary cleanup incomplete at ${BASE}`);
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(rmSync).not.toHaveBeenCalled();
    expect(cleanupReceipt().failure.message).toBeTruthy();
  });

  it("keeps successful stop evidence when the final ownership observation fails", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(leaseResult(ACTIVE))
      .mockReturnValueOnce(processResult())
      .mockReturnValueOnce(processResult({ status: null, signal: "SIGKILL" }));
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow("writer-lease inspection failed");
    expect(rmSync).not.toHaveBeenCalled();
    expect(cleanupReceipt()).toMatchObject({ before: ACTIVE, stop: { status: 0 } });
    expect(cleanupReceipt().failure.message).toContain('"signal":"SIGKILL"');
  });

  it("reports failed directory removal instead of silently accepting residue", () => {
    vi.mocked(rmSync).mockImplementation(() => {
      throw Object.assign(new Error("directory busy"), { code: "EBUSY" });
    });
    const sb = makeSandbox();
    expect(() => sb.dispose()).toThrow("directory busy");
    expect(cleanupReceipt()).toMatchObject({ before: ABSENT, failure: { code: "EBUSY" } });
  });

  it("keeps the receipt in the thrown failure if writing it is unavailable", () => {
    const sb = makeSandbox();
    vi.mocked(spawnSync).mockReturnValue(processResult({ status: 1 }));
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    expect(() => sb.dispose()).toThrow(
      '"receiptWriteFailure":{"message":"no space","code":"ENOSPC"}',
    );
    expect(rmSync).not.toHaveBeenCalled();
  });
});
