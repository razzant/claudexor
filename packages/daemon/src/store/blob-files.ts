import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StoreError } from "./errors.js";
import { linkExternalFile, writeExternalFile } from "./external-files.js";
import { requireTransaction, type SqlWriteContext } from "./mutation.js";
import type { OwnerGenerations, UnlinkOutcome } from "./owner-generations.js";
import type { EngineStore } from "./store.js";

/** Bodies up to this size are stored inline in `blob.inline`; larger bodies are files. */
export const INLINE_BODY_MAX_BYTES = 64 * 1024;

export interface BodyRef {
  /** Bare hex sha256 (the blob file name). */
  sha256: string;
  size: number;
  inline: Buffer | null;
  /** The content-addressed file, for bodies above the inline cap. */
  file: string | null;
  /** Registration generation of the file write, when a file was involved. */
  generation: number | null;
}

/**
 * Every row that can own a blob (SYNTHESIS_R5 §6.5). The GC recheck and the
 * orphan sweep both ask this exact question so a file can only be removed
 * when no index of any table points at its digest. `?1` is the bare hex digest.
 */
export const BLOB_OWNER_PREDICATE = `EXISTS(SELECT 1 FROM command WHERE params_sha = ?1)
  OR EXISTS(SELECT 1 FROM command WHERE result_sha = ?1)
  OR EXISTS(SELECT 1 FROM turn WHERE prompt_sha = ?1)
  OR EXISTS(SELECT 1 FROM event WHERE payload_sha = ?1)
  OR EXISTS(SELECT 1 FROM resource WHERE sha256 = ?1 AND state IN ('publishing', 'ready'))
  OR EXISTS(SELECT 1 FROM upload WHERE finalize_sha = ?1)
  OR EXISTS(SELECT 1 FROM effect_obligation WHERE kind = 'publish_blob'
            AND json_extract(CAST(payload AS TEXT), '$.sha') = ?1)`;
export const BLOB_OWNER_SQL = `SELECT (${BLOB_OWNER_PREDICATE}) AS owned`;

/** Inline bytes and their final reference disappear in one durable prefix. */
export function deleteUnownedInlineInTx(sql: SqlWriteContext, sha256: string): void {
  requireTransaction(sql);
  sql
    .prepare(
      `DELETE FROM blob WHERE sha256 = ?1 AND inline IS NOT NULL AND NOT (${BLOB_OWNER_PREDICATE})`,
    )
    .run(sha256);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type GcOutcome = UnlinkOutcome;

/**
 * Content-addressed bodies: `resource-store/blobs/<sha256>` for anything above
 * 64 KiB, written synchronously on the request thread in the same tick as the
 * owning transaction (temp `O_DSYNC` + rename, never rewriting an existing
 * file), then the `blob` row plus the owner's reference row commit together.
 * The store owns the shared owner generations the GC is bound to.
 */
export class BlobFiles {
  readonly dir: string;
  /** Owner-change generations shared with the sweep (R5_AMENDMENTS A3/C10). */
  readonly owners: OwnerGenerations;

  constructor(
    private readonly store: EngineStore,
    dir = store.paths.blobs,
  ) {
    this.dir = dir;
    this.owners = store.owners;
  }

  /** Before the owning transaction (same tick): hash, and write the file if the body is large.
   * "Already present" is decided by the FILE, never by the `blob` row (C3). */
  prepareBody(bytes: Uint8Array): BodyRef {
    const sha256 = sha256Hex(bytes);
    if (bytes.byteLength <= INLINE_BODY_MAX_BYTES) {
      return {
        sha256,
        size: bytes.byteLength,
        inline: Buffer.from(bytes),
        file: null,
        generation: null,
      };
    }
    const receipt = writeExternalFile(this.store, {
      dir: this.dir,
      name: sha256,
      bytes,
      keepExisting: true,
    });
    return {
      sha256,
      size: bytes.byteLength,
      inline: null,
      file: receipt.path,
      generation: receipt.generation,
    };
  }

  /** Inside the owning transaction: the `blob` row (idempotent per digest). */
  insertRow(ref: BodyRef): void {
    if (!this.store.inTransaction)
      throw new Error("blob rows are inserted inside the owner's transaction");
    this.store
      .prepare("INSERT OR IGNORE INTO blob(sha256, size, inline) VALUES(?, ?, ?)")
      .run(ref.sha256, ref.size, ref.inline);
  }

  /** The body bytes, verified against the digest; inline wins, else the file. */
  read(sha256: string): Buffer {
    const row = this.store.prepare("SELECT size, inline FROM blob WHERE sha256 = ?").get(sha256) as
      { size: number | bigint; inline: Uint8Array | null } | undefined;
    if (!row) throw new StoreError("blob_not_found", 404, false, `no blob ${sha256}`);
    const bytes = row.inline ? Buffer.from(row.inline) : this.readFile(sha256);
    if (bytes.byteLength !== Number(row.size) || sha256Hex(bytes) !== sha256) {
      throw new StoreError(
        "blob_digest_mismatch",
        409,
        false,
        `blob ${sha256} does not match its digest`,
      );
    }
    return bytes;
  }

  filePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new StoreError("blob_digest_mismatch", 409, false, "blob digest is not a hex sha256");
    }
    return join(this.dir, sha256);
  }

  /** Finalize publication (SYNTHESIS_R5 §6.4): hard-link the part into the blob store (EEXIST = present). */
  publishLink(
    sourcePath: string,
    sha256: string,
  ): { path: string; generation: number; linked: boolean } {
    const path = this.filePath(sha256);
    // Restart may find the published blob after its redundant part was removed.
    if (existsSync(path))
      return { path, generation: this.store.registerExternal(this.dir), linked: false };
    const receipt = linkExternalFile(this.store, {
      source: sourcePath,
      dir: this.dir,
      name: path.slice(this.dir.length + 1),
    });
    return { path: receipt.path, generation: receipt.generation, linked: receipt.written };
  }

  /** Is any row still pointing at this digest? (the exact question the sweep asks too) */
  owned(sha256: string): boolean {
    const row = this.store.prepare(BLOB_OWNER_SQL).get(sha256) as { owned: number | bigint };
    return Number(row.owned) === 1;
  }

  /**
   * Right after the COMMIT of a transaction that inserted, released or changed
   * a reference to the digest (publication, prune, event delete, releaseModel,
   * upload discard, publish_blob removal): the GC is bound to this generation.
   */
  noteOwnerChange(sha256: string): number {
    return this.owners.noteChange(`blob:${sha256}`);
  }

  /**
   * GC (A3/C3/C10): wait for the barrier of the LATEST known owner change,
   * then in ONE synchronous section re-check newer changes and every reverse
   * index; at zero owners unlink the file (ENOENT = already gone) and delete
   * the file-mode `blob` row. One flight per digest; concurrent callers join.
   */
  gc(sha256: string): Promise<GcOutcome> {
    const path = this.filePath(sha256);
    return this.owners.unlinkWhenUnowned(`blob:${sha256}`, {
      path,
      owners: () => this.owned(sha256),
      afterUnlink: () => {
        this.store.transaction(() => {
          this.store.prepare("DELETE FROM blob WHERE sha256 = ? AND inline IS NULL").run(sha256);
        });
        this.store.registerExternal(this.dir);
      },
    });
  }

  private readFile(sha256: string): Buffer {
    const path = this.filePath(sha256);
    try {
      return readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StoreError("blob_unavailable", 409, false, `blob file ${sha256} is missing`);
      }
      throw error;
    }
  }
}
