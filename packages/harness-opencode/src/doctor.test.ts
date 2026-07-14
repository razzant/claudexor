import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSecret: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("@claudexor/secrets", () => ({ resolveSecret: mocks.resolveSecret }));
vi.mock("@claudexor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/core")>();
  return { ...actual, runCapture: mocks.runCapture };
});

import { createOpenCodeAdapter } from "./index.js";

const KEY_ENV = ["OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

describe("opencode doctor exact auth-source readiness", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    for (const name of KEY_ENV) delete process.env[name];
    mocks.resolveSecret.mockReset().mockReturnValue(null);
    mocks.runCapture
      .mockReset()
      .mockResolvedValue({ stdout: "opencode 1.2.3\n", stderr: "", code: 0 });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports a present exact api_key_env source as available but unverified without a paid smoke", async () => {
    const secret = `sk-${"o".repeat(48)}`;
    const report = await createOpenCodeAdapter().doctor({
      cwd: "/repo",
      authSource: "api_key_env",
      env: { OPENCODE_API_KEY: secret },
    });

    expect(report.status).toBe("degraded");
    expect(report.auth_sources).toEqual([
      {
        source: "api_key_env",
        availability: "available",
        verification: "not_run",
        detail: "credential source is present; verification requires an isolated capability smoke",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports a missing exact api_key_env source as unavailable but unverified", async () => {
    const report = await createOpenCodeAdapter().doctor({
      cwd: "/repo",
      authSource: "api_key_env",
    });

    expect(report.status).toBe("unavailable");
    expect(report.auth_sources).toEqual([
      {
        source: "api_key_env",
        availability: "unavailable",
        verification: "not_run",
        detail: "no provider API key is configured",
      },
    ]);
  });

  it("returns exact unsupported-source evidence without reading any API-key source", async () => {
    process.env.OPENCODE_API_KEY = `sk-${"x".repeat(48)}`;

    const report = await createOpenCodeAdapter().doctor({
      cwd: "/repo",
      authSource: "native_session",
    });

    expect(report.enabled_intents).toEqual([]);
    expect(report.auth_sources).toEqual([
      {
        source: "native_session",
        availability: "unavailable",
        verification: "not_run",
        detail: "opencode does not support native_session",
      },
    ]);
    expect(mocks.resolveSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("api_key_env");
  });

  it("preserves exact key availability evidence when the CLI itself is missing", async () => {
    process.env.OPENAI_API_KEY = `sk-${"m".repeat(48)}`;
    mocks.runCapture.mockRejectedValueOnce(new Error("ENOENT"));

    const report = await createOpenCodeAdapter().doctor({
      cwd: "/repo",
      authSource: "api_key_env",
    });

    expect(report.status).toBe("unavailable");
    expect(report.auth_sources).toEqual([
      {
        source: "api_key_env",
        availability: "available",
        verification: "not_run",
        detail: "credential source is present; verification requires an isolated capability smoke",
      },
    ]);
    expect(report.reasons).toContain(
      "opencode not found (install OpenCode or set CLAUDEXOR_OPENCODE_BIN)",
    );
  });

  it("redacts secret-like vendor output before it enters doctor evidence", async () => {
    const leakedSecret = `ghp_${"z".repeat(36)}`;
    process.env.OPENCODE_API_KEY = `sk-${"r".repeat(48)}`;
    mocks.runCapture.mockResolvedValueOnce({
      stdout: `opencode 1.2.3 ${leakedSecret}\n`,
      stderr: "",
      code: 0,
    });

    const report = await createOpenCodeAdapter().doctor({
      cwd: "/repo",
      authSource: "api_key_env",
    });

    expect(JSON.stringify(report)).not.toContain(leakedSecret);
    expect(report.checks.find((check) => check.id === "installed")?.detail).toContain("[redacted]");
  });
});
