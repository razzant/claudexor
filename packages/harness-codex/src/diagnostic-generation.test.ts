import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAdapter } from "./index.js";

const WITHHELD = /verification not run: paid diagnostic generation is disabled/;

function fixture(loggedIn: boolean) {
  const smokes: string[] = [];
  const adapter = createCodexAdapter({
    detectVersion: async () => "codex 0.144.1",
    brokenInstallAdvisory: () => null,
    probeEfforts: async () => null,
    probeLogin: async () =>
      loggedIn
        ? { authed: true, method: "chatgpt", probeError: null }
        : { authed: false, method: "logged_out", probeError: null },
    hasApiKey: () => true,
    codexApiKey: () => "fixture-not-a-real-key",
    smokeIsolatedApiKey: async () => {
      smokes.push("api_key");
      return { ok: true, detail: "fixture smoke" };
    },
  });
  return { adapter, smokes };
}

describe("Codex diagnostic generation (forbidden at a $0 paid limit)", () => {
  // An inherited native-store override must not steer these reads; restored afterwards.
  beforeEach(() => vi.stubEnv("CLAUDEXOR_CODEX_NATIVE_HOME", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("does not send the API-key smoke and reports the route as not run", async () => {
    const { adapter, smokes } = fixture(false);
    for (const authPreference of ["auto", "api_key"] as const) {
      const report = await adapter.doctor({
        cwd: "/repo",
        authPreference,
        fresh: true,
        diagnosticGeneration: "forbidden",
      });
      expect(report.status, authPreference).toBe("degraded");
      expect(report.auth_sources).toContainEqual(
        expect.objectContaining({
          source: "provider_auth_file",
          availability: "available",
          verification: "not_run",
          detail: expect.stringMatching(WITHHELD),
        }),
      );
      expect(report.reasons.join(" ")).toMatch(WITHHELD);
      expect(report.reasons.join(" ")).not.toMatch(/smoke failed/);
    }
    expect(smokes).toEqual([]);
  });

  it("keeps a ready ChatGPT session ready; the manual doctor still verifies the key", async () => {
    const ready = fixture(true);
    const report = await ready.adapter.doctor({
      cwd: "/repo",
      authPreference: "auto",
      fresh: true,
      diagnosticGeneration: "forbidden",
    });
    expect(report.status).toBe("ok");
    expect(ready.smokes).toEqual([]);
    const manual = fixture(false);
    const verified = await manual.adapter.doctor({
      cwd: "/repo",
      authPreference: "api_key",
      fresh: true,
    });
    expect(manual.smokes).toEqual(["api_key"]);
    expect(verified.status).toBe("ok");
  });
});
