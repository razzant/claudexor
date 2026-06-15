import type { ConformanceCheck, HarnessManifest, Intent } from "@claudexor/schema";
import type { AdapterRegistry, DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, runDoctor } from "@claudexor/core";
import { allowedIntents } from "./gating.js";

export interface HarnessStatus {
  id: string;
  available: boolean;
  status: "ok" | "degraded" | "unavailable";
  manifest: HarnessManifest | null;
  enabledIntents: Intent[];
  disabledIntents: Intent[];
  checks: ConformanceCheck[];
  reasons: string[];
}

/**
 * Wraps an adapter registry with discovery, conformance role-gating, and
 * selection. Default selection prefers an available non-fake harness; fakes are
 * only used when explicitly requested by id.
 */
export class HarnessGateway {
  constructor(private readonly registry: AdapterRegistry) {}

  list(): string[] {
    return [...this.registry.keys()];
  }

  get(id: string): HarnessAdapter | undefined {
    return this.registry.get(id);
  }

  async statusAll(spec: DoctorSpec): Promise<HarnessStatus[]> {
    return this.statusAllForAdapters([...this.registry.values()], spec);
  }

  private async statusAllForAdapters(adapters: HarnessAdapter[], spec: DoctorSpec): Promise<HarnessStatus[]> {
    const out: HarnessStatus[] = [];
    for (const adapter of adapters) {
      let manifest: HarnessManifest | null = null;
      try {
        manifest = await adapter.discover();
      } catch {
        manifest = null;
      }
      const report = (await runDoctor(new Map([[adapter.id, adapter]]), spec))[0] ?? null;
      const status = report?.status ?? "unavailable";
      out.push({
        id: adapter.id,
        available: manifest !== null && status !== "unavailable",
        status,
        manifest,
        enabledIntents: manifest ? allowedIntents(manifest, report) : [],
        disabledIntents: report?.disabled_intents ?? [],
        checks: report?.checks ?? [],
        reasons: report?.reasons ?? [],
      });
    }
    return out;
  }

  /**
   * Doctor-VERIFIED real harnesses only (`status === "ok"`). Degraded routes
   * (key present but unproven) are excluded — claims of "doctor-verified"
   * availability must never include them.
   */
  async doctorOkReal(spec: DoctorSpec = { cwd: process.cwd() }, intent?: Intent): Promise<string[]> {
    const statuses = await this.statusAllForAdapters([...this.registry.values()], spec);
    return statuses
      .filter(
        (s) =>
          s.manifest?.kind !== "fake" &&
          s.status === "ok" &&
          s.enabledIntents.length > 0 &&
          (intent === undefined || s.enabledIntents.includes(intent)),
      )
      .map((s) => s.id);
  }
}
