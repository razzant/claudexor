import { existsSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Thread as ThreadSchema, type Thread } from "@claudexor/schema";
import type { EngineStore } from "./store.js";
import type { Obligations, ObligationHandler } from "./obligations.js";

export interface PurgeFilesPayload {
  thread: Thread;
}
/** Uses the CLI/workspace's existing purge owner; it reports touched parents. */
export type PurgeFilesEffect = (thread: Thread) => Promise<readonly string[]>;

/** SQL owns the decision and retry; the existing workspace owner owns deletion. */
export class SqlPurgeFiles {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    readonly store: EngineStore,
    readonly obligations: Obligations,
  ) {}

  handler(perform: PurgeFilesEffect): ObligationHandler {
    return async (obligation, effects) => {
      const thread = ThreadSchema.parse((obligation.payload as PurgeFilesPayload).thread);
      if (thread.id !== obligation.key)
        throw new Error("purge obligation does not name its thread");
      // Covers the decision committed before this call, also after restart.
      await this.store.synced(this.store.mark());
      const dirs = await perform(thread);
      for (const dir of new Set(dirs)) effects.register(dir);
    };
  }

  /** Runtime replay uses the same handler as startup, without replaying every
   * open obligation or resetting another effect's materialized state. */
  complete(id: string, perform: PurgeFilesEffect): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const completion = this.completeOne(id, perform).finally(() => this.pending.delete(id));
    this.pending.set(id, completion);
    return completion;
  }

  private async completeOne(id: string, perform: PurgeFilesEffect): Promise<void> {
    const row = this.store
      .prepare(
        "SELECT pid,payload,created_at,state,materialized_g FROM effect_obligation WHERE kind='purge_fs' AND key=?",
      )
      .get(id) as
      | {
          pid: number;
          payload: Uint8Array;
          created_at: string;
          state: "pending" | "materialized";
          materialized_g: number | null;
        }
      | undefined;
    if (!row || row.state === "materialized") return;
    await this.handler(perform)(
      {
        kind: "purge_fs",
        key: id,
        pid: row.pid,
        createdAt: row.created_at,
        payload: JSON.parse(Buffer.from(row.payload).toString("utf8")) as unknown,
        state: row.state,
        materializedGeneration: row.materialized_g,
      },
      { register: (dir) => this.obligations.registerEffect("purge_fs", id, dir) },
    );
    this.obligations.materialize("purge_fs", id);
  }
}

/** PR-D supplies already validated, engine-owned leftovers. Logical SQL
 * archives have no fake filesystem move; only a real leftover creates this. */
export interface PartitionFilesPayload {
  source: string;
  destination: string;
}

export function partitionFilesHandler(store: EngineStore): ObligationHandler {
  return async (obligation, effects) => {
    const { source, destination } = obligation.payload as PartitionFilesPayload;
    if (typeof source !== "string" || typeof destination !== "string")
      throw new Error("invalid partition filesystem obligation");
    await store.synced(store.mark());
    if (existsSync(source)) {
      if (existsSync(destination)) throw new Error("partition archive destination already exists");
      renameSync(source, destination);
    } else if (!existsSync(destination))
      throw new Error("partition archive source and destination are missing");
    effects.register(existingDirectory(dirname(source)));
    effects.register(existingDirectory(dirname(destination)));
  };
}

/** Removed parents cannot be opened by the flusher; sync the surviving parent. */
export function existingDirectory(path: string): string {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current) && statSync(current).isDirectory()) return current;
    if (dirname(current) === current) throw new Error(`no surviving parent directory of ${path}`);
  }
}
