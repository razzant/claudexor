import { createHash } from "node:crypto";
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
/**
 * Non-OK results age out much faster: an out-of-band `codex login` /
 * `claude /login` (which Claudexor cannot observe to invalidate) should become
 * routable within seconds, not a full TTL. OK results keep the long TTL since
 * readiness rarely degrades spontaneously and re-probing it is what costs money.
 */
const DOCTOR_NON_OK_TTL_MS = Number(process.env.CLAUDEXOR_DOCTOR_NON_OK_TTL_MS ?? 15_000);
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
  return `${adapterId}::${spec.cwd ?? ""}::${spec.authPreference ?? ""}::${envDigest}`;
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
