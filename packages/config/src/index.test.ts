import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import {
  ConfigParseError,
  listTrustConfigs,
  loadConfig,
  repoHash,
  sweepRetiredConfigKeysAtStartup,
  updateGlobalConfig,
  updateTrustConfig,
} from "./index.js";

describe("loadConfig", () => {
  function withTempConfig(
    fn: (paths: { dir: string; repo: string; configDir: string }) => void,
  ): void {
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const prevReviewerTimeout = process.env.CLAUDEXOR_REVIEWER_TIMEOUT_MS;
    const prevRetryMax = process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX;
    const prevRetryInitialDelay = process.env.CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS;
    const prevRetryMaxDelay = process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS;
    const dir = mkdtempSync(join(tmpdir(), "claudexor-config-test-"));
    const repo = join(dir, "repo");
    const configDir = join(dir, "home");
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    delete process.env.CLAUDEXOR_REVIEWER_TIMEOUT_MS;
    delete process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX;
    delete process.env.CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS;
    delete process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS;
    try {
      fn({ dir, repo, configDir });
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      if (prevReviewerTimeout === undefined) delete process.env.CLAUDEXOR_REVIEWER_TIMEOUT_MS;
      else process.env.CLAUDEXOR_REVIEWER_TIMEOUT_MS = prevReviewerTimeout;
      if (prevRetryMax === undefined) delete process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX;
      else process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX = prevRetryMax;
      if (prevRetryInitialDelay === undefined)
        delete process.env.CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS;
      else process.env.CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS = prevRetryInitialDelay;
      if (prevRetryMaxDelay === undefined)
        delete process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS;
      else process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS = prevRetryMaxDelay;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns defaults when no config files exist", () => {
    withTempConfig(({ repo }) => {
      const cfg = loadConfig(repo);
      expect(cfg.sources).toEqual([]);
      expect(cfg.global.routing.goal).toBe("auto");
      expect(cfg.global.routing.paid_fallback).toBe("when_unavailable");
      expect(cfg.global.runtime.reviewer_timeout_ms).toBe(600_000);
      expect(cfg.global.runtime.transient_retry.max_retries).toBe(2);
    });
  });

  it("honors runtime env overrides and validates them loudly", () => {
    withTempConfig(({ repo }) => {
      process.env.CLAUDEXOR_REVIEWER_TIMEOUT_MS = "700000";
      process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX = "3";
      const cfg = loadConfig(repo);
      expect(cfg.global.runtime.reviewer_timeout_ms).toBe(700_000);
      expect(cfg.global.runtime.transient_retry.max_retries).toBe(3);
      process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX = "-1";
      expect(() => loadConfig(repo)).toThrow(ConfigParseError);
    });
  });

  it("fails loudly on malformed project YAML instead of silently defaulting", () => {
    withTempConfig(({ repo }) => {
      const configPath = join(repo, ".claudexor", "config.yaml");
      writeFileSync(configPath, "version: [unterminated\n");
      try {
        loadConfig(repo);
        throw new Error("expected loadConfig to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigParseError);
        expect((err as ConfigParseError).path).toBe(configPath);
        expect(String((err as Error).message)).toMatch(/invalid Claudexor YAML config/);
      }
    });
  });

  it("fails loudly on malformed global YAML", () => {
    withTempConfig(({ repo, configDir }) => {
      const configPath = join(configDir, "config.yaml");
      writeFileSync(configPath, "global: [broken\n");
      expect(() => loadConfig(repo)).toThrow(ConfigParseError);
      expect(() => loadConfig(repo)).toThrow(configPath);
    });
  });

  it("fails loudly on malformed trust YAML", () => {
    withTempConfig(({ repo, configDir }) => {
      const trustPath = join(configDir, "trust", `${repoHash(repo)}.yaml`);
      mkdirSync(join(configDir, "trust"), { recursive: true });
      writeFileSync(trustPath, "trust: [broken\n");
      expect(() => loadConfig(repo)).toThrow(ConfigParseError);
      expect(() => loadConfig(repo)).toThrow(trustPath);
    });
  });

  it("does not rewrite malformed global config during update", () => {
    withTempConfig(({ configDir }) => {
      const configPath = join(configDir, "config.yaml");
      writeFileSync(configPath, "global: [broken\n");
      expect(() => updateGlobalConfig((cfg) => cfg)).toThrow(ConfigParseError);
    });
  });
});

describe("strict config unknown keys", () => {
  it("names unknown keys in the friendly ConfigParseError message (cross-package zod instance)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-strict-cfg-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      writeFileSync(join(dir, "config.yaml"), "version: 1\ntotally_unknown_knob: true\n");
      expect(() => loadConfig(dir)).toThrowError(/unknown key\(s\): totally_unknown_knob/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("retired-key sweep (B9)", () => {
  it("loads a config carrying a retired harnesses.<id>.active_profile_id (stripped in-memory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-cfg-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      writeFileSync(
        join(dir, "config.yaml"),
        "version: 1\nharnesses:\n  claude:\n    active_profile_id: exp-a\n    default_model: sonnet\n",
      );
      // Load must SUCCEED — the retired key is stripped before the strict parse.
      const cfg = loadConfig(dir);
      expect(cfg.global.harnesses?.claude?.default_model).toBe("sonnet");
      expect((cfg.global.harnesses?.claude as Record<string, unknown>)?.active_profile_id).toBe(
        undefined,
      );
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PERSISTS the cleaned file and DISCLOSES the sweep at startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-sweep-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    const configPath = join(dir, "config.yaml");
    try {
      writeFileSync(
        configPath,
        "version: 1\nharnesses:\n  claude:\n    active_profile_id: exp-a\n    default_model: sonnet\n",
      );
      const sweeps = sweepRetiredConfigKeysAtStartup();
      // The global sweep reports the exact retired path it removed.
      const global = sweeps.find((s) => s.path === configPath);
      expect(global?.removed).toContain("harnesses.claude.active_profile_id");
      // The persisted file no longer carries the retired key, keeps the rest.
      const onDisk = yamlParse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(onDisk.harnesses.claude.active_profile_id).toBeUndefined();
      expect(onDisk.harnesses.claude.default_model).toBe("sonnet");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails LOUD on a genuinely unknown key (not on the retired registry)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-loud-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      writeFileSync(
        join(dir, "config.yaml"),
        "version: 1\nharnesses:\n  claude:\n    bogus_knob: 1\n",
      );
      expect(() => loadConfig(dir)).toThrowError(/unknown key/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("trust config enumeration", () => {
  it("updateTrustConfig stamps repo_root provenance; listTrustConfigs enumerates entries (legacy files -> null root)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-trust-list-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const repoA = join(dir, "proj-a");
      const res = updateTrustConfig(repoA, (cfg) => ({ ...cfg, allow_full_access: true }));
      expect(res.config.repo_root).toBe(repoA);
      expect(res.config.allow_full_access).toBe(true);
      // A legacy file written BEFORE provenance stamping: enumerable, null root.
      writeFileSync(
        join(dir, "trust", `${repoHash("/legacy/proj")}.yaml`),
        "version: 1\naccess_default: workspace_write\nallow_full_access: true\n",
      );
      const entries = listTrustConfigs();
      expect(entries).toHaveLength(2);
      const roots = entries.map((e) => e.config.repo_root).sort();
      expect(roots).toEqual([repoA, null].sort());
      // Revoke keeps the file enumerable with the flag off (Settings shows truth).
      updateTrustConfig(repoA, (cfg) => ({ ...cfg, allow_full_access: false }));
      const after = listTrustConfigs().find((e) => e.config.repo_root === repoA);
      expect(after?.config.allow_full_access).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
