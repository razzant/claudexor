import { homedir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { ResolvedConfig } from "@claudex/schema";
import {
  GlobalConfig,
  ProjectConfig,
  ResolvedConfig as ResolvedConfigSchema,
  TrustConfig,
} from "@claudex/schema";
import { ensureDir, pathExists, readTextSafe, sha256, writeText } from "@claudex/util";

export function globalConfigDir(): string {
  return join(homedir(), ".claudex");
}

/** Short stable hash of a repo root path, used to key user-local trust files. */
export function repoHash(repoRoot: string): string {
  return sha256(repoRoot).replace(/^sha256:/, "").slice(0, 16);
}

function readYaml(path: string): unknown | null {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    return yamlParse(text);
  } catch {
    return null;
  }
}

/**
 * Resolve effective config by precedence. Sensitive settings live ONLY in the
 * global config and the user-local trust file — never in versioned repo config
 * (the ProjectConfig schema structurally excludes them).
 */
export function loadConfig(repoRoot: string): ResolvedConfig {
  const sources: string[] = [];

  const globalPath = join(globalConfigDir(), "config.yaml");
  const globalRaw = readYaml(globalPath);
  if (globalRaw !== null) sources.push(globalPath);
  const global = GlobalConfig.parse(globalRaw ?? {});

  const projectPath = join(repoRoot, ".claudex", "config.yaml");
  const projectRaw = readYaml(projectPath);
  if (projectRaw !== null) sources.push(projectPath);
  const project = ProjectConfig.parse(projectRaw ?? {});

  const trustPath = join(globalConfigDir(), "trust", `${repoHash(repoRoot)}.yaml`);
  const trustRaw = readYaml(trustPath);
  if (trustRaw !== null) sources.push(trustPath);
  const trust = TrustConfig.parse(trustRaw ?? {});

  return ResolvedConfigSchema.parse({ project, trust, global, sources });
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), "config.yaml");
}

/** Update ~/.claudex/config.yaml with validated global settings. Sensitive values are not accepted here. */
export function updateGlobalConfig(mutator: (config: GlobalConfig) => GlobalConfig): { path: string; config: GlobalConfig } {
  const path = globalConfigPath();
  const current = GlobalConfig.parse(readYaml(path) ?? {});
  const next = GlobalConfig.parse(mutator(current));
  ensureDir(globalConfigDir());
  writeText(path, yamlStringify(next));
  return { path, config: next };
}

export interface InitResult {
  configPath: string;
  created: boolean;
}

/** Scaffold a default versioned project config (used by `claudex init`). */
export function initProjectConfig(repoRoot: string): InitResult {
  const configPath = join(repoRoot, ".claudex", "config.yaml");
  if (pathExists(configPath)) {
    return { configPath, created: false };
  }
  const config = ProjectConfig.parse({
    project: { name: undefined, language_stack: [] },
    context: {
      agents_md_first: true,
      never_silent_truncate: true,
      mandatory_files: ["README.md", "docs/ARCHITECTURE.md"],
    },
  });
  const header =
    "# Claudex project config (versioned). Safe settings only.\n" +
    "# Sensitive settings (full access, secrets, budget-above-cap, plugin install,\n" +
    "# MCP trust) live in ~/.claudex/config.yaml or ~/.claudex/trust/<hash>.yaml.\n";
  writeText(configPath, header + yamlStringify(config));
  return { configPath, created: true };
}
