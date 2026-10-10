import type { DurableJournal } from "@claudexor/journal";
import { RunEvent as RunEventSchema, type RunEvent } from "@claudexor/schema";

interface TerminalIndex {
  upToSeq: number;
  terminals: Map<string, RunEvent>;
}

/** Keyed by the exact journal object, i.e. per generation: a restart,
 * quarantine or reopen constructs a new journal and therefore a fresh index. */
const indexes = new WeakMap<DurableJournal, TerminalIndex>();

/**
 * One validated pass over a partition's journaled `run.event` records, shared
 * by the RunEventStore projection (validation) and the CommandStore's durable
 * terminal recovery. Every `run.event` is parsed exactly once per generation:
 * the index remembers the sequence it has seen and extends itself from there,
 * so later appends cost only the new records and a second consumer never
 * re-parses history. A validation failure leaves the index untouched, so the
 * next call reports the same failure instead of a phantom duplicate terminal.
 */
export function durableTerminalRunEvents(journal: DurableJournal): ReadonlyMap<string, RunEvent> {
  const index = indexes.get(journal) ?? { upToSeq: 0, terminals: new Map<string, RunEvent>() };
  const upTo = journal.currentSequence();
  if (upTo > index.upToSeq) {
    const added = new Map<string, RunEvent>();
    for (const entry of journal.records(index.upToSeq, ["run.event"])) {
      const event = RunEventSchema.parse(entry.payload);
      if (
        event.type !== "run.completed" &&
        event.type !== "run.failed" &&
        event.type !== "run.blocked"
      ) {
        continue;
      }
      if (index.terminals.has(event.run_id) || added.has(event.run_id)) {
        throw new Error(`multiple durable terminal events for run ${event.run_id}`);
      }
      added.set(event.run_id, event);
    }
    for (const [runId, event] of added) index.terminals.set(runId, event);
    index.upToSeq = upTo;
    indexes.set(journal, index);
  }
  return index.terminals;
}
