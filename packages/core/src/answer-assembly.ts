/**
 * Answer assembly with TYPED finality (W-C1): a harness's `final` message
 * (claude/cursor terminal `result`, codex's finalized last agent message) IS
 * the answer, verbatim — mid-run narration never bleeds into it. The joined
 * narration remains the fallback for adapters/versions without the marker.
 */
export class AnswerAssembly {
  private readonly parts: string[] = [];
  private finalText?: string;
  /**
   * MACHINE-truth final, decoupled from the DISPLAY final (codex #19816 /
   * QA-009). A codex constrained WorkReport route pre-unwraps its final
   * message's DISPLAY text to the `output` (so the answer bubble + the app's
   * twin-removal see the unwrapped output, not raw JSON) and carries the raw
   * `{work_report, output}` envelope on `payload.work_report_envelope`. The
   * orchestrator un-nests machine truth via `machineText()`, so the display
   * unwrap never breaks the envelope parse; adapters that leave the raw envelope
   * IN the final text (claude) never set this, so `machineText()` === `text()`.
   */
  private machineFinalText?: string;

  /** Feed one already-sanitized harness event; non-answer events are ignored. */
  observe(ev: {
    type: string;
    text?: string;
    final?: boolean;
    payload?: Record<string, unknown>;
  }): void {
    if (ev.type !== "message") return;
    if (ev.payload?.["auth_switched"] === true) return;
    // Live deltas are DISPLAY-stream chunks (W-C4): the complete message
    // always follows — joining chunks here would shred the answer.
    if (ev.payload?.["delta"] === true) return;
    if (ev.final === true) {
      const raw = ev.payload?.["work_report_envelope"];
      const machine = typeof raw === "string" ? raw : undefined;
      const display = ev.text ?? "";
      // A whitespace-only DISPLAY final is NOT an answer and must never erase an
      // earlier real final (review sol #3) — UNLESS it carries machine truth. A
      // codex constrained route legitimately finalizes `output:""` (all its work
      // lived in the work_report): keep the RAW envelope so the orchestrator
      // still un-nests work_state/outcome, with an empty display. Otherwise the
      // accepted final is kept VERBATIM (the documented contract) — no trimming.
      if (display.trim().length === 0 && machine === undefined) return;
      this.finalText = display;
      this.machineFinalText = machine;
      return;
    }
    if (!ev.text) return;
    pushUniqueText(this.parts, ev.text);
  }

  /** Whether a typed final answer has been accepted. */
  hasFinal(): boolean {
    return this.finalText !== undefined;
  }

  /** The assembled answer for DISPLAY: the typed final verbatim, else joined
   * narration. For codex constrained routes this is the UNWRAPPED output. */
  text(): string {
    return this.finalText ?? this.parts.join("\n").trim();
  }

  /** The assembled answer for MACHINE consumption (the WorkReport un-nest): the
   * raw envelope when the adapter pre-unwrapped the display copy, else identical
   * to `text()`. The orchestrator passes THIS to `unwrapWorkReportEnvelope`. */
  machineText(): string {
    return this.machineFinalText ?? this.text();
  }
}

/**
 * Deduplicate the known "final result repeats the last streamed message" shape
 * (adjacent only). Legitimately repeated earlier messages are preserved — a
 * whole-array dedupe would silently merge real output.
 */
function pushUniqueText(parts: string[], text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const last = parts[parts.length - 1]?.trim();
  if (last === normalized) return;
  parts.push(normalized);
}
