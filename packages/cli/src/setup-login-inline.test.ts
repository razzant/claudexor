import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlSetupJob } from "@claudexor/schema";
import {
  streamDurableCodexLogin,
  terminalLoginFallback,
  terminalLoginReport,
} from "./setup-login-inline.js";

type TerminalJob = Pick<ControlSetupJob, "state" | "message" | "nativeCommand">;

function receipt(
  errorCode?: "device_auth_unsupported" | "spawn_failed",
): ControlSetupJob["nativeCommand"] {
  return {
    executionId: "exec-1",
    commandDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    permitIssuedAt: null,
    commandStarted: false,
    exitCode: null,
    signal: null,
    ...(errorCode ? { errorCode } : {}),
    finishedAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("D-17 audit 8: CLI terminal login report", () => {
  it("renders device_auth_unsupported as an ACTIONABLE next step, not a dead end", () => {
    const job: TerminalJob = {
      state: "not_supported",
      message: "codex does not expose typed device-code auth over its app-server",
      nativeCommand: receipt("device_auth_unsupported"),
    };
    const report = terminalLoginReport(job, "codex");
    expect(report.exitCode).toBe(1);
    // The consistent typed code is surfaced verbatim…
    expect(report.lines.join("\n")).toContain("device_auth_unsupported");
    // …with the exact actionable next step (start the Terminal sign-in).
    expect(report.lines.join("\n")).toContain("claudexor auth login codex --browser-redirect");
  });

  it("keeps ordinary terminal states on the plain status line", () => {
    expect(
      terminalLoginReport({ state: "succeeded", message: "ok", nativeCommand: undefined }, "codex"),
    ).toEqual({ lines: ["codex login succeeded: ok"], exitCode: 0 });
    // A not_supported WITHOUT the typed code (e.g. vendor not installed) has no
    // Terminal fallback claim — it stays the plain message.
    const bare: TerminalJob = {
      state: "not_supported",
      message: "install codex first",
      nativeCommand: undefined,
    };
    const report = terminalLoginReport(bare, "codex");
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).not.toContain("device_auth_unsupported");
  });

  it("scopes the profile fallback prose to the profile, not the default-store command", () => {
    const job: TerminalJob = {
      state: "not_supported",
      message: "codex does not expose typed device-code auth over its app-server",
      nativeCommand: receipt("device_auth_unsupported"),
    };
    const report = terminalLoginReport(job, "codex/work", { profileId: "work" });
    expect(report.exitCode).toBe(1);
    // The default-store one-liner would log into the WRONG store for a profile.
    expect(report.lines.join("\n")).not.toContain("claudexor auth login codex --browser-redirect");
    expect(report.lines.join("\n")).toContain("this profile");
  });
});

describe("D-17 audit 8: typed nextAction", () => {
  it("maps the device_auth_unsupported terminal to a typed browser_redirect pivot", () => {
    expect(
      terminalLoginFallback({
        state: "not_supported",
        nativeCommand: receipt("device_auth_unsupported"),
      }),
    ).toEqual({
      kind: "terminal_login_fallback",
      reason: "device_auth_unsupported",
      loginFlow: "browser_redirect",
    });
  });

  it("has no next action for an ordinary terminal or a plain not_supported", () => {
    expect(terminalLoginFallback({ state: "succeeded", nativeCommand: undefined })).toBeNull();
    expect(terminalLoginFallback({ state: "not_supported", nativeCommand: undefined })).toBeNull();
    expect(
      terminalLoginFallback({ state: "failed", nativeCommand: receipt("spawn_failed") }),
    ).toBeNull();
  });
});

// ---- Full valid setup-job fixtures for streamer snapshots ----

const AUTH_CAP_DISCLOSED = {
  attemptId: "attempt-inline",
  challengeDigest: "d".repeat(64),
  requestDigest: "e".repeat(64),
  disclosure: {
    schemaVersion: 1,
    protocolVersion: 1,
    harness: "codex",
    requested: "subscription",
    requiredRoute: "vendor_native",
    requiredSource: "native_session",
    networkScope: "selected_harness_only",
    billingKnowledge: "unknown",
    incrementalCostKnowledge: "unknown",
    mayConsumeQuota: true,
    generatedAt: "2026-07-23T00:00:00.000Z",
  },
  state: "disclosed",
};

const AUTHORIZATION = {
  executionId: "exec-1",
  executable: {
    realpath: "/usr/local/bin/codex",
    sha256: "c".repeat(64),
    size: 1234,
    mode: 33261,
    device: "16777220",
    inode: "999",
  },
  args: ["codex", "app-server", "--stdio"],
  commandDigest: "a".repeat(64),
  manifestDigest: "b".repeat(64),
};

function unsupportedJob(): unknown {
  return {
    jobId: "setup-inline-1",
    harness: "codex",
    action: "login",
    profileId: null,
    state: "not_supported",
    phase: "completed",
    outcome: { reason: "not_supported" },
    command: null,
    guideUrl: null,
    message: "codex does not expose typed device-code auth over its app-server",
    createdAt: "2026-07-23T00:00:00.000Z",
    startedAt: "2026-07-23T00:00:00.500Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    authCapability: AUTH_CAP_DISCLOSED,
    authorization: AUTHORIZATION,
    nativeCommand: {
      executionId: "exec-1",
      commandDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      permitIssuedAt: null,
      commandStarted: false,
      exitCode: null,
      signal: null,
      errorCode: "device_auth_unsupported",
      finishedAt: "2026-07-23T00:00:01.000Z",
    },
  };
}

function activeJob(state = "waiting_for_input", phase = "awaiting_user"): unknown {
  return {
    jobId: "setup-inline-1",
    harness: "codex",
    action: "login",
    profileId: null,
    state,
    phase,
    command: null,
    guideUrl: null,
    message: "waiting for the sign-in",
    createdAt: "2026-07-23T00:00:00.000Z",
    startedAt: "2026-07-23T00:00:00.500Z",
    finishedAt: null,
    authCapability: AUTH_CAP_DISCLOSED,
  };
}

function snapshot(job: unknown, deviceCode?: unknown): unknown {
  return { job, cursor: "cursor-1", sequence: 1, ...(deviceCode ? { deviceCode } : {}) };
}

function jsonResponse(value: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  return { ok, status, json: async () => value, text: async () => JSON.stringify(value) };
}

/** Fake control-plane transport: successive snapshot GETs, recorded POSTs. */
function makeTransport(snapshots: unknown[], postResponse?: unknown) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let calls = 0;
  const fetchImpl = async (path: string, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      posts.push({ path, body: JSON.parse(String(init?.body)) });
      return jsonResponse(postResponse ?? activeJob());
    }
    const snap = snapshots[Math.min(calls, snapshots.length - 1)];
    calls += 1;
    return jsonResponse(snap);
  };
  return { fetchImpl, posts, calls: () => calls };
}

const ADDR = { baseUrl: "http://127.0.0.1:0", token: "test-token" };

describe("D-17 audit 8: streamDurableCodexLogin one-action fallback", () => {
  let out: string[] = [];
  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });
  afterEach(() => vi.restoreAllMocks());

  it("on a TTY, accepting the offer STARTS the browser_redirect job in one action", async () => {
    const { fetchImpl, posts } = makeTransport([snapshot(unsupportedJob())]);
    const code = await streamDurableCodexLogin(ADDR, "setup-inline-1", {
      label: "codex",
      fallback: { harness: "codex" },
      promptYesNo: async () => true,
      sleep: async () => {},
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/setup/jobs");
    expect(posts[0].body).toMatchObject({
      harness: "codex",
      action: "login",
      authRequest: "subscription",
      loginFlow: "browser_redirect",
    });
    expect(posts[0].body.profileId).toBeUndefined();
    expect(out.join("")).toContain("Opening the Terminal codex sign-in");
  });

  it("declining the offer starts nothing and points at the exact command (exit 1)", async () => {
    const { fetchImpl, posts } = makeTransport([snapshot(unsupportedJob())]);
    const code = await streamDurableCodexLogin(ADDR, "setup-inline-1", {
      label: "codex",
      fallback: { harness: "codex" },
      promptYesNo: async () => false,
      sleep: async () => {},
      fetchImpl,
    });
    expect(code).toBe(1);
    expect(posts).toHaveLength(0);
    expect(out.join("")).toContain("claudexor auth login codex --browser-redirect");
  });

  it("scopes an accepted profile fallback to that profile's store", async () => {
    const { fetchImpl, posts } = makeTransport([snapshot(unsupportedJob())]);
    const code = await streamDurableCodexLogin(ADDR, "setup-inline-1", {
      label: "codex/work",
      fallback: { harness: "codex", profileId: "work" },
      promptYesNo: async () => true,
      sleep: async () => {},
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(posts[0].body).toMatchObject({ loginFlow: "browser_redirect", profileId: "work" });
  });

  it("--json emits the typed nextAction on the miss and never auto-starts a job", async () => {
    const { fetchImpl, posts } = makeTransport([snapshot(unsupportedJob())]);
    const code = await streamDurableCodexLogin(ADDR, "setup-inline-1", {
      label: "codex",
      json: true,
      fallback: { harness: "codex" },
      sleep: async () => {},
      fetchImpl,
    });
    expect(code).toBe(1);
    expect(posts).toHaveLength(0);
    const obj = JSON.parse(out.join(""));
    expect(obj.ok).toBe(false);
    expect(obj.nextAction).toEqual({
      kind: "terminal_login_fallback",
      reason: "device_auth_unsupported",
      loginFlow: "browser_redirect",
    });
    expect(obj.job.state).toBe("not_supported");
  });

  it("--json returns the disclosure promptly for a supported flow (no hang, no fallback)", async () => {
    const deviceCode = {
      flow: "chatgptDeviceCode",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "WXYZ-7788",
    };
    const { fetchImpl, posts } = makeTransport([snapshot(activeJob(), deviceCode)]);
    const code = await streamDurableCodexLogin(ADDR, "setup-inline-1", {
      label: "codex",
      json: true,
      fallback: { harness: "codex" },
      sleep: async () => {},
      fetchImpl,
    });
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    const obj = JSON.parse(out.join(""));
    expect(obj.deviceCode.userCode).toBe("WXYZ-7788");
    expect(obj.nextAction).toBeUndefined();
  });

  it("polls through an active snapshot before offering the fallback at the terminal state", async () => {
    const transport = makeTransport([
      snapshot(activeJob("running", "launching")),
      snapshot(unsupportedJob()),
    ]);
    const code = await streamDurableCodexLogin(ADDR, "setup-inline-1", {
      label: "codex",
      fallback: { harness: "codex" },
      promptYesNo: async () => false,
      sleep: async () => {},
      fetchImpl: transport.fetchImpl,
    });
    expect(code).toBe(1);
    expect(transport.calls()).toBe(2);
    expect(transport.posts).toHaveLength(0);
  });
});
