import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

type JsonSchema = Record<string, any>;

function requiredFieldsPresent(value: unknown, schema: JsonSchema): boolean {
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0)
    return schema.anyOf.some((part: unknown) =>
      part && typeof part === "object" && !Array.isArray(part)
        ? requiredFieldsPresent(value, part as JsonSchema)
        : false,
    );
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
    return schema.oneOf.some((part: unknown) =>
      part && typeof part === "object" && !Array.isArray(part)
        ? requiredFieldsPresent(value, part as JsonSchema)
        : false,
    );
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((part: unknown) =>
      part && typeof part === "object" && !Array.isArray(part)
        ? requiredFieldsPresent(value, part as JsonSchema)
        : true,
    )
  )
    return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 0) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (!required.every((key: unknown) => typeof key === "string" && key in object)) return false;
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  return required.every((key: unknown) => {
    if (typeof key !== "string") return false;
    const child = properties[key];
    return !child || requiredFieldsPresent(object[key], child);
  });
}

function requiredFieldScore(schema: JsonSchema): number {
  const own = Array.isArray(schema.required) ? schema.required.length : 0;
  const nested = Object.values((schema.properties ?? {}) as Record<string, JsonSchema>).reduce(
    (total, child) => total + requiredFieldScore(child),
    0,
  );
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].reduce(
    (total: number, child: unknown) =>
      child && typeof child === "object" && !Array.isArray(child)
        ? Math.max(total, requiredFieldScore(child as JsonSchema))
        : total,
    0,
  );
  return own + nested + branches;
}

function isAccountsSnapshotBranch(schema: JsonSchema): boolean {
  return Array.isArray(schema.required) && schema.required.includes("harnesses");
}

function requiresResourcesBranch(schema: JsonSchema): boolean {
  const quota = (schema.properties ?? {}).quota as JsonSchema | undefined;
  return !!quota && Array.isArray(quota.required) && quota.required.includes("resources");
}

/** Project newer engine responses to the advertised MCP shape without
 * weakening validation or inventing missing required fields. */
export function projectAccountsStructuredContent(
  value: unknown,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const root = outputSchema as JsonSchema;
  if (Array.isArray(root.anyOf) && value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const isSnapshot = ["harnesses", "git", "quotaEventCursor"].some((key) => key in object);
    if (isSnapshot) {
      const snapshotBranches = root.anyOf.filter(
        (branch: unknown): branch is JsonSchema =>
          !!branch &&
          typeof branch === "object" &&
          !Array.isArray(branch) &&
          isAccountsSnapshotBranch(branch),
      );
      const hasResources =
        !!object.quota &&
        typeof object.quota === "object" &&
        !Array.isArray(object.quota) &&
        "resources" in (object.quota as Record<string, unknown>);
      const candidates = snapshotBranches.filter(
        (branch) => requiresResourcesBranch(branch) === hasResources,
      );
      if (!candidates.some((branch) => requiredFieldsPresent(value, branch))) return object;
      return projectAgainstSchema(value, { anyOf: candidates }) as Record<string, unknown>;
    }
  }
  return projectAgainstSchema(value, root) as Record<string, unknown>;
}

function projectAgainstSchema(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const candidates = schema.anyOf.filter(
      (candidate: unknown): candidate is JsonSchema =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate),
    );
    const selected = candidates
      .filter((candidate) => requiredFieldsPresent(value, candidate))
      .sort((a, b) => requiredFieldScore(b) - requiredFieldScore(a))[0];
    return selected ? projectAgainstSchema(value, selected) : value;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const selected = schema.oneOf.find(
      (candidate: unknown): candidate is JsonSchema =>
        !!candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        requiredFieldsPresent(value, candidate),
    );
    return selected ? projectAgainstSchema(value, selected) : value;
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce(
      (current: unknown, part: unknown) =>
        part && typeof part === "object" && !Array.isArray(part)
          ? projectAgainstSchema(current, part as JsonSchema)
          : current,
      value,
    );
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return schema.items && typeof schema.items === "object"
      ? value.map((item) => projectAgainstSchema(item, schema.items as JsonSchema))
      : value;
  }
  if (schema.type !== "object" || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const additional = schema.additionalProperties;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (properties[key]) out[key] = projectAgainstSchema(child, properties[key]);
    else if (additional && typeof additional === "object" && !Array.isArray(additional))
      out[key] = projectAgainstSchema(child, additional as JsonSchema);
    else if (additional === true) out[key] = child;
  }
  return out;
}

export function accountsTool(runner: RunnerFn, outputSchema: Record<string, unknown>): McpTool {
  return {
    name: "claudexor_accounts",
    description:
      "Return the read-only Accounts view: registered profiles, readiness, quota freshness, and routing identity. " +
      "accountPools.next_up is the configured default model's verdict, never a forecast for another model; routingEvidence carries model-scoped recent refusals, temporary per-model capability marks, and each account's last service per requested model (a routing observation, not a quota or authentication verdict). " +
      "Default combines current quota and registry facts with retained readiness observations: one coalesced cold acquisition, including failure, then passive reads with the original check time. Viewing does not renew old evidence; actual execution performs its own checks. " +
      "fresh:true requests the atomic snapshot instead — an EXPENSIVE explicit refresh (a live probe per registered profile, a full harness doctor sweep, and the vendor quota fan-out, which honors account/route rate-limit cooldowns and existing broad floors and discloses paused subjects in quota.refresh_skipped). " +
      "Use fresh:true only when acting on staleness matters; never poll with it. This tool never starts login or changes account state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fresh: {
          type: "boolean",
          description:
            "true = the expensive atomic Accounts snapshot (fresh probes + doctor + vendor quota fan-out); false/absent = current quota/registry facts with retained readiness observations and their age.",
        },
      },
    },
    outputSchema,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const result = await runner({
        mode: "__accounts",
        ...(args?.fresh === true ? { fresh: true } : {}),
      });
      const structured = projectAccountsStructuredContent(result, outputSchema);
      return {
        text: formatRunResult(result),
        structured,
      };
    },
  };
}
