import paidBudgetSchemaRaw from "@claudexor/schema/generated/PaidBudget.schema.json" with { type: "json" };
import taskGroupIdSchemaRaw from "@claudexor/schema/generated/TaskGroupId.schema.json" with { type: "json" };
import {
  AccessProfile,
  ExternalContextPolicy,
  ProviderFamily,
  effortJsonSchema,
} from "@claudexor/schema";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { reviewerPanelEntrySchema } from "./reviewer-panel-schema.js";

const paidBudgetSchema = inlineJsonSchemaRefs(paidBudgetSchemaRaw);
const taskGroupIdSchema = inlineJsonSchemaRefs(taskGroupIdSchemaRaw);

/** Public one-shot metadata only; thread and Delegate declarations do not compose this. */
export function taskGroupProperties(): Record<string, unknown> {
  return { taskGroupId: taskGroupIdSchema };
}

/**
 * MCP shapes of the canonical per-run controls, one owner for every tool that
 * starts a run (launches and successors), so their names, enums and limits
 * cannot drift apart. Semantics stay with ControlRunStartRequest.
 */
export function externalContextProperties(): Record<string, unknown> {
  return {
    web: {
      type: "string",
      enum: ExternalContextPolicy.options,
      description: "External context policy for this run.",
    },
    externalContextPolicy: {
      type: "string",
      enum: ExternalContextPolicy.options,
      description: "Alias of web for control-api parity.",
    },
  };
}

/** The scalar effort as the engine applies it: to every harness lane of the
 * run (run-input-resolution.ts), never to a reviewer. */
export function scalarEffortProperty(): Record<string, unknown> {
  return effortJsonSchema(
    "Optional reasoning effort for every harness this run executes (not its reviewers), instead of each harness's Settings default.",
  );
}

/** Each lane runs at efforts[harness], else effort, else its Settings default. */
export function effortProperties(): Record<string, unknown> {
  return {
    effort: scalarEffortProperty(),
    efforts: {
      type: "object",
      propertyNames: { minLength: 1, pattern: "\\S" },
      additionalProperties: effortJsonSchema("Reasoning effort for this harness id."),
      description:
        "Optional harness-scoped effort map (harness id to effort); an entry wins over effort and that harness's Settings default. The engine refuses an unregistered harness id.",
    },
  };
}

export function accessAndLimitProperties(): Record<string, unknown> {
  return {
    paidBudget: paidBudgetSchema,
    credentialProfileId: {
      type: "string",
      minLength: 1,
      pattern: "\\S",
      description: "Strict credential profile for this run; never falls back to another account.",
    },
    access: {
      type: "string",
      enum: AccessProfile.options,
      description: "Optional access profile for this run.",
    },
    maxSeconds: {
      type: "integer",
      minimum: 1,
      maximum: 604800,
      description:
        "Initial run time limit in seconds. Explicit limits default to hard unless timeLimitMode is soft.",
    },
    timeLimitMode: {
      type: "string",
      enum: ["soft", "hard"],
      description: "With maxSeconds: soft warns and continues; hard cancels on expiry.",
    },
  };
}

export function reviewProperties(): Record<string, unknown> {
  const families = ProviderFamily.options;
  return {
    review: {
      type: "boolean",
      description:
        "Enable internal model review. Ordinary Agent defaults to false; true selects reviewers automatically. An explicit reviewer panel or reviewer overrides also enable review. Best-of and until-clean retain review.",
    },
    reviewerPanel: {
      type: "array",
      minItems: 1,
      description:
        "Enable review with explicit panel entries, preserving order and duplicates; no additional review flag is needed.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: reviewerPanelEntrySchema,
        required: ["harness"],
      },
    },
    reviewerModels: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        families.map((family) => [family, { type: "string", minLength: 1 }]),
      ),
      description: "Enable review with per-provider reviewer model overrides.",
    },
    reviewerEfforts: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        families.map((family) => [
          family,
          effortJsonSchema(`Reviewer effort for the ${family} family.`),
        ]),
      ),
      description: "Enable review with per-provider reviewer effort overrides.",
    },
  };
}
