import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const prevMaxConcurrent = process.env.CLAUDEXOR_MAX_CONCURRENT;
    const prevMaxParallelCandidates = process.env.CLAUDEXOR_MAX_PARALLEL_CANDIDATES;
    const prevMaxDeepScanWidth = process.env.CLAUDEXOR_MAX_DEEP_SCAN_WIDTH;
    const prevMaxCouncilMembers = process.env.CLAUDEXOR_MAX_COUNCIL_MEMBERS;
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
    delete process.env.CLAUDEXOR_MAX_CONCURRENT;
    delete process.env.CLAUDEXOR_MAX_PARALLEL_CANDIDATES;
    delete process.env.CLAUDEXOR_MAX_DEEP_SCAN_WIDTH;
    delete process.env.CLAUDEXOR_MAX_COUNCIL_MEMBERS;
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
      if (prevMaxConcurrent === undefined) delete process.env.CLAUDEXOR_MAX_CONCURRENT;
      else process.env.CLAUDEXOR_MAX_CONCURRENT = prevMaxConcurrent;
      if (prevMaxParallelCandidates === undefined)
        delete process.env.CLAUDEXOR_MAX_PARALLEL_CANDIDATES;
      else process.env.CLAUDEXOR_MAX_PARALLEL_CANDIDATES = prevMaxParallelCandidates;
      if (prevMaxDeepScanWidth === undefined) delete process.env.CLAUDEXOR_MAX_DEEP_SCAN_WIDTH;
      else process.env.CLAUDEXOR_MAX_DEEP_SCAN_WIDTH = prevMaxDeepScanWidth;
      if (prevMaxCouncilMembers === undefined) delete process.env.CLAUDEXOR_MAX_COUNCIL_MEMBERS;
      else process.env.CLAUDEXOR_MAX_COUNCIL_MEMBERS = prevMaxCouncilMembers;
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
      expect(cfg.global.runtime.max_concurrent).toBe("unlimited");
      expect(cfg.global.runtime.max_parallel_candidates).toBe(4);
      expect(cfg.global.runtime.max_deep_scan_width).toBe(8);
      expect(cfg.global.runtime.max_council_members).toBe(4);
      expect(cfg.global.runtime.transient_retry.max_retries).toBe(2);
    });
  });

  it("honors runtime env overrides and validates them loudly", () => {
    withTempConfig(({ repo }) => {
      process.env.CLAUDEXOR_REVIEWER_TIMEOUT_MS = "700000";
      process.env.CLAUDEXOR_MAX_CONCURRENT = "30";
      process.env.CLAUDEXOR_MAX_PARALLEL_CANDIDATES = "6";
      process.env.CLAUDEXOR_MAX_DEEP_SCAN_WIDTH = "10";
      process.env.CLAUDEXOR_MAX_COUNCIL_MEMBERS = "5";
      process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX = "3";
      const cfg = loadConfig(repo);
      expect(cfg.global.runtime.reviewer_timeout_ms).toBe(700_000);
      expect(cfg.global.runtime.max_concurrent).toBe(30);
      expect(cfg.global.runtime.max_parallel_candidates).toBe(6);
      expect(cfg.global.runtime.max_deep_scan_width).toBe(10);
      expect(cfg.global.runtime.max_council_members).toBe(5);
      expect(cfg.global.runtime.transient_retry.max_retries).toBe(3);
      process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX = "-1";
      expect(() => loadConfig(repo)).toThrow(ConfigParseError);
      process.env.CLAUDEXOR_TRANSIENT_RETRY_MAX = "3";
      for (const name of [
        "CLAUDEXOR_MAX_CONCURRENT",
        "CLAUDEXOR_MAX_PARALLEL_CANDIDATES",
        "CLAUDEXOR_MAX_DEEP_SCAN_WIDTH",
        "CLAUDEXOR_MAX_COUNCIL_MEMBERS",
      ]) {
        process.env[name] = "0";
        expect(() => loadConfig(repo)).toThrow(ConfigParseError);
        delete process.env[name];
      }
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

  it("loads versioned project protected-path restrictions", () => {
    withTempConfig(({ repo }) => {
      writeFileSync(
        join(repo, ".claudexor", "config.yaml"),
        "version: 1\nconstraints:\n  protected_paths:\n    - migrations/**\n    - '**/*.env'\n",
      );
      expect(loadConfig(repo).project.constraints.protected_paths).toEqual([
        "migrations/**",
        "**/*.env",
      ]);
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

  it("PERSISTS the cleaned file, DISCLOSES the sweep, and leaves a byte-identical backup on this generation's DEFAULT root", () => {
    // The positive gate case needs root == defaultUserConfigDir(): point HOME
    // at a temp dir and drop the vitest-global CLAUDEXOR_CONFIG_DIR override.
    const home = mkdtempSync(join(tmpdir(), "claudexor-retired-sweep-home-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    const prevHome = process.env.HOME;
    delete process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.HOME = home;
    const configDir = join(home, ".claudexor", "v3");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    const originalText =
      "version: 1\nharnesses:\n  claude:\n    active_profile_id: exp-a\n    default_model: sonnet\n";
    try {
      writeFileSync(configPath, originalText);
      const sweeps = sweepRetiredConfigKeysAtStartup();
      // The global sweep reports the exact retired path it removed.
      const global = sweeps.find((s) => s.path === configPath);
      expect(global?.removed).toContain("harnesses.claude.active_profile_id");
      // The persisted file no longer carries the retired key, keeps the rest.
      const onDisk = yamlParse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(onDisk.harnesses.claude.active_profile_id).toBeUndefined();
      expect(onDisk.harnesses.claude.default_model).toBe("sonnet");
      // A byte-identical pre-sweep backup sits beside the config.
      expect(global?.backupPath).toBeTruthy();
      expect(readFileSync(global!.backupPath!, "utf8")).toBe(originalText);
      const backups = readdirSync(configDir).filter((f) => f.startsWith("config.yaml.bak-"));
      expect(backups.length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does NOT rewrite the global config of a FOREIGN root (CLAUDEXOR_CONFIG_DIR override)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-foreign-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    const configPath = join(dir, "config.yaml");
    const originalText =
      "version: 1\nharnesses:\n  claude:\n    active_profile_id: exp-a\n    default_model: sonnet\n";
    try {
      writeFileSync(configPath, originalText);
      const sweeps = sweepRetiredConfigKeysAtStartup();
      // No global sweep on a root this generation does not own by default.
      expect(sweeps.find((s) => s.path === configPath)).toBeUndefined();
      expect(readFileSync(configPath, "utf8")).toBe(originalText);
      // In-memory stripping still makes the config loadable (separate concern).
      expect(loadConfig(dir).global.harnesses?.claude?.default_model).toBe("sonnet");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still sweeps explicit PROJECT repoRoots under a config-dir override", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-project-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    const projectPath = join(repo, ".claudexor", "config.yaml");
    const originalText = "version: 1\nreview:\n  attempts: 3\n";
    try {
      writeFileSync(projectPath, originalText);
      const sweeps = sweepRetiredConfigKeysAtStartup([repo]);
      const project = sweeps.find((s) => s.path === projectPath);
      expect(project?.removed).toContain("review");
      expect(project?.backupPath).toBeTruthy();
      // The pre-sweep backup is byte-identical to the original (parity with the
      // global-root sweep test) — the untouched original bytes are recoverable.
      expect(readFileSync(project!.backupPath!, "utf8")).toBe(originalText);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips the incident-class v1 keys (default_portfolio, routing.default_policy, budget.max_usd_per_run, harnesses.*.max_usd)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-v1-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      writeFileSync(
        join(dir, "config.yaml"),
        [
          "version: 1",
          "default_portfolio: subscription-first",
          "routing:",
          "  default_policy: auto",
          "budget:",
          "  max_usd_per_run: null",
          "harnesses:",
          "  codex:",
          "    max_usd: 5",
          "    default_model: gpt-5.6-sol",
          "",
        ].join("\n"),
      );
      const cfg = loadConfig(dir);
      expect(cfg.global.harnesses?.codex?.default_model).toBe("gpt-5.6-sol");
      expect((cfg.global as Record<string, unknown>).default_portfolio).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ConfigParseError carries the typed problem projection (status/code/requiredActions)", () => {
    const err = new ConfigParseError("/tmp/nowhere/config.yaml", new Error("boom"));
    expect(err.status).toBe(422);
    expect(err.code).toBe("config_invalid");
    expect(err.retryable).toBe(false);
    expect(err.requiredActions.some((a) => a.includes("/tmp/nowhere/config.yaml"))).toBe(true);
    expect(err.requiredActions.some((a) => a.includes(".bak-"))).toBe(true);
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

describe("A6 limit_action serialize rule (never persist auto)", () => {
  const withConfigDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-limit-action-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      fn(dir);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** The pre-A6 installed engine's enum: rollback must parse today's file. */
  const baseEnumParses = (yamlText: string) => {
    const raw = yamlParse(yamlText) as {
      harnesses?: Record<string, { profile_policy?: { limit_action?: unknown } }>;
    };
    for (const harness of Object.values(raw.harnesses ?? {})) {
      const action = harness.profile_policy?.limit_action;
      if (action !== undefined) {
        expect(["fail", "ask", "rotate"]).toContain(action);
      }
    }
  };

  it("an identity write on a config with materialized auto strips limit_action from the yaml", () => {
    withConfigDir((dir) => {
      // A file that already carries the materialized default (the pre-fix bug shape).
      writeFileSync(
        join(dir, "config.yaml"),
        "harnesses:\n  claude:\n    profile_policy:\n      limit_action: auto\n",
      );
      const { path, config } = updateGlobalConfig((cfg) => cfg);
      // The in-memory config still resolves the default...
      expect(config.harnesses["claude"]?.profile_policy.limit_action).toBe("auto");
      // ...but the durable file never spells it: absent means auto.
      const written = readFileSync(path, "utf8");
      expect(written).not.toContain("limit_action");
      baseEnumParses(written);
      // And the next load still resolves auto from absence.
      const reloaded = loadConfig(dir);
      expect(reloaded.global.harnesses["claude"]?.profile_policy.limit_action).toBe("auto");
    });
  });

  it("explicit fail/ask/rotate round-trip untouched and stay base-enum-parseable", () => {
    withConfigDir((dir) => {
      const { path } = updateGlobalConfig((cfg) => ({
        ...cfg,
        harnesses: {
          ...cfg.harnesses,
          claude: {
            ...(cfg.harnesses["claude"] ?? {
              enabled: true,
              native_credentials_enabled: true,
              default_model: null,
              effort: null,
              max_turns: null,
              max_rounds: null,
              profile_policy: {
                limit_action: "auto",
                rotation_eligible: [],
                headroom_threshold: 0.9,
              },
              tools_allow: [],
              tools_deny: [],
              fallback_model: null,
              web: "auto",
              auth_preference: "auto",
            }),
            profile_policy: {
              limit_action: "rotate",
              rotation_eligible: [],
              headroom_threshold: 0.9,
            },
          },
        },
      }));
      const written = readFileSync(path, "utf8");
      expect(written).toContain("limit_action: rotate");
      baseEnumParses(written);
      expect(loadConfig(dir).global.harnesses["claude"]?.profile_policy.limit_action).toBe(
        "rotate",
      );
    });
  });
});

describe("concurrency default serialization", () => {
  it("does not materialize new default caps into a durable config", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-concurrency-defaults-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const { path } = updateGlobalConfig((cfg) => cfg);
      const written = readFileSync(path, "utf8");
      expect(written).not.toContain("max_concurrent:");
      expect(written).not.toContain("max_parallel_candidates:");
      expect(written).not.toContain("max_deep_scan_width:");
      expect(written).not.toContain("max_council_members:");
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists explicit non-default caps and reloads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-concurrency-explicit-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const { path } = updateGlobalConfig((cfg) => ({
        ...cfg,
        runtime: {
          ...cfg.runtime,
          max_concurrent: 30,
          max_parallel_candidates: 6,
          max_deep_scan_width: 10,
          max_council_members: 5,
        },
      }));
      const written = readFileSync(path, "utf8");
      expect(written).toContain("max_concurrent: 30");
      expect(loadConfig(dir).global.runtime.max_council_members).toBe(5);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
