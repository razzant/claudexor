import { readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
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
/**
 * Keys that OLDER Claudexor versions legitimately wrote and current schemas
 * retired. These are migration debt, not typos: they are stripped before the
 * strict parse (and disappear from the file on the next config write), while
 * any key NOT in this registry still fails loudly. Each entry is a path
 * matcher over segments ("*" matches one segment).
 */
const RETIRED_CONFIG_KEYS: Array<{ path: string[]; retired: string }> = [
  { path: ["secrets"], retired: "secret refs moved to the SecretStore (Keychain / 0600 store)" },
  { path: ["budget", "max_usd_per_day"], retired: "per-day caps were removed; quota respect + per-run caps remain" },
  { path: ["routing", "default_model"], retired: "model choice is harness-scoped (INV-103); use harnesses.<id>.default_model" },
  { path: ["harnesses", "*", "auth_ref"], retired: "auth routes come from doctor + auth_preference; refs live in the SecretStore" },
  { path: ["harnesses", "*", "native_options"], retired: "never consumed by any adapter (v0.15 triage); per-harness knobs are typed fields" },
];

/** Keys older `claudexor init` scaffolds wrote into PROJECT config and current
 * schemas retired. Same migration-debt registry semantics as the global list. */
const RETIRED_PROJECT_CONFIG_KEYS: Array<{ path: string[]; retired: string }> = [
  { path: ["project"], retired: "language_stack was never consumed" },
  { path: ["delivery"], retired: "delivery knobs were never consumed from project config" },
  { path: ["review"], retired: "review attempts/strictness moved to engine policy" },
  { path: ["context", "agents_md_first"], retired: "context assembly always reads agent docs first" },
  { path: ["context", "never_silent_truncate"], retired: "no-silent-truncation is a Bible invariant, not a knob" },
];

function stripRetiredKeys(raw: unknown, matchers: Array<{ path: string[] }>): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const strip = (node: Record<string, unknown>, segs: string[][]): void => {
    for (const [key, value] of Object.entries(node)) {
      const here = segs.filter((s) => s[0] === key || s[0] === "*");
      if (here.some((s) => s.length === 1)) {
        delete node[key];
        continue;
      }
      const deeper = here.filter((s) => s.length > 1).map((s) => s.slice(1));
      if (deeper.length > 0 && typeof value === "object" && value !== null && !Array.isArray(value)) {
        strip(value as Record<string, unknown>, deeper);
      }
    }
  };
  const clone = structuredClone(raw) as Record<string, unknown>;
  strip(clone, matchers.map((m) => m.path));
  return clone;
}

/**
 * Parse a raw config document against its STRICT schema. Unknown keys are a
 * ConfigParseError NAMING the keys (a typo'd knob must fail loudly, never be
 * silently stripped into a no-op — the same bug class as staged fields).
 */
function parseStrict<T>(schema: { parse: (v: unknown) => T }, raw: unknown, path: string): T {
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = err.issues
        .map((issue) => {
          const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
          if (issue.code === "unrecognized_keys") {
            return `unknown key(s)${at}: ${issue.keys.join(", ")}`;
          }
          return `${issue.message}${at}`;
        })
        .join("; ");
      throw new ConfigParseError(path, details);
    }
    throw new ConfigParseError(path, err);
  }
}

export function loadConfig(repoRoot: string): ResolvedConfig {
  const sources: string[] = [];

  const globalPath = join(globalConfigDir(), "config.yaml");
  const globalRaw = stripRetiredKeys(readYaml(globalPath), RETIRED_CONFIG_KEYS);
  if (globalRaw !== null) sources.push(globalPath);
  const global = applyEnvOverrides(parseStrict(GlobalConfig, globalRaw ?? {}, globalPath));

  const projectPath = join(repoRoot, ".claudexor", "config.yaml");
  const projectRaw = stripRetiredKeys(readYaml(projectPath), RETIRED_PROJECT_CONFIG_KEYS);
  if (projectRaw !== null) sources.push(projectPath);
  const project = parseStrict(ProjectConfig, projectRaw ?? {}, projectPath);

  const trustPath = join(globalConfigDir(), "trust", `${repoHash(repoRoot)}.yaml`);
  const trustRaw = readYaml(trustPath);
  if (trustRaw !== null) sources.push(trustPath);
  const trust = parseStrict(TrustConfig, trustRaw ?? {}, trustPath);

  return ResolvedConfigSchema.parse({ project, trust, global, sources });
}

function positiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigParseError(`env:${name}`, `expected a positive integer, got ${raw}`);
  }
  return parsed;
}

function nonnegativeIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigParseError(`env:${name}`, `expected a nonnegative integer, got ${raw}`);
  }
  return parsed;
}

function applyEnvOverrides(global: GlobalConfig): GlobalConfig {
  const reviewerTimeout = positiveIntEnv("CLAUDEXOR_REVIEWER_TIMEOUT_MS");
  const inactivityTimeout = positiveIntEnv("CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS");
  const maxRetries = nonnegativeIntEnv("CLAUDEXOR_TRANSIENT_RETRY_MAX");
  const initialDelay = nonnegativeIntEnv("CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS");
  const maxDelay = nonnegativeIntEnv("CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS");
  if (
    reviewerTimeout === null &&
    inactivityTimeout === null &&
    maxRetries === null &&
    initialDelay === null &&
    maxDelay === null
  )
    return global;
  return GlobalConfig.parse({
    ...global,
    runtime: {
      ...global.runtime,
      ...(reviewerTimeout !== null ? { reviewer_timeout_ms: reviewerTimeout } : {}),
      ...(inactivityTimeout !== null ? { harness_inactivity_timeout_ms: inactivityTimeout } : {}),
      transient_retry: {
        ...global.runtime.transient_retry,
        ...(maxRetries !== null ? { max_retries: maxRetries } : {}),
        ...(initialDelay !== null ? { initial_delay_ms: initialDelay } : {}),
        ...(maxDelay !== null ? { max_delay_ms: maxDelay } : {}),
      },
    },
  });
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), "config.yaml");
}

/** Resolved user-local trust file path for one repo (keyed by repo-root hash). */
export function trustConfigPath(repoRoot: string): string {
  return join(globalConfigDir(), "trust", `${repoHash(repoRoot)}.yaml`);
}

/**
 * Write the user-local trust file for a repo (used by `claudexor trust`).
 * Values are validated against the STRICT TrustConfig schema; the write is
 * atomic (tmp+rename) like updateGlobalConfig.
 */
export function updateTrustConfig(
  repoRoot: string,
  mutator: (config: TrustConfig) => TrustConfig,
): { path: string; config: TrustConfig } {
  // Guard at the HASH site: a relative root would silently key a different
  // file per cwd (and stamp wrong provenance). Callers surface their own
  // status codes; this is the single-owner backstop.
  if (!isAbsolute(repoRoot)) {
    throw new Error(`trust config requires an absolute repo root (got ${repoRoot})`);
  }
  const path = trustConfigPath(repoRoot);
  ensureDir(join(globalConfigDir(), "trust"));
  // Locked read-mutate-write: the app's POST /trust and CLI `claudexor trust`
  // are two live writers of the same file — same discipline as global config.
  return withConfigLock(path, () => {
    const current = parseStrict(TrustConfig, readYaml(path) ?? {}, path);
    // Stamp provenance on every write: the filename is a one-way hash, so the
    // repo root recorded INSIDE the file is what makes trust state enumerable
    // (Settings trust list). Never trusted for gating — loadConfig keys by hash.
    const next = TrustConfig.parse({ ...mutator(current), repo_root: repoRoot });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeText(tmp, yamlStringify(next));
    renameSync(tmp, path);
    return { path, config: next };
  });
}

/**
 * Enumerate every user-local trust file (Settings trust list). Unreadable or
 * schema-invalid entries are skipped: listing is a projection, and one stale
 * hand-edited file must not take down the whole settings surface — the strict
 * parse still fails loudly on the load path that actually GATES access.
 */
export function listTrustConfigs(): Array<{ path: string; config: TrustConfig }> {
  const dir = join(globalConfigDir(), "trust");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".yaml"));
  } catch {
    return [];
  }
  const out: Array<{ path: string; config: TrustConfig }> = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      out.push({ path, config: parseStrict(TrustConfig, readYaml(path) ?? {}, path) });
    } catch (err) {
      // Skip-but-disclose: the projection must survive one stale file, but an
      // operator debugging "why is my grant not listed" needs the breadcrumb.
      process.stderr.write(
        `claudexor: skipping unparseable trust file ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return out;
}

/**
 * Two-writer safety: run `fn` while holding an advisory lock file
 * (O_EXCL create; stale after 10s). ONE owner of the locking discipline —
 * every read-mutate-write config cycle (global config, per-repo trust files)
 * must go through here so concurrent daemon and CLI writers can never
 * interleave into torn YAML or lose one writer's fields.
 */
function withConfigLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  const LOCK_STALE_MS = 10_000;
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let heldSince = 0;
      try {
        heldSince = statSync(lockPath).mtimeMs;
      } catch {
        continue; // holder just released; retry immediately
      }
      if (Date.now() - heldSince > LOCK_STALE_MS) {
        // Stale lock from a crashed writer: break it loudly-in-band.
        try {
          unlinkSync(lockPath);
        } catch {
          /* raced with another breaker */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`config lock at ${lockPath} is held by another writer; retry in a moment`);
      }
      // Sleep 25ms without spinning the event loop (Atomics.wait is the
      // standard synchronous sleep; config writes are rare and brief).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already broken as stale */
    }
  }
}

/**
 * Update ~/.claudexor/config.yaml with validated global settings. Sensitive
 * values are not accepted here. Locked + atomic (see withConfigLock).
 */
export function updateGlobalConfig(mutator: (config: GlobalConfig) => GlobalConfig): { path: string; config: GlobalConfig } {
  const path = globalConfigPath();
  ensureDir(globalConfigDir());
  return withConfigLock(path, () => {
    const current = parseStrict(
      GlobalConfig,
      stripRetiredKeys(readYaml(path), RETIRED_CONFIG_KEYS) ?? {},
      path,
    );
    const next = GlobalConfig.parse(mutator(current));
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeText(tmp, yamlStringify(next));
    renameSync(tmp, path);
    return { path, config: next };
  });
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
  // Seed an EMPTY mandatory_files set: a fresh repo must never have `init` break
  // its own read-only modes (plan/audit/explore fail-close on missing mandatory
  // context). mandatory_files is opt-in via the commented example below.
  const config = ProjectConfig.parse({});
  const header =
    "# Claudexor project config (versioned). Safe settings only.\n" +
    "# Sensitive settings (full access, secrets, budget-above-cap, plugin install,\n" +
    "# MCP trust) live in ~/.claudexor/config.yaml or ~/.claudexor/trust/<hash>.yaml.\n" +
    "#\n" +
    "# Optional: require files as mandatory run context (fail-closed if missing,\n" +
    "# enforced uniformly across every mode). Empty by default; uncomment to opt in:\n" +
    '#   context:\n' +
    '#     mandatory_files: ["README.md", "docs/ARCHITECTURE.md"]\n';
  writeText(configPath, header + yamlStringify(config));
  return { configPath, created: true };
}
