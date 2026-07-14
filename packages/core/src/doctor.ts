import { createHash } from "node:crypto";
import type { ConformanceReport } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { AdapterRegistry, DoctorSpec } from "./adapter.js";

/**
 * Short-lived doctor cache. Real-harness `doctor()` is expensive (version probe,
 * native-auth check, and — for the api-key route — a paid isolated smoke), and
 * the orchestrator calls statusAll more than once per run (reviewers + candidates).
 * Without a cache an `ask "2+2"` could pay multiple smokes before work starts.
 * The TTL bounds staleness; mutating auth/secrets/settings should call
 * `invalidateDoctorCache()` for an immediate refresh.
 */
const DOCTOR_TTL_MS = Number(process.env.CLAUDEXOR_DOCTOR_TTL_MS ?? 90_000);
/**
 * Non-OK results age out much faster: an out-of-band `codex login` /
 * `claude auth login --claudeai` (which Claudexor cannot observe to invalidate) should become
 * routable within seconds, not a full TTL. OK results keep the long TTL since
 * readiness rarely degrades spontaneously and re-probing it is what costs money.
 */
const DOCTOR_NON_OK_TTL_MS = Number(process.env.CLAUDEXOR_DOCTOR_NON_OK_TTL_MS ?? 15_000);
interface DoctorCacheEntry {
  adapterId: string;
  cwd: string;
  report: ConformanceReport;
  at: number;
}
const doctorCache = new Map<string, DoctorCacheEntry>();
let globalCacheGeneration = 0;
const adapterCacheGenerations = new Map<string, number>();
const cwdCacheGenerations = new Map<string, number>();
const adapterCwdCacheGenerations = new Map<string, number>();

export interface DoctorCacheInvalidationScope {
  /** Remove every cached probe variant for this adapter only. */
  adapterId?: string;
  /** Optionally narrow invalidation to one exact doctor cwd. */
  cwd?: string;
}

/**
 * Invalidate derived doctor evidence after auth/secrets/settings mutations.
 * No scope preserves the historical whole-cache behavior. A scope removes
 * only entries whose structured dimensions match, so a Claude login cannot
 * evict an unrelated Codex API-key smoke (or vice versa).
 */
export function invalidateDoctorCache(scope?: DoctorCacheInvalidationScope): void {
  if (!scope || (scope.adapterId === undefined && scope.cwd === undefined)) {
    doctorCache.clear();
    globalCacheGeneration += 1;
    adapterCacheGenerations.clear();
    cwdCacheGenerations.clear();
    adapterCwdCacheGenerations.clear();
    return;
  }
  if (scope.adapterId !== undefined && scope.cwd !== undefined) {
    incrementGeneration(adapterCwdCacheGenerations, `${scope.adapterId}\0${scope.cwd}`);
  } else if (scope.adapterId !== undefined) {
    incrementGeneration(adapterCacheGenerations, scope.adapterId);
  } else if (scope.cwd !== undefined) {
    incrementGeneration(cwdCacheGenerations, scope.cwd);
  }
  for (const [key, entry] of doctorCache) {
    if (scope.adapterId !== undefined && entry.adapterId !== scope.adapterId) continue;
    if (scope.cwd !== undefined && entry.cwd !== scope.cwd) continue;
    doctorCache.delete(key);
  }
}

function incrementGeneration(generations: Map<string, number>, key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

function cacheGeneration(adapterId: string, cwd: string): string {
  return [
    globalCacheGeneration,
    adapterCacheGenerations.get(adapterId) ?? 0,
    cwdCacheGenerations.get(cwd) ?? 0,
    adapterCwdCacheGenerations.get(`${adapterId}\0${cwd}`) ?? 0,
  ].join(":");
}

function doctorCacheKey(adapterId: string, spec: DoctorSpec): string {
  // The key covers EVERY spec field that can change a probe's outcome: cwd,
  // the auth-route preference, and any scoped env overlay. Omitting them
  // would let a scoped-route probe poison (or be served) the default-route
  // report for the same cwd — a latent cross-route cache bug even though
  // today's scoped callers bypass runDoctor. Env entries can carry key
  // MATERIAL, so they enter the key only as a digest, never as plaintext.
  const envDigest = spec.env
    ? createHash("sha256")
        .update(JSON.stringify(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))))
        .digest("hex")
        .slice(0, 16)
    : "";
  return `${adapterId}::${spec.cwd ?? ""}::${spec.authPreference ?? ""}::${spec.authSource ?? ""}::${envDigest}`;
}

/** Run conformance probes across all registered adapters; never throws. */
export async function runDoctor(
  adapters: AdapterRegistry,
  spec: DoctorSpec,
): Promise<ConformanceReport[]> {
  const reports: ConformanceReport[] = [];
  const now = Date.now();
  for (const adapter of adapters.values()) {
    // Fakes are cheap + deterministic and are reconfigured per test — never cache
    // them (avoids cross-test contamination); only real adapters benefit.
    // A caller asking for fresh evidence must neither read nor seed shared
    // cache state. This keeps an explicit post-login probe isolated from the
    // normal routing cache and avoids clearing useful reports for other specs.
    const cacheable =
      DOCTOR_TTL_MS > 0 &&
      !adapter.id.startsWith("fake") &&
      spec.fresh !== true &&
      spec.abortSignal === undefined;
    const cwd = spec.cwd ?? "";
    // Capture the invalidation generation before the asynchronous probe. If
    // auth/settings change while it is in flight, its result may still be
    // returned to the original caller but must never repopulate shared cache.
    const generation = cacheGeneration(adapter.id, cwd);
    const key = doctorCacheKey(adapter.id, spec);
    if (cacheable) {
      const hit = doctorCache.get(key);
      const ttl = hit?.report.status === "ok" ? DOCTOR_TTL_MS : DOCTOR_NON_OK_TTL_MS;
      if (hit && now - hit.at < ttl) {
        reports.push(hit.report);
        continue;
      }
    }
    let report: ConformanceReport;
    try {
      report = await adapter.doctor(spec);
    } catch (err) {
      // Adapter errors are projected into successful doctor/readiness DTOs, so
      // they bypass the control-api problem redactor. Sanitize at this producer
      // boundary before the message can enter reasons, cache state, or exact
      // auth-source evidence.
      const detail = redactSecrets(err instanceof Error ? err.message : String(err));
      report = {
        harness_id: adapter.id,
        status: "unavailable",
        checks: [],
        enabled_intents: [],
        disabled_intents: [],
        reasons: [detail],
        // An exact source probe that failed is UNKNOWN, not evidence that the
        // source is absent. Preserve the requested identity so callers never
        // have to collapse "probe failed" into null/unsupported.
        auth_sources:
          spec.authSource === undefined
            ? []
            : [
                {
                  source: spec.authSource,
                  availability: "unknown",
                  verification: "not_run",
                  detail,
                },
              ],
      };
    }
    if (cacheable && generation === cacheGeneration(adapter.id, cwd)) {
      doctorCache.set(key, {
        adapterId: adapter.id,
        cwd,
        report,
        at: now,
      });
    }
    reports.push(report);
  }
  return reports;
}
