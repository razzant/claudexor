import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { SetupJobProjection } from "./setup-job-projection.js";
import { LegacySetupPersistence } from "./setup-job-persistence.js";
export { ACTIVE_SETUP_STATES, TERMINAL_SETUP_STATES } from "./setup-job-projection.js";

export interface SetupJobStoreOptions {
  now?: () => Date;
  journal?: DurableJournal;
}

/** Setup's operational interface, without a concrete journal or private maps. */
export type SetupJobStorePort = Pick<
  SetupJobProjection,
  | "rootDir"
  | "artifactsDir"
  | "paths"
  | "recoveryState"
  | "validateProjection"
  | "create"
  | "resolveCreate"
  | "bindCreate"
  | "update"
  | "resolveExtend"
  | "status"
  | "list"
  | "some"
  | "snapshot"
  | "events"
  | "appendLog"
>;

/** Legacy production entry until the importer-controlled SQL switch. */
export class SetupJobStore extends SetupJobProjection {
  readonly journal: DurableJournal;

  constructor(rootDir: string, opts: SetupJobStoreOptions = {}) {
    const now = opts.now ?? (() => new Date());
    let journal: DurableJournal | undefined;
    super(
      rootDir,
      () => {
        journal =
          opts.journal ??
          new DurableJournal({ rootDir: join(rootDir, "journal"), partition: "global", now });
        if (journal.options.partition !== "global")
          throw new Error(
            `setup lifecycle requires the global journal, received '${journal.options.partition}'`,
          );
        return new LegacySetupPersistence(journal);
      },
      now,
    );
    this.journal = journal!;
  }
}
