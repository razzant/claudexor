import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeOauthKeychainItem,
  parseClaudeOauthCredential,
  parseClaudeOauthUsage,
  readClaudeOauthCredential,
  refreshClaudeOauthUsageQuota,
} from "./claude-oauth-usage.js";

/** The EXACT response shape of the 2026-07-17 live experiment (max plan). */
const LIVE_USAGE = {
  five_hour: { utilization: 38.0, resets_at: "2026-07-17T07:40:00Z" },
  seven_day: { utilization: 26.0, resets_at: "2026-07-19T20:00:00Z" },
  limits: [
    { kind: "session", percent: 38, severity: "normal", is_active: true },
    { kind: "weekly_all", percent: 26 },
    { kind: "weekly_scoped", percent: 17, scope: { model: { display_name: "Fable" } } },
  ],
  extra_usage: { is_enabled: true, utilization: 98.77 },
  spend: { percent: 99, severity: "critical" },
};

describe("claude oauth/usage quota source (W5.3, INV-062)", () => {
  it("keychain item name follows the live-verified vendor formula", () => {
    // sha256("/Users/anton/.claudexor/v3-experiment/claude-A")[:8] observed
    // LIVE in the macOS keychain after a profile login (2026-07-17).
    expect(claudeOauthKeychainItem("/Users/anton/.claudexor/v3-experiment/claude-A")).toBe(
      "Claude Code-credentials-eb020df8",
    );
  });

  it("parses the live response into subject-scoped proactive constraints", () => {
    const snapshot = parseClaudeOauthUsage(
      LIVE_USAGE,
      "work",
      "max",
      new Date("2026-07-17T07:00:00Z"),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.subject).toMatchObject({
      harness: "claude",
      credential_route: "vendor_native",
      subject_id: "work",
      plan_label: "max",
    });
    expect(snapshot?.source).toBe("claude_oauth_usage");
    const byId = new Map(snapshot!.constraints.map((c) => [c.id, c]));
    expect(byId.get("five_hour")).toMatchObject({
      used_ratio: 0.38,
      resets_at: "2026-07-17T07:40:00Z",
      window_seconds: 5 * 3600,
    });
    expect(byId.get("seven_day")).toMatchObject({ used_ratio: 0.26 });
    expect(byId.get("weekly_scoped:Fable")).toMatchObject({
      used_ratio: 0.17,
      label: "7 day (Fable)",
    });
  });

  it("fails to unknown on junk — no fabricated constraints", () => {
    expect(parseClaudeOauthUsage(null, null, null)).toBeNull();
    expect(parseClaudeOauthUsage({}, null, null)).toBeNull();
    expect(parseClaudeOauthUsage({ five_hour: { utilization: "38" } }, null, null)).toBeNull();
  });

  it("reads both credential shapes and never invents a token", () => {
    expect(
      parseClaudeOauthCredential(JSON.stringify({ accessToken: "tok", subscriptionType: "max" })),
    ).toEqual({ accessToken: "tok", subscriptionType: "max" });
    expect(
      parseClaudeOauthCredential(
        JSON.stringify({ claudeAiOauth: { accessToken: "tok2", subscriptionType: "pro" } }),
      ),
    ).toEqual({ accessToken: "tok2", subscriptionType: "pro" });
    expect(parseClaudeOauthCredential("not json")).toBeNull();
    expect(parseClaudeOauthCredential(JSON.stringify({ refreshToken: "only" }))).toBeNull();
  });

  it("claims a typed not_logged_in absence (never throws) when no subject responds", async () => {
    // Default user / non-macOS: no credential is readable, so the refresher
    // produces no snapshot — but the absence is STATED, not silent emptiness
    // (release cut V11a). It never throws (a throw only polluted the registry's
    // aggregate failure line).
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.subject.harness).toBe("claude");
    expect(nativeAbsence?.reason).toBe("not_logged_in");
    expect(result.absences?.every((a) => a.reason === "not_logged_in")).toBe(true);
  });

  it("claims a refresh_failed absence when the usage endpoint refuses", async () => {
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => ({ accessToken: "tok", subscriptionType: "max" }),
      fetchUsage: async () => {
        throw new Error("oauth/usage responded 500");
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("refresh_failed");
    expect(nativeAbsence?.detail).toContain("500");
  });

  it("claims a refresh_failed absence when an HTTP-200 body carries no parseable quota windows (BACKLOG Q-a)", async () => {
    // An endpoint that answers 200 but with a body that maps to zero quota
    // windows must yield a typed absence, not silent emptiness — the registry
    // needs the observation to back off instead of re-polling forever.
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => ({ accessToken: "tok", subscriptionType: "max" }),
      fetchUsage: async () => ({ unrelated: "payload", limits: [] }),
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("refresh_failed");
    expect(nativeAbsence?.detail).toContain("parseable quota windows");
  });
});

describe("claude credential-file store off macOS (Linux quota parity)", () => {
  const configDir = () => mkdtemp(join(tmpdir(), "claudexor-cred-"));
  // Redaction bait is assembled at runtime so no token-like literal ever
  // lands in the source tree (secret-scan CI step, INV-062).
  const bait = ["sk", "ant", "oat01", "b".repeat(24)].join("-");

  it("reads both vendor credential shapes from .credentials.json", async () => {
    const flat = await configDir();
    await writeFile(
      join(flat, ".credentials.json"),
      JSON.stringify({ accessToken: bait, subscriptionType: "max" }),
    );
    await expect(readClaudeOauthCredential(flat, "linux")).resolves.toEqual({
      accessToken: bait,
      subscriptionType: "max",
    });

    const wrapped = await configDir();
    await writeFile(
      join(wrapped, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: bait, subscriptionType: "pro" } }),
    );
    await expect(readClaudeOauthCredential(wrapped, "linux")).resolves.toEqual({
      accessToken: bait,
      subscriptionType: "pro",
    });
  });

  it("a missing credential file is the honest logged-out null, not an error", async () => {
    await expect(readClaudeOauthCredential(await configDir(), "linux")).resolves.toBeNull();
  });

  it("darwin stays keychain-only: a present credential file is never read there", async () => {
    // Owner lock Q2=a. A fresh temp dir can have no keychain item (its name
    // hashes the path), and off macOS the `security` binary does not exist —
    // so on EVERY platform a darwin-gated read must ignore the file → null.
    const dir = await configDir();
    await writeFile(
      join(dir, ".credentials.json"),
      JSON.stringify({ accessToken: bait, subscriptionType: "max" }),
    );
    await expect(readClaudeOauthCredential(dir, "darwin")).resolves.toBeNull();
  });

  it("an unparseable credential file throws a tagged fault with no file bytes", async () => {
    const dir = await configDir();
    await writeFile(join(dir, ".credentials.json"), `{"refreshToken":"${bait}"`);
    const failure = await readClaudeOauthCredential(dir, "linux").then(
      () => null,
      (error: unknown) => error as Error & { quotaAbsenceReason?: string },
    );
    expect(failure).not.toBeNull();
    expect(failure?.quotaAbsenceReason).toBe("refresh_failed");
    expect(failure?.message).not.toContain(bait);
    expect(failure?.message).not.toContain("refreshToken");
  });

  it("an unreadable credential file throws a tagged fault naming only the error class", async () => {
    const dir = await configDir();
    await mkdir(join(dir, ".credentials.json"));
    const failure = await readClaudeOauthCredential(dir, "linux").then(
      () => null,
      (error: unknown) => error as Error & { quotaAbsenceReason?: string },
    );
    expect(failure?.quotaAbsenceReason).toBe("refresh_failed");
    expect(failure?.message).toContain("EISDIR");
  });

  it("refresher states the file-store detail off macOS and keychain detail on it", async () => {
    const linux = await refreshClaudeOauthUsageQuota({
      readCredential: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-21T00:00:00Z"),
      platform: "linux",
    });
    const linuxAbsence = linux.absences?.find((a) => a.subject.subject_id === null);
    expect(linuxAbsence?.reason).toBe("not_logged_in");
    expect(linuxAbsence?.detail).toContain("credential file");
    expect(linuxAbsence?.detail).not.toContain("keychain");

    const darwin = await refreshClaudeOauthUsageQuota({
      readCredential: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-21T00:00:00Z"),
      platform: "darwin",
    });
    const darwinAbsence = darwin.absences?.find((a) => a.subject.subject_id === null);
    expect(darwinAbsence?.reason).toBe("not_logged_in");
    expect(darwinAbsence?.detail).toContain("keychain");
  });

  it("refresher converts a tagged store fault into a refresh_failed absence, never a throw", async () => {
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => {
        throw Object.assign(new Error("credential file unreadable (EACCES)"), {
          quotaAbsenceReason: "refresh_failed" as const,
        });
      },
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-21T00:00:00Z"),
      platform: "linux",
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("refresh_failed");
    expect(nativeAbsence?.detail).toContain("EACCES");
  });
});
