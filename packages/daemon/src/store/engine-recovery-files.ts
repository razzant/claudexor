import { closeSync, existsSync, fsyncSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256, sha256File } from "../journal-recovery-files.js";
import { typedError } from "../journal-recovery-operation.js";

export const ENGINE_STATE_FILES = [
  "engine.sqlite",
  "engine.sqlite-wal",
  "engine.sqlite-shm",
] as const;
export interface EngineFileEvidence {
  name: (typeof ENGINE_STATE_FILES)[number];
  bytes: number | null;
  sha256: string | null;
}

/** Only the SQLite file set, never root authority, credentials or retained artifacts. */
export function engineFileEvidence(root: string): EngineFileEvidence[] {
  return ENGINE_STATE_FILES.map((name) => {
    const path = join(root, name);
    if (!existsSync(path)) return { name, bytes: null, sha256: null };
    const digest = sha256File(path); // Existing owned/no-follow, stable, bounded reader.
    return { name, bytes: statSync(path).size, sha256: digest };
  });
}

export function engineFingerprint(files: readonly EngineFileEvidence[]): string {
  return sha256(Buffer.from(JSON.stringify(files)));
}

/** The explicit closed-file recovery path must persist checkpointed DB pages,
 * not infer their durability from a WAL-only barrier. */
export function syncEngineFiles(root: string, files: readonly EngineFileEvidence[]): void {
  for (const file of files) {
    if (file.sha256 === null) continue;
    const fd = openSync(join(root, file.name), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function parseEngineFiles(value: unknown): EngineFileEvidence[] {
  if (!Array.isArray(value) || value.length !== ENGINE_STATE_FILES.length)
    throw typedError(
      "recovery_operation_malformed",
      503,
      "closed engine file inventory is incomplete",
    );
  return value.map((row, index) => {
    if (
      !row ||
      row.name !== ENGINE_STATE_FILES[index] ||
      !(
        (row.sha256 === null && row.bytes === null) ||
        (typeof row.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(row.sha256) &&
          Number.isSafeInteger(row.bytes) &&
          row.bytes >= 0)
      )
    )
      throw typedError(
        "recovery_operation_malformed",
        503,
        "closed engine file inventory is invalid",
      );
    return { name: row.name, bytes: row.bytes, sha256: row.sha256 };
  });
}
