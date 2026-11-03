import { HarnessSpeech } from "@claudexor/schema";
import { StreamEcho } from "@claudexor/util";
import { sealedReviewTranscriptChunk } from "./sealedReviewEnvelope.js";

/** One transcript append and the complete current parser input for this try. */
export interface ReviewerTextChunk {
  transcript: string;
  parsed: string;
}

/**
 * One reviewer try's message text, projected twice. The saved transcript keeps
 * every byte (`sealedReviewTranscriptChunk`): stream fragments join exactly and
 * every complete message (whole, buffered or the typed final) has its own line.
 * The parser input is the same text without an exact repetition, so one answer
 * is parsed once: a complete message that repeats streamed text, as the
 * retained-output projection decides it too (`StreamEcho`: the unkeyed fragments
 * since the last complete message from the start of one run, across tool calls
 * and other events, or the previous complete message), adds only its line end.
 * Its streamed copy then starts its own parser-input line where the repeated
 * text began, which is always where a run began, as the complete message would
 * have. Text a speech key identifies is linked by its key, never by this rule:
 * it is parsed as captured, unless the harness states that the speech will never
 * be completed: its fragments then leave the parser input, so their unfinished
 * syntax cannot hold a later response, while the transcript keeps them. Only
 * identical text collapses: a final that differs from its draft is parsed as well.
 */
export class ReviewerTextProjection {
  private readonly echo = new StreamEcho();
  /** Parser-input offset where each fragment since the last complete message began. */
  private fragmentAt: number[] = [];
  /** Parser-input ranges of keyed fragments whose speech is neither complete nor abandoned. */
  private openSpeech: { key: string; start: number; end: number }[] = [];
  private openLine = false;
  private parsedText = "";

  next(event: unknown): ReviewerTextChunk | null {
    const record = isRecord(event) ? event : {};
    const payload = isRecord(record["payload"]) ? record["payload"] : {};
    const speech = HarnessSpeech.safeParse(record["speech"]).data;
    if (record["type"] !== "message" || payload["auth_switched"] === true) {
      this.echo.interrupt();
      return speech?.op === "abandoned" ? this.abandon(speech.key) : null;
    }
    const transcript = sealedReviewTranscriptChunk(event, this.openLine);
    if (transcript === null) return null;
    const text = record["text"] as string;
    let parsed = transcript;
    if (speech && speech.op !== "abandoned") {
      this.echo.reset();
      this.fragmentAt = [];
      const start = this.parsedText.length;
      const last = this.openSpeech.at(-1);
      if (payload["delta"] !== true)
        this.openSpeech = this.openSpeech.filter((r) => r.key !== speech.key);
      else if (last?.key === speech.key && last.end === start) last.end += parsed.length;
      else this.openSpeech.push({ key: speech.key, start, end: start + parsed.length });
    } else if (payload["delta"] === true) {
      this.echo.fragment(text);
      this.fragmentAt.push(this.parsedText.length);
    } else {
      const repeated = this.echo.complete(text, {
        buffered: payload["buffered"] === true,
        final: record["final"] === true,
      });
      if (repeated !== null) {
        // Parser input only: the captured transcript bytes stay unchanged.
        if (repeated !== "previous") this.startLineAt(this.fragmentAt[repeated]!);
        parsed = this.openLine ? "\n" : "";
      }
      this.fragmentAt = [];
    }
    this.openLine = !transcript.endsWith("\n");
    this.parsedText += parsed;
    return { transcript, parsed: this.parsedText };
  }

  /** Start a parser-input line at `offset` unless one already starts there. */
  private startLineAt(offset: number): void {
    const prefix = this.parsedText.slice(0, offset);
    if (prefix !== "" && !prefix.endsWith("\n")) {
      this.parsedText = `${prefix}\n${this.parsedText.slice(offset)}`;
    }
  }

  /** Remove an abandoned speech's open fragments from the parser input (never
   * from the transcript); every later offset moves back with them. */
  private abandon(key: string): ReviewerTextChunk | null {
    const cut = this.openSpeech.filter((range) => range.key === key);
    if (cut.length === 0) return null;
    for (const { start, end } of cut.reverse()) {
      const shift = (at: number) => (at >= end ? at - (end - start) : at);
      this.parsedText = this.parsedText.slice(0, start) + this.parsedText.slice(end);
      this.fragmentAt = this.fragmentAt.map(shift);
      for (const range of this.openSpeech)
        [range.start, range.end] = [shift(range.start), shift(range.end)];
    }
    this.openSpeech = this.openSpeech.filter((range) => range.key !== key);
    return { transcript: "", parsed: this.parsedText };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
