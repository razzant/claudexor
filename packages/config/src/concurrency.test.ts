import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigParseError, loadConfig, updateGlobalConfig } from "./index.js";
import {
  CONCURRENCY_KEYS,
  RuntimeConcurrencyCaps,
  concurrencyState,
  runtimeConcurrencyCaps,
} from "@claudexor/schema";

const vars = [
  "CLAUDEXOR_MAX_CONCURRENT",
  "CLAUDEXOR_MAX_CONCURRENT_NON_MODEL_JOBS",
  "CLAUDEXOR_MAX_CONCURRENT_MODEL_OPERATIONS",
  "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
  "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
  "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
];
describe("concurrency configuration contract", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-cap-config-"));
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
    for (const name of vars) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips explicit defaults while unrelated saves omit implicit defaults", () => {
    updateGlobalConfig((cfg) => cfg);
    const path = join(root, "config.yaml");
    expect(readFileSync(path, "utf8")).not.toContain("max_concurrent:");
    writeFileSync(path, "runtime:\n  max_concurrent: 24\n");
    updateGlobalConfig((cfg) => cfg);
    expect(readFileSync(path, "utf8")).toContain("max_concurrent: 24");
    expect(readFileSync(path, "utf8")).not.toContain("max_deep_scan_width:");
  });

  it.each(vars)("validates %s independently with typed config failures", (name) => {
    for (const raw of ["0", "-1", "1.5", "abc", "Infinity", "9007199254740992", ""]) {
      vi.stubEnv(name, raw);
      expect(() => loadConfig(root), raw).toThrow(ConfigParseError);
    }
    vi.stubEnv(name, "9007199254740991");
    expect(() => loadConfig(root)).not.toThrow();
  });

  it("uses env over YAML without rewriting it and compares every admission and strategy cap", () => {
    const path = join(root, "config.yaml");
    const yaml = "runtime:\n  max_concurrent: 30\n";
    writeFileSync(path, yaml);
    vi.stubEnv("CLAUDEXOR_MAX_CONCURRENT", "48");
    expect(loadConfig(root).global.runtime.max_concurrent).toBe(48);
    expect(readFileSync(path, "utf8")).toBe(yaml);
    const caps = RuntimeConcurrencyCaps.parse({});
    expect(concurrencyState(caps, caps).restartRequired).toBe(false);
    for (const key of CONCURRENCY_KEYS) {
      expect(
        concurrencyState(
          { ...caps, [key]: typeof caps[key] === "number" ? caps[key] + 1 : 2 },
          caps,
        ).restartRequired,
      ).toBe(true);
    }
  });

  it("distinguishes absent, explicit unlimited and finite limits through file and env resolution", () => {
    const absent = loadConfig(root);
    expect(absent.global.runtime).toMatchObject({
      max_concurrent: "unlimited",
      max_concurrent_non_model_jobs: "unlimited",
      max_concurrent_model_operations: "unlimited",
      max_parallel_candidates: 4,
      max_deep_scan_width: 8,
      max_council_members: 4,
    });
    expect(absent.runtimeConcurrencySources).toMatchObject({
      max_concurrent: "default",
      max_concurrent_non_model_jobs: "default",
      max_concurrent_model_operations: "default",
    });
    writeFileSync(
      join(root, "config.yaml"),
      "runtime:\n  max_concurrent: unlimited\n  max_concurrent_non_model_jobs: 24\n  max_council_members: 8\n",
    );
    const configured = loadConfig(root);
    expect(configured.global.runtime.max_concurrent).toBe("unlimited");
    expect(configured.runtimeConcurrencySources).toMatchObject({
      max_concurrent: "config",
      max_concurrent_non_model_jobs: "config",
      max_concurrent_model_operations: "default",
    });
    vi.stubEnv("CLAUDEXOR_MAX_CONCURRENT", "12");
    vi.stubEnv("CLAUDEXOR_MAX_CONCURRENT_NON_MODEL_JOBS", "unlimited");
    vi.stubEnv("CLAUDEXOR_MAX_CONCURRENT_MODEL_OPERATIONS", "3");
    const overridden = loadConfig(root);
    expect(overridden.global.runtime).toMatchObject({
      max_concurrent: 12,
      max_concurrent_non_model_jobs: "unlimited",
      max_concurrent_model_operations: 3,
      max_council_members: 8,
    });
    expect(overridden.runtimeConcurrencySources).toMatchObject({
      max_concurrent: "environment",
      max_concurrent_non_model_jobs: "environment",
      max_concurrent_model_operations: "environment",
    });
    updateGlobalConfig((cfg) => ({ ...cfg, interaction_timeout_ms: 1234 }));
    const saved = readFileSync(join(root, "config.yaml"), "utf8");
    expect(saved).toContain("max_concurrent: unlimited");
    expect(saved).toContain("max_concurrent_non_model_jobs: 24");
    expect(saved).not.toContain("max_concurrent_model_operations:");
  });

  it("freezes effective values and provenance while a file change becomes pending", () => {
    writeFileSync(join(root, "config.yaml"), "runtime:\n  max_concurrent: 24\n");
    const before = loadConfig(root);
    const effective = runtimeConcurrencyCaps(before.global, before.runtimeConcurrencySources);
    writeFileSync(
      join(root, "config.yaml"),
      "runtime:\n  max_concurrent: unlimited\n  max_concurrent_model_operations: 2\n",
    );
    const after = loadConfig(root);
    const state = concurrencyState(
      runtimeConcurrencyCaps(after.global, after.runtimeConcurrencySources),
      effective,
    );
    expect(state).toMatchObject({
      configured: {
        maxConcurrent: "unlimited",
        maxConcurrentModelOperations: 2,
        sources: { max_concurrent: "config" },
      },
      effective: {
        maxConcurrent: 24,
        maxConcurrentModelOperations: "unlimited",
        sources: { max_concurrent_model_operations: "default" },
      },
      restartRequired: true,
    });
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.sources)).toBe(true);
  });

  it("accepts unlimited only for admission axes, never as a strategy-width sentinel", () => {
    for (const name of vars.slice(0, 3)) {
      vi.stubEnv(name, "unlimited");
      expect(() => loadConfig(root)).not.toThrow();
    }
    for (const name of vars.slice(3)) {
      vi.stubEnv(name, "unlimited");
      expect(() => loadConfig(root)).toThrow(ConfigParseError);
      vi.stubEnv(name, undefined);
    }
    for (const key of [
      "max_concurrent",
      "max_concurrent_non_model_jobs",
      "max_concurrent_model_operations",
    ]) {
      for (const value of ["null", "0", "-1", "1.5", "9007199254740992", "true"]) {
        writeFileSync(join(root, "config.yaml"), `runtime:\n  ${key}: ${value}\n`);
        expect(() => loadConfig(root)).toThrow(ConfigParseError);
      }
    }
  });
});
