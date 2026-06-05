import type { ConformanceReport } from "@claudex/schema";
import type { AdapterRegistry, DoctorSpec } from "./adapter.js";

/** Run conformance probes across all registered adapters; never throws. */
export async function runDoctor(
  adapters: AdapterRegistry,
  spec: DoctorSpec,
): Promise<ConformanceReport[]> {
  const reports: ConformanceReport[] = [];
  for (const adapter of adapters.values()) {
    try {
      reports.push(await adapter.doctor(spec));
    } catch (err) {
      reports.push({
        harness_id: adapter.id,
        status: "unavailable",
        checks: [],
        enabled_intents: [],
        disabled_intents: [],
        reasons: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return reports;
}
