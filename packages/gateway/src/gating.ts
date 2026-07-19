import type {
  ConformanceReport,
  HarnessCapabilities,
  HarnessManifest,
  Intent,
} from "@claudexor/schema";

/** Map declared capabilities to the intents an adapter could in principle play. */
export function capabilityIntents(caps: HarnessCapabilities): Intent[] {
  const intents: Intent[] = [];
  if (caps.plan) intents.push("plan", "spec");
  if (caps.implement) intents.push("implement", "repair");
  if (caps.create_from_scratch) intents.push("create_from_scratch");
  if (caps.review) intents.push("review");
  if (caps.verify) intents.push("verify");
  if (caps.synthesize) intents.push("synthesize");
  if (caps.read_files) intents.push("explain", "audit");
  return [...new Set(intents)];
}

/**
 * Compute the intents an adapter may actually be assigned, gating critical roles
 * behind conformance. A degraded adapter keeps only the intents it explicitly
 * still enables; an unavailable adapter gets none.
 */
export function allowedIntents(
  manifest: HarnessManifest,
  report: ConformanceReport | null,
): Intent[] {
  const base = capabilityIntents(manifest.capabilities);
  if (!report || report.status === "unavailable") return [];
  if (report.status === "ok") {
    // If the report enumerates enabled intents, intersect; otherwise trust capabilities.
    if (report.enabled_intents.length > 0) {
      return base.filter((i) => report.enabled_intents.includes(i));
    }
    return base;
  }
  // Degraded means the adapter is only trusted for the roles the doctor
  // explicitly re-enabled. Capability declarations alone are not enough once
  // conformance/auth is degraded.
  if (report.enabled_intents.length === 0) return [];
  return base.filter(
    (i) => report.enabled_intents.includes(i) && !report.disabled_intents.includes(i),
  );
}
