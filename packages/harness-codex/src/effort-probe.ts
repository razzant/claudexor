import { observeHarnessProgram } from "@claudexor/core";
import { CODEX_PROGRAM } from "./program.js";
import {
  prepareHarnessCommand,
  killOwnedProcessTree,
  harnessBinaryIdentityOnPath,
  harnessRuntimeEnv,
} from "@claudexor/core";
/**
 * Per-model effort discovery through Codex app-server model/list.
 * Vocabularies and defaults belong to each model, not the whole harness.
 * The vendor defines effort as an advertised nonempty string, so new values
 * need no repository enum update. A missing CLI, unsupported query, timeout
 * or malformed answer falls back to the recorded snapshot below.
 */
import { spawn } from "node:child_process";
import type { EffortResolution, ModelEffortCapability } from "@claudexor/schema";
import { EffortHint, effortLevelsForModel, mergeEffortLadders } from "@claudexor/schema";
import { effortLadders, resolveEffortEvidence } from "@claudexor/core";
import { readCodexProcessingModels } from "./processing.js";
import type { ProcessingCapability, HarnessModel } from "@claudexor/schema";
import { resolveCodexBin, probeEnv } from "./missing-cli.js";
import { CODEX_VENDOR_CLI_VERSION } from "./vendor-cli-version.js";

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
  /** Vendor default; null when none is advertised. */
  defaultModel: string | null;
  /** Listed models whose effort metadata was absent, distinct from an empty array. */
  unverifiedModels?: string[];
  processing?: Record<string, ProcessingCapability>;
  nativeModels?: HarnessModel[];
}
/**
 * Recorded fallback: the pinned CLI's visible `model/list` capture plus ladders
 * retained from historical account captures — a union, not a claim that every
 * account advertises every model (the freshness gate checks live entries and
 * permits snapshot-only ones). Used ONLY when the live probe cannot answer;
 * vendor evidence, never a hand-kept allow-list. `defaultModel` is the pinned
 * capture's `isDefault: true`; historical defaults never override it.
 */
export const CODEX_EFFORT_SNAPSHOT: CodexEffortCatalog = {
  models: {
    "gpt-6.1-sol": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
    },
    "gpt-6-astra": {
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "medium",
    },
    "gpt-6-sol": { levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "medium" },
    "gpt-6-luna": { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
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
    "gpt-5.2": { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  },
  defaultModel: "gpt-6.1-sol",
};

/** Vendor CLI version `CODEX_EFFORT_SNAPSHOT` was captured from. Aliases the
 * vendor-version SSOT (vendor-cli-version.ts) the remote installer pins, so the
 * freshness gate and the installed bytes vouch for one version. */
export const CODEX_EFFORT_SNAPSHOT_VERIFIED_AGAINST: string = CODEX_VENDOR_CLI_VERSION;

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
 * Missing metadata is unverified; an explicit empty array is known empty.
 * A malformed member poisons the probe instead of publishing a partial ladder.
 */
function readEntry(raw: ModelListEntry): [string, ModelEffortCapability] | null | typeof MALFORMED {
  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  if (!Array.isArray(raw.supportedReasoningEfforts)) return null;
  const levels: EffortHint[] = [];
  for (const item of raw.supportedReasoningEfforts) {
    const level = (item as { reasoningEffort?: unknown })?.reasoningEffort;
    if (level === undefined) return MALFORMED;
    const parsed = EffortHint.safeParse(level);
    if (!parsed.success) return MALFORMED;
    if (!levels.includes(parsed.data)) levels.push(parsed.data);
  }
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
  const unverifiedModels: string[] = [];
  let defaultModel: string | null = null;
  for (const raw of data) {
    const listed = raw as ModelListEntry;
    const entry = readEntry(listed);
    if (entry === MALFORMED) return null;
    // Default identity survives missing effort metadata.
    if (listed.isDefault === true && typeof listed.id === "string" && listed.id.trim() !== "") {
      defaultModel ??= listed.id;
    }
    if (!entry) {
      if (typeof listed.id === "string" && listed.id.trim()) unverifiedModels.push(listed.id);
      continue;
    }
    capability[entry[0]] = entry[1];
  }
  return Object.keys(capability).length > 0 || unverifiedModels.length > 0
    ? {
        models: capability,
        defaultModel,
        ...(unverifiedModels.length ? { unverifiedModels } : {}),
        ...readCodexProcessingModels(data),
      }
    : null;
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
      const command = prepareHarnessCommand(
        bin,
        ["app-server", "--stdio"],
        opts.env ?? harnessRuntimeEnv(),
      );
      child = spawn(command.binary, command.args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: command.env,
        // A captured background probe: no console window for the direct child on Windows.
        windowsHide: true,
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
        killOwnedProcessTree(child, "SIGKILL");
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
 * never comes, and `clearCodexEffortCache` runs only on a credential change or
 * harness maintenance. The cap is what makes the map's size provably bounded
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
/** Moved by every clear; a probe that began under an earlier value stores nothing. */
let codexEffortCacheGeneration = 0;

/**
 * Drop every cached catalog and void every probe still running. A login or other
 * credential change keeps a home's key while changing the account behind it, so
 * the daemon's credential invalidation calls this, as does harness maintenance. A
 * probe that began earlier still answers its own caller, which asked before the
 * change, and stores nothing. That invalidation also runs on every settings save
 * and any harness's login window and this clear has no scope, so the next read of
 * each home spawns one prompt-free app-server child again. The cache belongs to
 * this process and nothing re-reads it on a schedule: after a change another
 * process makes (a vendor login or logout the daemon did not run) a live answer
 * stays until its first read past the TTL, an observed clear, a changed binary or
 * a restart (docs/ARCHITECTURE.md).
 */
export function clearCodexEffortCache(): void {
  codexEffortCacheGeneration += 1;
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
  return JSON.stringify([
    env?.["CODEX_HOME"] ?? "",
    harnessBinaryIdentityOnPath(bin, env?.PATH ?? harnessRuntimeEnv().PATH ?? "") ?? bin,
  ]);
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
  const generation = codexEffortCacheGeneration;
  const now = nowMs();
  const program = await observeHarnessProgram(CODEX_PROGRAM, env, bin);
  const key = JSON.stringify([codexEffortCacheKey(bin, env), program.key]);
  const cached = codexEffortCache.get(key);
  if (generation === codexEffortCacheGeneration && cached && cached.expiresAtMs > now) {
    return { catalog: cached.catalog, live: cached.live };
  }
  const probed = await probe(bin, env);
  const live = probed !== null;
  const catalog = probed ?? CODEX_EFFORT_SNAPSHOT;
  // A clear during the probe means this answer, or this failure, may describe the
  // earlier account: its caller keeps it, and no later reader is handed it.
  if (generation === codexEffortCacheGeneration) {
    storeCodexEfforts(
      key,
      {
        catalog,
        live,
        expiresAtMs: now + (live ? CODEX_EFFORT_CACHE_TTL_MS : CODEX_EFFORT_FAILURE_CACHE_TTL_MS),
      },
      now,
    );
  }
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
  return await codexEffortCapability(
    deps.probeEfforts,
    deps.nowMs,
    resolveCodexBin(),
    probeEnv(envPatch),
  );
}

/** The ONE effort result of a codex route: arg builders send `resolution.submitted`,
 * the run records `resolution`, and the disclosure seams (effort-gate.ts) describe it. */
export interface CodexEffortResolution {
  resolution: EffortResolution;
  /** The model whose advertised ladder decided this (the hint, or the catalog default). */
  effectiveModel: string | null;
}

/**
 * The effort receipt for one (model, requested) pair: advertised passes through
 * verbatim; a level a SIBLING model advertises clamps inside the merged vendor
 * order (`ultra` on gpt-5.4 → `xhigh`, because the merged codex ladder places
 * it); a word NO codex model lists is placed by the shared preference order onto
 * the model's own ladder (`none` → `low`, `ultra` on a catalog that stops at
 * `xhigh` → `xhigh`), which the receipt's `reason` states; a word neither order
 * places is rejected and sends no flag. Contradicting vendor lists authorize no
 * substitution at all. `provenance` is the run's (where its catalog came from,
 * and whether a snapshot fallback is untrusted on this CLI version — nothing is
 * submitted then); pure arg-shape callers keep the default.
 */
export function codexEffortResolution(
  catalog: CodexEffortCatalog,
  model: string | null | undefined,
  requested: EffortHint | null | undefined,
  provenance: { source: EffortResolution["source"]; untrusted: boolean } = {
    source: "live_probe",
    untrusted: false,
  },
): CodexEffortResolution {
  const { effectiveModel, advertised, ladders, unverifiable } = codexEffortInputs(catalog, model);
  const resolution = resolveEffortEvidence(
    requested,
    advertised,
    ladders,
    provenance.source,
    "model_reasoning_effort",
    unverifiable || provenance.untrusted,
  );
  return { resolution, effectiveModel };
}

/** Capability inputs of one (catalog, model) pair: what the final model accepts
 * and the two rank orders a request may be placed along (vendor first). */
function codexEffortInputs(catalog: CodexEffortCatalog, model: string | null | undefined) {
  const lists = Object.values(catalog.models).map((entry) => entry.levels);
  const merged = mergeEffortLadders(lists);
  // Final model identity narrows accepted values, including known empty arrays.
  // Missing metadata on a listed model cannot borrow a sibling's capability;
  // a genuinely unlisted advisory model retains the existing union fallback.
  const effectiveModel = model ?? catalog.defaultModel;
  const unverifiable =
    effectiveModel != null &&
    (catalog.unverifiedModels?.includes(effectiveModel) === true ||
      (effectiveModel === catalog.defaultModel && !(effectiveModel in catalog.models)));
  const advertised = unverifiable
    ? []
    : ((effectiveModel != null ? catalog.models[effectiveModel]?.levels : undefined) ??
      effortLevelsForModel(
        {
          effort_levels: [...merged.order, ...merged.unconstrained],
          model_effort_levels: catalog.models,
        },
        effectiveModel,
      ));
  return { effectiveModel, advertised, unverifiable, ladders: effortLadders(lists) };
}

/**
 * The level an arg builder emits for one (model, requested) pair, or null when
 * no flag should be sent: `submitted` of `codexEffortResolution` — the same
 * function the run's receipt comes from. A run hands its builders the receipt's
 * own `submitted`; this projection serves arg-shape callers that have only a
 * catalog (the recorded snapshot by default).
 */
export function codexEffortFor(
  catalog: CodexEffortCatalog = CODEX_EFFORT_SNAPSHOT,
  model: string | null | undefined,
  requested: EffortHint | null | undefined,
): EffortHint | null {
  return codexEffortResolution(catalog, model, requested).resolution.submitted;
}
