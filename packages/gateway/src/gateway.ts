import type { HarnessManifest, Intent } from "@claudex/schema";
import type { AdapterRegistry, DoctorSpec, HarnessAdapter } from "@claudex/core";
import { HarnessUnavailableError, runDoctor } from "@claudex/core";
import { allowedIntents } from "./gating.js";

export interface HarnessStatus {
  id: string;
  available: boolean;
  status: "ok" | "degraded" | "unavailable";
  manifest: HarnessManifest | null;
  enabledIntents: Intent[];
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
    const out: HarnessStatus[] = [];
    for (const adapter of this.registry.values()) {
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
        reasons: report?.reasons ?? [],
      });
    }
    return out;
  }

  async resolve(requestedId?: string): Promise<HarnessAdapter> {
    if (requestedId) {
      const adapter = this.registry.get(requestedId);
      if (!adapter) throw new HarnessUnavailableError(`Harness not registered: ${requestedId}`);
      return adapter;
    }
    for (const adapter of this.registry.values()) {
      let manifest: HarnessManifest | null = null;
      try {
        manifest = await adapter.discover();
      } catch {
        continue;
      }
      if (manifest.kind === "fake") continue;
      return adapter;
    }
    throw new HarnessUnavailableError(
      "No available harness. Install codex/claude/cursor/opencode, or pass --harness fake-success.",
    );
  }

  async availableReal(): Promise<string[]> {
    const ids: string[] = [];
    for (const adapter of this.registry.values()) {
      try {
        const manifest = await adapter.discover();
        if (manifest.kind !== "fake") ids.push(adapter.id);
      } catch {
        /* unavailable */
      }
    }
    return ids;
  }
}
