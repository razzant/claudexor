import {
  AccessProfile,
  AgentCapabilityCatalog,
  ControlRunStartRequest,
  MODE_MUTABILITY,
  ModeKind,
  OUTPUT_SCHEMA_DIALECTS,
  RUN_START_CLIENT_REJECTED_KEYS,
  RunApplyState,
  WorkspaceMode,
  type CatalogHarness,
  type ControlHarnessModelsResponse,
} from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import { validateModel } from "@claudexor/core";
import { defaultClaudexorTools } from "@claudexor/mcp-server";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { CLI_COMMANDS } from "./command-registry.js";
import { buildGateway, harnessModels } from "./registry.js";

/** MCP tool names from the server's own descriptor producer (noop runner). */
export function mcpToolNames(): readonly string[] {
  return defaultClaudexorTools(async () => "").map((t) => t.name);
}

/** Sentinel for user-level probes with no project root (same as claudexord). */
const NO_PROJECT_ROOT = "/nonexistent-claudexor-project";

/**
 * Compose the AgentCapabilityCatalog from the existing truth producers:
 * gateway.statusAll (manifest + doctor), the model-truth service, the user
 * config (configured models), the CLI command registry, and the schema's own
 * closed vocabularies. Shared verbatim by the daemon's GET /agent-capabilities
 * service, the `claudexor capabilities` verb, and the MCP
 * `claudexor_capabilities` tool — three views, one composer.
 */
export async function buildAgentCapabilityCatalog(): Promise<AgentCapabilityCatalog> {
  const statuses = await buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT });
  const cfg = loadConfig(NO_PROJECT_ROOT);

  const harnesses: CatalogHarness[] = await Promise.all(
    statuses.map(async (s) => {
      // Model truth degrades soft: a catalog is a status surface, so an
      // unreachable vendor CLI yields source=none instead of throwing the
      // whole catalog away. The fallback is the full typed response shape.
      const truth: ControlHarnessModelsResponse = await harnessModels(
        s.id,
        NO_PROJECT_ROOT,
        false,
      ).catch((): ControlHarnessModelsResponse => ({
        harnessId: s.id,
        models: [],
        source: "none",
        verifiedAgainst: null,
      }));
      const configured = cfg.global.harnesses[s.id]?.default_model ?? null;
      const check = configured
        ? validateModel(
            configured,
            truth.models.map((m) => m.id),
            truth.source === "api" ? "api" : "manifest",
          )
        : null;
      const profile = s.manifest?.capability_profile;
      // Settings can disable a harness outright (harnesses.<id>.enabled=false);
      // routing drops it, so the catalog must not advertise it as available.
      const enabled = cfg.global.harnesses[s.id]?.enabled !== false;
      return {
        id: s.id,
        enabled,
        displayName: s.manifest?.display_name ?? s.id,
        status: s.status,
        providerFamily: s.manifest?.provider_family ?? "unknown",
        enabledIntents: [...s.enabledIntents],
        disabledIntents: [...s.disabledIntents],
        reasons: [...s.reasons],
        configuredModel: configured,
        configuredModelValid: check ? check.status === "ok" : null,
        models: {
          source: truth.source,
          count: truth.models.length,
          verifiedAgainst: truth.verifiedAgainst,
        },
        webPolicy: s.manifest?.capabilities.web_policy ?? "none",
        attachmentInputs: [...(profile?.attachment_inputs ?? [])],
        effortLevels: [...(s.manifest?.capabilities.effort_levels ?? [])],
        accessProfilesSupported: [...(s.manifest?.access_profiles_supported ?? [])],
        readonlyMechanism: profile?.access_control.readonly_mechanism ?? "none",
      };
    }),
  );

  // Run-control keys are DERIVED from the schema shape, minus the keys the
  // daemon rejects from direct clients (thread-turn pipeline internals) —
  // one shared list in @claudexor/schema keeps catalog and guards in lockstep.
  const rejected = new Set<string>(RUN_START_CLIENT_REJECTED_KEYS);
  const runControlKeys = Object.keys(ControlRunStartRequest.shape)
    .filter((k) => !rejected.has(k))
    .sort();

  return AgentCapabilityCatalog.parse({
    ok: true,
    version: CLAUDEXOR_VERSION,
    generatedAt: new Date().toISOString(),
    harnesses,
    availableHarnesses: harnesses.filter((h) => h.status === "ok" && h.enabled).map((h) => h.id),
    modes: [...ModeKind.options],
    runControlKeys,
    outputSchemaDialects: OUTPUT_SCHEMA_DIALECTS.map((dialect) => ({ ...dialect })),
    mutability: {
      readOnlyModes: ModeKind.options.filter((m) => MODE_MUTABILITY[m] === "read"),
      writeModes: ModeKind.options.filter((m) => MODE_MUTABILITY[m] === "write"),
      isolationKinds: ["envelope", "live"],
      workspaceModes: [...WorkspaceMode.options],
      accessProfiles: [...AccessProfile.options],
      applyModes: ["apply", "commit", "branch", "pr"],
    },
    cliCommands: CLI_COMMANDS.map((c) => ({
      id: c.id,
      mutability: c.mutability,
      stability: c.stability,
      recovery: c.recovery === true,
    })),
    mcpTools: [...mcpToolNames()],
    runApplyStates: [...RunApplyState.options],
  });
}
