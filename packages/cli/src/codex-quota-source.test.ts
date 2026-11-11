import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultNativeCodexHome } from "@claudexor/harness-codex";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";
import {
  codexQuotaInvocation,
  parseCodexRateLimitsResponse,
  refreshCodexQuota,
  requestCodexAccount,
} from "./codex-quota-source.js";

describe("Codex app-server quota source", () => {
  it.skipIf(process.platform === "win32")(
    "runs its captured app-server without a console window and stops it after the answer",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-quota-window-"));
      try {
        const bin = join(dir, "codex");
        writeFileSync(
          bin,
          `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id !== undefined)
    process.stdout.write(JSON.stringify({ id: request.id, result: { method: request.method } }) + "\\n");
});
`,
        );
        chmodSync(bin, 0o755);
        const started: Array<{ args: string[]; options: SpawnOptions; child: ChildProcess }> = [];
        const start = ((binary: string, args: string[], options: SpawnOptions) => {
          const child = spawn(binary, args, options);
          started.push({ args, options, child });
          return child;
        }) as typeof spawn;
        const env = { PATH: dirname(process.execPath) };
        const home = join(dir, "home");
        await expect(requestCodexAccount(home, env, bin, start)).resolves.toEqual({
          method: "account/rateLimits/read",
        });
        expect(started).toHaveLength(1);
        expect(started[0]?.args).toEqual(codexQuotaInvocation(env, home).args);
        expect(started[0]?.options).toMatchObject({
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        expect(started[0]?.options.detached).toBeUndefined();
        const child = started[0]!.child;
        if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
        expect(child.signalCode ?? child.exitCode).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { rateLimits: null },
    { rateLimitsByLimitId: {} },
    { rateLimits: { primary: null, secondary: null } },
    { rateLimits: { limitId: "codex", planType: "pro" } },
    { rateLimitsByLimitId: { codex: { primary: null, secondary: null } } },
  ])("recognizes explicit absent windows without inventing zero usage: %j", (value) => {
    const snapshots = parseCodexRateLimitsResponse(value, new Date("2026-10-04T12:00:00Z"), "work");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.constraints).toEqual([]);
    expect(snapshots[0]?.subject.subject_id).toBe("work");
  });

  it.each([
    null,
    [],
    {},
    { rateLimitResetCredits: { availableCount: 3 } },
    { rateLimits: {} },
    { rateLimits: { unexpected: true } },
    { rateLimits: { primary: {} } },
    { rateLimits: { primary: "unknown" } },
    { rateLimits: { primary: { usedPercent: "0" } } },
    { rateLimits: { primary: { usedPercent: Number.NaN } } },
    { rateLimits: { primary: { usedPercent: 0, resetsAt: "bad" } } },
    { rateLimitsByLimitId: [] },
    { rateLimitsByLimitId: { codex: null } },
    { rateLimitsByLimitId: { codex: {}, review: { primary: { usedPercent: 0 } } } },
    { rateLimitsByLimitId: {}, rateLimits: { primary: "bad" } },
  ])(
    "refuses malformed or unrecognized readings instead of declaring successful absence: %j",
    (value) => {
      expect(() => parseCodexRateLimitsResponse(value, new Date())).toThrow(/Codex quota response/);
    },
  );

  it("preserves an available legacy window when the bucket map is empty", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimitsByLimitId: {},
        rateLimits: { primary: { usedPercent: 100, resetsAt: 1893456000 } },
      },
      new Date(),
    );
    expect(snapshot?.constraints[0]?.used_ratio).toBe(1);
  });

  it("keeps null measurements unknown in a recognized window", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      { rateLimits: { primary: { usedPercent: null, windowDurationMins: null, resetsAt: null } } },
      new Date(),
    );
    expect(snapshot?.constraints[0]?.used_ratio).toBeNull();
  });

  it.each([
    {
      code: -32603,
      message: "usage endpoint rejected the read",
      data: { code: "missing_scope", status: 403 },
    },
    { code: -32000, message: "the vendor operation timed out", data: { token: "private-value" } },
  ])(
    "keeps safe native refusal detail without turning RPC errors into auth or transport claims",
    async (error) => {
      const home = defaultNativeCodexHome();
      mkdirSync(home, { recursive: true });
      const authPath = join(home, "auth.json");
      writeFileSync(authPath, "{}\n");
      const requests: string[] = [];
      const diagnostics: QuotaRefreshDiagnostic[] = [];
      const start = (() => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = new EventEmitter();
        const stdin = new Writable({
          write(chunk, _encoding, callback) {
            const request = JSON.parse(String(chunk)) as { method: string; id?: number };
            requests.push(request.method);
            if (request.id !== undefined)
              queueMicrotask(() =>
                stdout.write(
                  `${JSON.stringify(
                    request.method === "account/rateLimits/read"
                      ? { id: request.id, error }
                      : { id: request.id, result: {} },
                  )}\n`,
                ),
              );
            callback();
          },
        });
        return Object.assign(child, {
          stdout,
          stderr,
          stdin,
          kill() {
            stdout.end();
            stderr.end();
            child.emit("exit", 0, null);
            return true;
          },
        });
      }) as unknown as typeof spawn;
      try {
        const result = await refreshCodexQuota({
          spawn: start,
          diagnostic: (record) => diagnostics.push(record),
        });
        expect(result.snapshots).toEqual([]);
        expect(result.absences).toHaveLength(1);
        expect(result.absences?.[0]).toMatchObject({ reason: "refresh_failed" });
        expect(result.absences?.[0]?.detail).toContain(`"rpc_code":${error.code}`);
        expect(result.absences?.[0]?.detail).toContain(error.message);
        expect(result.absences?.[0]?.detail).not.toContain("private-value");
        if (error.data.code)
          expect(result.absences?.[0]?.detail).toContain('"native_code":"missing_scope"');
        expect(requests).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
        expect(diagnostics).toMatchObject([
          { stage: "native_rpc", outcome: "started", reason: "account/rateLimits/read" },
          {
            stage: "native_rpc",
            outcome: "failed",
            reason: "native_rpc_refused",
            nativeRpcCode: error.code,
          },
        ]);
        expect(diagnostics[0]?.operationId).toBeTruthy();
        expect(diagnostics[0]?.operationId).toBe(diagnostics[1]?.operationId);
        expect(diagnostics.every((record) => record.stage !== "usage_http")).toBe(true);
      } finally {
        rmSync(authPath, { force: true });
      }
    },
  );

  it("keeps recognized text and image windows without giving unknown buckets global scope", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimits: { planType: "plus", limitId: "codex" },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1782368577 },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1782387153 },
            burst: { usedPercent: 5, windowDurationMins: 15, resetsAt: 1782351000 },
            metadata: { display: "not a window" },
          },
          image_gen: {
            primary: { usedPercent: 90, windowDurationMins: 1440, resetsAt: 1782360000 },
          },
          review: {
            limitId: "review",
            limitName: "Review",
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1782360000 },
          },
        },
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(snapshot?.subject.plan_label).toBe("plus");
    expect(snapshot?.constraints.map((c) => c.applies_to_request_kinds)).toEqual([
      ["text"],
      ["text"],
      ["text"],
      ["image"],
    ]);
    expect(snapshot?.constraints.map((item) => [item.id, item.used_ratio])).toEqual([
      ["codex:primary", 0.2],
      ["codex:secondary", 0.4],
      ["codex:burst", 0.05],
      ["image_gen:primary", 0.9],
    ]);
  });

  it("defaults quota reads to the Claudexor-owned native home and scrubs provider secrets", () => {
    const invocation = codexQuotaInvocation({
      PATH: "/bin",
      HOME: "/operator",
      CODEX_HOME: "/operator/.codex",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "other-secret",
      OPENAI_API_BASE: "https://redirect.invalid",
    });

    expect(invocation.args).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
      "--stdio",
    ]);
    expect(invocation.env.CODEX_HOME).toBe(defaultNativeCodexHome());
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.OPENAI_API_BASE).toBeUndefined();
    expect(invocation.env.HOME).toBe("/operator");
  });

  it("honors an explicit CODEX_HOME (per-profile quota reads bind to the profile home)", () => {
    const invocation = codexQuotaInvocation(
      { PATH: "/bin", HOME: "/operator" },
      "/scoped/work-home",
    );
    expect(invocation.env.CODEX_HOME).toBe("/scoped/work-home");
    expect(invocation.env.HOME).toBe("/operator");
  });

  it("stamps subject_id onto the snapshot for a profiled candidate", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1782360000 },
        },
      },
      new Date("2026-07-15T12:00:00.000Z"),
      "work",
    );
    expect(snapshot?.subject.subject_id).toBe("work");
  });

  it("a logged-out native home yields a not_logged_in absence WITHOUT spawning the binary", async () => {
    // No auth.json in the hermetic native home: even a "binary" that would
    // explode on spawn must never be reached (v3.0.3 S8 precheck).
    const result = await refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.subject.harness).toBe("codex");
    expect(nativeAbsence?.reason).toBe("not_logged_in");
    expect(nativeAbsence?.detail).toContain("auth login codex");
  });

  it("a post-migration refresh cycle carries no null candidate — the row alone covers the migrated home", async () => {
    // With a completed codex migration record, the retired null subject must
    // not resurrect: only the row candidate observes the (shared) store, so
    // one refresh cycle never double-probes it. Logged-out rows make the
    // observation cheap (typed absence, no binary spawn).
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "claudexor-codex-mig-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const { accountsMigrationFilePath } = await import("./accounts-unified-migration.js");
      const { updateGlobalConfig } = await import("@claudexor/config");
      const home = defaultNativeCodexHome();
      mkdirSync(home, { recursive: true });
      mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
      writeFileSync(
        accountsMigrationFilePath(),
        JSON.stringify({
          codex: {
            phase: "completed",
            row_id: "codex-default",
            legacy_aliases: [null],
            locator: home,
            backup_ref: null,
          },
        }),
      );
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [
          {
            profile_id: "codex-default",
            harness_id: "codex",
            display_name: "migrated",
            credential_kind: "config_dir_login",
            isolation_locator: home,
            secret_ref: null,
            enabled: true,
            created_at: null,
          },
        ],
      }));
      const result = await refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" });
      expect(result.snapshots).toEqual([]);
      // Exactly one observation of the store — the row's; never {codex, null}.
      expect(result.absences?.map((a) => a.subject.subject_id)).toEqual(["codex-default"]);
      expect(result.absences?.some((a) => a.subject.subject_id === null)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing Codex binary yields a transport absence claim, not a throw", async () => {
    const home = defaultNativeCodexHome();
    mkdirSync(home, { recursive: true });
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, "{}\n");
    try {
      const result = await refreshCodexQuota({ bin: "/definitely/missing/claudexor-codex" });
      expect(result.snapshots).toEqual([]);
      const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
      expect(nativeAbsence?.subject.harness).toBe("codex");
      expect(nativeAbsence?.reason).toBe("transport_unavailable");
      expect(nativeAbsence?.detail).toContain("Codex app-server quota refresh failed");
    } finally {
      rmSync(authPath, { force: true });
    }
  });

  it.skipIf(process.platform === "win32").each([
    { payload: { rateLimits: { primary: null, secondary: null } }, accepted: true },
    { payload: { rateLimits: { primary: {} } }, accepted: false },
  ])(
    "the app-server boundary preserves success versus malformed data: %j",
    async ({ payload, accepted }) => {
      const fixture = mkdtempSync(join(tmpdir(), "codex-quota-response-"));
      const binary = join(fixture, "app-server");
      const requestTime = join(fixture, "requested-at");
      const home = defaultNativeCodexHome();
      const auth = join(home, "auth.json");
      mkdirSync(home, { recursive: true });
      writeFileSync(auth, "{}\n");
      writeFileSync(
        binary,
        `#!${process.execPath}
const fs = require("node:fs");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const send = result => process.stdout.write(JSON.stringify({id:request.id, result}) + "\\n");
  if (request.method !== "account/rateLimits/read") return send({});
  fs.writeFileSync(${JSON.stringify(requestTime)}, String(Date.now()));
  setTimeout(() => send(${JSON.stringify(payload)}), 20);
});
`,
      );
      chmodSync(binary, 0o755);
      try {
        const result = await refreshCodexQuota({ bin: binary });
        if (accepted) {
          expect(result.snapshots).toHaveLength(1);
          expect(result.snapshots[0]?.constraints).toEqual([]);
          // The reply is delivered later; the observation remains bound to
          // request start so an intervening refusal cannot be superseded.
          expect(Date.parse(result.snapshots[0]!.observed_at)).toBeLessThanOrEqual(
            Number(readFileSync(requestTime, "utf8")),
          );
        } else {
          expect(result.snapshots).toEqual([]);
          expect(result.absences?.find((row) => row.subject.subject_id === null)?.reason).toBe(
            "refresh_failed",
          );
        }
      } finally {
        rmSync(auth, { force: true });
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});

describe("codex rateLimitResetCredits (W5.3 mini-gap, live-verified shape)", () => {
  const base = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1784822659 },
      planType: "pro",
    },
  };

  it("keeps reset inventory out of canonical quota constraints (legacy display is serialized separately)", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      { ...base, rateLimitResetCredits: { availableCount: 3, credits: [] } },
      new Date("2026-07-17T12:00:00Z"),
    );
    expect(snapshot?.constraints.some((c) => c.id === "reset_credits")).toBe(false);
    expect(snapshot?.constraints).toHaveLength(1);
  });

  it("stays silent on the live zero-balance shape", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      { ...base, rateLimitResetCredits: { availableCount: 0, credits: [] } },
      new Date("2026-07-17T12:00:00Z"),
    );
    expect(snapshot?.constraints.some((c) => c.id === "reset_credits")).toBe(false);
  });
});
