import { existsSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  Thread as ThreadSchema,
  type Thread,
  type ThreadExportDigestEntry,
  type ThreadRetirementAcceptance,
} from "@claudexor/schema";
import { safeProblemMessage } from "@claudexor/util";
import type { PurgeRepositoryRecord } from "@claudexor/workspace";
import type { EngineStore } from "./store.js";
import type { Obligations, ObligationHandler } from "./obligations.js";
import { runMutation } from "./mutation.js";

export interface PurgeFilesPayload {
  thread: Thread;
  /** The repository holding the thread's worktree registration and branch,
   * recorded by an attempt before Git's first change in it. */
  repository?: PurgeRepositoryRecord;
  /** A conditional retirement's acceptance. */
  retirement?: ThreadRetirementAcceptance;
  /** The lane entries that acceptance read from disk: every attempt deletes only
   * a lane whose remaining entries are among these, byte for byte. */
  acceptedLane?: readonly ThreadExportDigestEntry[];
  /** Why the last attempt left this retirement's cleanup open. */
  lastError?: string;
}
/** The obligation keeps the repository an attempt resolved until it clears,
 * so every retry, startup replay included, deletes and syncs in that one. */
export interface PurgeRepositoryCustody {
  readonly recorded: PurgeRepositoryRecord | null;
  /** Durable before it resolves; the effect deletes nothing in Git earlier. */
  record(repository: PurgeRepositoryRecord): Promise<void>;
  /** A retirement's accepted lane entries; present exactly for a retirement. */
  readonly acceptedLane?: readonly ThreadExportDigestEntry[];
}
/** Uses the CLI/workspace's existing purge owner; it reports touched parents. */
export type PurgeFilesEffect = (
  thread: Thread,
  repository?: PurgeRepositoryCustody,
) => Promise<readonly string[]>;

/** SQL owns the decision and retry; the existing workspace owner owns deletion. */
export class SqlPurgeFiles {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    readonly store: EngineStore,
    readonly obligations: Obligations,
  ) {}

  handler(perform: PurgeFilesEffect): ObligationHandler {
    return async (obligation, effects) => {
      const payload = obligation.payload as PurgeFilesPayload;
      const thread = ThreadSchema.parse(payload.thread);
      if (thread.id !== obligation.key)
        throw new Error("purge obligation does not name its thread");
      // Covers the decision committed before this call, also after restart.
      await this.store.synced(this.store.mark());
      let current = payload;
      const update = async (patch: Partial<PurgeFilesPayload>) => {
        current = { ...current, ...patch };
        await this.updatePayload(thread.id, current);
      };
      let dirs: readonly string[];
      try {
        dirs = await perform(thread, {
          recorded: recordedRepository(payload.repository),
          record: (repository) => update({ repository }),
          ...(payload.retirement ? { acceptedLane: acceptedLaneOf(payload) } : {}),
        });
      } catch (error) {
        if (payload.retirement)
          await update({ lastError: safeProblemMessage(error) }).catch(() => undefined);
        throw error;
      }
      if (current.lastError) await update({ lastError: undefined });
      for (const dir of new Set(dirs)) effects.register(dir);
    };
  }

  private async updatePayload(id: string, payload: PurgeFilesPayload): Promise<void> {
    runMutation(this.store, (tx) => {
      const recorded = tx
        .prepare(
          "UPDATE effect_obligation SET payload=? WHERE kind='purge_fs' AND key=? AND state='pending'",
        )
        .run(Buffer.from(JSON.stringify(payload)), id);
      if (Number(recorded.changes) === 0) throw new Error(`no pending purge obligation ${id}`);
    });
    await this.store.synced(this.store.mark());
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

/** A retirement's cleanup without a readable lane inventory deletes nothing. */
function acceptedLaneOf(payload: PurgeFilesPayload): readonly ThreadExportDigestEntry[] {
  const entries = payload.acceptedLane as unknown;
  if (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        typeof entry?.itemId === "string" &&
        typeof entry?.sha256 === "string" &&
        Number.isSafeInteger(entry?.sizeBytes),
    )
  )
    return entries as ThreadExportDigestEntry[];
  throw new Error("retirement cleanup has no readable accepted lane inventory; nothing deleted");
}

/** An unreadable record stays a refusal: dropping it would ask the project path. */
function recordedRepository(value: unknown): PurgeRepositoryRecord | null {
  if (value === undefined) return null;
  const { gitDir, identity } = (value ?? {}) as Partial<PurgeRepositoryRecord>;
  if (typeof gitDir === "string" && (typeof identity === "string" || identity === null))
    return { gitDir, identity };
  throw new Error("purge obligation records an unreadable repository");
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
