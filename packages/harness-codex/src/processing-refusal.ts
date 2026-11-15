import type { ControlProblem, ModelCallOptions, ProcessingReceipt } from "@claudexor/schema";

/** Only HTTP admission refusals prove this generation did not start. Never
 * call this for a failed stream or infer a refusal from vendor message text.
 * Flex's explicit resource_unavailable response is documented as uncharged:
 * https://developers.openai.com/api/docs/guides/flex-processing#resource-unavailable-errors */
export function processingAdmissionProblem(
  problem: ControlProblem,
  options: ModelCallOptions,
  submitted: ProcessingReceipt | undefined,
): ControlProblem {
  if (options.processingPreference === undefined || options.serviceTier !== undefined || !submitted)
    return problem;
  const { httpStatus, vendorCode, parameter } = problem.context;
  const refusal =
    httpStatus === 429 &&
    vendorCode === "resource_unavailable" &&
    submitted.submittedNative === "flex"
      ? "capacity"
      : httpStatus === 400 &&
          vendorCode === "unsupported_parameter" &&
          parameter === "service_tier" &&
          (submitted.submitted === "fast" ||
            submitted.submitted === "ultrafast" ||
            submitted.submittedNative === "flex")
        ? "unsupported"
        : null;
  if (refusal === null) return problem;
  return {
    ...problem,
    code: "processing_unavailable",
    context: {
      ...problem.context,
      generationStarted: false,
      processingFallback: "standard",
      processingRefusal: refusal,
    },
  };
}
