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

/**
 * How the WorkReport rides the wire for an active envelope (D-16c):
 * - `constrained_json`: the whole final answer IS the `{work_report, output}`
 *   JSON (codex `--output-schema`; claude `--json-schema` WITH a caller schema).
 * - `side_tool`: a `{work_report}`-only schema arms claude's StructuredOutput
 *   TOOL; the markdown final message stays the deliverable and the report rides
 *   the tool payload (surfaced on the final message's `work_report_side_tool`).
 * - `instructed_fence`: no native constraint — the model is INSTRUCTED to end
 *   its answer with a fenced `{work_report, output}` JSON block, validated off
 *   the last fenced JSON (cursor).
 */
export type WorkReportChannel = "constrained_json" | "side_tool" | "instructed_fence";

/** The per-attempt envelope decision made at spec build and consumed by the
 * unwrap. `active` means the orchestrator actually armed a WorkReport transport
 * for this route, so a missing/malformed report is a typed contract failure. */
export interface WorkReportEnvelopeMode {
  active: boolean;
  source: WorkReportSource;
  hasCallerSchema: boolean;
  channel: WorkReportChannel;
  /** Instruction to APPEND to the spec (instructed_fence only); null otherwise. */
  instruction: string | null;
}

/**
 * The instruction appended to an `instructed_fence` (cursor) route so the model
 * emits the WorkReport envelope the finalizer validates. No native schema
 * constrains cursor, so the contract is instructed and validated off the last
 * fenced JSON block (D-16c). The `output` string carries the deliverable prose.
 */
export const WORK_REPORT_FENCE_INSTRUCTION = [
  "When you have finished, end your reply with a single fenced ```json code block",
  "containing exactly this object and nothing after it:",
  '{"work_report": {"state": "completed" | "needs_input" | "incomplete",',
  '"required_inputs": [{"kind": "file"|"context"|"credential"|"permission"|"decision"|"external_dependency",',
  '"locator": string|null, "description": string}]}, "output": "<your final answer as a string>"}.',
  'Use state "completed" only when the task is fully done with an empty required_inputs list;',
  'use "needs_input" (with at least one required_inputs entry) when you are blocked on a missing input;',
  'use "incomplete" when partial work remains. This block is mandatory.',
].join(" ");

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
 * Activated HERE directly for `constrained` routes that natively constrain
 * output and are not interactive-gated (the WorkReport rides the
 * `{work_report, output}` envelope; claude's no-caller `side_tool` case instead
 * arms a `{work_report}`-only schema on the StructuredOutput tool so the markdown
 * final stays the deliverable — the D-16c seam), and for `validated` routes
 * (cursor), where the report rides an INSTRUCTED fenced envelope. Only
 * interactive-gated and schema-incapable routes stay inactive here (disclosed
 * `absent` work_state).
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

  // `validated` transport (cursor): no native schema constrains the output —
  // the WorkReport rides an INSTRUCTED fenced envelope validated off the last
  // fenced JSON (D-16c). Caller schemas on such routes were already refused by
  // the mandatory-schema gate upstream, so this is the WorkReport-only case.
  if (opts.transport === "validated" && !interactiveGated) {
    return {
      outputSchema: callerStrict ?? undefined,
      mode: {
        active: true,
        source: "validated",
        hasCallerSchema,
        channel: "instructed_fence",
        instruction: WORK_REPORT_FENCE_INSTRUCTION,
      },
    };
  }

  const active =
    opts.transport === "constrained" && opts.supportsJsonSchemaOutput && !interactiveGated;

  if (active) {
    // claude side_tool WITHOUT a caller schema (D-16c): arm a {work_report}-only
    // schema on the StructuredOutput tool; the markdown final message stays the
    // deliverable and the report rides the tool payload. Every other constrained
    // case carries the output INSIDE the `{work_report, output}` envelope
    // (caller schema → the strict S; no-caller final_message → output:string).
    if (opts.channel === "side_tool" && !hasCallerSchema) {
      return {
        outputSchema: buildWorkReportEnvelope(null),
        mode: {
          active: true,
          source: "constrained",
          hasCallerSchema,
          channel: "side_tool",
          instruction: null,
        },
      };
    }
    const output: Record<string, unknown> | "string" = hasCallerSchema
      ? (callerStrict as Record<string, unknown>)
      : "string";
    return {
      outputSchema: buildWorkReportEnvelope(output),
      mode: {
        active: true,
        source: "constrained",
        hasCallerSchema,
        channel: "constrained_json",
        instruction: null,
      },
    };
  }
  return {
    // Legacy path preserved: a caller schema still rides (strictified) on a
    // non-activated route (the mandatory-schema gate already refused
    // schema-incapable routes upstream).
    outputSchema: callerStrict ?? undefined,
    mode: {
      active: false,
      source: "absent",
      hasCallerSchema,
      channel: "constrained_json",
      instruction: null,
    },
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

/** Extract the LAST fenced ```…``` block's body (its optional language tag
 * stripped), or null when the text has no closed fence. No-regex, mechanical
 * transport parsing (INV-049 governs the typed WorkReport, not this seam). */
function lastFencedBlock(text: string): string | null {
  const FENCE = "```";
  const end = text.lastIndexOf(FENCE);
  if (end <= 0) return null;
  const start = text.lastIndexOf(FENCE, end - 1);
  if (start < 0) return null;
  let inner = text.slice(start + FENCE.length, end);
  const nl = inner.indexOf("\n");
  if (nl >= 0) {
    const firstLine = inner.slice(0, nl).trim();
    // A bare language tag (letters/digits/±_-, no whitespace) on the opening
    // line is dropped; a first line that is already JSON content is kept.
    const isLangTag =
      firstLine.length > 0 &&
      firstLine.length <= 20 &&
      ![...firstLine].some((ch) => ch === " " || ch === "{" || ch === "[" || ch === '"');
    if (firstLine === "" || isLangTag) inner = inner.slice(nl + 1);
  }
  return inner.trim();
}

/**
 * Un-nest the WorkReport envelope from an active route's answer (D-16 §2). The
 * behavior forks on `mode.channel`:
 * - `constrained_json`: the whole answer IS `{work_report, output}` JSON.
 * - `instructed_fence`: the envelope is the LAST fenced JSON block; prose
 *   before it is discarded (the `output` string is the deliverable).
 * - `side_tool`: the answer text IS the markdown deliverable; the report rides
 *   `opts.sideToolReport` (the tool payload the adapter surfaced).
 * A non-active mode passes the answer through untouched. The WorkReport
 * cross-field rules (completed ⇒ no required_inputs; needs_input ⇒ ≥1) are
 * enforced HERE so a broken report is a typed contract violation.
 */
export function unwrapWorkReportEnvelope(
  answerText: string,
  mode: WorkReportEnvelopeMode,
  opts: { sideToolReport?: unknown } = {},
): UnwrappedAnswer {
  if (!mode.active) {
    return {
      deliverable: answerText,
      workReport: null,
      source: mode.source,
      contractViolation: null,
    };
  }
  // side_tool: the markdown answer stays the deliverable; the report is the tool
  // payload. A missing/malformed tool report is a typed contract failure.
  if (mode.channel === "side_tool") {
    if (opts.sideToolReport === undefined) {
      return {
        deliverable: answerText,
        workReport: null,
        source: mode.source,
        contractViolation: "the StructuredOutput tool did not carry a work_report",
      };
    }
    return validateWorkReport(answerText, opts.sideToolReport, mode.source);
  }
  let text = answerText.trim();
  if (mode.channel === "instructed_fence") {
    const fenced = lastFencedBlock(answerText);
    if (fenced === null) {
      return {
        deliverable: answerText,
        workReport: null,
        source: mode.source,
        contractViolation: "final answer has no fenced work_report envelope",
      };
    }
    text = fenced;
  }
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
  return validateWorkReport(deliverable, obj["work_report"], mode.source);
}

/** Parse + cross-field-validate a raw work_report value against a resolved
 * deliverable. The cross-field rules (completed ⇒ no required_inputs;
 * needs_input ⇒ ≥1) live HERE, not on the permissive Zod wire type. */
function validateWorkReport(
  deliverable: string,
  rawReport: unknown,
  source: WorkReportSource,
): UnwrappedAnswer {
  const wr = WorkReport.safeParse(rawReport);
  if (!wr.success) {
    return {
      deliverable,
      workReport: null,
      source,
      contractViolation: `work_report missing or malformed: ${wr.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  const report = wr.data;
  if (report.state === "completed" && report.required_inputs.length > 0) {
    return {
      deliverable,
      workReport: null,
      source,
      contractViolation: "a completed work_report must not list required_inputs",
    };
  }
  if (report.state === "needs_input" && report.required_inputs.length === 0) {
    return {
      deliverable,
      workReport: null,
      source,
      contractViolation: "a needs_input work_report must list at least one required_input",
    };
  }
  return { deliverable, workReport: report, source, contractViolation: null };
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
        ...(report.required_inputs.length > 0 ? { required_inputs: report.required_inputs } : {}),
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
