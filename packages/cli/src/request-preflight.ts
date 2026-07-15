import type { ResourceStore } from "@claudexor/daemon";
import { RequestRequirementsResolver } from "@claudexor/orchestrator";
import type { ControlRunStartRequest, Intent } from "@claudexor/schema";
import { buildGateway, buildRegistry } from "./registry.js";

const modeIntent = {
  agent: "implement",
  ask: "explain",
  plan: "plan",
  audit: "audit",
  orchestrate: "orchestrate",
} as const satisfies Record<NonNullable<ControlRunStartRequest["mode"]>, Intent>;

/** Refuse requests that no selected lane can satisfy before a run or turn is created. */
export function createRunRequirementsPreflight(
  resources: Pick<ResourceStore, "resolve">,
  noProjectRoot: string,
): (request: ControlRunStartRequest) => Promise<void> {
  const requirements = new RequestRequirementsResolver();
  return async (request) => {
    if ((request.attachments?.length ?? 0) === 0 && request.browser !== true) return;
    const cwd = request.scope.kind === "project" ? request.scope.root : noProjectRoot;
    let harnessIds = request.harnesses ?? [];
    if (harnessIds.length === 0) {
      const statuses = await buildGateway({ includeFakes: false }).statusAll({ cwd });
      const intent = modeIntent[request.mode ?? "agent"];
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

    const registry = buildRegistry({ includeFakes: true });
    const attachments = resources.resolve(request.attachments ?? []);
    const manifests = await Promise.all(
      harnessIds.map(async (harnessId) => {
        const adapter = registry.get(harnessId);
        if (!adapter)
          throw requestError(`unknown harness lane: ${harnessId}`, 400, "harness_unavailable");
        return { harnessId, manifest: await adapter.discover() };
      }),
    );
    for (const { harnessId, manifest } of manifests) {
      const refusal = requirements.attachmentRefusal(
        harnessId,
        attachments,
        manifest.capability_profile.attachment_inputs,
      );
      if (refusal) throw requestError(refusal, 400, "attachment_pool_unsupported");
    }
    if (request.browser !== true) return;

    const resolutions = manifests.map(({ harnessId, manifest }) =>
      requirements.resolveBrowser({
        harnessId,
        requested: true,
        manifestCapable: manifest.capabilities.browser_tool,
        webPolicy: request.externalContextPolicy ?? request.web ?? "auto",
        access: request.access ?? "workspace_write",
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
