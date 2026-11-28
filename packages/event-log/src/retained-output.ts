import type { RunEvent } from "@claudexor/schema";
import {
  newAssistantSource,
  observeAssistantText,
  type SourceOutput,
} from "./assistant-text-blocks.js";
import { writeOutputArtifact } from "./write-output-artifact.js";

export const RETAINED_OUTPUT_PATH = "final/retained-output.md";

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
   * joined frame names), its exact adjacent delta, flush and complete forms, and the
   * streamed blocks it exactly repeats. Its earlier finals and other narration stay,
   * whatever their text. Without an accepted final its joined narration is the answer
   * and the whole try is omitted. Text never decides what is represented. */
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
    const source = sources.get(key) ?? newAssistantSource(attempt, harness, session);
    sources.set(key, source);
    observeAssistantText(source, p, event.seq ?? 0);
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
      if (!represented) return true;
      // No accepted final: the joined narration is the answer.
      if (answer === undefined) return false;
      // Only the carried final's own block and the streamed blocks it exactly
      // repeats are represented: equal or contained text elsewhere (another turn,
      // a short "OK" inside "NOT OK") is its own evidence.
      return block !== answer && !answer?.forms?.includes(block);
    });
    // A section needs visible text; a whitespace-only block (a separator fragment
    // between tool calls) stays exact inside one.
    if (!blocks.some((block) => block.text.trim())) return [];
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
  return text === null ? null : writeOutputArtifact(runDir, RETAINED_OUTPUT_PATH, text);
}
