import { closeSync, existsSync, fsyncSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fsyncDirectory } from "@claudexor/util";

type PublicationStep = "synced" | "floor" | "database" | "journal";

/** The import worker has closed its one connection and proved equivalence.
 * This startup-only owner publishes the closed database under the existing
 * root-authority lease. No request handler or background writer uses it. */
export function publishImportedStore(input: {
  daemonDir: string;
  externalDirectories: readonly string[];
  advanceFloor(): void;
  /** Crash-matrix test seam; production supplies no hook. */
  afterStep?: (step: PublicationStep) => void;
}): { databasePath: string; legacyPath: string | null } {
  const temporary = join(input.daemonDir, "engine.sqlite.import");
  const databasePath = join(input.daemonDir, "engine.sqlite");
  if (existsSync(`${temporary}-wal`)) {
    throw Object.assign(new Error("closed import still has a WAL; database was not published"), {
      code: "store_import_wal_present",
      status: 503,
      retryable: true,
    });
  }
  if (existsSync(databasePath)) {
    throw new Error("an engine database is already published; use the existing-store startup path");
  }
  // Names of imported external bodies precede the device barrier on the
  // database. Their bytes were written through by the import body writer.
  for (const dir of new Set(input.externalDirectories)) fsyncDirectory(dir);
  const fd = openSync(temporary, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  input.afterStep?.("synced");
  input.advanceFloor();
  input.afterStep?.("floor");
  renameSync(temporary, databasePath);
  input.afterStep?.("database");
  const legacyPath = preserveLegacyJournal(input.daemonDir);
  input.afterStep?.("journal");
  fsyncDirectory(input.daemonDir);
  return { databasePath, legacyPath };
}

/** A crash after the database rename resumes here. The published database
 * wins; historical journals are retained as evidence and never served. */
export function preserveLegacyJournal(daemonDir: string): string | null {
  const journal = join(daemonDir, "journal");
  if (!existsSync(journal)) return null;
  const ordinary = join(daemonDir, "journal-legacy");
  const target = existsSync(ordinary) ? `${ordinary}-${Date.now()}-${randomUUID()}` : ordinary;
  renameSync(journal, target);
  fsyncDirectory(daemonDir);
  return target;
}
