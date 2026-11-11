import type {
  AccountIdentity,
  AuthSourceKind,
  AuthSourceReadiness,
  ConformanceCheck,
  HarnessManifest,
  Intent,
} from "@claudexor/schema";
import type { AdapterRegistry, DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { runDoctor } from "@claudexor/core";
import { allowedIntents } from "./gating.js";

export interface HarnessStatus {
  id: string;
  available: boolean;
  status: "ok" | "degraded" | "unavailable";
  manifest: HarnessManifest | null;
  /** Intents an EXPLICIT selection of this harness may run: capability intents
   * the doctor enables. A degraded harness keeps the intents its doctor still
   * enables, with its reasons; an unavailable one has none (#133). */
  enabledIntents: Intent[];
  /** Intents the AUTO pool may route here: `enabledIntents` only while the
   * doctor reports ok, so a degraded harness is never automatically eligible.
   * Explicit-selection surfaces read `enabledIntents` instead; neither field
   * is re-derived by clients (R8). */
  routableIntents: Intent[];
  disabledIntents: Intent[];
  checks: ConformanceCheck[];
  reasons: string[];
  authSources: AuthSourceReadiness[];
}

/** Accounts-only status receipt; generic HarnessStatus deliberately stays identity-free. */
export interface HarnessAccountStatus {
  status: HarnessStatus;
  identity: AccountIdentity | null;
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
   * Probe one concrete auth source on one concrete harness. This deliberately
   * bypasses discover() and every other adapter: post-login verification must
   * not spend or accidentally accept an unrelated credential route.
   */
  async probeAuthSource(
    harnessId: string,
    source: AuthSourceKind,
    spec: DoctorSpec,
  ): Promise<AuthSourceReadiness | null> {
    const adapter = this.registry.get(harnessId);
    if (!adapter) return null;
    const report = (
      await runDoctor(new Map([[adapter.id, adapter]]), { ...spec, authSource: source })
    )[0];
    return report?.auth_sources.find((candidate) => candidate.source === source) ?? null;
  }

  /**
   * Source-targeted readiness point-probe for ROUTE gating (W3.3 / TZ-1 §B):
   * re-derives ONE harness's readiness in the exact resolved env/cwd its run
   * will spawn with, so routing never admits a route on host-env auth truth
   * the run's scoped env cannot reproduce. Discovery stays host-level
   * (statusAll); this never probes unrelated adapters and never resurrects a
   * harness that host discovery dropped.
   */
  async routeStatus(harnessId: string, spec: DoctorSpec): Promise<HarnessStatus | null> {
    const adapter = this.registry.get(harnessId);
    if (!adapter) return null;
    return (await this.statusAllForAdapters([adapter], spec))[0] ?? null;
  }

  /**
   * Discover + conformance-probe harnesses. When `only` is given, ONLY those
   * adapters are probed (so `doctor --harness X` / `auth status X` pay one
   * harness's discovery cost — incl. any paid smoke — instead of probing every
   * registered adapter and post-filtering). Unknown ids in `only` are skipped.
   */
  async statusAll(spec: DoctorSpec, only?: string[]): Promise<HarnessStatus[]> {
    return this.statusAllForAdapters(this.selectedAdapters(only), spec);
  }

  /**
   * Accounts-specific variant of statusAll. An adapter with a rich Accounts
   * doctor returns readiness and identity from the SAME native probe; adapters
   * without that capability retain their exact generic status path and expose
   * no identity. The identity is never added to HarnessStatus or its wire DTO.
   */
  async statusAllForAccounts(spec: DoctorSpec, only?: string[]): Promise<HarnessAccountStatus[]> {
    const identities = new Map<string, AccountIdentity | null>();
    const adapters = this.selectedAdapters(only).map((adapter): HarnessAdapter => {
      if (!adapter.doctorForAccounts) return adapter;
      return {
        ...adapter,
        doctor: async (doctorSpec) => {
          const receipt = await adapter.doctorForAccounts!(doctorSpec);
          identities.set(adapter.id, receipt.identity);
          return receipt.report;
        },
      };
    });
    const statuses = await this.statusAllForAdapters(adapters, spec);
    return statuses.map((status) => ({
      status,
      identity: identities.get(status.id) ?? null,
    }));
  }

  private selectedAdapters(only?: string[]): HarnessAdapter[] {
    const all = [...this.registry.values()];
    return only && only.length > 0 ? all.filter((adapter) => only.includes(adapter.id)) : all;
  }

  private async statusAllForAdapters(
    adapters: HarnessAdapter[],
    spec: DoctorSpec,
  ): Promise<HarnessStatus[]> {
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
      const enabledIntents = manifest ? allowedIntents(manifest, report) : [];
      out.push({
        id: adapter.id,
        available: manifest !== null && status !== "unavailable",
        status,
        manifest,
        enabledIntents,
        routableIntents: status === "ok" ? enabledIntents : [],
        disabledIntents: report?.disabled_intents ?? [],
        checks: report?.checks ?? [],
        reasons: [...(discoverError ? [discoverError] : []), ...(report?.reasons ?? [])],
        authSources: report?.auth_sources ?? [],
      });
    }
    return out;
  }

  /**
   * Doctor-VERIFIED real harnesses only (`status === "ok"`). Degraded routes
   * (key present but unproven) are excluded — claims of "doctor-verified"
   * availability must never include them.
   */
  async doctorOkReal(
    spec: DoctorSpec = { cwd: process.cwd() },
    intent?: Intent,
  ): Promise<string[]> {
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
