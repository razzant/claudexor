/**
 * Per-model effort discovery for codex.
 *
 * Codex advertises reasoning-effort vocabularies PER MODEL and exposes them
 * machine-readably: `codex app-server --stdio` speaks JSON-RPC, and the v2
 * `model/list` request answers with `data[].supportedReasoningEfforts` +
 * `defaultReasoningEffort`. The ceiling is genuinely model-scoped — gpt-5.6-sol
 * takes `ultra` while gpt-5.4 stops at `xhigh` — so a harness-wide ladder is
 * always wrong for some model.
 *
 * The vendor's own generated schema types `ReasoningEffort` as "a non-empty
 * reasoning effort value advertised by the model" (a bounded string, NOT an
 * enum). We mirror that: whatever the probe reports is what we advertise, so a
 * level newer than this repo starts working the moment codex ships it.
 *
 * A probe is never load-bearing. Missing binary, an older app-server without
 * `model/list`, a timeout or malformed output all fall back to the recorded
 * snapshot below and the run proceeds.
 */
import { spawn } from "node:child_process";
import type { HarnessEvent, HarnessRunSpec, ModelEffortCapability } from "@claudexor/schema";
import { EffortHint, effortLevelsForModel, mergeEffortLadders } from "@claudexor/schema";
import { resolveEffort } from "@claudexor/core";
import { nowIso } from "@claudexor/util";
import { BIN, probeEnv } from "./missing-cli.js";

export type CodexEffortCapability = Record<string, ModelEffortCapability>;

/**
 * One account's whole advertised effort surface: the per-model vocabularies
 * PLUS which model codex itself runs when no `-m` is given (`model/list` marks
 * it with `isDefault`). The default matters for effort resolution: a run with
 * no model hint executes on the DEFAULT model, so its ladder — not the
 * harness-wide union — is what a requested level must be held to.
 */
export interface CodexEffortCatalog {
  models: CodexEffortCapability;
  /** `model/list` entry flagged `isDefault: true`; null when the vendor marked none. */
  defaultModel: string | null;
}

/**
 * Recorded fallback, captured from a live `model/list` on the CLI version
 * stamped below. Used ONLY when the live probe cannot answer; it is a snapshot
 * of vendor state, never an allow-list this repo maintains by hand.
 * (`defaultModel` is the entry that carried `isDefault: true` in that capture.)
 */
export const CODEX_EFFORT_SNAPSHOT: CodexEffortCatalog = {
  models: {
    "gpt-5.6-sol": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
    },
    "gpt-5.6-terra": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "medium",
    },
    "gpt-5.6-luna": { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    "gpt-5.5": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    "gpt-5.4": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    "gpt-5.4-mini": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
    "gpt-5.3-codex-spark": { levels: ["low", "medium", "high", "xhigh"], default: "high" },
  },
  defaultModel: "gpt-5.6-sol",
};

/** Vendor CLI version `CODEX_EFFORT_SNAPSHOT` was captured from. */
export const CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST = "0.144.1";

/**
 * Harness-wide merged ladder of an advertised catalog, weakest→strongest. Kept
 * as the coarse `effort_levels` fallback so every existing reader (settings
 * validation, the composer's picker, INV-105 disclosure) keeps working while
 * per-model narrowing happens through `effortLevelsForModel`.
 *
 * Ordering authority is the VENDOR: `model/list` returns each model's
 * `supportedReasoningEfforts` already ordered weakest→strongest, so the
 * harness ladder is the positional merge of those lists (`mergeEffortLadders`)
 * — never a table this repo maintains. The Swift composer merges the manifests'
 * already-ordered arrays the same way, so both sides of the wire agree.
 *
 * A level NO model orders against the rest (`unconstrained`) still belongs to
 * the advertised set — some model really accepts it — but has no honest rank,
 * so it trails the ranked merge here (membership/display) while staying
 * excluded from the clamping order (`mergeEffortLadders.order`).
 */
export function unionEffortLevels(capability: CodexEffortCapability): EffortHint[] {
  const merged = mergeEffortLadders(Object.values(capability).map((entry) => entry.levels));
  return [...merged.order, ...merged.unconstrained];
}

interface ModelListEntry {
  id?: unknown;
  isDefault?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}

/**
 * A vendor VALUE that is not an effort level at all. Distinct from `null` (an
 * entry that simply advertises no effort surface, which is normal and skipped):
 * this poisons the whole probe. See `readModelListEfforts`.
 */
const MALFORMED = Symbol("malformed-effort-entry");

/**
 * Shape-check one `model/list` entry; never throws.
 *
 * ABSENCE is skipped (`null`): no id, no `supportedReasoningEfforts` array, an
 * array member without the field, an empty list — a model with no effort surface
 * is ordinary vendor output. A PRESENT value that is not an `EffortHint` is
 * MALFORMED, because `EffortHint` is the wire contract every consumer downstream
 * enforces, right up to `HarnessManifest.parse`.
 */
function readEntry(raw: ModelListEntry): [string, ModelEffortCapability] | null | typeof MALFORMED {
  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  if (!Array.isArray(raw.supportedReasoningEfforts)) return null;
  const levels: EffortHint[] = [];
  for (const item of raw.supportedReasoningEfforts) {
    const level = (item as { reasoningEffort?: unknown })?.reasoningEffort;
    if (level === undefined) continue;
    const parsed = EffortHint.safeParse(level);
    if (!parsed.success) return MALFORMED;
    if (!levels.includes(parsed.data)) levels.push(parsed.data);
  }
  if (levels.length === 0) return null;
  // An absent default is normal (the vendor omits it, or sends an empty string);
  // a present one must be a real level, since it is published as the manifest's
  // per-model `default` and read back through the same schema.
  const fallback = raw.defaultReasoningEffort;
  if (fallback === undefined || fallback === null || fallback === "") {
    return [raw.id, { levels, default: null }];
  }
  const parsedDefault = EffortHint.safeParse(fallback);
  if (!parsedDefault.success) return MALFORMED;
  return [raw.id, { levels, default: parsedDefault.data }];
}

/**
 * The whole `model/list` payload as a capability map, or null for a FAILED probe.
 *
 * STRICT on purpose (the reviewed decision): ONE malformed value discards the
 * ENTIRE live catalog and the caller degrades to the recorded snapshot, which is
 * exactly what this module promises. Skipping the bad entry instead would publish
 * a silently NARROWED ladder — a model advertising `["low", "HIGH!"]` would go out
 * as `["low"]`, stamped with the installed CLI version, so a `high` request would
 * clamp down to `low` and the freshness gate would call the ladder fresh. And a
 * malformed value that reached the manifest would fail `HarnessManifest.parse`,
 * breaking discovery rather than degrading it. The snapshot is a real, usable
 * ladder, so strictness costs freshness and never capability.
 *
 * `defaultModel` is the entry the vendor flagged `isDefault: true`
 * (live-verified on 0.144.1). Only a literal boolean true counts: the flag is
 * model identity, not part of the effort wire contract, so an absent or odd
 * value degrades the default to null rather than poisoning the catalog.
 */
export function readModelListEfforts(data: unknown): CodexEffortCatalog | null {
  if (!Array.isArray(data)) return null;
  const capability: CodexEffortCapability = {};
  let defaultModel: string | null = null;
  for (const raw of data) {
    const listed = raw as ModelListEntry;
    const entry = readEntry(listed);
    if (entry === MALFORMED) return null;
    // TWO separate facts per entry. `isDefault` is model IDENTITY and is read
    // even when the entry contributes no ladder: a default model that
    // advertises no effort surface is still the model a hint-less run executes
    // on, and dropping its identity with its (nonexistent) ladder silently
    // re-validated hint-less runs against the harness-wide union — the exact
    // bug the default-model narrowing exists to prevent.
    if (listed.isDefault === true && typeof listed.id === "string" && listed.id.trim() !== "") {
      defaultModel ??= listed.id;
    }
    if (!entry) continue;
    capability[entry[0]] = entry[1];
  }
  return Object.keys(capability).length > 0 ? { models: capability, defaultModel } : null;
}

/**
 * Ask a live `codex app-server` what each model advertises. Resolves to null on
 * ANY failure — the caller falls back to the snapshot.
 */
export async function probeCodexEfforts(
  bin: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CodexEffortCatalog | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return await new Promise<CodexEffortCatalog | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value: CodexEffortCatalog | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* the child is already gone; nothing to clean up */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    child.on("error", () => finish(null));
    // `close`, NOT `exit`: `exit` fires when the process is reaped, which can
    // beat the buffered stdout reaching the `data` handler above. An app-server
    // that answers `model/list` and exits promptly would then be recorded as a
    // FAILED probe and silently degrade a perfectly good live catalog to the
    // snapshot. `close` fires only once every stdio stream is done, so by the
    // time it runs the answer has already been parsed and `settled` is true.
    // This does not reintroduce the EPIPE hazard: the asynchronous stream break
    // still lands on the stdin/stdout `error` listeners below.
    child.on("close", () => finish(null));

    // A pipe to a child that already died reports the break ASYNCHRONOUSLY, on
    // the stream's `error` event — `write()` returns normally and the EPIPE
    // arrives a tick later, so the try/catch in `send` can never see it. Left
    // unhandled that event is an UNCAUGHT EXCEPTION: it took down whole test
    // runs on machines with no codex installed while every dev box (codex
    // present, handshake answered) stayed green. Both failure shapes have the
    // same meaning here — no live catalog — so both land on `finish(null)` and
    // the caller degrades to the recorded snapshot.
    child.stdin?.on("error", () => finish(null));
    child.stdout?.on("error", () => finish(null));

    const send = (payload: unknown): void => {
      // The probe is over: the child has been killed, so a queued frame would
      // only write into a destroyed stream to no purpose.
      if (settled) return;
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // Kept for the SYNCHRONOUS shapes (a destroyed stream, a serialization
        // fault); the asynchronous shape arrives on the listener above.
        finish(null);
      }
    };

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        let message: { id?: unknown; result?: { data?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          // Handshake accepted: the notification, then the v2 model query.
          send({ method: "initialized", params: null });
          send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });
          continue;
        }
        if (message.id !== 2) continue;
        finish(readModelListEfforts(message.result?.data));
        return;
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "claudexor", version: "1" } },
    });
  });
}

// Codex advertises effort PER MODEL (`model/list`), so there is no single codex
// ladder to declare here — `codexEffortCapability()` below reads the live one and
// falls back to the recorded snapshot. Cached like cursor's api-key smoke: a
// bounded TTL map, so discovery and every run share one probe instead of
// re-spawning an app-server per call.
const CODEX_EFFORT_CACHE_TTL_MS = 10 * 60_000;
const CODEX_EFFORT_FAILURE_CACHE_TTL_MS = 60_000;

/**
 * Hard ceiling on cached catalogs.
 *
 * The cache key is (resolved `CODEX_HOME`, binary), and an API-key route mints a
 * FRESH `mkdtemp` home per run — so in a long-lived daemon every such run inserts
 * a key that can never be read again. Expiry alone does not bound it: expiry is
 * only consulted on a later read of the SAME key, which for an ephemeral home
 * never comes, and `clearCodexEffortCache` is only reached from tests and the
 * doctor's `fresh` path. The cap is what makes the map's size provably bounded
 * regardless of run volume or uptime. Generous next to the real population
 * (native home + one per credential profile, times installed binaries), so
 * eviction only ever bites the ephemeral keys it exists for.
 */
const CODEX_EFFORT_CACHE_MAX_ENTRIES = 64;

interface CodexEffortCacheEntry {
  catalog: CodexEffortCatalog;
  /** True when a live `model/list` answered; false when the snapshot filled in. */
  live: boolean;
  expiresAtMs: number;
}
const codexEffortCache = new Map<string, CodexEffortCacheEntry>();

/** Drop the cached effort probe (tests; and the doctor's `fresh` path). */
export function clearCodexEffortCache(): void {
  codexEffortCache.clear();
}

/** Live entry count. Exported so the bound above can be asserted, not assumed. */
export function codexEffortCacheSize(): number {
  return codexEffortCache.size;
}

/**
 * Insert under the bound: drop everything already expired, then evict
 * oldest-first until there is room. `Map` iterates in insertion order, so the
 * first surviving key is the least recently INSERTED one — good enough here,
 * because entries are rewritten on every refresh and the keys this protects
 * against are write-once by construction.
 */
function storeCodexEfforts(key: string, entry: CodexEffortCacheEntry, nowMs: number): void {
  for (const [k, v] of codexEffortCache) {
    if (v.expiresAtMs <= nowMs) codexEffortCache.delete(k);
  }
  codexEffortCache.delete(key);
  while (codexEffortCache.size >= CODEX_EFFORT_CACHE_MAX_ENTRIES) {
    const oldest = codexEffortCache.keys().next();
    if (oldest.done) break;
    codexEffortCache.delete(oldest.value);
  }
  codexEffortCache.set(key, entry);
}

/** Live per-model discovery for one binary in one resolved environment. */
export type CodexEffortProbe = (
  bin: string,
  env?: NodeJS.ProcessEnv,
) => Promise<CodexEffortCatalog | null>;

/**
 * Cache identity of ONE codex effort catalog: the resolved `CODEX_HOME` plus the
 * binary path.
 *
 * `model/list` answers for the ACCOUNT the resolved home is logged into, and
 * every credential profile and API-key route gets its own `CODEX_HOME`. Keying by
 * the binary alone therefore served one profile another account's models and
 * ladders for the whole TTL — omitting levels the account really has, or sending
 * levels it does not. The binary stays in the key because two codex versions
 * advertise different catalogs from the same home.
 */
function codexEffortCacheKey(bin: string, env?: NodeJS.ProcessEnv): string {
  // A JSON-encoded pair, not a joined string: both halves are paths, so any
  // printable separator would let two different (home, bin) pairs share a key.
  return JSON.stringify([env?.["CODEX_HOME"] ?? "", bin]);
}

/**
 * The per-model effort vocabulary codex currently advertises FOR THIS ENV. Live
 * when the app-server answers, the recorded snapshot otherwise — a probe failure
 * degrades the ladder's freshness, never the run.
 */
export async function codexEffortCapability(
  probe: CodexEffortProbe,
  nowMs: () => number,
  bin: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ catalog: CodexEffortCatalog; live: boolean }> {
  const now = nowMs();
  const key = codexEffortCacheKey(bin, env);
  const cached = codexEffortCache.get(key);
  if (cached && cached.expiresAtMs > now) {
    return { catalog: cached.catalog, live: cached.live };
  }
  const probed = await probe(bin, env);
  const live = probed !== null;
  const catalog = probed ?? CODEX_EFFORT_SNAPSHOT;
  storeCodexEfforts(
    key,
    {
      catalog,
      live,
      expiresAtMs: now + (live ? CODEX_EFFORT_CACHE_TTL_MS : CODEX_EFFORT_FAILURE_CACHE_TTL_MS),
    },
    now,
  );
  return { catalog, live };
}

/**
 * The catalog for the environment a codex child will ACTUALLY run in. ONE owner
 * of that resolution: callers hand over their env PATCH (spec env + provider
 * scrub + the resolved `CODEX_HOME`) and this resolves it exactly the way the
 * spawn will, so the probe env and the cache identity can never disagree.
 *
 * An API-key route uses a fresh temporary `CODEX_HOME` per run, so it re-probes
 * each time by construction. That is the correct trade: one bounded app-server
 * spawn instead of a cross-account catalog served out of the cache.
 */
export async function codexEffortsForEnv(
  deps: { probeEfforts: CodexEffortProbe; nowMs: () => number },
  envPatch?: Record<string, string | null | undefined>,
): Promise<{ catalog: CodexEffortCatalog; live: boolean }> {
  return await codexEffortCapability(deps.probeEfforts, deps.nowMs, BIN, probeEnv(envPatch));
}

/**
 * The full outcome of resolving one (model, requested) pair against a catalog:
 * what to send, whether the merged vendor order MOVED it there, and which
 * model's ladder decided. `codexEffortFor` keeps only the level for the arg
 * builder; the disclosure seams need the other two facts, because a CLAMP is a
 * changed setting the user asked for differently (INV-105) even though a flag
 * is still sent.
 */
export interface CodexEffortResolution {
  /** The level to send, or null when no flag should be sent at all. */
  effort: EffortHint | null;
  /** True when `effort` differs from the request — the merged vendor order clamped it. */
  clamped: boolean;
  /** The model whose advertised ladder decided this (the hint, or the catalog default). */
  effectiveModel: string | null;
}

/**
 * The effort value to send for one (model, requested) pair: advertised passes
 * through verbatim, a level a SIBLING model advertises clamps inside the merged
 * vendor order (`ultra` on gpt-5.4 → `xhigh` because the merged codex ladder
 * places it), anything else sends no flag at all.
 *
 * If a future catalog ever contains two models whose advertised orders
 * genuinely contradict each other, there is no honest merged rank — so
 * cross-model clamping is treated as IMPOSSIBLE (the ladder collapses to the
 * model's own list) and an unadvertised level is refused rather than clamped
 * along an order this repo would have had to invent.
 */
export function codexEffortResolution(
  catalog: CodexEffortCatalog,
  model: string | null | undefined,
  requested: EffortHint | null | undefined,
): CodexEffortResolution {
  const merged = mergeEffortLadders(Object.values(catalog.models).map((entry) => entry.levels));
  // No model hint does NOT mean "any model": codex runs the catalog's DEFAULT
  // model (`model/list` isDefault), so the requested level is held to THAT
  // model's ladder. Validating a hint-less run against the harness-wide union
  // let a sibling-only level (`ultra`) ride into a default model that rejects
  // it. A catalog with no recorded default keeps the union fallback — the
  // broadest honest set when the effective model is genuinely unknown.
  //
  // A default model the catalog recorded WITHOUT a ladder is different from an
  // unknown model: the vendor listed it and advertised no effort surface, so
  // its ladder is KNOWN-EMPTY, not unknown. `effortLevelsForModel`'s union
  // fallback would clamp against sibling ladders the run never executes on;
  // an empty advertised set instead sends no flag, and the caller's INV-105
  // seam (`codexEffortIgnoredEvent`) discloses the dropped setting.
  const effectiveModel = model ?? catalog.defaultModel;
  const defaultKnownEffortless =
    effectiveModel != null &&
    effectiveModel === catalog.defaultModel &&
    !(effectiveModel in catalog.models);
  const advertised = defaultKnownEffortless
    ? []
    : effortLevelsForModel(
        {
          effort_levels: [...merged.order, ...merged.unconstrained],
          model_effort_levels: catalog.models,
        },
        effectiveModel,
      );
  const check = resolveEffort(requested, advertised, merged.consistent ? merged.order : advertised);
  if (check.status !== "ok") return { effort: null, clamped: false, effectiveModel };
  return { effort: check.effort, clamped: check.clamped, effectiveModel };
}

/**
 * The level the arg builder should emit for one (model, requested) pair, or
 * null when no flag should be sent. Thin projection of
 * `codexEffortResolution`; the run-side disclosure seams read the full
 * resolution so a clamp or a drop is never silent.
 */
export function codexEffortFor(
  catalog: CodexEffortCatalog,
  model: string | null | undefined,
  requested: EffortHint | null | undefined,
): EffortHint | null {
  return codexEffortResolution(catalog, model, requested).effort;
}

/**
 * The INV-105 disclosure for an effort the RUN itself could not honor, or null
 * when nothing was dropped. Preflight validates against the manifest — the
 * DEFAULT account's catalog — but the adapter resolves against the catalog for
 * the env the child actually runs in (profile / API-key homes have their own
 * accounts), so a level can pass preflight and still resolve to "send no flag"
 * here. Without this event that run silently executed at the vendor default;
 * the payload rides the same `ignored_settings` channel governance uses, so
 * the timeline renders the same warning either way.
 */
export function codexEffortIgnoredEvent(
  catalog: CodexEffortCatalog,
  spec: Pick<HarnessRunSpec, "session_id" | "model_hint" | "effort_hint">,
): HarnessEvent | null {
  if (!spec.effort_hint) return null;
  if (codexEffortFor(catalog, spec.model_hint, spec.effort_hint) !== null) return null;
  const target = spec.model_hint ?? catalog.defaultModel;
  // An EMPTY catalog is the version-gated snapshot distrust case
  // (`codexCatalogForRun`): the live probe could not answer and the recorded
  // snapshot belongs to a different CLI version, so the honest statement is
  // "unverifiable", not "not accepted".
  const detail =
    Object.keys(catalog.models).length > 0
      ? `effort=${spec.effort_hint} (not accepted by the codex catalog resolved for this run's ` +
        `environment${target ? ` on model ${target}` : ""}; the run used the vendor default)`
      : `effort=${spec.effort_hint} (could not be verified against the installed codex CLI: ` +
        "the live model/list probe could not answer, and the recorded snapshot was captured " +
        `from CLI ${CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST}, a different version, ` +
        "so no effort flag was sent; the run used the vendor default)";
  return {
    type: "message",
    session_id: spec.session_id,
    ts: nowIso(),
    text: `[effort] ignored: ${detail}`,
    payload: { ignored_settings: [detail] },
  };
}

/**
 * The INV-105 disclosure for an effort the run CLAMPED, or null when the
 * requested level rode through verbatim (or was dropped — that is
 * `codexEffortIgnoredEvent`'s shape, and the two are mutually exclusive: a
 * drop sends no level, a clamp sends a different one). A clamp is quieter than
 * a drop but just as much a changed setting: `--effort ultra` on gpt-5.4 runs
 * at `xhigh`, and without this event nothing in the timeline said so. The
 * payload rides the same `ignored_settings` channel governance and the drop
 * seam use, so every existing reader renders the same warning.
 */
/**
 * The one INV-105 seam the run yields: the DROP disclosure or the CLAMP
 * disclosure, whichever applies (they are mutually exclusive by construction —
 * a drop sends no flag, a clamp sends a different one), or null when the
 * requested level rode through verbatim or nothing was requested.
 */
export function codexEffortDisclosureEvent(
  catalog: CodexEffortCatalog,
  spec: Pick<HarnessRunSpec, "session_id" | "model_hint" | "effort_hint">,
): HarnessEvent | null {
  return codexEffortIgnoredEvent(catalog, spec) ?? codexEffortClampedEvent(catalog, spec);
}

export function codexEffortClampedEvent(
  catalog: CodexEffortCatalog,
  spec: Pick<HarnessRunSpec, "session_id" | "model_hint" | "effort_hint">,
): HarnessEvent | null {
  if (!spec.effort_hint) return null;
  const resolved = codexEffortResolution(catalog, spec.model_hint, spec.effort_hint);
  if (!resolved.clamped || resolved.effort === null) return null;
  const detail =
    `effort=${spec.effort_hint} (clamped to ${resolved.effort}: the requested level is not ` +
    `advertised by${resolved.effectiveModel ? ` model ${resolved.effectiveModel}` : " the resolved model"}, ` +
    `so the run sent ${resolved.effort}, the nearest level that model advertises)`;
  return {
    type: "message",
    session_id: spec.session_id,
    ts: nowIso(),
    text: `[effort] clamped: ${detail}`,
    payload: { ignored_settings: [detail] },
  };
}
