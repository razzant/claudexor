import type { AdapterRegistry } from "@claudexor/core";
import type { ControlHarnessModelsResponse } from "@claudexor/schema";
import { HarnessGateway } from "@claudexor/gateway";
import { createClaudeAdapter } from "@claudexor/harness-claude";
import { createCodexAdapter } from "@claudexor/harness-codex";
import { createCursorAdapter } from "@claudexor/harness-cursor";
import { FAKE_KINDS, createFakeHarness } from "@claudexor/harness-fake";
import { createOpenCodeAdapter } from "@claudexor/harness-opencode";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";

export interface RegistryOptions {
  /** Register the fake-harness suite (so `--harness fake-*` works). Default true. */
  includeFakes?: boolean;
}

/**
 * Build the adapter registry. All five real adapters are always registered;
 * the gateway only selects doctor-OK non-fake harnesses by default. Fakes are
 * registered for explicit `--harness`. An `openrouter` raw-API instance is the
 * direct-API path for arbitrary models (orchestrate/review) when its key exists.
 */
export function buildRegistry(opts: RegistryOptions = {}): AdapterRegistry {
  const registry: AdapterRegistry = new Map();
  for (const adapter of [
    createCodexAdapter(),
    createClaudeAdapter(),
    createCursorAdapter(),
    createOpenCodeAdapter(),
    createRawApiAdapter(),
    createRawApiAdapter({
      id: "openrouter",
      providerFamily: "unknown",
      baseUrl: process.env.CLAUDEXOR_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY",
      defaultModel: process.env.CLAUDEXOR_OPENROUTER_MODEL ?? "openai/gpt-5.5",
    }),
  ]) {
    registry.set(adapter.id, adapter);
  }
  if (opts.includeFakes !== false) {
    for (const kind of FAKE_KINDS) registry.set(kind, createFakeHarness(kind));
  }
  return registry;
}

export function buildGateway(opts: RegistryOptions = {}): HarnessGateway {
  return new HarnessGateway(buildRegistry(opts));
}

/**
 * Resolve enumerable models for one harness (ADP4). The SSOT shared by the
 * control-api `harnessModels` service and the CLI `models` command, so both
 * surfaces report identical truth: `source: "api"` when the adapter has a real
 * models() producer, `"manifest"` when the manifest's known-good hint set is
 * the truth source (with the CLI version it was verified against), `"none"`
 * only when the harness has no truth source at all. Fails soft — adapter
 * models() already swallows network/auth errors and returns [].
 */
export async function harnessModels(harnessId: string, cwd: string, includeFakes = false): Promise<ControlHarnessModelsResponse> {
  const adapter = buildRegistry({ includeFakes }).get(harnessId);
  if (!adapter) {
    return { harnessId, models: [], source: "none", verifiedAgainst: null };
  }
  if (typeof adapter.models === "function") {
    const models = await adapter.models({ cwd });
    return { harnessId, models, source: "api", verifiedAgainst: null };
  }
  const manifest = await adapter.discover();
  const known = manifest.capabilities.known_models;
  if (known.length === 0) {
    return { harnessId, models: [], source: "none", verifiedAgainst: null };
  }
  return {
    harnessId,
    models: known.map((id) => ({ id, label: null, context_window: null })),
    source: "manifest",
    verifiedAgainst: manifest.capabilities.known_models_verified_against,
  };
}
