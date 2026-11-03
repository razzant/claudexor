/**
 * Exact echo of one physical message stream's own unkeyed text, shared by the
 * projections that read it (retained output, reviewer parser input) so they
 * agree on WHICH complete message repeats streamed text; each keeps its own
 * presentation. A complete message (whole, buffered snapshot or typed final)
 * repeats the fragments (`payload.delta`) since the last complete message when
 * its text is byte-identical to their concatenation from the start of one run
 * of fragments to the end: all of them, or the runs after a tool call or
 * another event (an Antigravity result repeats its whole turn; an ACP final,
 * the text after its last tool). A suffix that begins inside a run is not a
 * repetition. With no fragment since, it repeats the previous complete message
 * when equal to it, unless that message was a typed final, which ends its
 * native turn. Only a message adjacent to that text may repeat it: one that
 * directly follows a fragment or a buffered snapshot, or is itself buffered or
 * a typed final. Text whose identity its adapter states (a speech key) is never
 * part of this rule (`reset`). Never a substring, prefix, trimmed or semantic
 * match.
 */
export class StreamEcho {
  /** Fragments since the last complete message, joined exactly. */
  private fragments = "";
  /** Offset in `fragments` where each run of fragments began -> the ordinal of its first fragment. */
  private runs = new Map<number, number>();
  /** Fragments since the last complete message. */
  private count = 0;
  private previous: string | null = null;
  private openFragment = false;
  private pendingSnapshot = false;

  /** Any other event of this stream (tool call, thinking, status, auth switch). */
  interrupt(): void {
    this.openFragment = false;
    this.pendingSnapshot = false;
  }

  /** Text whose identity its adapter states (a speech key): nothing before it is
   * repeated by what follows, and it repeats nothing. Everything starts over. */
  reset(): void {
    this.fragments = "";
    this.runs.clear();
    this.count = 0;
    this.previous = null;
    this.openFragment = false;
    this.pendingSnapshot = false;
  }

  /** One non-empty fragment. True when it continues the open fragment run (no
   * other event since the previous fragment), false when it starts a run. */
  fragment(text: string): boolean {
    const continues = this.openFragment;
    if (!continues) this.runs.set(this.fragments.length, this.count);
    this.count += 1;
    this.fragments += text;
    this.openFragment = true;
    this.pendingSnapshot = false;
    return continues;
  }

  /** One non-empty complete message. Returns what it repeats exactly: the
   * ordinal (since the last complete message) of the fragment where the
   * repeated text begins, `"previous"` for the previous complete message, or
   * null. Either way it then becomes the previous complete message, unless it is
   * a typed final. */
  complete(text: string, kind: { buffered: boolean; final: boolean }): number | "previous" | null {
    const adjacent = this.openFragment || this.pendingSnapshot || kind.buffered || kind.final;
    let repeated: number | "previous" | null = null;
    if (adjacent && this.count === 0) {
      if (text === this.previous) repeated = "previous";
    } else if (adjacent && this.fragments.endsWith(text)) {
      repeated = this.runs.get(this.fragments.length - text.length) ?? null;
    }
    this.fragments = "";
    this.runs.clear();
    this.count = 0;
    this.previous = kind.final ? null : text;
    this.openFragment = false;
    this.pendingSnapshot = kind.buffered;
    return repeated;
  }
}
