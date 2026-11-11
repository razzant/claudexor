import { describe, expect, it } from "vitest";
import { codexCapabilityRefusal } from "./model-capability-refusal.js";
import { providerProblem } from "./responses.js";

const exact = (model: string) =>
  `The '${model}' model is not supported when using Codex with a ChatGPT account.`;
function classify(body: unknown, status = 400, model = "gpt-6.1-sol") {
  return codexCapabilityRefusal(providerProblem(status, body), status, body, model);
}
describe("pre-generation Codex capability refusal", () => {
  it.each(["gpt-6.1-sol", "gpt-6-astra"])(
    "classifies the exact %s refusal without code/type",
    (model) => {
      expect(classify({ detail: exact(model) }, 400, model)).toMatchObject({
        code: "model_capability_refused",
        retryable: false,
        context: {
          requestedModel: model,
          generationStarted: false,
          retryOnOtherAccount: false,
          capabilityEvidence: "provider_text",
          capabilityKind: "model_not_supported",
          providerReason: exact(model),
        },
      });
    },
  );
  it.each([
    { error: { code: "model_not_found", message: "No access" } },
    {
      error: {
        type: "invalid_request_error",
        message: "The model `gpt-6.1-sol` does not exist or you do not have access to it.",
      },
    },
    { error: { type: "invalid_request_error", message: exact("gpt-6.1-sol") } },
  ])("classifies an explicit model refusal %j", (body) => {
    expect(classify(body, 404).code).toBe("model_capability_refused");
  });
  it.each([
    { error: { code: "unsupported_parameter", message: exact("gpt-6.1-sol") } },
    { error: { code: "context_length_exceeded", message: "Context too long" } },
    { error: { message: "Malformed input" } },
    { error: { param: "temperature", message: exact("gpt-6.1-sol") } },
    { error: { message: exact("other-model") } },
    { error: { message: "The model failed to parse this request" } },
    { error: { code: "usage_limit_reached", message: exact("gpt-6.1-sol") } },
  ])("preserves non-capability classification %j", (body) => {
    expect(classify(body)).toEqual(providerProblem(400, body));
  });
  it.each([401, 403, 429, 500, 200])("does not reinterpret status %i", (status) => {
    const body = { error: { code: "model_not_found", message: exact("gpt-6.1-sol") } };
    expect(classify(body, status)).toEqual(providerProblem(status, body));
  });
  it("redacts credentials from provider reason text", () => {
    // Like util's redaction fixtures, assemble the credential only at runtime.
    const token = "d".repeat(40);
    const result = classify({
      error: {
        code: "model_not_found",
        message: "No model; Bearer " + token,
      },
    });
    expect(result.context.providerReason).not.toContain(token);
    expect(result.context.providerReason).toContain("[redacted]");
  });
});
