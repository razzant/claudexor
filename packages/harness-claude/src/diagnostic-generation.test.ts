import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAuthStatusProbe } from "./auth-status.js";
import { createClaudeAdapter } from "./index.js";

const WITHHELD = /verification not run: paid diagnostic generation is disabled/;
const loggedOut = { loggedIn: false, authed: false, authMethod: null, probeError: null } as const;
const ready = { loggedIn: true, authed: true, authMethod: "claude.ai", probeError: null } as const;

/** Fictitious credential material; each physical smoke lands on `smokes`. */
function fixture(native: ClaudeAuthStatusProbe, key: boolean, token: boolean) {
  const smokes: string[] = [];
  const adapter = createClaudeAdapter({
    detectVersion: async () => "2.1.261",
    installation: () => ({ path: null, advisory: null }),
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "fixture" }),
    probeAuthStatus: async () => native,
    anthropicApiKey: () => (key ? "fixture-not-a-real-key" : null),
    claudeOAuthToken: () => (token ? "fixture-not-a-real-token" : null),
    smokeIsolatedApiKey: async () => {
      smokes.push("api_key");
      return { ok: true, detail: "fixture smoke" };
    },
    smokeIsolatedOAuthToken: async () => {
      smokes.push("setup_token");
      return { ok: true, detail: "fixture smoke" };
    },
  });
  return { adapter, smokes };
}

describe("Claude diagnostic generation (forbidden at a $0 paid limit)", () => {
  // An inherited native-store override must not steer these reads; restored afterwards.
  beforeEach(() => vi.stubEnv("CLAUDEXOR_CLAUDE_NATIVE_DIR", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("sends neither the API-key nor the setup-token smoke, and reports both as not run", async () => {
    const { adapter, smokes } = fixture(loggedOut, true, true);
    for (const authPreference of ["auto", "subscription", "api_key"] as const) {
      const report = await adapter.doctor({
        cwd: "/repo",
        authPreference,
        fresh: true,
        diagnosticGeneration: "forbidden",
      });
      expect(report.status, authPreference).toBe("degraded");
      expect(report.enabled_intents).toEqual([]);
      expect(report.auth_sources).toEqual(
        expect.arrayContaining(
          authPreference === "api_key"
            ? [expect.objectContaining({ source: "api_key_env", verification: "not_run" })]
            : [
                expect.objectContaining({ source: "oauth_token_env", verification: "not_run" }),
                expect.objectContaining({ source: "api_key_env", verification: "not_run" }),
              ],
        ),
      );
      expect(report.reasons.join(" "), authPreference).toMatch(WITHHELD);
      expect(report.reasons.join(" "), authPreference).not.toMatch(
        /smoke failed|verification failed/,
      );
    }
    expect(smokes).toEqual([]);
  });

  it("keeps a ready native session ready and still sends nothing", async () => {
    const { adapter, smokes } = fixture(ready, true, true);
    const report = await adapter.doctor({
      cwd: "/repo",
      authPreference: "auto",
      fresh: true,
      diagnosticGeneration: "forbidden",
    });
    expect(report.status).toBe("ok");
    expect(report.auth_sources).toContainEqual(
      expect.objectContaining({ source: "native_session", verification: "passed" }),
    );
    expect(smokes).toEqual([]);
  });

  it("the manual doctor and an allowed probe still verify (no mode, and allowed)", async () => {
    for (const diagnosticGeneration of [undefined, "allowed" as const]) {
      const { adapter, smokes } = fixture(loggedOut, true, true);
      const report = await adapter.doctor({
        cwd: "/repo",
        authPreference: "auto",
        fresh: true,
        ...(diagnosticGeneration ? { diagnosticGeneration } : {}),
      });
      expect(smokes).toEqual(["setup_token", "api_key"].slice(0, smokes.length));
      expect(smokes.length).toBeGreaterThan(0);
      expect(report.status).toBe("ok");
    }
  });

  it("reports a lone setup-token as not run under Auto, never as a missing login", async () => {
    const { adapter, smokes } = fixture(loggedOut, false, true);
    const report = await adapter.doctor({
      cwd: "/repo",
      authPreference: "auto",
      fresh: true,
      diagnosticGeneration: "forbidden",
    });
    expect(report.reasons.join(" ")).toMatch(WITHHELD);
    expect(report.reasons.join(" ")).not.toMatch(/not authenticated/);
    expect(report.auth_sources).toContainEqual(
      expect.objectContaining({ source: "oauth_token_env", verification: "not_run" }),
    );
    expect(smokes).toEqual([]);
  });

  it("keeps the withheld proofs in the Auto reasons beside a stale native observation", async () => {
    const { adapter, smokes } = fixture({ ...ready, stale: true, staleAgeMs: 5 }, true, true);
    const report = await adapter.doctor({
      cwd: "/repo",
      authPreference: "auto",
      fresh: true,
      diagnosticGeneration: "forbidden",
    });
    const reasons = report.reasons.join(" ");
    expect(reasons).toMatch(/last-known-good/);
    expect(reasons).toMatch(WITHHELD);
    expect(smokes).toEqual([]);
  });
});
