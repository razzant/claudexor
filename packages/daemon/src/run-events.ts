import type { DurableJournal } from "@claudexor/journal";
import { RunEvent, type RunEvent as RunEventValue } from "@claudexor/schema";

const RECORDED = "run.event";

/** Writes typed run events into their owning global/project journal partition. */
export class RunEventStore {
  constructor(private readonly journal: DurableJournal) {
    this.validateProjection();
  }

  record(value: RunEventValue): RunEventValue {
    const event = RunEvent.parse(value);
    this.journal.append(RECORDED, event);
    return event;
  }

  validateProjection(): void {
    for (const entry of this.journal.records()) {
      if (entry.type === RECORDED) RunEvent.parse(entry.payload);
    }
  }
}

export function runEventProjection() {
  return {
    name: "run-events",
    create: (journal: DurableJournal) => new RunEventStore(journal),
    validate: (store: RunEventStore) => store.validateProjection(),
  };
}
