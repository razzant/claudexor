import { loadConfig } from "@claudexor/config";
import {
  HarnessUnavailableError,
  credentialProfilePolicyProblem,
  credentialProfilePolicyState,
  type AdapterRegistry,
} from "@claudexor/core";
import type { ProjectControlPort, ResourceStorePort } from "@claudexor/daemon";
import type { HarnessStatus } from "@claudexor/gateway";
import {
  RequestRequirementsResolver,
  effectiveHarnessPool,
  resolveCandidateHarnessIds,
  resolveCredentialProfile,
} from "@claudexor/orchestrator";
import {
  runStartRequiresGit,
  resolveRunAccess,
  runAccessStrategyViolation,
  runAuxiliaryWritableRootsViolation,
  runExecutionWorkspaceViolation,
  type AccessProfile,
  type ControlRunStartRequest,
  type GitCapability,
  type Intent,
} from "@claudexor/schema";
import { gitCapabilityProblem, probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildGateway, buildRegistry } from "./registry.js";
import { runCredentialProfileId } from "./run-credential-profile.js";
import { threadRunStartRequiresGit } from "./thread-execution-workspace.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

const modeIntent = {
  agent: "implement",
  ask: "explain",
  plan: "plan",
} as const satisfies Record<NonNullable<ControlRunStartRequest["mode"]>, Intent>;

type HarnessStatusProjection = Pick<HarnessStatus, "id" | "status" | "enabledIntents"> &
  Partial<Pick<HarnessStatus, "manifest">>;

interface RunRequirementsPreflightDependencies {
  config?: typeof loadConfig;
  statusAll?: (cwd: string, harnessIds?: string[]) => Promise<HarnessStatusProjection[]>;
  registry?: AdapterRegistry;
  accessDefault?: (cwd: string) => AccessProfile;
  gitCapability?: () => Promise<GitCapability>;
  requiresGit?: (request: ControlRunStartRequest) => boolean;
  threadProfileId?: (threadId: string) => string | null;
}

export interface RunRequirementsPreflightPolicy {
  /** Thread turns defer Git to the durable daemon job; direct runs keep eager admission. */
  git?: "eager" | "durable_job";
}

/** Direct runs, Exact Retry and thread turns read an omitted pin from the same thread. */
export function createThreadAwareRunRequirementsPreflights(
  resources: Pick<ResourceStorePort, "resolve">,
  noProjectRoot: string,
  threads: Pick<ProjectControlPort, "getThread">,
) {
  const dependencies: RunRequirementsPreflightDependencies = {
    threadProfileId: (id) => threads.getThread(id)?.credential_profile_id ?? null,
    requiresGit: (request) => {
      const root = request.scope.kind === "project" ? request.scope.root : noProjectRoot;
      const config = loadConfig(root);
      return threadRunStartRequiresGit(
        request,
        request.threadId ? threads.getThread(request.threadId) : undefined,
        config.project.constraints.protected_paths,
        config.trust.access_default,
      );
    },
  };
  return {
    preflightRunRequirements: createRunRequirementsPreflight(
      resources,
      noProjectRoot,
      dependencies,
    ),
    preflightThreadRunRequirements: createRunRequirementsPreflight(
      resources,
      noProjectRoot,
      dependencies,
      { git: "durable_job" },
    ),
  };
}

/** Canonical Git admission used both eagerly by direct runs and immediately
 * pre-provider by durable thread jobs. */
export async function preflightRunGitRequirement(
  request: ControlRunStartRequest,
  dependencies: Pick<
    RunRequirementsPreflightDependencies,
    "accessDefault" | "gitCapability" | "requiresGit"
  > = {},
): Promise<void> {
  const requiresGit = dependencies.requiresGit
    ? dependencies.requiresGit(request)
    : runStartRequiresGit(request, {
        accessDefault: dependencies.accessDefault?.(
          request.scope.kind === "project" ? request.scope.root : NO_PROJECT_ROOT,
        ),
      });
  if (!requiresGit) return;
  const git = await (dependencies.gitCapability ?? probeGitCapability)();
  const blocker = gitCapabilityProblem(git);
  if (!blocker) return;
  throw Object.assign(new Error(blocker.reason), {
    status: 503,
    code: blocker.code,
    retryable: true,
    requiredActions: [blocker.remediation ?? "Install Git and retry."],
    context: {
      capability: "git",
      capabilityStatus: git.status,
    },
  });
}

/** Refuse requests that no selected lane can satisfy before a run or turn is created.
 * `heldBy`: the accepted owner reading its own refs (an accepted turn's first dispatch). */
export function createRunRequirementsPreflight(
  resources: Pick<ResourceStorePort, "resolve">,
  noProjectRoot: string,
  dependencies: RunRequirementsPreflightDependencies = {},
  policy: RunRequirementsPreflightPolicy = {},
): (
  request: ControlRunStartRequest,
  heldBy?: Parameters<ResourceStorePort["resolve"]>[1],
) => Promise<void> {
  const requirements = new RequestRequirementsResolver();
  return async (request, heldBy) => {
    const cwd = request.scope.kind === "project" ? request.scope.root : noProjectRoot;
    const access = resolveRunAccess(
      request,
      dependencies.accessDefault
        ? dependencies.accessDefault(cwd)
        : (dependencies.config ?? loadConfig)(cwd).trust.access_default,
    ).effective;
    const accessStrategyViolation = runAccessStrategyViolation(request, access);
    if (accessStrategyViolation) {
      throw Object.assign(
        requestError(accessStrategyViolation.message, 400, accessStrategyViolation.code),
        {
          retryable: accessStrategyViolation.retryable,
          requiredActions: [...accessStrategyViolation.requiredActions],
        },
      );
    }
    const workspaceViolation =
      runExecutionWorkspaceViolation(request, access) ??
      runAuxiliaryWritableRootsViolation(request, access);
    if (workspaceViolation) {
      throw Object.assign(requestError(workspaceViolation.message, 400, workspaceViolation.code), {
        retryable: workspaceViolation.retryable,
        requiredActions: [...workspaceViolation.requiredActions],
      });
    }
    if ((policy.git ?? "eager") === "eager") {
      await preflightRunGitRequirement(request, {
        ...dependencies,
        requiresGit:
          dependencies.requiresGit ??
          ((candidate) => runStartRequiresGit(candidate, { effectiveAccess: access })),
      });
    }
    const hasAuxiliaryRoots = (request.execution.auxiliaryWritableRoots?.length ?? 0) > 0;
    const needsManifests = (request.attachments?.length ?? 0) > 0 || request.browser === true;
    if (!hasAuxiliaryRoots && !needsManifests) return;
    const config = (dependencies.config ?? loadConfig)(cwd).global;
    // Execution's pool: the request's (a thread turn carries its sticky pool),
    // else Settings; either is strict. Only Auto membership reads host status.
    const pool = effectiveHarnessPool(request.harnesses, config.routing.eligible_harnesses);
    const explicitPool = (pool?.length ?? 0) > 0;
    const intent = modeIntent[request.mode ?? "agent"];
    const profileId = runCredentialProfileId(request, dependencies.threadProfileId ?? (() => null));
    const registry = dependencies.registry ?? buildRegistry({ includeFakes: true });
    const candidateIds = (statuses: HarnessStatusProjection[]) => {
      try {
        return resolveCandidateHarnessIds({
          harnesses: pool,
          credentialProfileId: profileId,
          config,
          registry,
          statuses,
          intent,
        });
      } catch (error) {
        if (error instanceof HarnessUnavailableError)
          throw requestError(error.message, 400, "harness_unavailable");
        throw error;
      }
    };
    const auxiliaryCapable = (id: string) =>
      registry.get(id)?.capabilityProfile?.access_control.auxiliary_writable_roots === true;
    const autoIds = [...registry.keys()].filter((id) => config.harnesses[id]?.enabled !== false);
    // Auxiliary roots are static adapter facts. Drop incompatible Auto lanes
    // before discovery and profile cardinality; pools and pins remain strict.
    if (hasAuxiliaryRoots) {
      const selectedIds = explicitPool ? pool! : profileId ? candidateIds([]) : [];
      for (const id of selectedIds) {
        if (!registry.get(id))
          throw requestError(`unknown harness lane: ${id}`, 400, "harness_unavailable");
        if (!auxiliaryCapable(id))
          throw auxiliaryUnsupported(`${id} cannot apply execution.auxiliaryWritableRoots`);
      }
      if (selectedIds.length === 0 && !autoIds.some(auxiliaryCapable))
        throw auxiliaryUnsupported(
          "no installed harness can apply execution.auxiliaryWritableRoots",
        );
    }
    if (!needsManifests) return;
    const probeIds = explicitPool
      ? []
      : autoIds.filter((id) => !hasAuxiliaryRoots || auxiliaryCapable(id));
    const statuses =
      probeIds.length === 0
        ? []
        : dependencies.statusAll
          ? await dependencies.statusAll(cwd, probeIds)
          : await buildGateway({ includeFakes: false }).statusAll({ cwd }, probeIds);
    const harnessIds = candidateIds(statuses);

    // Static lane facts only: account readiness, quota and model admission
    // stay with execution, which checks them before any provider starts.
    const attachments = resources.resolve(request.attachments ?? [], heldBy);
    const refusals: Error[] = [];
    const manifests = await Promise.all(
      harnessIds.map(async (harnessId) => {
        const adapter = registry.get(harnessId);
        if (!adapter)
          throw requestError(`unknown harness lane: ${harnessId}`, 400, "harness_unavailable");
        if (config.harnesses[harnessId]?.enabled === false)
          throw requestError(`${harnessId} is disabled in settings`, 400, "harness_unavailable");
        if (profileId) {
          // A pin binds every lane; it is refused, never substituted.
          try {
            resolveCredentialProfile(config.credential_profiles, profileId, harnessId);
          } catch (error) {
            throw requestError(
              `${harnessId}: ${error instanceof Error ? error.message : String(error)}`,
              400,
              "harness_unavailable",
            );
          }
        }
        // A null Auto manifest is the gateway's own failed discovery.
        const status = statuses.find((entry) => entry.id === harnessId);
        let manifest: HarnessStatus["manifest"] = null;
        if (status?.manifest !== null) {
          try {
            manifest = status?.manifest ?? (await adapter.discover());
          } catch {
            manifest = null;
          }
        }
        if (!manifest) {
          const refusal = requestError(
            `${harnessId} is unavailable (discovery failed)`,
            400,
            "harness_unavailable",
          );
          if (explicitPool) throw refusal;
          refusals.push(refusal);
          return null;
        }
        return { harnessId, manifest };
      }),
    );
    const eligibleManifests = manifests.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
    if (eligibleManifests.length === 0)
      throw (
        refusals[0] ??
        requestError(
          "no eligible harness lane can satisfy this request",
          400,
          "request_requirements_unavailable",
        )
      );
    const attachmentAdmission = requirements.resolveAttachmentPool(
      explicitPool ? "explicit" : "auto",
      attachments,
      eligibleManifests.map(({ harnessId, manifest }) => ({
        harnessId,
        declarations: manifest.capability_profile.attachment_inputs,
        available: true,
      })),
    );
    if (attachmentAdmission.outcome === "refused") {
      throw requestError(
        attachmentAdmission.message ??
          "no eligible harness lane can receive every required attachment",
        400,
        "attachment_pool_unsupported",
      );
    }
    const compatibleManifests = attachmentAdmission.admittedHarnessIds
      .map((harnessId) => eligibleManifests.find((entry) => entry.harnessId === harnessId))
      .filter((entry): entry is (typeof eligibleManifests)[number] => entry !== undefined);
    // Like execution, validate profile cardinality only after Auto has dropped
    // lanes incompatible with auxiliary roots or mandatory attachments. Explicit pools remain
    // strict: resolveAttachmentPool above refuses any incompatible selected lane.
    for (const { harnessId } of compatibleManifests) {
      const cardinality = credentialProfilePolicyState({
        adapter: registry.get(harnessId),
        registry: config.credential_profiles,
      });
      if (cardinality.ambiguous)
        throw credentialProfilePolicyProblem(cardinality, "credential_profile_ambiguous");
    }
    if (request.browser !== true) return;

    const resolutions = compatibleManifests.map(({ harnessId, manifest }) =>
      requirements.resolveBrowser({
        harnessId,
        requested: true,
        manifestCapable: manifest.capabilities.browser_tool,
        requiresFullAccess: manifest.capability_profile.mcp_injection_requires_full_access,
        webPolicy: request.externalContextPolicy ?? request.web ?? "auto",
        access,
      }),
    );
    try {
      requirements.requireEffectiveBrowser(true, resolutions);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        status: 400,
      });
    }
  };
}

function requestError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function auxiliaryUnsupported(message: string): Error {
  return Object.assign(requestError(message, 400, "auxiliary_writable_roots_unsupported"), {
    retryable: false,
    requiredActions: [
      "Select a harness whose catalog row declares accessControl.auxiliaryWritableRoots, or omit execution.auxiliaryWritableRoots. For continueFrom, replace the complete execution group through POST /v2/runs (auxiliaryWritableRoots: [] clears it), or start a new run; claudexor_run_continue inherits execution.",
    ],
  });
}
