import { loadConfig } from "@claudexor/config";
import type { AdapterRegistry } from "@claudexor/core";
import type { ResourceStore } from "@claudexor/daemon";
import type { HarnessStatus } from "@claudexor/gateway";
import { RequestRequirementsResolver } from "@claudexor/orchestrator";
import type { AccessProfile, ControlRunStartRequest, Intent } from "@claudexor/schema";
import { buildGateway, buildRegistry } from "./registry.js";

const modeIntent = {
  agent: "implement",
  ask: "explain",
  plan: "plan",
  audit: "audit",
  orchestrate: "orchestrate",
} as const satisfies Record<NonNullable<ControlRunStartRequest["mode"]>, Intent>;

interface RunRequirementsPreflightDependencies {
  statusAll?: (
    cwd: string,
  ) => Promise<Array<Pick<HarnessStatus, "id" | "status" | "enabledIntents">>>;
  registry?: AdapterRegistry;
  accessDefault?: (cwd: string) => AccessProfile;
}

/** Refuse requests that no selected lane can satisfy before a run or turn is created. */
export function createRunRequirementsPreflight(
  resources: Pick<ResourceStore, "resolve">,
  noProjectRoot: string,
  dependencies: RunRequirementsPreflightDependencies = {},
): (request: ControlRunStartRequest) => Promise<void> {
  const requirements = new RequestRequirementsResolver();
  return async (request) => {
    if ((request.attachments?.length ?? 0) === 0 && request.browser !== true) return;
    const cwd = request.scope.kind === "project" ? request.scope.root : noProjectRoot;
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
    const compatibleManifests: typeof manifests = [];
    for (const { harnessId, manifest } of manifests) {
      const refusal = requirements.attachmentRefusal(
        harnessId,
        attachments,
        manifest.capability_profile.attachment_inputs,
      );
      if (refusal) {
        if (explicitPool) throw requestError(refusal, 400, "attachment_pool_unsupported");
        continue;
      }
      compatibleManifests.push({ harnessId, manifest });
    }
    if (compatibleManifests.length === 0) {
      throw requestError(
        "no eligible harness lane can receive every required attachment",
        400,
        "attachment_pool_unsupported",
      );
    }
    if (request.browser !== true) return;

    const access =
      intent === "implement"
        ? (request.access ??
          (dependencies.accessDefault
            ? dependencies.accessDefault(cwd)
            : loadConfig(cwd).trust.access_default))
        : "readonly";
    const resolutions = compatibleManifests.map(({ harnessId, manifest }) =>
      requirements.resolveBrowser({
        harnessId,
        requested: true,
        manifestCapable: manifest.capabilities.browser_tool,
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
