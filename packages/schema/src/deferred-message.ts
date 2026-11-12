import { z } from "zod/v3";
import { ResourceAttachmentRef } from "./attachment.js";
import { ControlRunStartRequest } from "./control.js";
import { CapturedRunStart, RunDefaultsSnapshot } from "./captured-run-start.js";
import { Id, IsoTimestamp } from "./primitives.js";
import { validateRunFactsReceipt, type ExpectedRunFactsIdentity } from "./run-facts.js";
import { reviewAllowsApply } from "./decision.js";
import { TurnEnqueueProblem } from "./thread.js";

/** Initial controls use ordinary continuation semantics; edits have no authority. */
const DeferredMessageControls = ControlRunStartRequest.pick({
  access: true,
  web: true,
  externalContextPolicy: true,
  credentialProfileId: true,
  paidBudget: true,
  maxSeconds: true,
  timeLimitMode: true,
  review: true,
  reviewerPanel: true,
  reviewerModels: true,
  reviewerEfforts: true,
  continueCarrier: true,
  effort: true,
  efforts: true,
  taskGroupId: true,
}).strict();
/** Create-time control keys; the bounded read reports their captured values. */
export const DEFERRED_MESSAGE_CONTROL_KEYS = Object.keys(DeferredMessageControls.shape);

const content = { prompt: z.string(), attachments: z.array(ResourceAttachmentRef) };
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DeferredMessageMutation = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("create"),
        predecessorId: Id,
        ...content,
        controls: DeferredMessageControls.optional(),
      })
      .strict(),
    z
      .object({ action: z.literal("replace"), draftId: Id, expectedRevision: revision, ...content })
      .strict(),
    z.object({ action: z.literal("clear"), draftId: Id, expectedRevision: revision }).strict(),
  ])
  .describe(
    "One editable reserved next message of a daemon-owned one-shot Agent/Ask. Every mutation requires Idempotency-Key; replace/clear require the exact revision.",
  );
export type DeferredMessageMutation = z.infer<typeof DeferredMessageMutation>;
export const DeferredMessageCall = z
  .object({
    request: DeferredMessageMutation,
    idempotencyKey: z.string().min(1).max(256).regex(/\S/),
  })
  .strict();
export type DeferredMessageCall = z.infer<typeof DeferredMessageCall>;

export const DeferredMessageHold = z
  .object({
    code: z.enum([
      "predecessor_failed",
      "predecessor_cancelled",
      "predecessor_interrupted",
      "predecessor_needs_input",
      "predecessor_incomplete",
      "predecessor_facts_unavailable",
      "predecessor_work_unverified",
      "predecessor_checks_failed",
      "predecessor_review_blocked",
      "predecessor_output_unavailable",
      "settlement_unknown",
      "stop_requested",
      "shutdown",
      "restart_requires_controller",
      "partition_retired",
      "admission_refused",
    ]),
    problem: TurnEnqueueProblem.optional(),
  })
  .strict()
  .describe(
    "Stable hold. Editing, observation and readiness restoration never rearm it; inspect the predecessor result and clear before an ordinary continuation. One exception: an unchanged settlement_unknown draft returns by itself when a later settlement of the predecessor's run, by the live daemon that ran it, proves its processes gone (see resumed); a Stop first keeps it held.",
  );
export type DeferredMessageHold = z.infer<typeof DeferredMessageHold>;

/** The visible reason a held draft was returned to the ordinary path (#613). */
export const DeferredMessageResumed = z
  .object({
    from: DeferredMessageHold.describe("The hold the draft was returned from."),
    reason: z
      .literal("process_scope_settled")
      .describe(
        "A later settlement of the predecessor's run proved its processes gone; the draft was unchanged, not cleared, replaced or stopped.",
      ),
    at: IsoTimestamp,
  })
  .strict()
  .describe(
    "Why this draft left its hold automatically. It then took the existing revision and admission path; any other reason holds it again.",
  );
export type DeferredMessageResumed = z.infer<typeof DeferredMessageResumed>;

export const DeferredMessageProjection = z
  .object({
    draftId: Id,
    revision,
    state: z.enum(["waiting", "held", "dispatched", "cleared"]),
    predecessorJobId: Id,
    predecessorRunId: Id.nullable(),
    predecessorResult: z
      .string()
      .describe("Existing addressed run-detail/result path; no duplicate result store."),
    hold: DeferredMessageHold.nullable(),
    resumed: DeferredMessageResumed.optional(),
    dispatchedRevision: revision.nullable(),
    successorJobId: Id.nullable(),
    successorRunId: Id.nullable(),
  })
  .strict()
  .describe(
    "Compact addressed draft state, with exact predecessor result and successor handles. A terminal predecessor does not imply the draft has resolved.",
  );
export type DeferredMessageProjection = z.infer<typeof DeferredMessageProjection>;

/** Daemon answer to a public Stop of the predecessor, whatever its lifecycle. */
export const DeferredMessageStopReport = z
  .object({
    held: z
      .boolean()
      .describe(
        "This Stop moved the predecessor's waiting draft to held, or took over a process-custody hold as its own.",
      ),
    draft: DeferredMessageProjection.nullable().describe(
      "The predecessor's latest draft after the Stop; a dispatched draft names the successor, which the Stop does not cancel.",
    ),
  })
  .strict();
export type DeferredMessageStopReport = z.infer<typeof DeferredMessageStopReport>;

/** Same typed claim refusal at ordinary HTTP preflight and raw acceptance. */
export function assertDeferredReservation(
  reservation: DeferredMessageProjection | null | undefined,
  reservedDraftId?: string,
): void {
  if (
    !reservation ||
    (reservation.state !== "waiting" && reservation.state !== "held") ||
    reservation.draftId === reservedDraftId
  )
    return;
  throw Object.assign(
    new Error("the predecessor's next message is reserved; inspect and clear the draft first"),
    {
      code: "continuation_reserved",
      status: 409,
      retryable: false,
      context: reservation,
      requiredActions: [
        "Inspect the predecessor result and clear the exact draft before continuing.",
      ],
    },
  );
}

export const DeferredMessageDetail = DeferredMessageProjection.extend({
  ...content,
  capturedStart: CapturedRunStart.nullable().describe(
    "Immutable execution controls captured once; null after clear. Completed envelopes may continue in a different_root under ordinary continueFrom custody.",
  ),
  capturedAt: IsoTimestamp.nullable().describe(
    "When capturedStart was frozen: draft creation. Edits never recapture; null after clear.",
  ),
}).strict();
export type DeferredMessageDetail = z.infer<typeof DeferredMessageDetail>;

export const DeferredMessageReceipt = z
  .object({
    appliedRevision: revision.describe(
      "The exact revision originally applied by this idempotency key.",
    ),
    draft: DeferredMessageProjection,
  })
  .strict();
export type DeferredMessageReceipt = z.infer<typeof DeferredMessageReceipt>;

/** Captured values only: nothing here is re-resolved against current settings. */
export const DeferredMessageCapturedControls = z
  .object({
    capturedAt: IsoTimestamp.describe("Draft creation; edits never recapture controls."),
    inherited: z
      .record(z.unknown())
      .describe(
        "Continuation-inherited groups from the predecessor's accepted request (mode, scope, execution, harness and model groups, promptCacheTtl); omitted per-harness models were completed from Settings at creation.",
      ),
    resolved: z
      .record(z.unknown())
      .describe(
        "Create-time controls as captured: explicit draft controls, otherwise ordinary new-run defaults at creation, never the predecessor's value. An omitted access is the project's default access at creation, not the predecessor's.",
      ),
    settings: RunDefaultsSnapshot.nullable().describe(
      "Settings execution preferences captured at creation (per-harness defaults, eligible and primary harness, auth preference), used at dispatch instead of current values.",
    ),
  })
  .strict()
  .describe(
    "Frozen effective controls. Dispatch reads tool permissions, account and harness enablement, trust, quota, capabilities, paid-fallback policy and other settings afresh; a refusal holds the draft.",
  );
export type DeferredMessageCapturedControls = z.infer<typeof DeferredMessageCapturedControls>;

export const DeferredMessageReadInput = z.object({ draftId: Id }).strict();
export const DeferredMessageReadResult = z
  .object({
    draft: DeferredMessageProjection,
    promptPreview: z.string(),
    promptBytes: z.number().int().nonnegative(),
    omittedPromptBytes: z.number().int().nonnegative(),
    attachments: z.array(ResourceAttachmentRef).max(32),
    omittedAttachments: z.number().int().nonnegative(),
    controls: DeferredMessageCapturedControls.nullable().describe("Null after clear."),
    detailPath: z.string(),
  })
  .strict()
  .describe(
    "Bounded editable-content snapshot. Read the exact predecessorResult path (or claudexor_run_result for its job/run handle) for predecessor output; output is never duplicated here. Terminal predecessor observation does not imply draft resolution.",
  );
export type DeferredMessageReadResult = z.infer<typeof DeferredMessageReadResult>;

/** Automatic promotion is deliberately stricter than explicit continuation.
 * Receipts are validated canonical facts; neither prose nor native retry events
 * enter this decision. Unverified work is a disclosure, not an invented failure. */
export function deferredMessageHold(
  lifecycle: string,
  rawFacts: unknown,
  identity: ExpectedRunFactsIdentity = {},
): DeferredMessageHold | null {
  if (lifecycle === "failed" || lifecycle === "cancelled" || lifecycle === "interrupted")
    return { code: `predecessor_${lifecycle}` };
  if (lifecycle !== "succeeded") return { code: "predecessor_facts_unavailable" };
  let facts;
  try {
    facts = validateRunFactsReceipt(rawFacts, { ...identity, lifecycle: "succeeded" });
  } catch {
    return { code: "predecessor_facts_unavailable" };
  }
  const work = facts.outcome.work_state;
  if (work?.state === "needs_input" || work?.state === "incomplete")
    return { code: `predecessor_${work.state}` };
  if (!work) return { code: "predecessor_work_unverified" };
  if (
    facts.outcome.checks === "failed" ||
    facts.gates.state === "failed" ||
    (facts.gates.required > 0 && facts.gates.state !== "passed")
  )
    return { code: "predecessor_checks_failed" };
  if (facts.review.blockers > 0 || !reviewAllowsApply(facts.outcome))
    return { code: "predecessor_review_blocked" };
  if (!facts.deliverable.present || facts.presentation?.state !== "ready")
    return { code: "predecessor_output_unavailable" };
  return null;
}
