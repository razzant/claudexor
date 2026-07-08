import type { ConformanceCheck, HarnessManifest, Intent } from "@claudexor/schema";
import type { AdapterRegistry, DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { runDoctor } from "@claudexor/core";
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
 * Wraps an adapter registry with discovery and conformance role-gating.
 * (Route SELECTION lives in the budget router and orchestrator routing —
 * this class only reports what exists and what each harness may do.)
 */
export class HarnessGateway {
  constructor(private readonly registry: AdapterRegistry) {}

  list(): string[] {
    return [...this.registry.keys()];
  }

  get(id: string): HarnessAdapter | undefined {
    return this.registry.get(id);
  }

  /**
   * Discover + conformance-probe harnesses. When `only` is given, ONLY those
   * adapters are probed (so `doctor --harness X` / `auth status X` pay one
   * harness's discovery cost — incl. any paid smoke — instead of probing every
   * registered adapter and post-filtering). Unknown ids in `only` are skipped.
   */
  async statusAll(spec: DoctorSpec, only?: string[]): Promise<HarnessStatus[]> {
    const all = [...this.registry.values()];
    const adapters = only && only.length > 0 ? all.filter((a) => only.includes(a.id)) : all;
    return this.statusAllForAdapters(adapters, spec);
  }

  private async statusAllForAdapters(adapters: HarnessAdapter[], spec: DoctorSpec): Promise<HarnessStatus[]> {
    const out: HarnessStatus[] = [];
    for (const adapter of adapters) {
      let manifest: HarnessManifest | null = null;
      let discoverError: string | null = null;
      try {
        manifest = await adapter.discover();
      } catch (err) {
        // A crashed discover() must stay distinguishable from "not installed":
        // the message rides the status reasons instead of vanishing.
        manifest = null;
        discoverError = `discover failed: ${err instanceof Error ? err.message : String(err)}`;
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
        reasons: [...(discoverError ? [discoverError] : []), ...(report?.reasons ?? [])],
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
