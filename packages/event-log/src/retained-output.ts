import { dirname, join } from "node:path";
import { renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { RunEvent } from "@claudexor/schema";
import { writeText } from "@claudexor/util";

export const RETAINED_OUTPUT_PATH = "final/retained-output.md";

interface TextBlock {
  text: string;
  first: number;
  last: number;
  delta: boolean;
  final: boolean;
}

interface SourceOutput {
  attempt: string;
  harness: string;
  session: string;
  blocks: TextBlock[];
  openDelta: boolean;
  pendingFlush: boolean;
  /** The block of the last final AnswerAssembly accepts (null when that final has no
   * visible text, only machine truth); absent while none was accepted. */
  answer?: TextBlock | null;
}

/** What a caller already passes on, so the projection does not repeat it. */
interface CarriedOutput {
  /** Carried text (a final answer, a checkpoint): a block wholly within it is omitted. */
  text?: string;
  /** The native try (attempt, process session) whose answer is carried. Its answer is
   * the LAST typed final AnswerAssembly accepts (a later native turn's final wins),
   * so only that final and the blocks it repeats are omitted; its earlier finals and
   * other narration stay. Without an accepted final its joined narration is the
   * answer and the whole try is omitted. */
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
    const source = sources.get(key) ?? {
      attempt,
      harness,
      session,
      blocks: [],
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
    const seq = event.seq ?? 0;
    const last = source.blocks.at(-1);
    if (delta && source.openDelta && last) {
      last.text += text;
      last.last = seq;
    } else if (
      !delta &&
      last?.text === text &&
      (source.openDelta || source.pendingFlush || final || payload?.["buffered"] === true)
    ) {
      // Exact adjacent delta/flush/final repetition, never a semantic or substring match.
      last.last = seq;
      last.delta = false;
      last.final ||= final;
    } else {
      source.blocks.push({ text, first: seq, last: seq, delta, final });
    }
    source.openDelta = delta;
    source.pendingFlush = payload?.["buffered"] === true;
    if (accepted) source.answer = text.trim() ? source.blocks.at(-1)! : null;
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
      const text = block.text.trim();
      if (!text || carried.text?.includes(text)) return false;
      if (!represented) return true;
      // No accepted final: the joined narration is the answer.
      if (answer === undefined) return false;
      return answer === null || (block !== answer && !answer.text.trim().includes(text));
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
