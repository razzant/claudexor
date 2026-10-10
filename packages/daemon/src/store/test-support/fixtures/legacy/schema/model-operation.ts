import { EffortResolution } from "./effort.js";
import { HarnessCapabilities } from "./harness.js";
import { z } from "zod/v3";
import { CostEvidence } from "./budget.js";
import { CostKnowledge } from "./auth.js";
import { CANCEL_REASON_CODES } from "./cancel-reason.js";
import { Id, IsoTimestamp, NonBlankString } from "./primitives.js";
import { ControlProblem } from "./problem.js";
import { RunLifecycle } from "./status-projection.js";
import { TokenUsage } from "./telemetry.js";
import { ProcessingCapability, ProcessingPreference, ProcessingReceipt } from "./processing.js";

export const ModelPayloadRef = z
  .object({
    resourceId: Id,
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()
  .describe("Digest-bound model-purpose resource; never an Agent attachment.");
export type ModelPayloadRef = z.infer<typeof ModelPayloadRef>;

export const ModelAccountChoice = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto"), preferredProfileId: Id.optional() }).strict(),
    z.object({ mode: z.literal("pin"), profileId: Id }).strict(),
  ])
  .describe("Auto keeps a usable prior account; pin never selects another account.");
export type ModelAccountChoice = z.infer<typeof ModelAccountChoice>;

export const ModelRoute = z
  .object({
    source: Id,
    credentialProfileId: Id,
    accountFingerprint: z.string().nullable(),
    model: z.string().nullable(),
  })
  .strict()
  .describe("Selected route at dispatch; a result records the actually observed model, or null.");
export type ModelRoute = z.infer<typeof ModelRoute>;

export const ModelNativeContinuation = z
  .object({
    route: ModelRoute,
    format: NonBlankString,
    payload: z.unknown(),
  })
  .strict()
  .describe(
    "Opaque provider-native continuation bound to its account and model; its format distinguishes assistant content from live transport state.",
  );
export type ModelNativeContinuation = z.infer<typeof ModelNativeContinuation>;

export const ModelToolCall = z
  .object({
    id: Id,
    type: z.literal("function"),
    function: z.object({ name: NonBlankString, arguments: z.string() }).strict(),
  })
  .strict();
export type ModelToolCall = z.infer<typeof ModelToolCall>;

export const ModelMessage = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).nullable(),
    name: z.string().optional(),
    tool_call_id: Id.optional(),
    tool_calls: z.array(ModelToolCall).optional(),
    nativeContinuation: ModelNativeContinuation.optional(),
  })
  .strict()
  .describe(
    "Caller-owned conversation message. Text, content blocks, and tool arguments are not redacted or rewritten.",
  );
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ModelTool = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: NonBlankString,
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()),
        strict: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .describe(
    "A caller-executed function; the model transport never executes it or rewrites its JSON schema.",
  );
export type ModelTool = z.infer<typeof ModelTool>;

export const ModelToolChoice = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({ type: z.literal("function"), function: z.object({ name: NonBlankString }).strict() })
    .strict(),
]);
export type ModelToolChoice = z.infer<typeof ModelToolChoice>;

export const ModelCallOptions = z
  .object({
    reasoningEffort: NonBlankString.optional(),
    serviceTier: NonBlankString.optional(),
    processingPreference: ProcessingPreference.optional(),
    parallelToolCalls: z.boolean().optional(),
    cacheKey: NonBlankString.optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().optional(),
  })
  .strict()
  .describe(
    "Generation options only, not a caller's context/output reserve; reasoningEffort is an adaptive preference, while unsupported other explicit options refuse before inference.",
  );
export type ModelCallOptions = z.infer<typeof ModelCallOptions>;

export const ModelCallRequest = z
  .object({
    source: Id,
    model: NonBlankString,
    account: ModelAccountChoice,
    messages: z.array(ModelMessage).min(1),
    tools: z.array(ModelTool).default([]),
    toolChoice: ModelToolChoice.default("auto"),
    options: ModelCallOptions.default({}),
    nativeContinuation: ModelNativeContinuation.nullable()
      .optional()
      .describe(
        "Caller-owned live transport turn: omit for stateless compatibility, null to start empty. Separate from historical assistant continuations.",
      ),
  })
  .strict()
  .describe(
    "One model generation request, stored only in a model-purpose payload outside the command journal.",
  );
export type ModelCallRequest = z.infer<typeof ModelCallRequest>;

export const ModelUsage = TokenUsage.extend({
  cache_write_tokens: z.number().int().nonnegative().nullable().default(null),
  reasoning_tokens: z.number().int().nonnegative().nullable().default(null),
}).describe("Provider-reported counters for one generation; missing counters remain null.");
export type ModelUsage = z.infer<typeof ModelUsage>;

export const ModelCostEvidence = CostEvidence.extend({
  cashUsd: z.number().nonnegative().nullable().default(null),
  valuationUsd: z.number().nonnegative().nullable().default(null),
  valuationKnowledge: CostKnowledge.default("unknown"),
}).describe(
  "Incremental cash and token valuation are independent; subscription credentials alone never invent a cash receipt.",
);
export type ModelCostEvidence = z.infer<typeof ModelCostEvidence>;

export const ModelFailureEvidence = z
  .object({
    bodyBase64: z.string(),
    receivedBytes: z.number().int().nonnegative(),
    bodyComplete: z.boolean().describe("True only when the response reader observed EOF."),
    stage: NonBlankString,
    errors: z
      .array(
        z
          .object({
            name: z.string().nullable(),
            message: z.string(),
            stack: z.string().nullable(),
            code: z.union([z.string(), z.number()]).nullable(),
          })
          .strict(),
      )
      .describe(
        "Original exception followed by causes and AggregateError members in depth-first order; empty when none was thrown.",
      ),
    causeCycle: z.boolean(),
  })
  .strict()
  .describe(
    "Private failed-response evidence: every byte returned to the reader, never an unreceived suffix. Retained only inside the model result resource when requested.",
  );
export type ModelFailureEvidence = z.infer<typeof ModelFailureEvidence>;

export const ModelCallResult = z
  .object({
    outcome: z.enum(["completed", "incomplete", "failed", "unknown"]),
    message: ModelMessage.nullable(),
    route: ModelRoute,
    modelMismatch: z
      .object({ requested: z.string(), observed: z.string() })
      .strict()
      .nullable()
      .optional()
      .describe(
        "Requested-vs-observed model mismatch on a completed or incomplete terminal response; null or absent when they match or either side is unknown. The outcome is unchanged.",
      ),
    usage: ModelUsage,
    cost: ModelCostEvidence,
    appliedOptions: ModelCallOptions,
    effortResolution: EffortResolution.optional().describe(
      "Prepared and observed effort evidence; model operations retain it only when creation requests captureEffortEvidence=true. Legacy results omit it before immutable publication.",
    ),
    processing: ProcessingReceipt.optional(),
    problem: ControlProblem.nullable(),
    failureEvidence: ModelFailureEvidence.optional(),
    nativeContinuation: ModelNativeContinuation.nullable()
      .optional()
      .describe(
        "Live transport continuation, present only when the request opted in; preserve independently of response body success.",
      ),
  })
  .strict()
  .describe(
    "One provider outcome; completed means a terminal response, never an EOF or a partial tool argument.",
  );
export type ModelCallResult = z.infer<typeof ModelCallResult>;

export const ModelCatalogEntry = z
  .object({
    id: NonBlankString,
    label: z.string().nullable(),
    isDefault: z.boolean(),
    contextWindow: z.number().int().positive().nullable(),
    maxContextWindow: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
    inputModalities: z.array(z.string()),
    reasoningEfforts: z.array(z.string()),
    reasoningEffortPreferenceOrder: z
      .array(NonBlankString)
      .optional()
      .describe(
        "Internal vendor order for preference adaptation when it includes choices the raw transport cannot submit. Not accepted values; projected out of both public catalog views.",
      ),
    reasoningEffortsVerified: z
      .boolean()
      .optional()
      .describe(
        "Whether the provider supplied a fully parsed effort array, including a known empty array. Missing on historical catalogs means unverified.",
      ),
    defaultReasoningEffort: z.string().nullable(),
    supportedOptions: z.array(z.string()),
    processing: ProcessingCapability.optional(),
  })
  .strict()
  .describe(
    "Model metadata from the selected raw transport; CLI compaction and usable-window policies are not capacity.",
  );
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;

export const ControlModelSourcesResponse = z
  .object({
    sources: z.array(
      z
        .object({
          id: Id,
          label: NonBlankString,
          credentialHarness: Id,
        })
        .strict(),
    ),
  })
  .strict()
  .describe("Available raw model transports, distinct from agent harness inventory.");
export type ControlModelSourcesResponse = z.infer<typeof ControlModelSourcesResponse>;

export const ControlModelSourcesAccountsResponse = z
  .object({
    sources: z.array(
      ControlModelSourcesResponse.shape.sources.element.extend({
        processingPreferences: z.array(ProcessingPreference),
        accountCatalog: z.literal(true),
      }),
    ),
  })
  .strict();
export type ControlModelSourcesAccountsResponse = z.infer<
  typeof ControlModelSourcesAccountsResponse
>;
export const ControlModelSourcesQueryResponse = z.union([
  ControlModelSourcesResponse,
  ControlModelSourcesAccountsResponse,
]);
export type ControlModelSourcesQueryResponse = z.infer<typeof ControlModelSourcesQueryResponse>;

export const ControlModelCatalogResponse = z
  .object({
    source: Id,
    credentialProfileId: Id,
    accountFingerprint: z.string().nullable(),
    observedAt: IsoTimestamp.describe(
      "Original catalog observation time; cached reuse never advances it.",
    ),
    provenance: NonBlankString.describe(
      "provider_http means the catalog body was read and validated from a successful upstream HTTP response at observedAt. Other values do not certify provider contact.",
    ),
    /** The backend may vary discovery by this declared client version;
     * absence is not proof of a minimum-version or entitlement refusal.
     * Null only for catalogs handed over by an older engine. */
    clientVersion: NonBlankString.nullable()
      .default(null)
      .describe(
        "Client version the transport declared when it read this catalog; server discovery may vary with it. Null for catalogs from an older engine.",
      ),
    clientVersionSource: z
      .enum(["verified_transport", "installed_cli"])
      .nullable()
      .default(null)
      .describe(
        "Where the declared client version came from: verified_transport (the version this Claudexor release verified its HTTP transport against) or installed_cli (a newer installed Codex CLI raised it). Null for catalogs from an older engine.",
      ),
    admission: z
      .object({
        requestedModel: NonBlankString,
        inventoryAbsence: HarnessCapabilities.shape.model_inventory_absence.unwrap(),
      })
      .strict()
      .optional()
      .describe(
        "Negotiated selected-account admission for this exact model, after auth and model-scoped quota checks. A valid catalog miss may be advisory; no generation or entitlement is proved.",
      ),
    models: z.array(ModelCatalogEntry),
  })
  .strict()
  .describe(
    "Exact-profile model discovery, not a global CLI alias list or an inference entitlement guarantee.",
  );
export type ControlModelCatalogResponse = z.infer<typeof ControlModelCatalogResponse>;

export const AccountCatalogAvailability = z
  .object({
    credentialProfileId: Id,
    availability: z.enum(["available", "unavailable", "unknown"]),
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "Current account evidence for display; this does not certify fresh execution admission.",
  );
export type AccountCatalogAvailability = z.infer<typeof AccountCatalogAvailability>;

export const ControlModelAccountCatalogResponse = z
  .object({
    source: Id,
    accounts: z.array(
      AccountCatalogAvailability.extend({ catalog: ControlModelCatalogResponse.nullable() }),
    ),
    partial: z.boolean(),
  })
  .strict()
  .describe(
    "All enabled managed model accounts, or one strict pin, retaining independent catalogs and failures. A missing catalog makes partial true.",
  );
export type ControlModelAccountCatalogResponse = z.infer<typeof ControlModelAccountCatalogResponse>;
export const ControlModelCatalogQueryResponse = z.union([
  ControlModelCatalogResponse,
  ControlModelAccountCatalogResponse,
]);
export type ControlModelCatalogQueryResponse = z.infer<typeof ControlModelCatalogQueryResponse>;

export const ModelDispatch = z
  .object({
    state: z.enum(["not_started", "started", "response_received", "unknown"]),
    startedAt: IsoTimestamp.nullable(),
    route: ModelRoute.nullable(),
  })
  .strict()
  .describe(
    "Started means the physical send may have begun, not proof the upstream accepted it. A terminal not_started may refine that attempted send only with typed proof no complete inference request was delivered; startedAt and route retain the attempt.",
  );
export type ModelDispatch = z.infer<typeof ModelDispatch>;

export const ModelResponseCustody = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z
      .object({
        state: z.literal("ready"),
        ref: ModelPayloadRef,
        readyAt: IsoTimestamp,
        expiresAt: IsoTimestamp,
      })
      .strict(),
    z
      .object({ state: z.literal("acknowledged"), ref: ModelPayloadRef, releasedAt: IsoTimestamp })
      .strict(),
    z
      .object({ state: z.literal("expired"), ref: ModelPayloadRef, releasedAt: IsoTimestamp })
      .strict(),
  ])
  .describe(
    "Result GET does not acknowledge delivery. Acknowledged/expired bytes never cause another generation.",
  );
export type ModelResponseCustody = z.infer<typeof ModelResponseCustody>;

export const ModelOperationParams = z
  .object({
    kind: z.literal("model"),
    request: ModelPayloadRef,
    captureFailureEvidence: z.literal(true).optional(),
    captureEffortEvidence: z.literal(true).optional(),
  })
  .strict();
export type ModelOperationParams = z.infer<typeof ModelOperationParams>;

/** Command-kind discrimination only; execution validates the complete params.
 * History scans need the kind, not a new Zod parse of every retained receipt. */
export function isModelOperation(params: unknown): boolean {
  return (
    typeof params === "object" && params !== null && "kind" in params && params.kind === "model"
  );
}

export const ModelOperationReceipt = z
  .object({
    lifecycle: RunLifecycle.exclude(["queued", "running"]),
    dispatch: ModelDispatch,
    response: ModelResponseCustody,
    usage: ModelUsage,
    cost: ModelCostEvidence.nullable(),
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "Compact command-owned terminal receipt; request/response bodies never ride journal updates.",
  );
export type ModelOperationReceipt = z.infer<typeof ModelOperationReceipt>;

export const ControlModelOperationCreateRequest = z.object({ request: ModelPayloadRef }).strict();
export type ControlModelOperationCreateRequest = z.infer<typeof ControlModelOperationCreateRequest>;
export const ControlModelOperationAckRequest = z
  .object({ sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();
export type ControlModelOperationAckRequest = z.infer<typeof ControlModelOperationAckRequest>;
export const ControlModelOperationControlRequest = z
  .object({
    action: z.literal("cancel"),
    reasonCode: z.enum(CANCEL_REASON_CODES).optional(),
  })
  .strict();
export type ControlModelOperationControlRequest = z.infer<
  typeof ControlModelOperationControlRequest
>;
export const ControlModelOperationDetail = z
  .object({
    id: Id,
    state: RunLifecycle,
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.nullable(),
    finishedAt: IsoTimestamp.nullable(),
    dispatch: ModelDispatch,
    response: ModelResponseCustody,
    usage: ModelUsage,
    cost: ModelCostEvidence.nullable(),
    problem: ControlProblem.nullable(),
  })
  .strict();
export type ControlModelOperationDetail = z.infer<typeof ControlModelOperationDetail>;
