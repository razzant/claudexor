import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigParseError, loadConfig, repoHash, updateGlobalConfig } from "./index.js";

describe("loadConfig", () => {
  function withTempConfig(fn: (paths: { dir: string; repo: string; configDir: string }) => void): void {
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
      if (prevRetryInitialDelay === undefined) delete process.env.CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS;
      else process.env.CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS = prevRetryInitialDelay;
      if (prevRetryMaxDelay === undefined) delete process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS;
      else process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS = prevRetryMaxDelay;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns defaults when no config files exist", () => {
    withTempConfig(({ repo }) => {
      const cfg = loadConfig(repo);
      expect(cfg.sources).toEqual([]);
      expect(cfg.global.default_portfolio).toBe("subscription-first");
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
