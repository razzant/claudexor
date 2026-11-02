import { dirname, join } from "node:path";
import { renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { HarnessSpeech, type RunEvent } from "@claudexor/schema";
import { writeText } from "@claudexor/util";

export const RETAINED_OUTPUT_PATH = "final/retained-output.md";

interface TextBlock {
  text: string;
  first: number;
  last: number;
  delta: boolean;
  final: boolean;
  /** The adapter-issued speech key: every fragment and the complete text of that key are this block. */
  key?: string;
  /** The harness's complete text of the keyed block replaced its fragments. */
  complete?: boolean;
}

interface SourceOutput {
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
  /** The block of the last final AnswerAssembly accepts (null when that final has no
   * visible text, only machine truth); absent while none was accepted. */
  answer?: TextBlock | null;
}

/** What a caller already passes on, so the projection does not repeat it. */
interface CarriedOutput {
  /**
   * @deprecated Accepted so earlier callers still compile, and ignored: carried
   * prose identifies no recorded event, so it never removes a block (#568).
   */
  text?: string;
  /** The native try (attempt, process session) whose answer is carried. Its answer is
   * the LAST typed final AnswerAssembly accepts (a later native turn's final wins),
   * so only that final's own block is omitted: its keyed fragments (with the run a
   * joined frame names) and its exact adjacent delta, flush and complete forms. Its
   * earlier finals and other narration stay, whatever their text. Without an accepted
   * final its joined narration is the answer and the whole try is omitted. Text never
   * decides what is represented. */
  represented?: { attempt: string; session: string };
}

/** Evidence projection only: never chooses an answer, validates a verdict or starts work. */
export function retainedOutput(
  events: Iterable<RunEvent>,
  malformed = 0,
  onlyAdditional = false,
  carried: CarriedOutput = {},
): string | null {
  const sources = new Map<string, SourceOutput>();
  const captured = new Map<string, string[]>();
  for (const event of events) {
    // Later control-audit rows cannot rewrite a committed result.
    if (["run.completed", "run.failed", "run.blocked"].includes(event.type)) break;
    if (
      event.type === "output.ready" &&
      event.payload["kind"] === "artifact" &&
      typeof event.payload["path"] === "string"
    ) {
      const path = event.payload["path"];
      const [root, attempt, directory, ...relative] = path.split("/");
      if (root === "attempts" && attempt && directory === "produced" && relative.join("/"))
        captured.set(attempt, [...(captured.get(attempt) ?? []), path]);
    }
    if (event.type !== "harness.event") continue;
    const p = event.payload;
    const attempt = String(p["attempt_id"] ?? "unknown");
    const harness = String(p["harness_id"] ?? "unknown");
    const session = String(p["session_id"] ?? "unknown");
    const key = JSON.stringify([attempt, harness, session]);
    const source: SourceOutput = sources.get(key) ?? {
      attempt,
      harness,
      session,
      blocks: [],
      keyed: new Map(),
      openDelta: false,
      pendingFlush: false,
    };
    sources.set(key, source);
    const payload = p["payload"] as Record<string, unknown> | null | undefined;
    if (p["type"] !== "message" || payload?.["auth_switched"] === true) {
      source.openDelta = false;
      source.pendingFlush = false;
      continue;
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
      continue;
    }
    const block = textBlock(source, event.seq ?? 0, text, delta, final, p["speech"], payload);
    source.current = block;
    source.openDelta = delta;
    source.pendingFlush = payload?.["buffered"] === true;
    if (accepted) source.answer = text.trim() ? block : null;
  }
  const observed = [...sources.values()]
    .flatMap((source) => source.blocks)
    .filter((block) => block.text.trim());
  if (onlyAdditional && !malformed && !captured.size && observed.length === 1 && observed[0]!.final)
    return null;
  const sections = [...sources.values()].flatMap((source) => {
    const represented =
      carried.represented?.attempt === source.attempt &&
      carried.represented.session === source.session;
    const answer = represented ? source.answer : undefined;
    const blocks = source.blocks.filter((block) => {
      if (!block.text.trim()) return false;
      if (!represented) return true;
      // No accepted final: the joined narration is the answer.
      if (answer === undefined) return false;
      // Only the carried final's own block is represented: equal or contained text
      // elsewhere (another turn, a short "OK" inside "NOT OK") is its own evidence.
      return block !== answer;
    });
    if (!blocks.length) return [];
    return [
      `## Attempt ${source.attempt} · ${source.harness}\n\nSession: \`${source.session}\`\n\n` +
        blocks
          .map(
            (block) =>
              `### ${block.final ? "Observed final message" : block.delta ? "Streamed text" : "Assistant message"}` +
              ` · events ${block.first}–${block.last}\n\n${block.text}`,
          )
          .join("\n\n"),
    ];
  });
  for (const [attempt, paths] of captured) {
    sections.push(
      `## Captured files · attempt ${attempt}\n\n` +
        [...new Set(paths)]
          .map(
            (path) =>
              `- [Open captured file](../${path.split("/").map(encodeURIComponent).join("/")}) · \`${path}\``,
          )
          .join("\n"),
    );
  }
  if (!sections.length) return null;
  return (
    "# Retained output\n\n" +
    "> Recorded assistant text, not a completion verdict. The run outcome and checks remain authoritative.\n" +
    (malformed
      ? `\n> Source log has ${malformed} unreadable record(s); this is incomplete evidence.\n`
      : "") +
    "\nSource: `events.jsonl`. Attempts and physical sessions are kept separate.\n\n" +
    sections.join("\n\n---\n\n") +
    "\n"
  );
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
 * turn. Anything else is a separate segment.
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
  const joined = delta ? undefined : joinedRun(source, seq, text, final, payload);
  if (joined) return joined;
  const current = source.current;
  if (delta && source.openDelta && current && current.key === undefined) {
    current.text += text;
    current.last = seq;
    return current;
  }
  if (
    !delta &&
    current &&
    !current.final &&
    current.text === text &&
    (source.openDelta || source.pendingFlush || final || payload?.["buffered"] === true)
  ) {
    // Exact adjacent delta/flush/final repetition, never a semantic or substring match.
    current.last = seq;
    current.delta = false;
    current.final ||= final;
    return current;
  }
  const block: TextBlock = { text, first: seq, last: seq, delta, final };
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

/** Publish a derived artifact atomically; a failed write never announces a partial file. */
export function writeRetainedOutput(
  runDir: string,
  source: { events: RunEvent[]; malformed: number },
  onlyAdditional = false,
): string | null {
  const text = retainedOutput(source.events, source.malformed, onlyAdditional);
  if (text === null) return null;
  const path = join(runDir, RETAINED_OUTPUT_PATH);
  const temporary = join(dirname(path), `.retained-output-${randomUUID()}.tmp`);
  try {
    writeText(temporary, text);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return RETAINED_OUTPUT_PATH;
}
