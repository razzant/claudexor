import type { ControlProblem } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

/** Only a non-success inference HTTP response can certify no generation. Stream
 * errors, malformed parameters and transport uncertainty never enter this lane. */
export function codexCapabilityRefusal(
  problem: ControlProblem,
  status: number,
  value: unknown,
  requestedModel: string,
): ControlProblem {
  if (![400, 404].includes(status)) return problem;
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const error =
    body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : body;
  const code = typeof error.code === "string" ? error.code : null;
  const type = typeof error.type === "string" ? error.type : null;
  const reason =
    typeof error.message === "string"
      ? error.message
      : typeof error.detail === "string"
        ? error.detail
        : "";
  if (error.param && error.param !== "model") return problem;
  if (
    code &&
    ![
      "model_not_found",
      "model_not_supported",
      "invalid_request",
      "invalid_request_error",
    ].includes(code)
  )
    return problem;
  if (
    !code &&
    type &&
    ![
      "model_not_found",
      "model_not_supported",
      "invalid_request",
      "invalid_request_error",
    ].includes(type)
  )
    return problem;
  const vendorCode = code ?? type;
  const explicit = vendorCode === "model_not_found" || vendorCode === "model_not_supported";
  const exact =
    reason ===
    `The '${requestedModel}' model is not supported when using Codex with a ChatGPT account.`;
  const missing =
    /^(?:The )?model [`'"]([^`'"]+)[`'"] (?:does not exist(?: or you do not have access to it)?|was not found|is not found)\.?$/i.exec(
      reason,
    );
  if (!explicit && !exact && missing?.[1] !== requestedModel) return problem;
  const kind =
    exact || vendorCode === "model_not_supported" ? "model_not_supported" : "model_not_found";
  return {
    ...problem,
    code: "model_capability_refused",
    message: "The selected Codex account refused the requested model before generation.",
    retryable: false,
    context: {
      ...problem.context,
      requestedModel,
      generationStarted: false,
      retryOnOtherAccount: false,
      capabilityKind: kind,
      capabilityEvidence: explicit ? "provider_code" : "provider_text",
      providerReason: redactSecrets(reason || vendorCode || kind)
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .slice(0, 1024),
    },
  };
}
