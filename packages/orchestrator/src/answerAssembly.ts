import { pushUniqueText } from "./runSupport.js";

/**
 * Answer assembly with TYPED finality (W-C1): a harness's `final` message
 * (claude/cursor terminal `result`, codex's finalized last agent message) IS
 * the answer, verbatim — mid-run narration never bleeds into it. The joined
 * narration remains the fallback for adapters/versions without the marker,
 * and the mid-attempt `soFar()` view feeds deliverable-empty retry checks.
 */
export class AnswerAssembly {
  private readonly parts: string[] = [];
  private finalText?: string;

  /** Feed one already-sanitized harness event; non-answer events are ignored. */
  observe(ev: {
    type: string;
    text?: string;
    final?: boolean;
    payload?: Record<string, unknown>;
  }): void {
    if (ev.type !== "message" || !ev.text) return;
    if (ev.payload?.["auth_switched"] === true) return;
    // Live deltas are DISPLAY-stream chunks (W-C4): the complete message
    // always follows — joining chunks here would shred the answer.
    if (ev.payload?.["delta"] === true) return;
    if (ev.final === true) this.finalText = ev.text.trim() || undefined;
    else pushUniqueText(this.parts, ev.text);
  }

  /** The assembled answer: the typed final verbatim, else joined narration. */
  text(): string {
    return this.finalText ?? this.parts.join("\n").trim();
  }
}
