/**
 * Evidence-index packet builder — PURE (A10).
 *
 * When no native carrier exists (the vendor refused the moved session, the
 * adapter cannot move, the mind asked for a re-brief), the successor is a
 * FRESH vendor session re-grounded by an EVIDENCE INDEX: the original work
 * order, admitted steering (live messages) with their delivery status, the
 * retained assistant output, a tool-call index (name, completed / unconfirmed
 * command / unresolved),
 * the diff stat and absolute paths to the predecessor's event log and attempt
 * artifacts readable from the new environment. Bounded inline with honest
 * truncation (`summarized` is true also when a single section was cut). No
 * second summarizer, no recap model call.
 *
 * This is NOT the thread continuation packet (`continuity.ts`
 * `buildContinuation`, INV-137): thread turns and the D-16d context-exhaustion
 * continuation keep that packet; the evidence index serves in-run packet hops
 * and `continueFrom`.
 */
import { commandOutcomeLabel, type ResumableCause } from "@claudexor/schema";

/** Admitted steering message of the predecessor (POST /v2/runs/:id/messages). */
export interface EvidenceSteering {
  text: string;
  /** confirmed: the vendor echoed it into its history; uncertain: it may not have been delivered. */
  delivery: "confirmed" | "uncertain";
}

/** Where the I/O collector reads the predecessor's evidence. */
export interface EvidenceIndexSources {
  runDir: string;
  attemptId: string;
  /** Serial attempts of this run whose evidence the source carries, in order
   * (default: `attemptId`); each keeps its own tool-result pairing boundary. */
  attemptIds?: readonly string[];
  workOrder: string;
  /** The complete chain work order file (`context/work-order.md`), when one exists. */
  workOrderPath?: string | null;
  /** The prompt carries the whole work order itself (a route that cannot read files). */
  workOrderInPrompt?: boolean;
  steering: EvidenceSteering[];
  /** Earlier runs, oldest first; each keeps its own tool-result pairing boundary. */
  predecessors?: readonly PredecessorEvidenceSource[];
}

export type PredecessorEvidenceSource = Omit<EvidenceIndexSources, "predecessors"> & {
  retainedOutput: string;
  diffStat: string | null;
};

export interface EvidenceToolCall {
  name: string;
  target: string | null;
  /** True only when a result or a typed completion was recorded for it. */
  resolved: boolean;
  /** A recorded non-ok outcome of that result or completion (completed is not success). */
  outcome?: "error" | "cancelled" | "denied";
  /** The result's stored `command_outcome` (#450), when it reported one. */
  commandOutcome?: unknown;
  /** An untyped edit frame repeated: the repeat may be its completion or another start. */
  unconfirmed?: true;
  /** The attempt that recorded it, when the evidence spans several attempts of one run. */
  attempt?: string;
}

/** Fully-resolved inputs of the pure builder (the collector reads them from the run dir). */
export interface EvidenceIndexInput {
  cause: ResumableCause;
  completed?: boolean;
  workOrder: string;
  workOrderPath?: string | null;
  workOrderInPrompt?: boolean;
  steering: EvidenceSteering[];
  /** The retained assistant output (`final/retained-output.md` or the attempt's answer), "" when none. */
  retainedOutput: string;
  toolCalls: EvidenceToolCall[];
  /** `git diff --stat`-style file list of the predecessor's tree, null when unknown. */
  diffStat: string | null;
  /** Absolute paths readable from the new environment; null when absent. */
  artifacts: { eventsLog: string | null; attemptDir: string | null; patch: string | null };
  predecessorArtifacts?: EvidenceIndexInput["artifacts"][];
}

export interface EvidenceIndex {
  /** The packet body delivered to the successor (bounded). */
  markdown: string;
  /** True when any section was truncated or collapsed. */
  summarized: boolean;
  toolCalls: number;
  unresolvedToolCalls: number;
  bytes: number;
}

/** Per-section verbatim budget. */
export const EVIDENCE_SECTION_BUDGET_BYTES = 8 * 1024;
/** Whole-index budget; the tool index collapses to counts past it. */
export const EVIDENCE_TOTAL_BUDGET_BYTES = 24 * 1024;
/** Tool rows kept verbatim before the index collapses to counts. */
export const EVIDENCE_TOOL_ROWS = 60;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The first `units` UTF-16 code units of `text`, one fewer when that cut would
 * split a surrogate pair (its lone half reads as U+FFFD). Shorter text and a
 * lone surrogate already in the source are kept exactly.
 */
export function wholeCharPrefix(text: string, units: number): string {
  return text.slice(0, (text.codePointAt(units - 1) ?? 0) > 0xffff ? units - 1 : units);
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a safe char boundary. */
function bound(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (bytes(text) <= maxBytes) return { text, cut: false };
  const marker = "\n…[truncated]";
  const buf = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - bytes(marker)));
  for (let trim = 0; trim <= 3 && trim <= buf.length; trim += 1) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        trim === 0 ? buf : buf.subarray(0, buf.length - trim),
      );
      return { text: `${decoded}${marker}`, cut: true };
    } catch {
      /* prefix ended inside a scalar; back off */
    }
  }
  return { text: `${buf.toString("utf8")}${marker}`, cut: true };
}

const CAUSE_LINE: Record<ResumableCause, string> = {
  vendor_limit: "a usage limit on its account",
  pool_exhausted: "every account's usage limit",
  pinned_limit: "the pinned account's usage limit",
  transport: "a process death",
  permission_denied: "a native tool permission refusal",
  context_exhausted: "context exhaustion",
  turn_limit: "the max-turns limit",
  wall_clock: "the wall-clock deadline",
  cancelled: "a cancel",
  host_restart: "a host restart",
  input_required: "a request for input",
  other: "an interruption",
};

/** Pure: render the bounded evidence index for a packet carrier. */
export function buildEvidenceIndex(input: EvidenceIndexInput): EvidenceIndex {
  let summarized = false;
  const section = (text: string): string => {
    const b = bound(text.trim(), EVIDENCE_SECTION_BUDGET_BYTES);
    summarized ||= b.cut;
    return b.text;
  };
  const unresolved = input.toolCalls.filter((call) => !call.resolved);
  const unconfirmed = unresolved.filter((call) => call.unconfirmed).length;
  const workOrder = input.workOrder.trim();
  const shownWorkOrder = bound(workOrder, EVIDENCE_SECTION_BUDGET_BYTES);
  summarized ||= shownWorkOrder.cut;
  const parts: string[] = [
    input.completed
      ? "# Evidence index of the previous work"
      : "# Evidence index of the interrupted work",
    "",
    input.completed
      ? "This index records the completed predecessor's work order, messages and actions. Check the current workspace before relying on its changes."
      : `The previous process stopped (${CAUSE_LINE[input.cause]}) before finishing. This index is mechanical evidence of what it was asked, told and did; it is not a summary. The workspace is as it was left.`,
    "",
    "## Original work order",
    "",
    shownWorkOrder.text || "(empty)",
    ...(shownWorkOrder.cut
      ? [
          `[Work order truncated to the ${EVIDENCE_SECTION_BUDGET_BYTES}-byte section budget; the whole work order is ${bytes(workOrder)} bytes.${input.workOrderInPrompt ? " It is given in full above." : input.workOrderPath ? ` It is complete in the file ${input.workOrderPath}.` : ""}]`,
        ]
      : []),
    "",
  ];
  if (input.steering.length > 0) {
    parts.push("## Messages sent while it ran", "");
    for (const [index, message] of input.steering.entries()) {
      const delivery =
        message.delivery === "confirmed"
          ? "delivered"
          : "delivery uncertain — reconcile against the work, do not replay blindly";
      parts.push(`### Message ${index + 1} (${delivery})`, "", section(message.text), "");
    }
  }
  parts.push("## Retained assistant output", "");
  parts.push(input.retainedOutput.trim() ? section(input.retainedOutput) : "(no output retained)");
  parts.push("", "## Tool calls", "");
  if (input.toolCalls.length === 0) {
    parts.push("(none recorded)");
  } else if (input.toolCalls.length > EVIDENCE_TOOL_ROWS) {
    summarized = true;
    parts.push(
      `${input.toolCalls.length} tool calls recorded, ${unresolved.length - unconfirmed} without a recorded result (cut off)${unconfirmed ? `, ${unconfirmed} with completion not confirmed` : ""}. The last ${EVIDENCE_TOOL_ROWS} follow:`,
      "",
      ...input.toolCalls.slice(-EVIDENCE_TOOL_ROWS).map(toolRow),
    );
  } else {
    parts.push(...input.toolCalls.map(toolRow));
  }
  parts.push("", "## Changed files", "");
  parts.push(input.diffStat && input.diffStat.trim() ? section(input.diffStat) : "(no diff stat)");
  const refs = [
    input.workOrderPath ? `- Complete work order: ${input.workOrderPath}` : null,
    ...[input.artifacts, ...(input.predecessorArtifacts ?? [])].flatMap((artifacts) => [
      artifacts.eventsLog && `- Event log: ${artifacts.eventsLog}`,
      artifacts.attemptDir && `- Attempt artifacts: ${artifacts.attemptDir}`,
      artifacts.patch && `- Patch so far: ${artifacts.patch}`,
    ]),
  ].filter((line): line is string => typeof line === "string");
  const footer = [
    "",
    "",
    "## Full evidence",
    "",
    refs.length ? section(refs.join("\n")) : "(no artifact paths available)",
    "",
    `Tool calls: ${input.toolCalls.length}; unresolved: ${unresolved.length}${unconfirmed ? ` (completion not confirmed: ${unconfirmed})` : ""}.`,
    "",
  ].join("\n");
  const prose = parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const total = bound(prose, EVIDENCE_TOTAL_BUDGET_BYTES - bytes(footer));
  summarized ||= total.cut;
  const markdown = total.text + footer;
  return {
    markdown,
    summarized,
    toolCalls: input.toolCalls.length,
    unresolvedToolCalls: unresolved.length,
    bytes: bytes(markdown),
  };
}

/**
 * The complete work order a route that cannot read files must receive inline
 * (`git_patch_envelope`: its process reads no path), set only when the index
 * would cut it and the prompt does not already carry it. Every other route
 * keeps the bounded section plus the file.
 */
export function readlessWorkOrder(
  route: { implementationTransport?: string } | undefined,
  workOrder: string,
  prompt: string,
): string | null {
  const whole = workOrder.trim();
  return route?.implementationTransport === "git_patch_envelope" &&
    bytes(whole) > EVIDENCE_SECTION_BUDGET_BYTES &&
    !prompt.includes(whole)
    ? whole
    : null;
}

/** Recorded work of the previous run's other processes that a resumed native session never received. */
export interface UncoveredWork {
  /** Steering delivered only to those processes. */
  steering: string[];
  retainedOutput: string;
  toolCalls: EvidenceToolCall[];
  eventsLog: string | null;
}

/** Pure: the bounded, labelled evidence a native resume adds for work outside its session ("" when none). */
export function uncoveredWorkSection(work: UncoveredWork): string {
  if (!work.steering.length && !work.retainedOutput.trim() && !work.toolCalls.length) return "";
  const section = (text: string) => bound(text.trim(), EVIDENCE_SECTION_BUDGET_BYTES).text;
  const parts = [
    "Other processes of the previous run recorded the work below after or apart from the session you are resuming. It is not part of the resumed session's history: reconcile it against the workspace; do not replay it blindly.",
  ];
  if (work.steering.length)
    parts.push(
      `Messages delivered to them:\n\n${work.steering.map((text, i) => `### Message ${i + 1}\n\n${section(text)}`).join("\n\n")}`,
    );
  if (work.retainedOutput.trim()) parts.push(`Their output:\n\n${section(work.retainedOutput)}`);
  if (work.toolCalls.length) {
    const shown = work.toolCalls.slice(-EVIDENCE_TOOL_ROWS);
    parts.push(
      `Their tool calls${shown.length < work.toolCalls.length ? ` (the last ${shown.length} of ${work.toolCalls.length})` : ""}:\n\n${shown.map(toolRow).join("\n")}`,
    );
  }
  // The record's path survives any cut of the prose above it.
  const footer = work.eventsLog ? `\n\nFull record: ${work.eventsLog}` : "";
  return bound(parts.join("\n\n"), EVIDENCE_TOTAL_BUDGET_BYTES - bytes(footer)).text + footer;
}

function toolRow(call: EvidenceToolCall): string {
  const target = call.target ? ` — ${wholeCharPrefix(call.target.replace(/\s+/g, " "), 160)}` : "";
  // A recorded result whose command was moved to the background, timed out or
  // ended unknown is not a completed command (#450).
  const unconfirmed = call.resolved ? commandOutcomeLabel(call.commandOutcome) : null;
  const state = unconfirmed
    ? `unconfirmed: ${unconfirmed}`
    : call.resolved
      ? `completed${call.outcome ? `: ${call.outcome}` : ""}`
      : call.unconfirmed
        ? "completion not confirmed"
        : "unresolved: no result recorded";
  return `- ${call.name}${target} (${state})${call.attempt ? ` · attempt ${call.attempt}` : ""}`;
}
