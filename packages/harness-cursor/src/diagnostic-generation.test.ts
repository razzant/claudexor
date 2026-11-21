import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessModel } from "@claudexor/schema";
import { createCursorAdapter } from "./index.js";

const WITHHELD = /verification not run: paid diagnostic generation is disabled/;

/** Fictitious key; every physical diagnostic request lands on `smokes`. */
function fixture() {
  const smokes: string[] = [];
  const listed: Array<string | null | undefined> = [];
  const adapter = createCursorAdapter({
    detectVersion: async () => "cursor-test",
    nativeAuthOk: async () => ({ kind: "loggedOut" }),
    cursorApiKey: () => "fixture-not-a-real-key",
    resolveProfileSecret: () => "fixture-not-a-real-key",
    listCursorModels: async (env) => {
      listed.push(env?.["CURSOR_API_KEY"]);
      return [HarnessModel.parse({ id: "fixture-model" })];
    },
    smokeIsolatedApiKey: async (key) => {
      smokes.push(key ?? "");
      return { ok: true, detail: "fixture smoke" };
    },
  });
  return { adapter, smokes, listed };
}

const apiProfile = {
  profile_id: "acc2",
  harness_id: "cursor",
  display_name: "Second",
  credential_kind: "api_key",
  isolation_locator: null,
  secret_ref: "cursor:acc2",
  enabled: true,
  created_at: null,
} as never;

describe("Cursor diagnostic generation (forbidden at a $0 paid limit)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cursor-diagnostic-"));
    // The allowed (positive) path observes the selected program before its fake
    // smoke; an absent absolute override leaves nothing to find or start.
    vi.stubEnv("CLAUDEXOR_CURSOR_BIN", join(root, "absent", "cursor-agent"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("doctor: a needed key smoke is not run, not failed, and never promoted to ready", async () => {
    const forbidden = fixture();
    const report = await forbidden.adapter.doctor({
      cwd: "/repo",
      authPreference: "api_key",
      fresh: true,
      diagnosticGeneration: "forbidden",
    });
    expect(forbidden.smokes).toEqual([]);
    expect(report.status).toBe("degraded");
    expect(report.auth_sources).toContainEqual(
      expect.objectContaining({
        source: "api_key_env",
        availability: "available",
        verification: "not_run",
        detail: expect.stringMatching(WITHHELD),
      }),
    );
    expect(report.checks.find((check) => check.id === "isolated_api_smoke")?.status).toBe("skip");
    expect(report.reasons.join(" ")).toMatch(WITHHELD);
    // The manual doctor (no mode) still verifies the key.
    const manual = fixture();
    const verified = await manual.adapter.doctor({
      cwd: "/repo",
      authPreference: "api_key",
      fresh: true,
    });
    expect(manual.smokes).toHaveLength(1);
    expect(verified.status).toBe("ok");
  });

  it("model inventory on a scoped route resolves no key smoke and lists nothing through the key", async () => {
    const { adapter, smokes, listed } = fixture();
    const spec = {
      cwd: "/repo",
      env: { HOME: "/scoped/home" },
      authPreference: "auto" as const,
      model: null,
      effort: null,
      fresh: true,
    };
    const prepared = await adapter.prepareProcessing!({
      ...spec,
      diagnosticGeneration: "forbidden",
    });
    expect(smokes).toEqual([]);
    expect(listed).toEqual([]);
    expect(prepared.catalog).toEqual([]);
    // Allowed (today's behavior): the key is proven, then lists.
    await adapter.prepareProcessing!(spec);
    expect(smokes).toHaveLength(1);
    expect(listed).toEqual(["fixture-not-a-real-key"]);
  });

  it("model inventory of an API-key account row resolves no key smoke", async () => {
    const { adapter, smokes } = fixture();
    const spec = {
      cwd: "/repo",
      env: { HOME: "/scoped/home" },
      authPreference: "auto" as const,
      credentialProfile: apiProfile,
      model: null,
      effort: null,
    };
    await adapter.prepareProcessing!({ ...spec, diagnosticGeneration: "forbidden" });
    expect(smokes).toEqual([]);
    await adapter.prepareProcessing!(spec);
    expect(smokes).toHaveLength(1);
  });

  it("the default-key inventory read (no scoped env) resolves no key smoke", async () => {
    const { adapter, smokes } = fixture();
    await adapter.models!({ cwd: "/repo", diagnosticGeneration: "forbidden" });
    expect(smokes).toEqual([]);
    await adapter.models!({ cwd: "/repo" });
    expect(smokes).toHaveLength(1);
  });
});
