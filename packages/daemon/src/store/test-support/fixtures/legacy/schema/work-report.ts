import { z } from "zod/v3";

/**
 * D-16: the model-authored WorkReport — the typed self-assessment an attempt
 * emits alongside its deliverable so the finalizer can tell "I finished" from
 * "I need input / I ran out of room" WITHOUT prose matching. It rides the
 * existing structured-output seam inside a compiled envelope (see
 * `buildWorkReportEnvelope` in output-schema.ts) and is validated by the
 * attempt finalizer, never by a Zod refinement on the wire type: the wire
 * shape is deliberately permissive (a malformed report is a typed
 * `work_report_contract` failure the finalizer raises, not a parse throw that
 * loses the whole answer).
 */

/** What state the model says its own work reached. Cross-field rules
 * (completed ⇒ no required_inputs; needs_input ⇒ ≥1) are enforced by the
 * finalizer, not here — the wire type stays permissive for transport. */
export const WorkReportState = z
  .enum(["completed", "needs_input", "incomplete"])
  .describe(
    "Model-authored work state: completed (the task is done), needs_input (blocked on a listed input), or incomplete (partial, more work remains).",
  );
export type WorkReportState = z.infer<typeof WorkReportState>;

/** The category of a blocking input the model needs to proceed. */
export const RequiredInputKind = z
  .enum(["file", "context", "credential", "permission", "decision", "external_dependency"])
  .describe(
    "Category of a missing input a needs_input/incomplete report lists: a file, additional context, a credential, a permission, a human decision, or an external dependency.",
  );
export type RequiredInputKind = z.infer<typeof RequiredInputKind>;

/** One blocking input the model reports it needs. `locator` points at the
 * concrete missing thing (a path, a URL, an env var name) when it can name it. */
export const RequiredInput = z
  .object({
    kind: RequiredInputKind,
    locator: z
      .string()
      .max(512)
      .nullable()
      .default(null)
      .describe("Concrete pointer to the missing thing (path/url/name); null when unnameable."),
    description: z
      .string()
      .max(1024)
      .describe("Human-readable description of what is needed and why."),
  })
  .describe("One blocking input a needs_input/incomplete WorkReport lists.");
export type RequiredInput = z.infer<typeof RequiredInput>;

/** The model-authored work self-assessment (D-16). */
export const WorkReport = z
  .object({
    state: WorkReportState,
    required_inputs: z
      .array(RequiredInput)
      .max(16)
      .default([])
      .describe(
        "Blocking inputs the model needs to proceed; empty for a completed report, ≥1 for needs_input (finalizer-enforced).",
      ),
  })
  .describe(
    "Model-authored WorkReport (D-16): a typed self-assessment of whether the attempt completed, needs input, or is incomplete, riding the structured-output envelope and validated by the attempt finalizer.",
  );
export type WorkReport = z.infer<typeof WorkReport>;

/**
 * How the engine OBTAINED (or failed to obtain) a WorkReport for an attempt —
 * the provenance of the work_state axis:
 * - `constrained`: a native schema-constrained transport carried it (codex
 *   --output-schema, claude StructuredOutput tool).
 * - `validated`: an instructed terminal metadata block carried it (cursor).
 * - `absent`: the route could not carry one (transport unsupported or a lane
 *   gated the structured transport off) — a DISCLOSED absence, not a failure.
 */
export const WorkReportSource = z
  .enum(["constrained", "validated", "absent"])
  .describe(
    "Provenance of a WorkReport: constrained (native schema transport), validated (instructed terminal metadata), or absent (no transport could carry one — a disclosed absence, not a failure).",
  );
export type WorkReportSource = z.infer<typeof WorkReportSource>;

/**
 * Why an ACTIVE instructed footer channel (`validated` source: cursor, agy,
 * acp) produced no valid WorkReport. On such a route nothing constrains the
 * model natively, so a missing or broken footer is disclosed, never a failure
 * (owner decision 2026-10-05): the run completes with `state: unverified`, the
 * complete answer stays the deliverable, and this reason names the cause. Never
 * set for a valid report or for a route that carries no transport (`absent`).
 */
export const WorkReportUnverifiedReason = z
  .enum([
    "footer_missing",
    "footer_not_json",
    "footer_not_object",
    "report_missing",
    "report_malformed",
    "report_contradictory",
    "legacy_output_invalid",
  ])
  .describe(
    "Why an active instructed footer yielded no valid WorkReport: no fenced block, a non-JSON or non-object last fence, a fence without work_report, a malformed report, a contradictory one (completed with required_inputs, or needs_input without any), or a historical fence-only envelope whose output is not a string.",
  );
export type WorkReportUnverifiedReason = z.infer<typeof WorkReportUnverifiedReason>;

/**
 * The D-16 work_state axis attached to attempt/run outcomes, ORTHOGONAL to the
 * process lifecycle (INV-116). `state` folds the WorkReport state with an
 * `unverified` value for the disclosed no-valid-report cases (transport
 * unsupported / lane gated, or an instructed footer that was missing or
 * broken — `unverified_reason` says which). A `needs_input`/`incomplete`
 * work_state VETOES applyability and forces a non-zero CLI exit even when the
 * process lifecycle succeeded, but it NEVER flips the lifecycle itself.
 */
export const WorkState = z
  .object({
    state: z
      .enum(["completed", "needs_input", "incomplete", "unverified"])
      .describe(
        "Folded work state: the WorkReport state, or unverified when no valid report was obtained (transport unsupported / lane gated, or an instructed footer missing or broken).",
      ),
    source: WorkReportSource,
    required_inputs: z
      .array(RequiredInput)
      .max(16)
      .optional()
      .describe("Carried through from a needs_input/incomplete WorkReport for honest disclosure."),
    unverified_reason: WorkReportUnverifiedReason.optional().describe(
      "Present only with state unverified on a validated (instructed footer) source: the disclosed cause of the missing report.",
    ),
  })
  .describe(
    "D-16 work_state axis: the model-attested work outcome, orthogonal to process lifecycle (INV-116); a needs_input/incomplete state vetoes applyability and exit 0 without flipping the lifecycle.",
  );
export type WorkState = z.infer<typeof WorkState>;

/**
 * Strict transport form of the WorkReport, hand-authored to match the Zod shape
 * (every key required, additionalProperties:false, optional locator expressed
 * as string|null — the vendor strict-mode recipe). This is the WorkReport half
 * of the compiled envelope that rides `HarnessRunSpec.output_schema`. A unit
 * test pins it against a fresh strictify of the generated WorkReport schema so
 * drift is caught.
 */
export const WORK_REPORT_TRANSPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["completed", "needs_input", "incomplete"] },
    required_inputs: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "file",
              "context",
              "credential",
              "permission",
              "decision",
              "external_dependency",
            ],
          },
          locator: { type: ["string", "null"], maxLength: 512 },
          description: { type: "string", maxLength: 1024 },
        },
        required: ["kind", "locator", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["state", "required_inputs"],
  additionalProperties: false,
};
