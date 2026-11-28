import { HarnessSpeech } from "@claudexor/schema";
import { StreamEcho } from "@claudexor/util";

export interface TextBlock {
  text: string;
  first: number;
  last: number;
  delta: boolean;
  final: boolean;
  /** The adapter-issued speech key: every fragment and the complete text of that key are this block. */
  key?: string;
  /** The harness's complete text of the keyed block replaced its fragments. */
  complete?: boolean;
  /** Cursor names a model call on buffered snapshots; its deltas and flush may be unlabelled. */
  modelCallId?: string;
  /** A complete message held outside `blocks`: the streamed blocks it exactly repeats. */
  forms?: TextBlock[];
}

export interface SourceOutput {
  attempt: string;
  harness: string;
  session: string;
  blocks: TextBlock[];
  /** Keyed blocks by speech key; a key never names two blocks or merges with another key. */
  keyed: Map<string, TextBlock>;
  /** The block the last text event reached: the only one an unkeyed repetition can continue. */
  current?: TextBlock;
  openDelta: boolean;
  pendingFlush: boolean;
  /** Which complete message exactly repeats this stream's unkeyed fragments; the
   * reviewer parser input reads the same rule. */
  echo: StreamEcho;
  /** The block of each unkeyed fragment since the last complete message, in the echo's order. */
  fragments: TextBlock[];
  /** The block of the last final AnswerAssembly accepts (null when that final has no
   * visible text, only machine truth); absent while none was accepted. */
  answer?: TextBlock | null;
}

export function newAssistantSource(
  attempt: string,
  harness: string,
  session: string,
): SourceOutput {
  return {
    attempt,
    harness,
    session,
    blocks: [],
    keyed: new Map(),
    openDelta: false,
    pendingFlush: false,
    echo: new StreamEcho(),
    fragments: [],
  };
}

/** Fold one stored event within its own physical assistant stream. */
export function observeAssistantText(
  source: SourceOutput,
  p: Record<string, unknown>,
  seq: number,
): void {
  const payload = p["payload"] as Record<string, unknown> | null | undefined;
  if (p["type"] !== "message" || payload?.["auth_switched"] === true) {
    source.openDelta = false;
    source.pendingFlush = false;
    source.echo.interrupt();
    return;
  }
  const text = p["text"];
  const delta = payload?.["delta"] === true;
  const final = p["final"] === true;
  // AnswerAssembly accepts a typed final that is no fragment or snapshot and has
  // display text or machine truth; the last one accepted is the answer.
  const accepted =
    final &&
    !delta &&
    payload?.["buffered"] !== true &&
    ((typeof text === "string" && text.trim() !== "") ||
      typeof payload?.["work_report_envelope"] === "string");
  if (typeof text !== "string" || text.length === 0) {
    if (accepted) source.answer = null;
    return;
  }
  const block = textBlock(source, seq, text, delta, final, p["speech"], payload);
  source.current = block;
  source.openDelta = delta;
  source.pendingFlush = payload?.["buffered"] === true;
  if (accepted) source.answer = text.trim() ? block : null;
}

/**
 * The block one text event belongs to. A keyed event (`speech`, typed only) is
 * its key's block wherever that block began: fragments extend it verbatim until
 * the harness's complete text replaces them, and another key is another block
 * even for equal words. An unkeyed event has no identity of its own: it
 * continues only the block the last text event reached, and only in the shapes
 * one speech takes on the wire (an open unkeyed delta run, or an exact
 * repetition of text just streamed or flushed, or of that block by a typed
 * final), or completes the keyed run its adapter names (`joinedRun`). A block
 * that holds a typed final is closed, since what follows is another native
 * turn. An unkeyed complete message that exactly repeats this stream's unkeyed
 * fragments across tool calls (`StreamEcho`: an Antigravity result repeating
 * its whole turn, an ACP final the text after its last tool) adds no block: its
 * text stays in the streamed blocks it names. Anything else is a separate
 * segment.
 */
function textBlock(
  source: SourceOutput,
  seq: number,
  text: string,
  delta: boolean,
  final: boolean,
  rawSpeech: unknown,
  payload: Record<string, unknown> | null | undefined,
): TextBlock {
  const speech = HarnessSpeech.safeParse(rawSpeech).data;
  if (speech && speech.op !== "abandoned") {
    // Keyed text is linked by its key, never by the unkeyed echo's words.
    source.echo.reset();
    source.fragments = [];
    const known = source.keyed.get(speech.key);
    if (!known) {
      const block: TextBlock = {
        text,
        first: seq,
        last: seq,
        delta: speech.op === "fragment",
        final,
        key: speech.key,
        complete: speech.op === "complete",
      };
      source.blocks.push(block);
      source.keyed.set(speech.key, block);
      return block;
    }
    if (speech.op === "complete") {
      known.text = text;
      known.complete = true;
      known.delta = false;
    } else if (!known.complete) known.text += text;
    known.last = seq;
    known.final ||= final;
    return known;
  }
  const current = source.current;
  if (delta) {
    const continues = source.echo.fragment(text);
    let block = current;
    if (continues && block) {
      block.text += text;
      block.last = seq;
    } else {
      block = { text, first: seq, last: seq, delta, final };
      source.blocks.push(block);
    }
    source.fragments.push(block);
    return block;
  }
  const buffered = payload?.["buffered"] === true;
  const call = buffered && source.harness === "cursor" ? payload?.["model_call_id"] : undefined;
  const modelCallId = typeof call === "string" && call ? call : undefined;
  const distinctCall = modelCallId && current?.modelCallId && modelCallId !== current.modelCallId;
  const repeated = source.echo.complete(text, { buffered, final });
  const repeats =
    typeof repeated === "number" ? [...new Set(source.fragments.slice(repeated))] : [];
  source.fragments = [];
  const joined = joinedRun(source, seq, text, final, payload);
  if (joined) return joined;
  if (
    current &&
    !current.final &&
    !distinctCall &&
    current.text === text &&
    (source.openDelta || source.pendingFlush || final || buffered)
  ) {
    // Exact adjacent delta/flush/final repetition, never a semantic or substring match.
    current.last = seq;
    current.delta = false;
    current.final ||= final;
    if (modelCallId) current.modelCallId = modelCallId;
    return current;
  }
  const block: TextBlock = {
    text,
    first: seq,
    last: seq,
    delta,
    final,
    ...(modelCallId ? { modelCallId } : {}),
  };
  if (repeated !== null && !(distinctCall && repeated === "previous"))
    return { ...block, forms: repeats };
  source.blocks.push(block);
  return block;
}

/**
 * A frame whose adapter names the keyed run it joins (`payload.joined_speech_keys`,
 * Claude's `text_runs_joined` frame) is that run's complete form only when the
 * named blocks are this source's last blocks in that order, none complete or
 * final, and its text is exactly theirs joined. They become one block; on any
 * other shape every block stays as recorded and the frame is its own segment.
 */
function joinedRun(
  source: SourceOutput,
  seq: number,
  text: string,
  final: boolean,
  payload: Record<string, unknown> | null | undefined,
): TextBlock | undefined {
  const keys = payload?.["joined_speech_keys"];
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  const run = source.blocks.slice(-keys.length);
  if (
    run.length !== keys.length ||
    run.some((block, i) => block.key !== keys[i] || block.complete || block.final) ||
    run.map((block) => block.text).join("") !== text
  ) {
    return undefined;
  }
  const [block, ...rest] = run as [TextBlock, ...TextBlock[]];
  source.blocks.length -= rest.length;
  for (const other of rest) source.keyed.set(other.key!, block);
  Object.assign(block, { text, last: seq, delta: false, complete: true, final });
  return block;
}
