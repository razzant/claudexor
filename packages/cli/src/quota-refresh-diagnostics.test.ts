import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshClaudeOauthUsageQuota, forgetClaudeOauthRejections } from "./claude-oauth-usage.js";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";

describe("quota observation diagnostics", () => {
  let previous: string | undefined;
  let root: string;
  const now = Date.parse("2026-10-04T10:00:00Z");
  const credential = {
    accessToken: "fixture-private-access",
    subscriptionType: null,
    expiresAtMs: now + 3_600_000,
    hasRefreshToken: true,
  };
  const usage = { five_hour: { utilization: 12, resets_at: "2026-10-04T15:00:00Z" } };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-quota-diagnostic-"));
    previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    forgetClaudeOauthRejections();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    forgetClaudeOauthRejections();
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("distinguishes a physical request from a remembered-token skip without storing credentials", async () => {
    const records: QuotaRefreshDiagnostic[] = [];
    let calls = 0;
    const deps = {
      readCredential: async () => credential,
      fetchUsage: async () => {
        calls++;
        throw Object.assign(new Error("vendor rejected a credential"), {
          quotaAbsenceReason: "auth_revoked",
        });
      },
      now: () => new Date(now),
      diagnostic: (record: QuotaRefreshDiagnostic) => records.push(record),
    };
    await refreshClaudeOauthUsageQuota(deps, { foreground: false });
    await refreshClaudeOauthUsageQuota(deps, { foreground: false });
    expect(calls).toBe(1);
    expect(records.map(({ stage, outcome, reason }) => ({ stage, outcome, reason }))).toEqual([
      { stage: "usage_http", outcome: "started", reason: undefined },
      { stage: "usage_http", outcome: "failed", reason: "auth_revoked" },
      { stage: "poll", outcome: "skipped", reason: "presented_token_already_rejected" },
    ]);
    expect(records[0]?.operationId).toBe(records[1]?.operationId);
    expect(records[2]?.operationId).not.toBe(records[0]?.operationId);
    expect(JSON.stringify(records)).not.toContain(credential.accessToken);
    expect(JSON.stringify(records)).not.toContain("tokenKey");
    // An externally replaced token remains eligible for an actual request.
    await refreshClaudeOauthUsageQuota({
      ...deps,
      readCredential: async () => ({ ...credential, accessToken: "replacement-private-access" }),
      fetchUsage: async () => {
        calls++;
        return usage;
      },
    });
    expect(calls).toBe(2);
    expect(records.at(-1)).toMatchObject({ stage: "usage_http", outcome: "succeeded" });
  });

  it("records obsolete completion as obsolete and diagnostics cannot change a successful refresh", async () => {
    const records: QuotaRefreshDiagnostic[] = [];
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => credential,
      fetchUsage: async () => {
        forgetClaudeOauthRejections();
        return usage;
      },
      now: () => new Date(now),
      diagnostic: (record) => records.push(record),
    });
    expect(result.snapshots).toHaveLength(1);
    expect(records[0]?.current).toBe(true);
    expect(records.at(-1)?.current).toBe(false);
    const successful = await refreshClaudeOauthUsageQuota({
      readCredential: async () => credential,
      fetchUsage: async () => usage,
      now: () => new Date(now),
      diagnostic: () => {
        throw new Error("log unavailable");
      },
    });
    expect(successful.snapshots).toHaveLength(1);
  });

  it("retains native child and expiry observations without guessing who wrote the store", async () => {
    const records: QuotaRefreshDiagnostic[] = [];
    const native = {
      binary: null,
      expiresAtMs: credential.expiresAtMs,
      exitCode: 0,
      signal: null,
      terminationUnconfirmed: false,
      childFailed: false,
    };
    await refreshClaudeOauthUsageQuota({
      readCredential: async () => ({ ...credential, expiresAtMs: now - 1 }),
      refreshCredential: async (_dir, _platform, _read, diagnostic) => {
        diagnostic?.(native);
        return credential;
      },
      fetchUsage: async () => usage,
      now: () => new Date(now),
      diagnostic: (record) => records.push(record),
    });
    expect(
      records.find((record) => record.stage === "native_refresh" && record.outcome === "succeeded"),
    ).toMatchObject({
      previousExpiresAtMs: now - 1,
      expiresAtMs: credential.expiresAtMs,
      reason: "fresh_expiry_observed_writer_unknown",
      native,
    });
    expect(
      records.filter((record) => record.stage === "usage_http" && record.outcome === "started"),
    ).toHaveLength(1);
  });
});
