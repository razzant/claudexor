import {
  AccessProfile,
  AgentCapabilityCatalog,
  ControlRunStartRequest,
  MODE_MUTABILITY,
  ModeKind,
  OUTPUT_SCHEMA_DIALECTS,
  RUN_START_CLIENT_REJECTED_KEYS,
  RunApplyState,
  RunDecisionAction,
  WorkspaceMode,
  WorkspaceKind,
  type CatalogHarness,
  type ControlHarnessModelsResponse,
  type HarnessCapabilityProfile,
} from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import { validateModel } from "@claudexor/core";
import { defaultClaudexorTools } from "@claudexor/mcp-server";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { CLI_COMMANDS } from "./command-registry.js";
import {
  buildGateway,
  buildRegistry,
  checkHarnessModelTruth,
  harnessModelTruth,
} from "./registry.js";
import { delegationCapabilityFor } from "./delegation-capability.js";
import { probeGitCapability } from "@claudexor/workspace";
import { effectiveSetupLoginCapability } from "./setup-login-capability.js";
import { catalogInputLimits } from "@claudexor/orchestrator";

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
/** The negotiated access-control row: capability-profile facts, never a harness name. */
export function catalogAccessControl(
  profile: HarnessCapabilityProfile | undefined,
): CatalogHarness["accessControl"] {
  return { auxiliaryWritableRoots: profile?.access_control.auxiliary_writable_roots ?? false };
}

export async function buildAgentCapabilityCatalog(): Promise<AgentCapabilityCatalog> {
  const [statuses, git] = await Promise.all([
    buildGateway({ includeFakes: false }).statusAll({ cwd: NO_PROJECT_ROOT }),
    probeGitCapability(),
  ]);
  const cfg = loadConfig(NO_PROJECT_ROOT);
  const adapters = buildRegistry({ includeFakes: false });

  const harnesses: CatalogHarness[] = await Promise.all(
    statuses.map(async (s) => {
      // Model truth degrades soft: a catalog is a status surface, so an
      // unreachable vendor CLI yields source=none instead of throwing the
      // whole catalog away. The fallback is the full typed response shape.
      const configured = cfg.global.harnesses[s.id]?.default_model ?? null;
      // One truth read serves the catalog's model summary and the
      // configured-model verdict, which honours the harness's own absence
      // declaration (INV-104) through the shared registry gate.
      const { truth, check } = await harnessModelTruth(s.id, NO_PROJECT_ROOT, false)
        .then((read) => ({
          truth: read.response,
          check: configured ? checkHarnessModelTruth(read, configured) : null,
        }))
        .catch(() => ({
          truth: {
            harnessId: s.id,
            models: [],
            source: "none",
            verifiedAgainst: null,
            sourceProgram: null,
          } satisfies ControlHarnessModelsResponse,
          // An unreachable vendor CLI verifies nothing: the stored model is
          // reported invalid exactly as before, never admitted on a guess.
          check: configured ? validateModel(configured, [], "manifest", "authoritative") : null,
        }));
      const profile = s.manifest?.capability_profile;
      // Settings can disable a harness outright (harnesses.<id>.enabled=false);
      // routing drops it, so the catalog must not advertise it as available.
      const enabled = cfg.global.harnesses[s.id]?.enabled !== false;
      return {
        id: s.id,
        ...(profile?.input_limits ? { inputLimits: catalogInputLimits(profile.input_limits) } : {}),
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
          ...("problem" in truth && truth.problem ? { problem: truth.problem } : {}),
        },
        webPolicy: s.manifest?.capabilities.web_policy ?? "none",
        attachmentInputs: [...(profile?.attachment_inputs ?? [])],
        effortLevels: [...(s.manifest?.capabilities.effort_levels ?? [])],
        processingPreferences: [...(s.manifest?.capabilities.processing_preferences ?? [])],
        promptCacheTtls: [...(profile?.prompt_cache_ttls ?? [])],
        accountCatalog: true,
        accessProfilesSupported: [...(s.manifest?.access_profiles_supported ?? [])],
        readonlyMechanism: profile?.access_control.readonly_mechanism ?? "none",
        writeMechanism: profile?.access_control.write_mechanism ?? "none",
        accessControl: catalogAccessControl(profile),
        delegation: delegationCapabilityFor(s.manifest),
        liveInput: profile?.live_input ?? "none",
        setupLogin: await effectiveSetupLoginCapability(s.id, {
          getAdapter: (id) => adapters.get(id),
        }),
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
    git,
    harnesses,
    availableHarnesses: harnesses.filter((h) => h.status === "ok" && h.enabled).map((h) => h.id),
    modes: [...ModeKind.options],
    runControlKeys,
    runDecisionActions: [...RunDecisionAction.options],
    outputSchemaDialects: OUTPUT_SCHEMA_DIALECTS.map((dialect) => ({ ...dialect })),
    mutability: {
      workspaceKinds: [...WorkspaceKind.options],
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
