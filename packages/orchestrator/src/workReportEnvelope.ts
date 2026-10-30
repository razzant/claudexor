/**
 * D-16 WorkReport transport envelope: the spec-build decision
 * (`resolveWorkReportEnvelope`) and the unwrap (`unwrapWorkReportEnvelope`) for
 * every channel, so a route arms exactly the transport the finalizer later
 * reads. PURE (no I/O, no clock); `attemptFinalize.ts` folds the result.
 */
import {
  buildWorkReportEnvelope,
  strictifyOutputSchema,
  WorkReport,
  type HarnessCapabilities,
  type WorkReportSource,
  type WorkReportUnverifiedReason,
} from "@claudexor/schema";

/**
 * How the WorkReport rides the wire for an active envelope (D-16c):
 * - `constrained_json`: the whole final answer IS the `{work_report, output}`
 *   JSON (codex `--output-schema`; claude `--json-schema` WITH a caller schema).
 * - `side_tool`: a `{work_report}`-only schema arms claude's StructuredOutput
 *   TOOL; the markdown final message stays the deliverable and the report rides
 *   the tool payload (surfaced on the final message's `work_report_side_tool`).
 * - `instructed_fence`: no native constraint — the model is ASKED to write its
 *   complete markdown answer, then append a fenced `{work_report}` metadata
 *   block validated off the last fenced JSON (cursor, agy, acp). Because
 *   nothing enforces it, a missing or broken footer is disclosed as an
 *   `unverified` work_state with a typed reason, never a contract failure
 *   (owner decision 2026-10-05); the two native channels stay strict.
 */
export type WorkReportChannel = "constrained_json" | "side_tool" | "instructed_fence";

/** The per-attempt envelope decision made at spec build and consumed by the
 * unwrap. `active` means the orchestrator actually armed a WorkReport transport
 * for this route, so a missing/malformed report is a typed contract failure on
 * the native channels and a disclosed unverified work_state on the instructed
 * fence. */
export interface WorkReportEnvelopeMode {
  active: boolean;
  source: WorkReportSource;
  hasCallerSchema: boolean;
  channel: WorkReportChannel;
  /** Instruction to APPEND to the spec (instructed_fence only); null otherwise. */
  instruction: string | null;
}

/**
 * The instruction appended to an `instructed_fence` (cursor, agy, acp) route so
 * the model emits the WorkReport footer the finalizer validates. No native
 * schema constrains these routes, so the footer is requested and validated off
 * the last fenced JSON block (D-16c). The normal markdown before that footer is
 * the deliverable; a historical fence-only `output` remains a read fallback. A
 * footer that is missing or broken leaves the run's work_state `unverified`
 * (the instruction says so) — it never fails the run.
 */
export const WORK_REPORT_FENCE_INSTRUCTION = [
  "Write your complete final answer as normal Markdown.",
  "When you have finished, append a single fenced ```json code block",
  "containing exactly this object and nothing after it:",
  '{"work_report": {"state": "completed" | "needs_input" | "incomplete",',
  '"required_inputs": [{"kind": "file"|"context"|"credential"|"permission"|"decision"|"external_dependency",',
  '"locator": string|null, "description": string}]}}.',
  "Do not duplicate or summarize your answer inside this block.",
  'Use state "completed" only when the task is fully done with an empty required_inputs list;',
  'use "needs_input" (with at least one required_inputs entry) when you are blocked on a missing input;',
  'use "incomplete" when partial work remains.',
  "Always end with this block; without a valid one the engine records your work state as unverified.",
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
  // `--json-schema` × interactive stream-json is live-verified (claude
  // 2.1.221) and CALLER schemas now ride interactive lanes (the DT2.1-16
  // refusal is gone). The WorkReport side_tool envelope stays gated on
  // interactive lanes as a DELIBERATE scope choice: arming a work-report
  // tool on every interactive run is a behavior change with its own
  // verification debt, not implied by the caller-schema verification. The
  // inactive branch below still carries the caller schema through.
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
 * validator must see — never a valid envelope or footer; on an instructed
 * footer problem it is the complete answer text. */
export interface UnwrappedAnswer {
  deliverable: string;
  workReport: WorkReport | null;
  source: WorkReportSource;
  /** Non-null when an active NATIVE route (constrained_json, side_tool) failed
   * to carry a valid WorkReport — a typed contract failure. */
  contractViolation: string | null;
  /** Parsed model claim retained as evidence only; never a valid WorkReport. */
  reportProblem?: { kind: "completed_with_required_inputs"; reported: WorkReport };
  /** Set when an INSTRUCTED footer (instructed_fence) yielded no valid report:
   * the answer stays whole and the work_state is disclosed as unverified. */
  unverified?: UnverifiedWorkReport;
}

/** The disclosed cause of an unverified work_state on an instructed-fence route. */
export interface UnverifiedWorkReport {
  reason: WorkReportUnverifiedReason;
  detail: string;
}

/** The `output` slot of a constrained `{work_report, output}` envelope (or a
 * historical fence-only Cursor envelope), resolved to the deliverable string,
 * or a typed contract violation when the slot is malformed. */
type ExtractedOutput = { deliverable: string } | { violation: string };

function extractOutput(
  obj: Record<string, unknown>,
  mode: WorkReportEnvelopeMode,
): ExtractedOutput {
  const output = obj["output"];
  if (mode.hasCallerSchema) {
    // Re-serialize the S-conformant object so finalizeStructuredOutput can
    // JSON.parse + validate it against the caller schema (the caller schema is
    // the conformance authority for `output`, so any shape rides through here).
    return { deliverable: output === undefined ? "" : JSON.stringify(output) };
  }
  // No caller schema: `output` MUST be a string deliverable. A non-string
  // (object/array/null/number/bool) or missing `output` is a BROKEN envelope —
  // coercing it (String({...}) => "[object Object]") would let a bogus payload
  // like {"work_report":{"state":"completed"},"output":{}} finalize CLEAN
  // instead of failing the WorkReport contract. Fail it here (D-16 §2).
  if (typeof output !== "string") {
    return { violation: "work_report envelope output must be a string" };
  }
  return { deliverable: output };
}

/** Extract the LAST fenced ```…``` block's body (its optional language tag
 * stripped) and the complete prefix before its opening fence, or null when the
 * text has no closed fence. No-regex, mechanical transport parsing (INV-049
 * governs the typed WorkReport, not this seam). */
function lastFencedBlock(text: string): { body: string; prefix: string } | null {
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
  return {
    body: inner.trim(),
    // Remove only the separator before the metadata footer. The caller owns
    // any further presentation trimming; all authored markdown stays intact.
    prefix: text.slice(0, start).trimEnd(),
  };
}

/**
 * Un-nest the WorkReport envelope from an active route's answer (D-16 §2). The
 * behavior forks on `mode.channel`:
 * - `constrained_json`: the whole answer IS `{work_report, output}` JSON; a
 *   broken envelope is a typed contract violation.
 * - `side_tool`: the answer text IS the markdown deliverable; the report rides
 *   `opts.sideToolReport` (the tool payload the adapter surfaced); a missing or
 *   malformed tool report is a typed contract violation.
 * - `instructed_fence`: the LAST fenced JSON block carries metadata; the
 *   markdown before it is the deliverable. Historical fence-only envelopes
 *   fall back to their string `output`. A missing or broken footer is NOT a
 *   violation: see `unwrapInstructedFence`.
 * A non-active mode passes the answer through untouched. The WorkReport
 * cross-field rules (completed ⇒ no required_inputs; needs_input ⇒ ≥1) are
 * enforced HERE so a broken report never passes as a valid one.
 *
 * For a `constrained_json` route `answerText` is the raw `{work_report, output}`
 * envelope (codex #19816 / QA-009: the orchestrator passes `answer.machineText()`,
 * which yields the raw envelope even when the codex adapter pre-unwrapped the
 * DISPLAY copy of the final message — the visible stream sees the output, the
 * un-nest here still sees the envelope).
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
  const violation = (contractViolation: string): UnwrappedAnswer => ({
    deliverable: answerText,
    workReport: null,
    source: mode.source,
    contractViolation,
  });
  // side_tool: the markdown answer stays the deliverable; the report is the tool
  // payload. A missing/malformed tool report is a typed contract failure.
  if (mode.channel === "side_tool") {
    if (opts.sideToolReport === undefined)
      return violation("the StructuredOutput tool did not carry a work_report");
    return validateWorkReport(answerText, opts.sideToolReport, mode.source);
  }
  if (mode.channel === "instructed_fence") return unwrapInstructedFence(answerText, mode);
  let parsed: unknown;
  try {
    parsed = JSON.parse(answerText.trim());
  } catch {
    return violation("final answer is not the JSON work_report envelope");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return violation("work_report envelope is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const extracted = extractOutput(obj, mode);
  if ("violation" in extracted) return violation(extracted.violation);
  return validateWorkReport(extracted.deliverable, obj["work_report"], mode.source);
}

/**
 * The instructed fence (cursor, agy, acp): the model was ASKED for a trailing
 * fenced `{work_report}` block; nothing constrains it natively, so a missing or
 * broken footer is a disclosed `unverified` work_state with a typed reason,
 * never a failure (owner decision 2026-10-05, partially revising the 2026-10-04
 * strict reading; the two native channels stay strict because there the
 * envelope is the only witness of a substituted final).
 *
 * Every unverified outcome keeps the COMPLETE answer text as the deliverable:
 * nothing is cut. A trailing fence that is not a footer — prose, code, an
 * array, an object without `work_report` — is the consumer's own content, and
 * a broken footer attempt stays visible too, so a malformed `needs_input`
 * claim is never hidden from the reader (the contradiction claim is also
 * retained as typed evidence). Only a VALID report is metadata and leaves the
 * deliverable: the prefix is the answer (completed → completed;
 * needs_input/incomplete → veto), and a historical fence-only
 * `{work_report, output}` reply yields its string output.
 */
function unwrapInstructedFence(answerText: string, mode: WorkReportEnvelopeMode): UnwrappedAnswer {
  const unverified = (reason: WorkReportUnverifiedReason, detail: string): UnwrappedAnswer => ({
    deliverable: answerText,
    workReport: null,
    source: mode.source,
    contractViolation: null,
    unverified: { reason, detail },
  });
  const fenced = lastFencedBlock(answerText);
  if (fenced === null)
    return unverified("footer_missing", "final answer has no fenced work_report block");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.body);
  } catch {
    return unverified("footer_not_json", "the last fenced block is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return unverified("footer_not_object", "the last fenced block is not a JSON object");
  const obj = parsed as Record<string, unknown>;
  if (!("work_report" in obj))
    return unverified("report_missing", "the last fenced block carries no work_report");
  const check = checkWorkReport(obj["work_report"]);
  if (!check.ok) {
    return {
      ...unverified(check.reason, check.detail),
      ...(check.reportProblem ? { reportProblem: check.reportProblem } : {}),
    };
  }
  // The complete normal markdown is canonical. The legacy output slot is
  // consulted only for historical fence-only replies; when both exist the
  // prefix wins deterministically, without length/heading heuristics that
  // could silently replace a full answer with a summary. A footer-only reply
  // is still a valid report with an empty deliverable (each consumer keeps its
  // product rule: Ask/report may surface "(no output)", Plan/reducer need prose).
  const prefix = fenced.prefix.trim() ? fenced.prefix : null;
  let deliverable = prefix ?? "";
  if (prefix === null && obj["output"] !== undefined) {
    const extracted = extractOutput(obj, mode);
    if ("violation" in extracted) {
      // An unusable historical output slot never downgrades a valid veto: the
      // needs_input/incomplete report stands and the whole reply is kept.
      if (check.report.state === "completed")
        return unverified("legacy_output_invalid", extracted.violation);
      deliverable = answerText;
    } else {
      deliverable = extracted.deliverable;
    }
  }
  return { deliverable, workReport: check.report, source: mode.source, contractViolation: null };
}

type WorkReportCheck =
  | { ok: true; report: WorkReport }
  | {
      ok: false;
      reason: "report_malformed" | "report_contradictory";
      detail: string;
      reportProblem?: UnwrappedAnswer["reportProblem"];
    };

/** Parse + cross-field-check a raw work_report value. The cross-field rules
 * (completed ⇒ no required_inputs; needs_input ⇒ ≥1) live HERE, not on the
 * permissive Zod wire type. */
function checkWorkReport(rawReport: unknown): WorkReportCheck {
  const wr = WorkReport.safeParse(rawReport);
  if (!wr.success) {
    return {
      ok: false,
      reason: "report_malformed",
      detail: `work_report missing or malformed: ${wr.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  // The model-authored locator/description strings flow verbatim into
  // telemetry yaml, decision facts, the CLI needsInputLabel and the next turn:
  // they are working content and stay exact (INV-146).
  const report: WorkReport = wr.data;
  if (report.state === "completed" && report.required_inputs.length > 0) {
    return {
      ok: false,
      reason: "report_contradictory",
      detail: "a completed work_report must not list required_inputs",
      reportProblem: { kind: "completed_with_required_inputs", reported: report },
    };
  }
  if (report.state === "needs_input" && report.required_inputs.length === 0) {
    return {
      ok: false,
      reason: "report_contradictory",
      detail: "a needs_input work_report must list at least one required_input",
    };
  }
  return { ok: true, report };
}

/** Validate a raw work_report for a NATIVE channel against a resolved
 * deliverable: a malformed or contradictory report is a typed contract
 * violation (the contradiction claim is retained as evidence). */
function validateWorkReport(
  deliverable: string,
  rawReport: unknown,
  source: WorkReportSource,
): UnwrappedAnswer {
  const check = checkWorkReport(rawReport);
  if (check.ok) return { deliverable, workReport: check.report, source, contractViolation: null };
  return {
    deliverable,
    workReport: null,
    source,
    contractViolation: check.detail,
    ...(check.reportProblem ? { reportProblem: check.reportProblem } : {}),
  };
}
