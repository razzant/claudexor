import { randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { RETAINED_OUTPUT_PATH, retainedOutput } from "@claudexor/event-log";
import { RunEvent } from "@claudexor/schema";
import { safeArtifactPath } from "./artifact-paths.js";
import { effectiveTerminalFacts, expectedRunFacts } from "./run-facts-projection.js";
import { readRunEventsWithIntegrity } from "./run-timeline.js";
import { readRunTombstone } from "./retention.js";
import type { DaemonRunRecord } from "./run-record.js";

/** Pure addressed recovery preparation. Uses the same request's parsed events. */
export function prepareInterruptedOutput(rec: DaemonRunRecord): string | null {
  if (rec.state !== "interrupted" || !rec.runDir || readRunTombstone(rec.runDir)) return null;
  if (effectiveTerminalFacts(rec.runDir, null, null, expectedRunFacts(rec)).runFacts) return null;
  if (safeArtifactPath(rec.runDir, RETAINED_OUTPUT_PATH) || !safeArtifactPath(rec.runDir, "final"))
    return null;
  const source = readRunEventsWithIntegrity(rec);
  if (source.integrity.unreadable || source.integrity.absent) return null;
  const events: RunEvent[] = [];
  let malformed = source.integrity.malformedLines + source.integrity.nonObjectLines;
  for (const raw of source.events) {
    const parsed = RunEvent.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else malformed++;
  }
  if (!events.every((event) => event.run_id === (rec.runId ?? rec.id))) return null;
  if (events.some((event) => ["run.completed", "run.failed", "run.blocked"].includes(event.type)))
    return null;
  return retainedOutput(events, malformed);
}

/** The server owns publication, including a write already underway at Stop.
 * A worker may be terminated at any point without leaving a partial artifact. */
export class RetainedOutputPublisher {
  private readonly pending = new Map<string, Promise<string | null>>();

  publish(rec: DaemonRunRecord, bytes: Uint8Array): Promise<string | null> {
    if (!rec.runDir) return Promise.resolve(null);
    const key = rec.runDir;
    const active = this.pending.get(key);
    if (active) return active;
    const write = this.write(rec, bytes).finally(() => this.pending.delete(key));
    this.pending.set(key, write);
    return write;
  }

  private async write(rec: DaemonRunRecord, bytes: Uint8Array): Promise<string | null> {
    let temporary: string | undefined;
    try {
      if (
        !rec.runDir ||
        safeArtifactPath(rec.runDir, RETAINED_OUTPUT_PATH) ||
        readRunTombstone(rec.runDir)
      )
        return null;
      const final = safeArtifactPath(rec.runDir, "final");
      if (!final) return null;
      temporary = join(final, `.retained-output-${randomUUID()}.tmp`);
      // UTF-8 encoding happened in the worker; publication does no unbounded
      // string conversion on the control event loop.
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, join(final, "retained-output.md"));
      return null;
    } catch {
      return "Interrupted output could not be materialized; the original run state is unchanged. Inspect events.jsonl.";
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
