import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { ResolvedConfig } from "@claudexor/schema";
import {
  GlobalConfig,
  ProjectConfig,
  ResolvedConfig as ResolvedConfigSchema,
  TrustConfig,
} from "@claudexor/schema";
import { ensureDir, pathExists, readTextSafe, sha256, userConfigDir, writeText } from "@claudexor/util";

export function globalConfigDir(): string {
  return userConfigDir();
}

export class ConfigParseError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`invalid Claudexor YAML config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ConfigParseError";
  }
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
  } catch (err) {
    throw new ConfigParseError(path, err);
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

  const projectPath = join(repoRoot, ".claudexor", "config.yaml");
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

/** Update ~/.claudexor/config.yaml with validated global settings. Sensitive values are not accepted here. */
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

/** Scaffold a default versioned project config (used by `claudexor init`). */
export function initProjectConfig(repoRoot: string): InitResult {
  const configPath = join(repoRoot, ".claudexor", "config.yaml");
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
    "# Claudexor project config (versioned). Safe settings only.\n" +
    "# Sensitive settings (full access, secrets, budget-above-cap, plugin install,\n" +
    "# MCP trust) live in ~/.claudexor/config.yaml or ~/.claudexor/trust/<hash>.yaml.\n";
  writeText(configPath, header + yamlStringify(config));
  return { configPath, created: true };
}
