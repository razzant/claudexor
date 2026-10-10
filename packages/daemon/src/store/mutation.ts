import type { EngineStore } from "./store.js";
import type { OwnerKey } from "./owner-generations.js";
import { deleteUnownedInlineInTx } from "./blob-files.js";
import { mapStoreError } from "./errors.js";

/** Row reducers need only a statement owner and an already open transaction.
 * An importer can supply this over its single connection without an EngineStore. */
export type SqlWriteContext = Pick<EngineStore, "prepare" | "inTransaction">;

export interface MutationContext extends SqlWriteContext {
  readonly changes: MutationDelta;
  readonly now: () => Date;
}

/** SQL committed even when a later projection/notification failed. Never retry
 * the mutation as though this were a rollback. All owner generations are set. */
export class MutationPostCommitError extends AggregateError {
  readonly committed = true;

  constructor(errors: unknown[]) {
    super(errors, "engine store mutation committed; post-commit notification failed");
    this.name = "MutationPostCommitError";
  }
}

/** Changes are collected during SQL writes, then published synchronously after
 * COMMIT. Record both old and new references when a row changes its owner key. */
export class MutationDelta {
  private readonly owners = new Set<OwnerKey>();
  private readonly callbacks: Array<() => void> = [];

  blobChanged(...digests: Array<string | null | undefined>): void {
    for (const digest of digests) if (digest != null) this.owners.add(`blob:${digest}`);
  }

  uploadChanged(...ids: Array<string | null | undefined>): void {
    for (const id of ids) if (id != null) this.owners.add(`upload:${id}`);
  }

  afterCommit(callback: () => void): void {
    this.callbacks.push(callback);
  }

  /** Run once after all row writers, before COMMIT. A later writer in the same
   * mutation may still acquire a reference, so cleanup must not run earlier. */
  clearUnownedInline(sql: SqlWriteContext): void {
    for (const key of this.owners)
      if (key.startsWith("blob:")) deleteUnownedInlineInTx(sql, key.slice(5));
  }

  /** Used by runMutation only, after EngineStore.transaction returned. */
  publish(store: EngineStore): void {
    for (const key of this.owners) store.owners.noteChange(key);
    const errors: unknown[] = [];
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new MutationPostCommitError(errors);
  }
}

/** Prepare file-backed bodies before calling this function, without an await
 * between preparation and commit. No nested transaction or async body. Failed
 * SQL discards the delta; successful SQL publishes every owner before callbacks. */
export function runMutation<T>(store: EngineStore, body: (tx: MutationContext) => T): T {
  const changes = new MutationDelta();
  const tx: MutationContext = {
    prepare: (sql) => store.prepare(sql),
    get inTransaction() {
      return store.inTransaction;
    },
    changes,
    now: store.now,
  };
  let result: T;
  try {
    result = store.transaction(() => {
      const value = body(tx);
      changes.clearUnownedInline(tx);
      return value;
    });
  } catch (error) {
    throw mapStoreError(error, "mutating engine rows");
  }
  changes.publish(store);
  return result;
}

export function requireTransaction(sql: SqlWriteContext): void {
  if (!sql.inTransaction) throw new Error("row writes require the owner's transaction");
}
