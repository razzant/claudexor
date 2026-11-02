import agentCapabilityCatalogSchemaRaw from "@claudexor/schema/generated/AgentCapabilityCatalog.schema.json" with { type: "json" };
import accountsQuerySchemaRaw from "@claudexor/schema/generated/McpAccountsToolResult.schema.json" with { type: "json" };
import { accountResourceTools } from "./account-resource-tools.js";
import { accountsTool } from "./accounts-tool.js";
import { formatRunResult } from "./run-result-format.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import type { McpTool, RunnerFn } from "./index.js";

/** Existing read-only catalog registrations, kept together outside the run surface. */
export function catalogTools(runner: RunnerFn): McpTool[] {
  const handler = (mode: string) => async () => {
    const result = await runner({ mode });
    return {
      text: formatRunResult(result),
      structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
    };
  };
  return [
    {
      name: "claudexor_status",
      description:
        "Return doctor-backed Claudexor runtime status: per-harness verdicts with enabled/disabled intents, doctor reasons and checks, and the configured model.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true },
      handler: handler("__status"),
    },
    {
      name: "claudexor_capabilities",
      description:
        "Return the derived AgentCapabilityCatalog: per-harness doctor-backed capabilities (the daemon may answer from a recent composition; generatedAt dates it), canonical modes, the mutability matrix, run-control keys, CLI verbs, and the run-apply-state vocabulary.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: inlineJsonSchemaRefs(agentCapabilityCatalogSchemaRaw),
      annotations: { readOnlyHint: true },
      handler: handler("__capabilities"),
    },
    accountsTool(runner, inlineJsonSchemaRefs(accountsQuerySchemaRaw)),
    ...accountResourceTools(runner),
  ];
}
