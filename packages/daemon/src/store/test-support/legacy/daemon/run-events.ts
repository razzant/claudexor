import type { DurableJournal } from "@claudexor/journal";
import { RunEvent, type RunEvent as RunEventValue } from "@claudexor/schema";
import { durableTerminalRunEvents } from "./run-event-terminal-index.js";

const RECORDED = "run.event";

/** Writes typed run events into their owning global/project journal partition. */
export class RunEventStore {
  constructor(
    private readonly journal: DurableJournal,
    validateOnCreate = true,
  ) {
    if (validateOnCreate) this.validateProjection();
  }

  record(value: RunEventValue): RunEventValue {
    const event = RunEvent.parse(value);
    this.journal.append(RECORDED, event);
    return event;
  }

  /** One shared validated pass with durable terminal recovery: every journaled
   * run event parses once per journal generation. */
  validateProjection(): void {
    durableTerminalRunEvents(this.journal);
  }
}

export function runEventProjection() {
  return {
    name: "run-events",
    // JournalManager always validates the created projection before binding it.
    create: (journal: DurableJournal) => new RunEventStore(journal, false),
    validate: (store: RunEventStore) => store.validateProjection(),
  };
}
