import { describe, expect, it } from "vitest";
import { normalizeReadiness } from "./readiness-presentation.js";

describe("normalizeReadiness (W4.7)", () => {
  it("classifies every REAL adapter probe id through the explicit table", () => {
    // The classification is a TABLE, not an id-substring match. This pin
    // enumerates the probe ids the in-repo adapters actually emit — adding a
    // probe id to an adapter without extending the table fails here, which is
    // exactly the honest failure (an unknown id renders as a generic probe
    // and, for smokes, would drop out of the typed smoke-readiness gate).
    const adapterIds: Record<string, { kind: string }> = {
      installed: { kind: "binary" },
      api_key: { kind: "auth" },
      provider_auth: { kind: "auth" },
      isolated_smoke: { kind: "smoke" },
      structured_output: { kind: "probe" },
    };
    const rows = normalizeReadiness({
      checks: Object.keys(adapterIds).map((id) => ({ id, status: "pass" as const })),
      authSources: [],
      configuredModel: null,
      configuredModelCheck: null,
    });
    for (const [id, expected] of Object.entries(adapterIds)) {
      const row = rows.find((r) => r.id === id);
      expect(row, id).toBeTruthy();
      expect(row!.kind, id).toBe(expected.kind);
      // A table hit has a curated title, never the raw id.
      expect(row!.title, id).not.toBe(id);
    }
  });

  it("degrades an UNKNOWN probe id honestly: generic probe, humanized name", () => {
    const rows = normalizeReadiness({
      checks: [{ id: "future_native_probe", status: "fail", detail: "boom" }],
      authSources: [],
      configuredModel: null,
      configuredModelCheck: null,
    });
    expect(rows).toEqual([
      {
        id: "future_native_probe",
        kind: "probe",
        title: "Future native probe",
        status: "fail",
        detail: "boom",
      },
    ]);
  });

  it("maps auth sources: verified passes, failed fails, everything else skips with honest detail", () => {
    const rows = normalizeReadiness({
      checks: [],
      authSources: [
        { source: "native_session", availability: "available", verification: "passed" },
        { source: "oauth_token_env", availability: "available", verification: "not_run" },
        { source: "api_key_env", availability: "unavailable", verification: "not_run" },
      ],
      configuredModel: null,
      configuredModelCheck: null,
    });
    expect(rows.map((r) => [r.id, r.kind, r.status, r.detail])).toEqual([
      ["auth_source:native_session", "auth", "pass", null],
      ["auth_source:oauth_token_env", "auth", "skip", "present, not verified"],
      ["auth_source:api_key_env", "auth", "skip", "not configured"],
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Native session", "Setup token", "API key"]);
  });

  it("renders the configured-model verdict as a row only when a model is configured", () => {
    expect(
      normalizeReadiness({
        checks: [],
        authSources: [],
        configuredModel: null,
        configuredModelCheck: null,
      }),
    ).toEqual([]);
    const rejected = normalizeReadiness({
      checks: [],
      authSources: [],
      configuredModel: "model-x",
      configuredModelCheck: { status: "rejected", message: "model-x is not in the truth source" },
    });
    expect(rejected).toEqual([
      {
        id: "configured_model",
        kind: "model",
        title: "Configured model",
        status: "fail",
        detail: "model-x is not in the truth source",
      },
    ]);
    const ok = normalizeReadiness({
      checks: [],
      authSources: [],
      configuredModel: "model-x",
      configuredModelCheck: { status: "ok" },
    });
    expect(ok[0]).toMatchObject({ status: "pass", detail: "model-x" });
  });
});
