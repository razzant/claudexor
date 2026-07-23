/**
 * D-16 unified attempt finalizer.
 *
 * ONE owner for the "did this attempt deliver, and in what work_state?" decision
 * — replacing the three divergent deliverable predicates (candidate diff||answer;
 * planner no-error⇒delivered; read-only nonempty-report). It folds the raw
 * intent-specific deliverable evidence with the model-authored WorkReport, the
 * typed context signals, the harness error state, and the gates into:
 *   - a final `deliverablePresent`,
 *   - a `work_state` axis (orthogonal to lifecycle, INV-116),
 *   - a typed reason,
 *   - and the class of outcome (clean / veto / contract-failure / interrupted).
 *
 * The module is PURE (no I/O, no clock). The envelope compile/unwrap helpers
 * live here too so the spec-build decision and the finalizer read one contract.
 */
import {
  buildWorkReportEnvelope,
  strictifyOutputSchema,
  WorkReport,
  type HarnessCapabilities,
  type RunReason,
  type WorkReportSource,
  type WorkState,
} from "@claudexor/schema";

/** The per-attempt envelope decision made at spec build and consumed by the
 * unwrap. `active` means the orchestrator actually placed a WorkReport envelope
 * on the spec's output_schema (a constrained route), so the final answer IS the
 * envelope JSON and a missing/malformed report is a typed contract failure. */
export interface WorkReportEnvelopeMode {
  active: boolean;
  source: WorkReportSource;
  hasCallerSchema: boolean;
}

/** Result of the spec-build envelope decision. */
export interface ResolvedWorkReportEnvelope {
  /** What rides HarnessRunSpec.output_schema (undefined = leave unset). */
  outputSchema: Record<string, unknown> | undefined;
  mode: WorkReportEnvelopeMode;
}

/**
 * Decide the transport envelope for one route at spec build (D-16 §2). The
 * caller's ORIGINAL schema stays the conformance authority for `output` (it is
 * NOT passed here strictified for validation — only the transport copy is).
 *
 * Activated ONLY for `constrained` routes that natively constrain output and
 * are not interactive-gated, and — for `side_tool` routes (claude) — only when
 * a caller schema is present (a no-caller WorkReport-only envelope on claude
 * would hijack the markdown final; that is the D-16c seam). `validated` routes
 * (cursor) and claude's no-caller case are left inactive here (disclosed
 * `absent` work_state) and activated by the D-16c adapter instruction layer.
 */
export function resolveWorkReportEnvelope(opts: {
  transport: HarnessCapabilities["work_report_transport"];
  channel: HarnessCapabilities["structured_output_channel"];
  supportsJsonSchemaOutput: boolean;
  interactive: boolean;
  callerSchema: Record<string, unknown> | null;
}): ResolvedWorkReportEnvelope {
  const hasCallerSchema = opts.callerSchema !== null;
  const callerStrict = hasCallerSchema
    ? strictifyOutputSchema(opts.callerSchema as Record<string, unknown>)
    : null;
  // claude's `--json-schema` × interactive stream-json is an unverified combo:
  // disclose the WorkReport transport as unsupported for that lane (§1).
  const interactiveGated = opts.channel === "side_tool" && opts.interactive;
  const active =
    opts.transport === "constrained" &&
    opts.supportsJsonSchemaOutput &&
    !interactiveGated &&
    (hasCallerSchema || opts.channel === "final_message");

  if (active) {
    // side_tool + caller schema and every final_message case carry the output
    // inside the envelope; final_message with no caller schema wraps the
    // markdown deliverable as `output: string`.
    const output: Record<string, unknown> | "string" = hasCallerSchema
      ? (callerStrict as Record<string, unknown>)
      : "string";
    return {
      outputSchema: buildWorkReportEnvelope(output),
      mode: { active: true, source: "constrained", hasCallerSchema },
    };
  }
  return {
    // Legacy path preserved: a caller schema still rides (strictified) on a
    // non-activated route (the mandatory-schema gate already refused
    // schema-incapable routes upstream).
    outputSchema: callerStrict ?? undefined,
    mode: { active: false, source: "absent", hasCallerSchema },
  };
}

/** The unwrapped attempt answer plus the extracted WorkReport (or a typed
 * contract violation). `deliverable` is what answer.md / the caller-schema
 * validator must see — never the envelope. */
export interface UnwrappedAnswer {
  deliverable: string;
  workReport: WorkReport | null;
  source: WorkReportSource;
  /** Non-null when an active route failed to carry a valid WorkReport. */
  contractViolation: string | null;
}

function extractOutput(obj: Record<string, unknown>, mode: WorkReportEnvelopeMode): string {
  const output = obj["output"];
  if (mode.hasCallerSchema) {
    // Re-serialize the S-conformant object so finalizeStructuredOutput can
    // JSON.parse + validate it against the caller schema.
    return output === undefined ? "" : JSON.stringify(output);
  }
  return typeof output === "string" ? output : output === undefined ? "" : String(output);
}

/**
 * Un-nest `{ work_report, output }` from the final answer of an active envelope
 * route (D-16 §2). A non-active mode passes the answer through untouched. The
 * WorkReport cross-field rules (completed ⇒ no required_inputs; needs_input ⇒
 * ≥1) are enforced HERE (not on the Zod wire type) so a broken report is a
 * typed contract violation, never a silent parse pass.
 */
export function unwrapWorkReportEnvelope(
  answerText: string,
  mode: WorkReportEnvelopeMode,
): UnwrappedAnswer {
  if (!mode.active) {
    return { deliverable: answerText, workReport: null, source: mode.source, contractViolation: null };
  }
  const text = answerText.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      deliverable: answerText,
      workReport: null,
      source: mode.source,
      contractViolation: "final answer is not the JSON work_report envelope",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      deliverable: answerText,
      workReport: null,
      source: mode.source,
      contractViolation: "work_report envelope is not a JSON object",
    };
  }
  const obj = parsed as Record<string, unknown>;
  const deliverable = extractOutput(obj, mode);
  const wr = WorkReport.safeParse(obj["work_report"]);
  if (!wr.success) {
    return {
      deliverable,
      workReport: null,
      source: mode.source,
      contractViolation: `work_report missing or malformed: ${wr.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  const report = wr.data;
  if (report.state === "completed" && report.required_inputs.length > 0) {
    return {
      deliverable,
      workReport: null,
      source: mode.source,
      contractViolation: "a completed work_report must not list required_inputs",
    };
  }
  if (report.state === "needs_input" && report.required_inputs.length === 0) {
    return {
      deliverable,
      workReport: null,
      source: mode.source,
      contractViolation: "a needs_input work_report must list at least one required_input",
    };
  }
  return { deliverable, workReport: report, source: mode.source, contractViolation: null };
}

/**
 * QA-036: the terminal outcome facts for a read-only (ask) run that produced NO
 * successful attempt. The D8 legacy mapping treated ANY web-blocked run as a
 * succeeded/review_blocked terminal (exit 0, "Needs review"); a blocked Ask that
 * delivered nothing then read as done. This re-checks the DELIVERABLE: only a
 * blocked attempt that actually produced a partial answer is a review-blocked
 * SUCCESS; an empty blocked (or plain failed) run is a failure (exit 1).
 */
export function readOnlyNoSuccessTerminal(opts: {
  webBlocked: boolean;
  hasDeliverable: boolean;
  budgetStopped: boolean;
  attemptsCount: number;
}): { lifecycle: "succeeded" | "failed"; review?: "blocked"; reason: RunReason } {
  if (opts.webBlocked && opts.hasDeliverable) {
    return { lifecycle: "succeeded", review: "blocked", reason: "review_blocked" };
  }
  if (opts.budgetStopped && opts.attemptsCount === 0) {
    return { lifecycle: "failed", reason: "budget_exhausted" };
  }
  return { lifecycle: "failed", reason: "harness_failed" };
}

/** Everything the finalizer folds for one attempt. The gate/web/belt axes are
 * NOT folded here — the finalizer decides deliverable+work_state, and
 * `setAttemptOutcome` runs the status math over gates/web/belt on top (so a
 * `completed` claim with a failed gate still yields a failed status there). */
export interface FinalizeAttemptInput {
  /** Raw intent-specific deliverable evidence (diff/answer/report present). */
  deliverableEvidence: boolean;
  harnessErrored: boolean;
  workReport: WorkReport | null;
  workReportSource: WorkReportSource;
  /** Non-null when an active route failed its WorkReport contract. */
  workReportViolation: string | null;
  /** A terminal capacity_exhausted context signal was observed this attempt. */
  contextTerminalExhausted: boolean;
}

/** Outcome class the run-level terminal maps onto lifecycle/facts. */
export type AttemptOutcomeClass = "clean" | "veto" | "contract_failure" | "interrupted";

export interface FinalizeAttemptResult {
  /** Final deliverable presence (a completed claim never invents evidence). */
  deliverablePresent: boolean;
  /** Final harness-error state (a contract failure elevates it). */
  harnessErrored: boolean;
  workState: WorkState;
  /** Typed reason for the veto/failure; null on a clean outcome. */
  reason: RunReason | null;
  outcomeClass: AttemptOutcomeClass;
}

/**
 * The unified finalizer. Precedence (hardest signal wins):
 *   1. terminal context exhaustion with no completed report ⇒ interrupted;
 *   2. a broken WorkReport contract on a constrained route ⇒ hard failure
 *      (never prose-success);
 *   3. a valid needs_input/incomplete report ⇒ veto (lifecycle stays, run is
 *      non-applyable, exit non-zero) — a `completed` claim NEVER overrides a
 *      harness error / failed gate / missing evidence;
 *   4. otherwise the disclosed work_state (completed or unverified).
 */
export function finalizeAttempt(input: FinalizeAttemptInput): FinalizeAttemptResult {
  const completed = input.workReport?.state === "completed";

  if (input.contextTerminalExhausted && !completed) {
    return {
      deliverablePresent: input.deliverableEvidence,
      harnessErrored: input.harnessErrored,
      workState: { state: "unverified", source: input.workReportSource },
      reason: "context_capacity_exhausted",
      outcomeClass: "interrupted",
    };
  }

  if (input.workReportViolation) {
    return {
      deliverablePresent: false,
      // A constrained route that promised a WorkReport and broke the contract
      // failed the attempt — it must never terminalize as a prose success.
      harnessErrored: true,
      workState: { state: "unverified", source: input.workReportSource },
      reason: "work_report_contract",
      outcomeClass: "contract_failure",
    };
  }

  const report = input.workReport;
  if (report && (report.state === "needs_input" || report.state === "incomplete")) {
    return {
      deliverablePresent: input.deliverableEvidence,
      harnessErrored: input.harnessErrored,
      workState: {
        state: report.state,
        source: input.workReportSource,
        ...(report.required_inputs.length > 0
          ? { required_inputs: report.required_inputs }
          : {}),
      },
      reason: report.state === "needs_input" ? "input_required" : "work_incomplete",
      outcomeClass: "veto",
    };
  }

  return {
    deliverablePresent: input.deliverableEvidence,
    harnessErrored: input.harnessErrored,
    workState: {
      state: report?.state === "completed" ? "completed" : "unverified",
      source: report ? input.workReportSource : "absent",
    },
    reason: null,
    outcomeClass: "clean",
  };
}
