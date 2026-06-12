import type { ConformanceReport } from "@claudexor/schema";
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
interface DoctorCacheEntry {
  report: ConformanceReport;
  at: number;
}
const doctorCache = new Map<string, DoctorCacheEntry>();

/** Clear the doctor cache (call after auth/secrets/settings mutations). */
export function invalidateDoctorCache(): void {
  doctorCache.clear();
}

function doctorCacheKey(adapterId: string, spec: DoctorSpec): string {
  return `${adapterId}::${spec.cwd ?? ""}`;
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
    const cacheable = DOCTOR_TTL_MS > 0 && !adapter.id.startsWith("fake");
    const key = doctorCacheKey(adapter.id, spec);
    if (cacheable) {
      const hit = doctorCache.get(key);
      if (hit && now - hit.at < DOCTOR_TTL_MS) {
        reports.push(hit.report);
        continue;
      }
    }
    let report: ConformanceReport;
    try {
      report = await adapter.doctor(spec);
    } catch (err) {
      report = {
        harness_id: adapter.id,
        status: "unavailable",
        checks: [],
        enabled_intents: [],
        disabled_intents: [],
        reasons: [err instanceof Error ? err.message : String(err)],
      };
    }
    if (cacheable) doctorCache.set(key, { report, at: now });
    reports.push(report);
  }
  return reports;
}
