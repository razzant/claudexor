import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, updateGlobalConfig } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("persisted disabled inactivity watchdog", () => {
  it("round-trips null through YAML and honors an explicit numeric environment override", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-inactivity-config-"));
    roots.push(root);
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "");
    const saved = updateGlobalConfig((config) => ({
      ...config,
      runtime: { ...config.runtime, harness_inactivity_timeout_ms: null },
    }));
    expect(readFileSync(saved.path, "utf8")).toContain("harness_inactivity_timeout_ms: null");
    expect(loadConfig(root).global.runtime.harness_inactivity_timeout_ms).toBeNull();
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "60000");
    expect(loadConfig(root).global.runtime.harness_inactivity_timeout_ms).toBe(60000);
  });

  it("keeps the factory window when omitted and passes long numeric windows through uncapped", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-inactivity-config-"));
    roots.push(root);
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "");
    expect(loadConfig(root).global.runtime.harness_inactivity_timeout_ms).toBe(3_600_000);
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "2147484647");
    expect(loadConfig(root).global.runtime.harness_inactivity_timeout_ms).toBe(2_147_484_647);
    vi.stubEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS", "0");
    expect(() => loadConfig(root)).toThrow(/positive integer/);
  });
});
