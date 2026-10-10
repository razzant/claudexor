import {
  ControlPendingInteraction,
  LaneCheckpoint,
  Project,
  RunEvent,
  Session,
  Thread,
  ThreadTurn,
} from "@claudexor/schema";
import { validateCommandRecord } from "../command-store.js";
import { parseInteractionResolution } from "../interactions.js";
import { parseOperatorDecision } from "../operator-decisions.js";
import { QuotaRegistry } from "../quota-registry.js";
import type { BlobFiles } from "./blob-files.js";
import { hydrateCommand, type CommandRow } from "./command-rows.js";
import { SqlEventLedger } from "./event-store.js";
import type { PartitionGeneration } from "./partitions.js";
import type { SqlRecoveryProjection } from "./sql-recovery.js";
import type { EngineStore } from "./store.js";

/** Explicit recovery validation reuses the domain's original parsers. This
 * cold operation may read the requested partition's full bodies; admission,
 * status and ordinary collection reads never call it. */
export function sqlRecoveryProjections(
  store: EngineStore,
  blobs: BlobFiles,
  generation: PartitionGeneration,
  validateSetup: (generation: PartitionGeneration) => void,
): SqlRecoveryProjection[] {
  const body = (value: Uint8Array) => JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  const typedRows = (table: string, schema: { parse(value: unknown): unknown }) => {
    const rows = store
      .prepare(`SELECT body FROM ${table} WHERE pid=?`)
      .all(generation.pid) as Array<{ body: Uint8Array }>;
    for (const row of rows) schema.parse(body(row.body));
  };
  const bindings = (owner: string, table: string, column = "id") => {
    const row = store
      .prepare(
        `SELECT i.target_id FROM idempotency i LEFT JOIN ${table} t
      ON t.${column}=i.target_id AND t.pid=i.pid WHERE i.owner=? AND i.pid=? AND t.${column} IS NULL LIMIT 1`,
      )
      .get(owner, generation.pid);
    if (row) throw new Error(`${owner} idempotency index is dangling`);
  };
  const projections: SqlRecoveryProjection[] = [
    {
      name: "commands",
      validate: () => {
        for (const row of store
          .prepare("SELECT * FROM command WHERE pid=?")
          .all(generation.pid) as unknown as CommandRow[])
          validateCommandRecord(hydrateCommand(row, blobs));
        bindings("command", "command");
      },
    },
    {
      name: "threads",
      validate: () => {
        typedRows("thread", Thread);
        typedRows("session", Session);
        typedRows("lane_checkpoint", LaneCheckpoint);
        for (const row of store
          .prepare("SELECT body,prompt_sha FROM turn WHERE pid=?")
          .all(generation.pid) as Array<{ body: Uint8Array; prompt_sha: string }>)
          ThreadTurn.parse({
            ...(body(row.body) as object),
            prompt: blobs.read(row.prompt_sha).toString("utf8"),
          });
        bindings("thread", "thread");
        bindings("turn", "turn");
      },
    },
    {
      name: "interactions",
      validate: () => {
        for (const row of store
          .prepare("SELECT request,resolution FROM interaction WHERE pid=?")
          .all(generation.pid) as Array<{ request: Uint8Array; resolution: Uint8Array | null }>) {
          ControlPendingInteraction.parse(body(row.request));
          if (row.resolution) parseInteractionResolution(body(row.resolution));
        }
      },
    },
    {
      name: "decisions",
      validate: () => {
        for (const row of store
          .prepare("SELECT body FROM operator_decision WHERE pid=?")
          .all(generation.pid) as Array<{ body: Uint8Array }>)
          parseOperatorDecision(body(row.body));
        bindings("decision", "operator_decision", "run_id");
      },
    },
    {
      name: "run-events",
      validate: () => {
        for (const row of store
          .prepare("SELECT event FROM run_terminal WHERE pid=?")
          .all(generation.pid) as Array<{ event: Uint8Array }>)
          RunEvent.parse(body(row.event));
        for (const event of new SqlEventLedger(store, blobs, generation).records(0, ["run.event"]))
          RunEvent.parse(event.payload);
      },
    },
  ];
  if (generation.name === "global")
    projections.push(
      {
        name: "projects",
        validate: () => {
          typedRows("project", Project);
          bindings("project", "project");
        },
      },
      {
        name: "quota",
        validate: () =>
          new QuotaRegistry(new SqlEventLedger(store, blobs, generation)).validateProjection(),
      },
      { name: "setup", validate: () => validateSetup(generation) },
    );
  return projections;
}
