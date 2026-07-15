import type {
  AccessProfile,
  Attachment,
  AttachmentInputClass,
  ExternalContextPolicy,
  ImplementationTransport,
  Intent,
  RequestRequirementResolution,
} from "@claudexor/schema";
import { HarnessUnavailableError } from "@claudexor/core";

export interface BrowserLaneRequirementInput {
  harnessId: string;
  requested: boolean;
  manifestCapable: boolean;
  webPolicy: ExternalContextPolicy;
  access: AccessProfile;
}

export class RequestRequirementsError extends HarnessUnavailableError {
  readonly code = "browser_unavailable";

  constructor(
    message: string,
    readonly resolutions: RequestRequirementResolution[],
  ) {
    super(message);
  }
}

/** One preflight owner for requested-vs-effective lane capability truth. */
export class RequestRequirementsResolver {
  /** Patch producers only read; the engine owns materialization and delivery. */
  adapterAccess(
    intent: Intent,
    implementationTransport: ImplementationTransport,
    requestedAccess: AccessProfile,
  ): AccessProfile {
    return implementationTransport === "git_patch_envelope" &&
      (intent === "implement" || intent === "synthesize")
      ? "readonly"
      : requestedAccess;
  }

  assertConvergenceWorkspace(
    inPlace: boolean,
    routes: { implementationTransport: ImplementationTransport }[],
  ): void {
    if (inPlace && routes.some((route) => route.implementationTransport === "git_patch_envelope")) {
      throw new HarnessUnavailableError(
        "in-place convergence is unavailable for git_patch_envelope adapters; use an isolated run or a single agent attempt",
      );
    }
  }

  attachmentRefusal(
    harnessId: string,
    attachments: Attachment[],
    declarations: AttachmentInputClass[],
  ): string | null {
    for (const attachment of attachments) {
      const declaration = declarations.find(
        (candidate) =>
          candidate.kind === attachment.kind && candidate.mime_types.includes(attachment.mime),
      );
      if (!declaration)
        return `${harnessId} cannot receive every mandatory attachment: ${attachment.kind} ${attachment.mime} is unsupported; choose a compatible harness pool or remove the attachment`;
      if (attachment.size_bytes > declaration.max_bytes)
        return `${harnessId} cannot receive every mandatory attachment: ${attachment.name || attachment.resource_id} is ${attachment.size_bytes} bytes (max ${declaration.max_bytes} for ${attachment.mime}); choose a compatible harness pool or remove the attachment`;
      const count = attachments.filter(
        (item) => item.kind === declaration.kind && declaration.mime_types.includes(item.mime),
      ).length;
      if (count > declaration.max_count)
        return `${harnessId} cannot receive every mandatory attachment: ${count} ${declaration.kind} attachments exceed max_count ${declaration.max_count}; choose a compatible harness pool or remove the attachment`;
    }
    return null;
  }

  browserSpec(
    resolution: RequestRequirementResolution,
    outputDir: string,
  ): { output_dir: string; headless: boolean } | null {
    return resolution.effective ? { output_dir: outputDir, headless: false } : null;
  }

  resolveBrowser(input: BrowserLaneRequirementInput): RequestRequirementResolution {
    const eligible = input.manifestCapable;
    if (!input.requested) {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible,
        requested: false,
        effective: false,
        reason: "not_requested",
        evidence_refs: ["request.browser"],
      };
    }
    if (!eligible) {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible: false,
        requested: true,
        effective: false,
        reason: "manifest_unsupported",
        evidence_refs: ["manifest.capabilities.browser_tool"],
      };
    }
    if (input.webPolicy === "off") {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible: true,
        requested: true,
        effective: false,
        reason: "web_policy_off",
        evidence_refs: ["request.external_context_policy"],
      };
    }
    if (input.access !== "full" && input.access !== "external_sandbox_full") {
      return {
        capability: "browser",
        harness_id: input.harnessId,
        eligible: true,
        requested: true,
        effective: false,
        reason: "access_profile_incompatible",
        evidence_refs: ["task.access.effective_profile"],
      };
    }
    return {
      capability: "browser",
      harness_id: input.harnessId,
      eligible: true,
      requested: true,
      effective: true,
      reason: "effective",
      evidence_refs: [
        "manifest.capabilities.browser_tool",
        "request.external_context_policy",
        "task.access.effective_profile",
      ],
    };
  }

  requireEffectiveBrowser(requested: boolean, resolutions: RequestRequirementResolution[]): void {
    if (!requested || resolutions.some((resolution) => resolution.effective)) return;
    const detail = resolutions
      .map((resolution) => `${resolution.harness_id}: ${resolution.reason}`)
      .join("; ");
    throw new RequestRequirementsError(
      `browser was requested but no selected harness lane can receive it${detail ? ` (${detail})` : ""}; choose a browser-capable lane with web enabled and full access`,
      resolutions,
    );
  }
}
