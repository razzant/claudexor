/** Evidence survives answer resets; rejected session output is never evidence. */
import { join } from "node:path";
import type { AnswerAssembly } from "@claudexor/core";
import { readRunEvents, retainedOutput } from "@claudexor/event-log";
import type { ContinuityIdentityCheck } from "@claudexor/schema";

/**
 * The attempt's retained assistant output for an in-run packet: the run log's
 * own projection (`retainedOutput`, the same owner as final/retained-output.md)
 * over THIS attempt's harness events, each physical session (one per try)
 * kept separate and exact — fragments joined verbatim, whitespace and repeats
 * kept — and an unreadable record disclosed. Only sessions whose identity
 * check rejected them are left out; earlier good tries stay. A typed final
 * whose machine truth differs from its display copy (a constrained envelope)
 * is added verbatim, since the projection shows the display copy only. Read
 * lazily: only a packet carrier needs it.
 */
export class RetainedAttemptOutput {
  private readonly rejected = new Set<string>();
  private readonly machineFinals: { session: string; text: string }[] = [];

  constructor(
    private readonly runDir: string,
    private readonly attemptId: string,
  ) {}

  add(session: string, answer: AnswerAssembly, identity: ContinuityIdentityCheck): void {
    if (identity === "mismatch_before_effects" || identity === "mismatch_after_possible_effects") {
      this.rejected.add(session);
      return;
    }
    const machine = answer.hasFinal() ? answer.machineText() : "";
    if (machine.trim() && machine !== answer.text())
      this.machineFinals.push({ session, text: machine });
  }

  text(): string {
    const { events, malformed } = readRunEvents(join(this.runDir, "events.jsonl"));
    const own = events.filter(
      (event) =>
        event.type === "harness.event" &&
        event.payload["attempt_id"] === this.attemptId &&
        !this.rejected.has(String(event.payload["session_id"] ?? "unknown")),
    );
    // Untrimmed: the projection's exact bytes, its last fragment's whitespace included.
    return [
      retainedOutput(own, malformed) ?? "",
      ...this.machineFinals.map(
        ({ session, text }) => `Machine-readable final of session \`${session}\`:\n\n${text}`,
      ),
    ]
      .filter((part) => part.trim())
      .join("\n\n");
  }
}
