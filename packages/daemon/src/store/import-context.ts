import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { INLINE_BODY_MAX_BYTES, sha256Hex, type BodyRef } from "./blob-files.js";
import { writeExternalFile } from "./external-files.js";
import { StoreError } from "./errors.js";
import type { SqlWriteContext } from "./mutation.js";

/** The importer has exactly one connection, no EngineStore or background worker. */
export class ImportContext implements SqlWriteContext {
  private readonly statements = new Map<string, StatementSync>();
  private active = false;
  readonly externalDirectories = new Set<string>();

  constructor(
    readonly db: DatabaseSync,
    readonly blobsDir: string,
  ) {}

  get inTransaction(): boolean {
    return this.active;
  }
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  transaction<T>(body: () => T): T {
    if (this.active) throw new Error("nested import transaction");
    this.db.exec("BEGIN IMMEDIATE");
    this.active = true;
    try {
      const value = body();
      if (value && typeof (value as { then?: unknown }).then === "function")
        throw new Error("async import transaction");
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.active = false;
    }
  }

  /** Existing O_DSYNC writer, with a directory receipt instead of live generations.
   * Parent fsyncs these directories before publishing the closed temp database. */
  body(bytes: Uint8Array): BodyRef {
    const sha256 = sha256Hex(bytes);
    if (bytes.byteLength <= INLINE_BODY_MAX_BYTES)
      return {
        sha256,
        size: bytes.byteLength,
        inline: Buffer.from(bytes),
        file: null,
        generation: null,
      };
    const receipt = writeExternalFile(
      {
        registerExternal: (dir) => {
          this.externalDirectories.add(dir);
          return 0;
        },
      },
      { dir: this.blobsDir, name: sha256, bytes, keepExisting: true },
    );
    // Existing immutable bytes are never rewritten, including a resource collision.
    if (!receipt.written) {
      const prior = readFileSync(receipt.path);
      if (prior.length !== bytes.byteLength || sha256Hex(prior) !== sha256)
        throw importError("store_import_blob_mismatch", `existing body ${sha256} differs`);
    }
    return { sha256, size: bytes.byteLength, inline: null, file: receipt.path, generation: null };
  }

  read(sha: string): Buffer {
    const row = this.prepare("SELECT size,inline FROM blob WHERE sha256=?").get(sha) as
      { size: number; inline: Uint8Array | null } | undefined;
    if (!row) throw importError("store_import_blob_missing", `missing body ${sha}`);
    const bytes =
      row.inline === null ? readFileSync(join(this.blobsDir, sha)) : Buffer.from(row.inline);
    if (bytes.length !== row.size || sha256Hex(bytes) !== sha)
      throw importError("store_import_blob_mismatch", `body ${sha} differs`);
    return bytes;
  }
}

export function importError(code: string, detail: string, cause?: unknown): StoreError {
  return new StoreError(code, 503, false, detail, cause === undefined ? undefined : { cause });
}
