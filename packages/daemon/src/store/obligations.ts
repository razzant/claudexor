import type { EngineStore } from "./store.js";
import { requireTransaction, runMutation, type MutationContext } from "./mutation.js";
import { deleteUnownedInlineInTx } from "./blob-files.js";

/** `effect_obligation.kind` values (SYNTHESIS_R5 §4.6). Data, not enum-in-logic:
 * stores register a completion handler per kind at startup. */
export const OBLIGATION_KINDS = [
  "terminal_files",
  "publish_blob",
  "archive_fs",
  "purge_fs",
  "quarantine_fs",
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export type ObligationState = "pending" | "materialized";

export interface ObligationRow {
  kind: ObligationKind;
  key: string;
  pid: number;
  createdAt: string;
  payload: unknown;
  state: ObligationState;
  materializedGeneration: number | null;
}

/** What a completion handler may do: redo the effect and bind its directories. */
export interface ObligationEffects {
  register(dir: string): number;
}

export type ObligationHandler = (
  obligation: ObligationRow,
  effects: ObligationEffects,
) => void | Promise<void>;

export interface ObligationCompletionReceipt {
  completed: Array<{ kind: ObligationKind; key: string }>;
  failed: Array<{ kind: ObligationKind; key: string; error: string }>;
  unhandled: Array<{ kind: ObligationKind; key: string }>;
}

interface Tracked {
  lastRegistration: number | null;
  materializedGeneration: number | null;
}

type StoredObligation = {
  kind: ObligationKind;
  key: string;
  pid: number | bigint;
  created_at: string;
  payload: Uint8Array;
  state: ObligationState;
  materialized_g: number | bigint | null;
};

function fromRow(row: StoredObligation): ObligationRow {
  return {
    kind: row.kind,
    key: row.key,
    pid: Number(row.pid),
    createdAt: row.created_at,
    payload: JSON.parse(Buffer.from(row.payload).toString("utf8")) as unknown,
    state: row.state,
    materializedGeneration: row.materialized_g === null ? null : Number(row.materialized_g),
  };
}

function trackKey(kind: string, key: string): string {
  return `${kind}\0${key}`;
}

/**
 * Obligations (SYNTHESIS_R5 §4.6 as amended by R5_AMENDMENTS A2): the row is
 * created `pending` in the SAME transaction as the decision it protects; the
 * effect runs (files, links, renames) and registers its directories; once
 * EVERY effect succeeded the owner materializes the row in one
 * micro-transaction, recording the generation of the last registration; only
 * `synced(G >= materialized_g)` deletes it. A `pending` row is never touched
 * by `synced`, however many registrations it has. Startup replays every open
 * row through idempotent handlers — their count is unfinished work, never
 * history.
 */
export class Obligations {
  private readonly tracked = new Map<string, Tracked>();
  private readonly handlers = new Map<ObligationKind, ObligationHandler>();
  private readonly unsubscribe: () => void;

  /**
   * Uses the store's owner-generation map (A3/C10): an open
   * `publish_blob` row is an owner of its digest, so clearing it is an owner
   * change the blob GC must observe. `log` receives a failed clear (ENOSPC,
   * SQLite error); the rows stay tracked and the clear retries on the next
   * `synced` instead of becoming an uncaught exception on the request thread.
   */
  constructor(
    private readonly store: EngineStore,
    private readonly options: {
      log?: (line: string) => void;
      /** Already deleted and committed. Shared blob owner generations are
       * updated before this notification; consumers must not repeat them. */
      onCleared?: (rows: readonly ObligationRow[]) => void;
    } = {},
  ) {
    this.unsubscribe = store.onSynced((generation) => this.clearSynced(generation));
  }

  /** Pure row write inside the caller's transaction. A duplicate (kind, key)
   * is a constraint violation. The enclosing mutation records any publish_blob
   * reference with changes.blobChanged alongside its upload/resource changes. */
  create(kind: ObligationKind, key: string, pid: number, payload: unknown): void {
    if (!this.store.inTransaction) {
      throw new Error("an obligation is created inside the transaction of its decision");
    }
    this.store
      .prepare(
        "INSERT INTO effect_obligation(kind, key, pid, created_at, payload, state) VALUES(?, ?, ?, ?, ?, 'pending')",
      )
      .run(kind, key, pid, this.store.now().toISOString(), Buffer.from(JSON.stringify(payload)));
  }

  /** Bind a directory the effect touched; returns the registration generation. */
  registerEffect(kind: ObligationKind, key: string, dir: string): number {
    if (this.store.inTransaction) throw new Error("file effects run outside SQL transactions");
    const g = this.store.registerExternal(dir);
    this.entry(kind, key).lastRegistration = g;
    return g;
  }

  /**
   * Every effect succeeded: `pending → materialized` with `materialized_g` =
   * the last registration (or a fresh mark when the effect registered
   * nothing). Runs as its own micro-transaction. A composed decision uses
   * materializeInTx with its MutationContext instead, so rollback cannot
   * publish materialized state in memory.
   */
  materialize(kind: ObligationKind, key: string): number {
    if (this.store.inTransaction) {
      throw new Error("use materializeInTx with the owner's MutationContext");
    }
    const generation = this.tracked.get(trackKey(kind, key))?.lastRegistration ?? this.store.mark();
    return runMutation(this.store, (tx) => this.materializeInTx(tx, kind, key, generation));
  }

  /** `generation` is the last file registration (or an empty-effect mark)
   * prepared outside this transaction. Row state and the enclosing decision
   * commit together; only their successful commit enables synced to clear it. */
  materializeInTx(
    tx: MutationContext,
    kind: ObligationKind,
    key: string,
    generation: number,
  ): number {
    requireTransaction(tx);
    const result = tx
      .prepare(
        "UPDATE effect_obligation SET state = 'materialized', materialized_g = ? WHERE kind = ? AND key = ?",
      )
      .run(generation, kind, key);
    if (Number(result.changes) === 0) throw new Error(`no obligation ${kind}:${key}`);
    tx.changes.afterCommit(() => {
      this.entry(kind, key).materializedGeneration = generation;
    });
    return generation;
  }

  open(): ObligationRow[] {
    return (
      this.store
        .prepare(
          "SELECT kind, key, pid, created_at, payload, state, materialized_g FROM effect_obligation ORDER BY created_at, kind, key",
        )
        .all() as StoredObligation[]
    ).map(fromRow);
  }

  get(kind: ObligationKind, key: string): ObligationRow | undefined {
    const row = this.store
      .prepare(
        "SELECT kind,key,pid,created_at,payload,state,materialized_g FROM effect_obligation WHERE kind=? AND key=?",
      )
      .get(kind, key) as StoredObligation | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Stores register one idempotent completion handler per kind at startup. */
  registerHandler(kind: ObligationKind, handler: ObligationHandler): void {
    if (this.handlers.has(kind))
      throw new Error(`obligation handler for '${kind}' already registered`);
    this.handlers.set(kind, handler);
  }

  /**
   * Startup hook: redo every open row through its handler and materialize it
   * with a fresh generation (a row left `materialized` by a crashed process
   * names generations nobody can prove any more). A handler failure leaves
   * the row `pending` (the fact `obligations_open` discloses it); a kind
   * without a handler is reported, never silently dropped.
   */
  async completeOpen(): Promise<ObligationCompletionReceipt> {
    const open = this.open();
    // A generation persisted by another process is not durability evidence.
    // Reset every open row before the first await, including unhandled kinds.
    runMutation(this.store, (tx) => {
      tx.prepare(
        "UPDATE effect_obligation SET state = 'pending', materialized_g = NULL WHERE state = 'materialized' OR materialized_g IS NOT NULL",
      ).run();
      tx.changes.afterCommit(() => this.tracked.clear());
    });
    const receipt: ObligationCompletionReceipt = { completed: [], failed: [], unhandled: [] };
    for (const obligation of open) {
      const handler = this.handlers.get(obligation.kind);
      if (!handler) {
        receipt.unhandled.push({ kind: obligation.kind, key: obligation.key });
        continue;
      }
      try {
        await handler(obligation, {
          register: (dir) => this.registerEffect(obligation.kind, obligation.key, dir),
        });
        this.materialize(obligation.kind, obligation.key);
        receipt.completed.push({ kind: obligation.kind, key: obligation.key });
      } catch (error) {
        receipt.failed.push({
          kind: obligation.kind,
          key: obligation.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return receipt;
  }

  close(): void {
    this.unsubscribe();
    this.tracked.clear();
  }

  private entry(kind: ObligationKind, key: string): Tracked {
    const id = trackKey(kind, key);
    let entry = this.tracked.get(id);
    if (!entry) {
      entry = { lastRegistration: null, materializedGeneration: null };
      this.tracked.set(id, entry);
    }
    return entry;
  }

  private clearSynced(generation: number): void {
    if (this.store.isClosed) return;
    const clearable: Array<[ObligationKind, string]> = [];
    for (const [id, entry] of this.tracked) {
      if (entry.materializedGeneration === null || entry.materializedGeneration > generation)
        continue;
      const [kind, key] = id.split("\0") as [ObligationKind, string];
      clearable.push([kind, key]);
    }
    if (clearable.length === 0) return;
    let cleared: ObligationRow[];
    try {
      const remove = this.store.prepare(
        "DELETE FROM effect_obligation WHERE kind = ? AND key = ? AND state = 'materialized' AND materialized_g <= ? RETURNING kind, key, pid, created_at, payload, state, materialized_g",
      );
      cleared = this.store.transaction(() => {
        const removed: ObligationRow[] = [];
        for (const [kind, key] of clearable) {
          removed.push(...(remove.all(kind, key, generation) as StoredObligation[]).map(fromRow));
        }
        for (const row of removed) {
          const sha =
            row.kind === "publish_blob" ? (row.payload as { sha?: unknown } | null)?.sha : null;
          if (typeof sha === "string") deleteUnownedInlineInTx(this.store, sha);
        }
        return removed;
      });
    } catch (error) {
      // The rows stay tracked and materialized; the next synced retries.
      this.options.log?.(
        `obligation clear deferred: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const [kind, key] of clearable) this.tracked.delete(trackKey(kind, key));
    // The deleted publish_blob rows were owners of their digests (A3): the GC
    // waiting on this very barrier must see the owner change and wait again.
    for (const row of cleared) {
      if (row.kind !== "publish_blob") continue;
      const digest = (row.payload as { sha?: unknown } | null)?.sha;
      if (typeof digest === "string") this.store.owners.noteChange(`blob:${digest}`);
    }
    if (cleared.length > 0) {
      try {
        this.options.onCleared?.(cleared);
      } catch (error) {
        this.options.log?.(
          `obligation rows cleared and committed; notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
