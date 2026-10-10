import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { estimateCodexCostUsd } from "./pricing.js";
import {
  type CodexRateLimitCursor,
  codexRateLimitCursor,
  codexTranscriptModel,
  codexTranscriptRateLimits,
} from "./transcript.js";

export type CodexEventDecoration = {
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  credentialRoute: NonNullable<HarnessEvent["credential_route"]>;
  credentialSource: NonNullable<HarnessEvent["credential_source"]>;
  tempCodexHome: string | null;
  model: string | null;
  nativeThreadId?: string;
  transcriptModel?: string;
  /** Where this run's rollout rate-limit reading left off. */
  rateLimits?: CodexRateLimitCursor;
};

export function decorateCodexEvent(
  event: HarnessEvent,
  context: CodexEventDecoration,
): HarnessEvent {
  const { spec } = context;
  const profile = spec.credential_profile;
  if (event.type === "started") {
    const nativeId = event.payload?.["native_session_id"];
    if (typeof nativeId === "string") context.nativeThreadId = nativeId;
  }
  if (spec.processing) {
    event.processing = spec.processing;
    event.processing_cost_basis = spec.processing_cost_basis;
  }
  if (event.type === "started" && spec.model_hint && !event.observed_model) {
    event.payload = {
      ...(event.payload ?? {}),
      requested_model: spec.model_hint,
      observed_model_source: "unobserved",
    };
  }
  event.credential_route = context.credentialRoute;
  event.credential_source = context.credentialSource;
  if (profile) event.credential_profile_id = profile.profile_id;
  if (!event.observed_model && spec.evidence_policy !== "stream_only") {
    context.transcriptModel ??=
      codexTranscriptModel(context.env["CODEX_HOME"], context.nativeThreadId) ?? undefined;
    if (context.transcriptModel) {
      event.observed_model = context.transcriptModel;
      event.payload = { ...(event.payload ?? {}), observed_model_source: "transcript" };
    }
  }
  if (
    event.type === "started" &&
    context.tempCodexHome &&
    event.payload &&
    "native_session_id" in event.payload
  ) {
    const { native_session_id: _dropped, ...rest } = event.payload as Record<string, unknown>;
    event.payload = { ...rest, resume_disabled: "ephemeral_codex_home" };
  }
  if (
    event.type === "usage" &&
    event.usage &&
    event.usage.cost_usd === undefined &&
    !spec.processing
  ) {
    const estimate = estimateCodexCostUsd(context.model, event.usage);
    if (estimate !== undefined) {
      event.usage.cost_usd = estimate;
      event.usage.estimated = true;
    }
  }
  if (event.type === "usage" && !event.quota && spec.evidence_policy !== "stream_only") {
    const quota = codexTranscriptRateLimits(
      context.env["CODEX_HOME"],
      context.nativeThreadId,
      (context.rateLimits ??= codexRateLimitCursor()),
    );
    if (quota) event.quota = quota;
  }
  if (event.quota && profile && event.quota.subject_id == null) {
    event.quota = { ...event.quota, subject_id: profile.profile_id };
  }
  return event;
}
