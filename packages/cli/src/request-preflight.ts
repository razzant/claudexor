import { loadConfig } from "@claudexor/config";
import type { AdapterRegistry } from "@claudexor/core";
import type { ResourceStorePort } from "@claudexor/daemon";
import type { HarnessStatus } from "@claudexor/gateway";
import { RequestRequirementsResolver } from "@claudexor/orchestrator";
import {
  runStartRequiresGit,
  resolveRunAccess,
  runAccessStrategyViolation,
  runExecutionWorkspaceViolation,
  type AccessProfile,
  type ControlRunStartRequest,
  type GitCapability,
  type Intent,
} from "@claudexor/schema";
import { gitCapabilityProblem, probeGitCapability } from "@claudexor/workspace";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildGateway, buildRegistry } from "./registry.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

const modeIntent = {
  agent: "implement",
  ask: "explain",
  plan: "plan",
} as const satisfies Record<NonNullable<ControlRunStartRequest["mode"]>, Intent>;

interface RunRequirementsPreflightDependencies {
  statusAll?: (
    cwd: string,
  ) => Promise<Array<Pick<HarnessStatus, "id" | "status" | "enabledIntents">>>;
  registry?: AdapterRegistry;
  accessDefault?: (cwd: string) => AccessProfile;
  gitCapability?: () => Promise<GitCapability>;
  requiresGit?: (request: ControlRunStartRequest) => boolean;
}

export interface RunRequirementsPreflightPolicy {
  /** Thread turns defer Git to the durable daemon job; direct runs keep eager admission. */
  git?: "eager" | "durable_job";
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

/** Refuse requests that no selected lane can satisfy before a run or turn is created. */
export function createRunRequirementsPreflight(
  resources: Pick<ResourceStorePort, "resolve">,
  noProjectRoot: string,
  dependencies: RunRequirementsPreflightDependencies = {},
  policy: RunRequirementsPreflightPolicy = {},
): (request: ControlRunStartRequest) => Promise<void> {
  const requirements = new RequestRequirementsResolver();
  return async (request) => {
    const cwd = request.scope.kind === "project" ? request.scope.root : noProjectRoot;
    const access = resolveRunAccess(
      request,
      dependencies.accessDefault
        ? dependencies.accessDefault(cwd)
        : loadConfig(cwd).trust.access_default,
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
    const workspaceViolation = runExecutionWorkspaceViolation(request, access);
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
    if ((request.attachments?.length ?? 0) === 0 && request.browser !== true) return;
    const explicitPool = (request.harnesses?.length ?? 0) > 0;
    const intent = modeIntent[request.mode ?? "agent"];
    let harnessIds = request.harnesses ?? [];
    if (harnessIds.length === 0) {
      const statuses = dependencies.statusAll
        ? await dependencies.statusAll(cwd)
        : await buildGateway({ includeFakes: false }).statusAll({ cwd });
      harnessIds = statuses
        .filter((status) => status.status === "ok" && status.enabledIntents.includes(intent))
        .map((status) => status.id);
    }
    if (harnessIds.length === 0) {
      throw requestError(
        "no eligible harness lane can satisfy this request",
        400,
        "request_requirements_unavailable",
      );
    }

    const registry = dependencies.registry ?? buildRegistry({ includeFakes: true });
    const attachments = resources.resolve(request.attachments ?? []);
    const manifests = await Promise.all(
      harnessIds.map(async (harnessId) => {
        const adapter = registry.get(harnessId);
        if (!adapter)
          throw requestError(`unknown harness lane: ${harnessId}`, 400, "harness_unavailable");
        return { harnessId, manifest: await adapter.discover() };
      }),
    );
    const attachmentAdmission = requirements.resolveAttachmentPool(
      explicitPool ? "explicit" : "auto",
      attachments,
      manifests.map(({ harnessId, manifest }) => ({
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
      .map((harnessId) => manifests.find((entry) => entry.harnessId === harnessId))
      .filter((entry): entry is (typeof manifests)[number] => entry !== undefined);
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
