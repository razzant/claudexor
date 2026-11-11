import { observeHarnessProgram } from "@claudexor/core";
import { CLAUDE_PROGRAM } from "./program.js";
/**
 * Live Claude model inventory from the prompt-free `initialize` handshake.
 *
 * The installed `claude` CLI answers a bare `initialize` control_request on
 * stdin with its model picker (`models[]`: the selectors `--model` accepts,
 * what each resolves to, a display name) and exits 0 on stdin EOF, without a
 * prompt, without a generation, and — with the flags below — without a login
 * (live-measured 2.1.280: 0.2 s, one stdout line, zero stderr). That answer is
 * the ONE producer behind the adapter's `models()`, so a model the vendor ships
 * after this release is selectable without a Claudexor release per model.
 *
 * What the picker is and is not (INV-104): it proves PRESENCE — "this binary,
 * on this route, offers these selectors" — never absence. It accepts ids it
 * does not list (`claude-opus-5-5`, older exact ids), it is modulated by the
 * account (an API key adds `sonnet[1m]`, a Max plan changes the Fable row),
 * and it ECHOES local configuration as fabricated rows (`--model`,
 * `ANTHROPIC_MODEL`, a settings.json `model`; live-measured). Hence:
 * `CLAUDE_MODEL_INVENTORY` declares absence ADVISORY, the probe never passes
 * `--model`, runs with `--setting-sources ""` (no hooks, no settings echo) and
 * `--strict-mcp-config`, scrubs the model-override env, and every consumer
 * gets the frozen `CLAUDE_KNOWN_MODELS` ids appended as `origin: "hint"` rows —
 * presence never shrinks below today's manifest, even when the binary is gone.
 *
 * Scopes (owner decision 2026-09-24, Q5=A: an account view reads the account):
 *  - PROFILE-BOUND, `config_dir_login`: the profile's own `CLAUDE_CONFIG_DIR`
 *    and keychain bridge exactly as its runs use, bootstrap allowed, so the
 *    account's own rows (server-provided options, org default, entitlement
 *    filtering) appear in account views.
 *  - PROFILE-BOUND, `api_key` / `oauth_token`: the profile's own credential in
 *    the env var its runs use (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`),
 *    under a scratch `HOME` + `CLAUDE_CONFIG_DIR`, bootstrap allowed — the
 *    picker an API-key account sees (`sonnet[1m]`, …) is not the logged-out
 *    menu. The cache key is the profile id; no secret byte ever keys anything.
 *  - BINARY-ONLY (no profile — the unscoped listing): a disposable scratch
 *    `HOME` + `CLAUDE_CONFIG_DIR` under the Claudexor-owned state root and
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` — no credential is read,
 *    nothing outside the scratch dir is written.
 *
 * One cached single-flight capture per (scope, binary identity): concurrent
 * callers share one child, a caller's abort never reaches it, answers live for
 * an hour, failures for a minute, a binary that changes on disk is re-probed on
 * the next call without a daemon restart, and an observed credential change
 * drops every answer (`clearClaudeModelProbeCache`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessModelSpec } from "@claudexor/core";
import {
  composeBaseEnv,
  harnessBinaryIdentity,
  harnessBinaryIdentityOnPath,
  providerScrubEnv,
  runCapture,
  type HarnessBinaryIdentity,
} from "@claudexor/core";
import type { HarnessCapabilities, HarnessModel } from "@claudexor/schema";
import { resolveSecret } from "@claudexor/secrets";
import { ensureDir, nativeHarnessStateRoot } from "@claudexor/util";
import { CLAUDE_KNOWN_MODELS } from "./capability-profile.js";
import { resolveClaudeBin } from "./effort-probe.js";
import { claudeNativeEnv } from "./index.js";
import { CLAUDE_INIT_REQUEST_ID } from "./interactive.js";
import { canonicalProfileConfigDir } from "./profile.js";

type Env = Record<string, string | null | undefined>;

/**
 * The manifest declaration of what `models()` proves — kept beside the
 * producer so the two halves cannot drift apart (INV-104, codex precedent).
 * `model_inventory_routes` is OMITTED on purpose: the picker answers on every
 * route (logged out included), so the producer serves unscoped queries too.
 */
export const CLAUDE_MODEL_INVENTORY = {
  model_inventory_absence: "advisory",
} as const satisfies Pick<
  HarnessCapabilities,
  "model_inventory_routes" | "model_inventory_absence"
>;

/** Exactly what the probe spawns. NEVER `--model`: the picker echoes it back
 * as a fabricated row with an invented effort ladder. */
export const CLAUDE_MODEL_PROBE_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--setting-sources",
  "",
  "--strict-mcp-config",
];

export const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 10_000;
export const CLAUDE_MODEL_PROBE_TTL_MS = 60 * 60_000;
export const CLAUDE_MODEL_PROBE_FAILURE_TTL_MS = 60_000;
/** Same bound and eviction as the codex effort cache: expired first, then
 * oldest-inserted. The population is tiny (one binary × one scope per
 * profile), so eviction only ever bites a rotated binary's dead keys. */
const CLAUDE_MODEL_PROBE_CACHE_MAX_ENTRIES = 64;

/** The one stdin frame: the initialize handshake interactive runs also open with. */
export function claudeInitializeFrame(): string {
  return (
    JSON.stringify({
      type: "control_request",
      request_id: CLAUDE_INIT_REQUEST_ID,
      request: { subtype: "initialize" },
    }) + "\n"
  );
}

export interface ClaudeInitializePickerRow {
  value: string;
  displayName: string | null;
  resolvedModel: string | null;
}
export interface ClaudeInitializeAnswer {
  models: ClaudeInitializePickerRow[];
}

/**
 * Pure parse of the probe's stdout: the line whose `control_response` answers
 * OUR request id with `subtype: "success"` and a `models` array. Hook frames
 * (`system/hook_started`, …) may precede it, so the frame is selected by id,
 * never by position. Anything else — no such frame, an error subtype, a
 * non-array picker — is a probe failure (`null`), never "no models".
 * `description`, effort fields and `supportsFastMode` are deliberately not
 * read (no per-model effort harvesting in v1; no regex over model prose).
 */
export function parseClaudeInitialize(
  stdout: string,
  requestId: string,
): ClaudeInitializeAnswer | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(frame) || frame["type"] !== "control_response") continue;
    const response = frame["response"];
    if (!isRecord(response) || response["request_id"] !== requestId) continue;
    if (response["subtype"] !== "success") return null;
    const body = response["response"];
    const models = isRecord(body) ? body["models"] : undefined;
    if (!Array.isArray(models)) return null;
    const rows: ClaudeInitializePickerRow[] = [];
    for (const row of models) {
      if (!isRecord(row)) continue;
      const value = row["value"];
      if (typeof value !== "string" || !value.trim()) continue;
      rows.push({
        value,
        displayName: nonBlank(row["displayName"]),
        resolvedModel: nonBlank(row["resolvedModel"]),
      });
    }
    return { models: rows };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The rows every consumer sees, in this order and deduplicated by exact id:
 *  1. each picker selector verbatim (`origin: "live"`, `resolved_model` = what
 *     the vendor says it resolves to; the alias→resolution link stays on the
 *     alias row);
 *  2. each resolution not already a row of its own (`origin: "live"`) — a
 *     vendor-endorsed exact id a dropdown can pin (owner Q7: no free text);
 *  3. every frozen `CLAUDE_KNOWN_MODELS` id not already present
 *     (`origin: "hint"`) — the presence floor, which is ALL of the answer when
 *     the probe failed. `context_window: null` always (the only sources would
 *     be the `[1m]` suffix or description prose); `routes: null` (the answer
 *     already reflects the route it ran under).
 */
export function claudeModelRows(answer: ClaudeInitializeAnswer | null): HarnessModel[] {
  const rows: HarnessModel[] = [];
  const seen = new Set<string>();
  const push = (
    id: string,
    label: string | null,
    origin: "live" | "hint",
    resolvedModel: string | null,
  ): void => {
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({
      id,
      label,
      context_window: null,
      routes: null,
      origin,
      resolved_model: resolvedModel,
    });
  };
  for (const row of answer?.models ?? [])
    push(row.value, row.displayName, "live", row.resolvedModel);
  for (const row of answer?.models ?? []) {
    if (row.resolvedModel !== null) push(row.resolvedModel, null, "live", null);
  }
  for (const id of CLAUDE_KNOWN_MODELS) push(id, null, "hint", null);
  return rows;
}

export type ClaudeModelProbeScope =
  | { kind: "profile"; key: string; configDir: string }
  | {
      kind: "credential";
      key: string;
      envKey: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN";
      secretRef: string | null;
    }
  | { kind: "binary"; key: "binary" };

/**
 * Which store the probe reads. A `config_dir_login` profile is probed under
 * its OWN config dir; an `api_key` / `oauth_token` profile with its OWN
 * credential in the env var its runs use; no profile (the unscoped listing)
 * gets the credential-free binary probe. The scope key is the account half of
 * the cache key; it never carries secret bytes (a config dir path or a profile
 * id, not a token).
 */
export function claudeModelProbeScope(spec?: HarnessModelSpec): ClaudeModelProbeScope {
  const profile = spec?.credentialProfile;
  if (profile?.credential_kind === "config_dir_login") {
    const configDir = canonicalProfileConfigDir(profile.isolation_locator ?? "");
    return { kind: "profile", key: `config:${configDir}`, configDir };
  }
  if (profile?.credential_kind === "api_key" || profile?.credential_kind === "oauth_token") {
    return {
      kind: "credential",
      key: `credential:${profile.profile_id}`,
      envKey:
        profile.credential_kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN",
      secretRef: profile.secret_ref ?? null,
    };
  }
  return { kind: "binary", key: "binary" };
}

/**
 * Env keys whose value the picker echoes as a fabricated row (`ANTHROPIC_MODEL`)
 * or folds into `resolvedModel` (`ANTHROPIC_DEFAULT_<FAMILY>_MODEL`,
 * live-measured). Matched on the KEY NAME so any future family is covered.
 */
function isModelOverrideEnvKey(key: string): boolean {
  return key === "ANTHROPIC_MODEL" || /^ANTHROPIC_DEFAULT_[A-Z0-9_]*MODEL$/.test(key);
}

/**
 * The env PATCH the probe child spawns under (applied by `runCapture` over the
 * normalized host env; `null` deletes). Provider secrets are scrubbed on every
 * scope; the profile scope re-adds nothing (the keychain bridge IS the
 * credential transport), the credential scope re-adds exactly the profile's
 * own variable, and both credential-free scopes point HOME/config at the
 * scratch dir. Every model-override key present anywhere in the effective env
 * is deleted explicitly so the answer describes the binary, not this host.
 */
export function claudeModelProbeEnv(
  scope: ClaudeModelProbeScope,
  base: Env | undefined,
  scratchDir: string,
  secret: string | null = null,
): Env {
  const patch: Env =
    scope.kind === "profile"
      ? { ...claudeNativeEnv(base, scope.configDir) }
      : {
          ...(base ?? {}),
          ...providerScrubEnv(),
          HOME: scratchDir,
          USERPROFILE: scratchDir,
          CLAUDE_CONFIG_DIR: scratchDir,
          // A credential scope needs the bootstrap (its rows come from the
          // account); the binary scope must not talk to anyone.
          ...(scope.kind === "credential"
            ? { [scope.envKey]: secret }
            : { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }),
        };
  for (const key of [...Object.keys(composeBaseEnv("mirror_native")), ...Object.keys(patch)]) {
    if (isModelOverrideEnvKey(key)) patch[key] = null;
  }
  return patch;
}

/**
 * Which bytes the probe will run, resolved exactly the way the spawn layer
 * resolves a bare `claude`: the normalized host env, unless the caller's env
 * patch carries a PATH — the spawn layer applies that patch verbatim over the
 * normalized env, so such a child resolves on the patch PATH alone and the
 * probe must not re-normalize it (it would key and capture the managed binary
 * while the run executes the override). The probe's own HOME overrides are
 * never applied here either.
 */
function probeBinaryIdentity(
  base: Env | undefined,
  deps: ClaudeModelProbeDeps,
): HarnessBinaryIdentity | null {
  const patchPath = base?.["PATH"];
  if (typeof patchPath === "string") {
    return (deps.binaryIdentityOnPath ?? harnessBinaryIdentityOnPath)(
      resolveClaudeBin(),
      patchPath,
    );
  }
  return (deps.binaryIdentity ?? harnessBinaryIdentity)(
    resolveClaudeBin(),
    composeBaseEnv("mirror_native"),
  );
}

/** Injection seams (tests only; production callers pass the adapter's secret resolver). */
export interface ClaudeModelProbeDeps {
  runCapture?: typeof runCapture;
  binaryIdentity?: typeof harnessBinaryIdentity;
  binaryIdentityOnPath?: typeof harnessBinaryIdentityOnPath;
  /** The profile's credential for a credential scope (never logged, never keyed). */
  resolveProfileSecret?: (ref: string) => string | null;
  nowMs?: () => number;
}

interface CacheEntry {
  rows: HarnessModel[];
  expiresAtMs: number;
}
let generation = 0;
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<HarnessModel[]>>();

/** Drop every cached answer and forget in-flight probes. A login, logout or
 * credential change keeps a profile's scope key while changing its account,
 * so the daemon's credential invalidation calls this; a capture that started
 * earlier then neither stores its answer nor removes a newer flight (both
 * check `pending` identity). That invalidation also runs on every settings save
 * and this clear has no scope, so the binary answer goes too and the next read
 * of each scope spawns one prompt-free probe again. The cache belongs to this
 * process and nothing re-reads it on a schedule: after a change made by another
 * process (a direct vendor login or logout) the rows stay until the first call
 * past the TTL, an observed clear, a changed binary or a restart. `fresh`
 * bypasses the cache only for a direct adapter caller; no daemon models route
 * accepts it, and the daemon's account view retains its own copy of these rows
 * past the TTL (docs/ARCHITECTURE.md). */
export function clearClaudeModelProbeCache(): void {
  generation += 1;
  cache.clear();
  pending.clear();
}

function store(key: string, entry: CacheEntry, nowMs: number): void {
  for (const [k, v] of cache) if (v.expiresAtMs <= nowMs) cache.delete(k);
  cache.delete(key);
  while (cache.size >= CLAUDE_MODEL_PROBE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(key, entry);
}

function cacheKey(scope: ClaudeModelProbeScope, identity: HarnessBinaryIdentity): string {
  // A JSON array, never a joined string: two halves are paths.
  return JSON.stringify([
    scope.key,
    identity.path,
    identity.ino,
    identity.size,
    identity.mtimeMs,
    identity.interpreter,
  ]);
}

/**
 * One capture. Spawns the exact identity path (so the bytes probed are the
 * bytes keyed), in a fresh scratch cwd that is never a repository (a `-p`
 * start inside a repo would load its project hooks and `.mcp.json`), and
 * removes the scratch dir afterwards whatever happened. Null = failure.
 */
async function captureOnce(
  scope: ClaudeModelProbeScope,
  base: Env | undefined,
  identity: HarnessBinaryIdentity,
  capture: typeof runCapture,
  secret: string | null,
): Promise<ClaudeInitializeAnswer | null> {
  const root = join(nativeHarnessStateRoot(), "claude", "model-probe");
  ensureDir(root);
  const scratch = mkdtempSync(join(root, "probe-"));
  try {
    const result = await capture(identity.launcher ?? identity.path, [...CLAUDE_MODEL_PROBE_ARGS], {
      env: claudeModelProbeEnv(scope, base, scratch, secret),
      cwd: scratch,
      input: claudeInitializeFrame(),
      timeoutMs: CLAUDE_MODEL_PROBE_TIMEOUT_MS,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    // A killed or timed-out child may have flushed a complete-looking line
    // before the signal landed; those bytes are not a fresh vendor answer.
    if (result.signal !== null) return null;
    return parseClaudeInitialize(result.stdout, CLAUDE_INIT_REQUEST_ID);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The adapter's `models()`: TOTAL and never empty. Any failure — the binary
 * missing, a spawn error, a timeout/signal, an unparseable answer, an env
 * derivation error (bad profile locator, keychain bridge) — yields the hint
 * rows alone, so presence never shrinks below the manifest and a listing can
 * never make a caller believe the account has no models.
 */
export async function probeClaudeModels(
  spec?: HarnessModelSpec,
  deps: ClaudeModelProbeDeps = {},
): Promise<HarnessModel[]> {
  const fallback = (): HarnessModel[] => claudeModelRows(null);
  if (spec?.abortSignal?.aborted) return fallback();
  const startedGeneration = generation;
  const nowMs = deps.nowMs ?? Date.now;
  let key: string;
  let flight: Promise<HarnessModel[]>;
  try {
    const scope = claudeModelProbeScope(spec);
    // A credential profile whose secret is not stored cannot be probed as that
    // account (its runs refuse too): hints, no spawn, nothing cached.
    const secret =
      scope.kind === "credential" && scope.secretRef
        ? (deps.resolveProfileSecret ?? resolveSecret)(scope.secretRef)
        : null;
    if (scope.kind === "credential" && !secret) return fallback();
    const identity = probeBinaryIdentity(spec?.env, deps);
    if (identity === null) return fallback();
    const program = await observeHarnessProgram(
      CLAUDE_PROGRAM,
      spec?.env,
      identity.launcher ?? identity.path,
    );
    if (generation !== startedGeneration) return fallback();
    key = JSON.stringify([cacheKey(scope, identity), program.key]);
    if (!spec?.fresh) {
      const hit = cache.get(key);
      if (hit && hit.expiresAtMs > nowMs()) return [...hit.rows];
    }
    const inFlight = pending.get(key);
    if (inFlight !== undefined) return await awaitProbe(inFlight, spec?.abortSignal, fallback);
    // The capture owns its own bound; no caller's signal reaches it, so one
    // cancelled caller cannot hand every later caller a killed capture.
    const started = nowMs();
    flight = captureOnce(scope, spec?.env, identity, deps.runCapture ?? runCapture, secret)
      .catch((): ClaudeInitializeAnswer | null => null)
      .then((answer) => {
        const rows = claudeModelRows(answer);
        // A probe superseded by a cache clear is not stored: its scope may no
        // longer describe the store (login/logout changed it).
        if (pending.get(key) === flight) {
          const ttl =
            answer === null ? CLAUDE_MODEL_PROBE_FAILURE_TTL_MS : CLAUDE_MODEL_PROBE_TTL_MS;
          store(key, { rows, expiresAtMs: started + ttl }, nowMs());
        }
        return rows;
      })
      .finally(() => {
        if (pending.get(key) === flight) pending.delete(key);
      });
    pending.set(key, flight);
  } catch {
    return fallback();
  }
  return await awaitProbe(flight, spec?.abortSignal, fallback);
}

/** Bound only the CALLER's wait: an aborted caller reads the hint rows while
 * the shared capture keeps running for everybody else. */
function awaitProbe(
  flight: Promise<HarnessModel[]>,
  signal: AbortSignal | undefined,
  fallback: () => HarnessModel[],
): Promise<HarnessModel[]> {
  const settle = flight.then(
    (rows) => [...rows],
    () => fallback(),
  );
  if (!signal) return settle;
  if (signal.aborted) return Promise.resolve(fallback());
  return new Promise<HarnessModel[]>((resolve) => {
    const onAbort = (): void => resolve(fallback());
    signal.addEventListener("abort", onAbort, { once: true });
    void settle.then((rows) => {
      signal.removeEventListener("abort", onAbort);
      resolve(signal.aborted ? fallback() : rows);
    });
  });
}
