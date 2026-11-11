import resourcesSchema from "@claudexor/schema/generated/ControlAccountResourcesResponse.schema.json" with { type: "json" };
import resetSchema from "@claudexor/schema/generated/ControlAccountResetResponse.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

export function accountResourceTools(runner: RunnerFn): McpTool[] {
  const target = {
    type: "object",
    additionalProperties: false,
    required: ["harness", "profile_id"],
    properties: {
      harness: { type: "string", minLength: 1 },
      profile_id: { type: "string", minLength: 1 },
    },
  };
  const handler = (mode: string) => async (args: Record<string, unknown>) => {
    const result = await runner({ ...args, mode });
    return {
      text: formatRunResult(result),
      structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
    };
  };
  return [
    {
      name: "claudexor_account_resources",
      description:
        "Read typed account balances, spending, reset offers and quota, plus API-key spending limits (each API-key harness's default key with target.profile_id null, and its enabled registered API-key accounts). refresh:true requests provider data; target selects one exact registered account, including a disabled portable profile. No login or spending-policy change.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { refresh: { type: "boolean" }, target, model: { type: "string" } },
      },
      outputSchema: inlineJsonSchemaRefs(resourcesSchema),
      annotations: { readOnlyHint: true },
      handler: handler("__account_resources"),
    },
    {
      name: "claudexor_account_reset",
      description:
        "Explicitly consume a selected account reset, outside inference capacity. Supply target, offer_id, optional grant_id and idempotency_key. Retain the original key and request after a timeout and repeat them to recover; never replace the key automatically. Or supply operation_id to read a receipt. Provider outcome and resource readback are separate; Claude already_used is not proof of this operation's success.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target,
          offer_id: { type: "string", minLength: 1 },
          grant_id: { type: "string", minLength: 1 },
          idempotency_key: { type: "string", minLength: 1 },
          operation_id: { type: "string", minLength: 1 },
        },
        oneOf: [
          {
            required: ["target", "offer_id", "idempotency_key"],
            not: { required: ["operation_id"] },
          },
          {
            required: ["operation_id"],
            not: {
              anyOf: [
                { required: ["target"] },
                { required: ["offer_id"] },
                { required: ["grant_id"] },
                { required: ["idempotency_key"] },
              ],
            },
          },
        ],
      },
      outputSchema: inlineJsonSchemaRefs(resetSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      handler: handler("__account_reset"),
    },
  ];
}
