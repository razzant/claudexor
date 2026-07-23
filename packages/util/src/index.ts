export { CLAUDEXOR_VERSION } from "./version.js";
export * from "./secret-names.js";
export * from "./sensitive-resource.js";
export * from "./delegation-env.js";
export * from "./runtime-manifest.js";
import { sensitiveResourcePolicy } from "./sensitive-resource.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDEXOR_VERSION } from "./version.js";

/** Generate a short unique id, optionally prefixed (e.g. "run-3f2a...."). */
export function newId(prefix = ""): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return prefix ? `${prefix}-${id}` : id;
}

/** Current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** sha256 of a string, returned as "sha256:<hex>". */
export function sha256(data: string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Deterministic hash of a JSON-serializable value (stable key ordering). */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

/** JSON.stringify with sorted object keys for stable hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function ensureDir(path: string): void {
  // DECIDED TRADEOFF: `mode` applies only at creation (POSIX). These helpers
  // also write into USER-CHOSEN locations (benchmark outputs, project dirs),
  // so re-chmodding a PRE-EXISTING directory here would silently lock down
  // directories Claudexor does not own. Claudexor-owned SENSITIVE stores
  // (secrets, daemon token) assert their own permissions at their writers.
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Establish a private daemon-owned directory without following any symlink in
 * the supplied spelling. The direct parent must already exist canonically;
 * callers create nested owned roots one level at a time. No chmod occurs until
 * pathname identity has been proven.
 */
export function ensureCanonicalPrivateDirectory(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    const parent = dirname(absolute);
    const parentStat = lstatSync(parent);
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      realpathSync.native(parent) !== parent
    ) {
      throw new Error(`owned directory parent is not canonical: ${parent}`);
    }
    mkdirSync(absolute, { recursive: false, mode: 0o700 });
    fsyncCanonicalDirectory(parent);
  }
  const preliminary = lstatSync(absolute);
  if (preliminary.isSymbolicLink() || !preliminary.isDirectory()) {
    throw new Error(`owned directory path is not canonical: ${absolute}`);
  }
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`owned directory path is not canonical: ${absolute}`);
  }
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(absolute);
    if (
      !opened.isDirectory() ||
      named.isSymbolicLink() ||
      !named.isDirectory() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      realpathSync.native(absolute) !== absolute ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error(`owned directory path is not canonical: ${absolute}`);
    }
    // Mutate permissions only through the descriptor whose inode and pathname
    // identity were proven above; never follow a replacement path with chmod.
    fchmodSync(fd, 0o700);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return absolute;
}

function fsyncCanonicalDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, line.endsWith("\n") ? line : line + "\n", { flag: "a", mode: 0o600 });
}

/** Read a text file; null on ANY error. BY DESIGN missing and unreadable/
 * corrupt are indistinguishable — callers that must tell them apart (e.g.
 * daemon load salvage) check existence first. */
export function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Read+parse JSON; null on ANY error (same by-design contract as readTextSafe). */
export function readJsonSafe<T = unknown>(path: string): T | null {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function usableAbsoluteDir(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value === "/" || value === "." || value === "~" || !isAbsolute(value)) return null;
  return value.replace(/\/+$/, "");
}

/**
 * Best-effort per-user home for GUI-launched daemons. macOS launch contexts can
 * have a sparse environment; never let a missing/invalid home collapse storage
 * to `/.claudexor`.
 */
export function userHomeDir(): string {
  const home =
    usableAbsoluteDir(process.env.HOME) ??
    usableAbsoluteDir(process.env.USERPROFILE) ??
    usableAbsoluteDir(homedir());
  if (!home) {
    throw new Error(
      "Unable to resolve a safe user home directory; set HOME or CLAUDEXOR_CONFIG_DIR",
    );
  }
  return home;
}

export function userConfigDir(): string {
  const override = process.env.CLAUDEXOR_CONFIG_DIR?.trim();
  if (override) {
    const safe = usableAbsoluteDir(override);
    if (!safe) throw new Error("CLAUDEXOR_CONFIG_DIR must be a safe absolute path");
    return safe;
  }
  return defaultUserConfigDir();
}

/**
 * This build's generation-versioned default root, INDEPENDENT of the
 * CLAUDEXOR_CONFIG_DIR override. v3 is an intentionally empty, non-migrating
 * namespace: the untouched older roots (v2, v1) ARE the archive (owner
 * decision, v3.0.0 plan). Keeping the version boundary in the default root
 * prevents the daemon from even probing older config, trust, secret, token,
 * or journal bytes whose contracts this generation deleted. An explicit
 * CLAUDEXOR_CONFIG_DIR remains the hermetic test/operator override and is
 * treated as the complete root. Comparing the ACTIVE root against this
 * default is how root-scoped behaviors (the global retired-key sweep) tell
 * "this generation's own root" from a foreign/overridden one — comparing
 * against userConfigDir() would be tautological.
 */
export function defaultUserConfigDir(): string {
  return join(userHomeDir(), ".claudexor", "v3");
}

/**
 * The ONE Claudexor-owned confinement root (round-22 DRY): under an explicit
 * CLAUDEXOR_CONFIG_DIR override, that override IS the complete relocatable
 * root; without it the owned tree is ~/.claudexor. Credential-profile
 * locators and the isolation-locator confinement both derive from here —
 * never re-derive this ternary inline.
 */
export function claudexorOwnedRoot(): string {
  return process.env.CLAUDEXOR_CONFIG_DIR?.trim()
    ? userConfigDir()
    : join(userHomeDir(), ".claudexor");
}

/**
 * Stable external runtime namespace for a project.
 *
 * A repository's `.claudexor/` directory is user-owned, versionable project
 * configuration. Runtime state (runs, worktrees, scoped homes, review packets)
 * therefore must never be placed below the repository or require Claudexor to
 * edit either of the user's `.gitignore` files. Existing roots are resolved
 * through symlinks before hashing so two spellings of the same project share a
 * single namespace; a not-yet-existing root still gets a deterministic absolute
 * identity and is re-keyed only after it exists and is registered.
 */
export function canonicalProjectRoot(repoRoot: string): string {
  const absolute = resolve(repoRoot);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function projectRuntimeDir(repoRoot: string): string {
  const digest = sha256(canonicalProjectRoot(repoRoot)).slice("sha256:".length);
  return join(userConfigDir(), "projects", digest);
}

export function noProjectRepoRoot(): string {
  return join(userHomeDir(), ".cache", "claudexor", "no-project");
}

/**
 * Whether `candidate` is the Claudexor-owned runtime tree or lives inside it
 * (F2 ghost-project guard): `~/.claudexor` (or the CLAUDEXOR_CONFIG_DIR
 * override) and everything under it — most importantly the per-project envelope
 * worktrees under `projects/<digest>/workspaces/`. Such a path is DAEMON runtime state,
 * never a legitimate user project root: registering one produces a "ghost"
 * project whose root vanishes when the workspace is swept. Symlinks are resolved
 * through the deepest existing ancestor so a not-yet-created (or already-swept)
 * envelope path is still recognized. `noProjectRepoRoot()` (~/.cache/claudexor)
 * is deliberately OUTSIDE this tree and is never flagged.
 */
export function isClaudexorOwnedRuntimePath(candidate: string): boolean {
  const owned = canonicalProjectRoot(claudexorOwnedRoot());
  const resolved = canonicalProjectRoot(candidate);
  const rel = relative(owned, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Best-effort redaction of obvious secret tokens from text destined for logs or
 * artifacts. This is defense-in-depth, never the primary control: secrets must
 * not reach this layer in the first place.
 */
export function redactSecrets(text: string): string {
  return sensitiveResourcePolicy.redact(text);
}

export function containsSecretLikeToken(text: string): boolean {
  return sensitiveResourcePolicy.containsSensitiveContent(text);
}

/** Keys whose subtree is a caller-authored JSON SCHEMA: its object keys are
 *  field NAMES (a `token` or `password` property is legitimate), so the
 *  key-based secret check must not fire there — but string VALUES inside it
 *  (const/default/enum literals) are still scanned for real secrets. */
const SCHEMA_VALUE_SUBTREE_KEYS = new Set(["outputSchema", "output_schema"]);

export function assertNoInlineSecretValues(
  value: unknown,
  path = "$",
  context = "run params",
  valuesOnly = false,
): void {
  if (typeof value === "string") {
    if (containsSecretLikeToken(value)) {
      // Prompts get a tailored remediation: they are DURABLE run artifacts
      // (task contracts, transcripts, review packets), so a pasted live
      // credential would outlive the run. There is deliberately NO bypass
      // flag for this fence.
      const inPrompt = /\.prompt(\[|\.|$)/.test(path);
      const remediation = inPrompt
        ? "the prompt contains a secret-like value; prompts are durable run artifacts — remove the credential (store it with `claudexor secrets set` and reference it instead) and retry"
        : "store values via secrets and pass refs/profiles";
      throw Object.assign(
        new Error(`secret-like value is not accepted in ${context} (${path}); ${remediation}`),
        {
          status: 400,
          code: "inline_secret_rejected",
        },
      );
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoInlineSecretValues(v, `${path}[${i}]`, context, valuesOnly));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // A real secret embedded in a KEY (e.g. a schema property literally named
    // with a live token) is rejected in EVERY mode — valuesOnly only relaxes
    // the NAME heuristic (a legitimate `token`/`password` field name), never
    // the actual-secret detector. Never echo the raw key in the message.
    if (containsSecretLikeToken(key)) {
      throw Object.assign(
        new Error(
          `secret-like value is not accepted in ${context} (${path}: object key); store values via secrets and pass refs/profiles`,
        ),
        { status: 400, code: "inline_secret_rejected" },
      );
    }
    // Inside a JSON Schema subtree, keys are field names — skip the name-word
    // heuristic (a `token`/`password`/`env` FIELD is legitimate), but string
    // VALUES are still scanned below.
    if (
      !valuesOnly &&
      (key === "env" ||
        key === "secrets" ||
        /(^|[_-])(secret|token|password|api[_-]?key)($|[_-])/i.test(key))
    ) {
      throw Object.assign(
        new Error(
          `inline secrets/env are not accepted in ${context} (${path}.${key}); store values via secrets and pass refs/profiles`,
        ),
        { status: 400, code: "inline_secret_rejected" },
      );
    }
    assertNoInlineSecretValues(
      child,
      `${path}.${key}`,
      context,
      valuesOnly || SCHEMA_VALUE_SUBTREE_KEYS.has(key),
    );
  }
}

/** The machine-readable `code` a typed error carries (e.g. inline_secret_rejected), if any. */
export function errorCode(err: unknown): string | undefined {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return undefined;
}

/**
 * Invoke an optional observer callback without letting its errors affect the
 * caller. Observers (GUI/service event sinks, run-start hooks) are untrusted:
 * a throwing observer must never change canonical run state or terminal status.
 */
export function safeInvoke<T>(fn: ((arg: T) => void) | undefined, arg: T): void {
  if (!fn) return;
  try {
    fn(arg);
  } catch {
    /* observer errors are isolated from control-plane state */
  }
}

/* ---- Engine build identity (D20) ---- */

export interface EngineBuildIdentity {
  /** Lockstep workspace version (generated CLAUDEXOR_VERSION). */
  version: string;
  /** Git commit SHA of the build: CLAUDEXOR_BUILD_SHA (stamped by packaging),
   * else `git rev-parse HEAD` of the module checkout, else "unknown". */
  sha: string;
  /** Resolved entry path of the running process — an unforgeable origin hint
   * (bundled app vs npm global vs dev checkout) without guessing an enum. */
  entry: string;
}

let cachedBuildIdentity: EngineBuildIdentity | null = null;

/** The serving engine's build identity: version + SHA + entry path. Cached.
 * Stale-daemon skew becomes visible in the handshake instead of guessed. */
export function engineBuildIdentity(): EngineBuildIdentity {
  if (cachedBuildIdentity) return cachedBuildIdentity;
  let sha = process.env.CLAUDEXOR_BUILD_SHA?.trim() ?? "";
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // Only trust `git rev-parse` when this module lives in Claudexor's OWN source
  // checkout. An installed copy (npm into node_modules, or the extracted engine
  // runtime bundle) sits inside an UNRELATED repo, where git walks up and
  // reports that project's HEAD as ours — a wrong sha is worse than an honest
  // "unknown". Release builds inject CLAUDEXOR_BUILD_SHA and skip git entirely.
  const isInstalledCopy = moduleDir.split(sep).includes("node_modules");
  if (!/^[0-9a-f]{40}$/.test(sha) && !isInstalledCopy) {
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: moduleDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // The toplevel must actually be an ancestor of this module (it always is
      // when git succeeds from here) AND not itself a node_modules install.
      if (top && !top.split(sep).includes("node_modules") && moduleDir.startsWith(top)) {
        sha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: moduleDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      }
    } catch {
      sha = "";
    }
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) sha = "unknown";
  let entry = process.execPath;
  try {
    entry = resolve(process.argv[1] ?? process.execPath);
  } catch {
    /* keep execPath */
  }
  cachedBuildIdentity = { version: CLAUDEXOR_VERSION, sha, entry };
  return cachedBuildIdentity;
}
