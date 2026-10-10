import { EngineRuntimeUnsupportedError } from "./errors.js";

/** First SQLite that fixes the WAL-reset corruption bug (two connections
 * writing/checkpointing at once — exactly the flusher topology). Bundled by
 * Node >= 24.15.0 and >= 22.23.0; the published engines floor is 24.15.0. */
export const ENGINE_SQLITE_MIN_VERSION = "3.51.3";

export type SqliteModule = typeof import("node:sqlite");

export interface EngineRuntime {
  sqlite: SqliteModule;
  nodeVersion: string;
  sqliteVersion: string;
}

export interface EngineRuntimeProbe {
  versions?: Readonly<Record<string, string | undefined>>;
  importSqlite?: () => Promise<SqliteModule>;
}

/** Compare dotted numeric versions; non-numeric segments compare as 0. */
export function compareDottedVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Lazily import `node:sqlite` and prove the bundled SQLite is new enough.
 * Fails typed (`engine_runtime_unsupported`) before any data root is touched:
 * Node 20 has no `node:sqlite`, Node 22 < 22.23 and Node 24 < 24.15 bundle
 * the WAL-reset-affected SQLite, and neither may serve an engine store.
 */
export async function loadEngineRuntime(probe: EngineRuntimeProbe = {}): Promise<EngineRuntime> {
  const versions = probe.versions ?? process.versions;
  const nodeVersion = versions["node"] ?? "unknown";
  const sqliteVersion = versions["sqlite"] ?? null;
  if (sqliteVersion === null) {
    throw new EngineRuntimeUnsupportedError({
      nodeVersion,
      sqliteVersion,
      requiredSqlite: ENGINE_SQLITE_MIN_VERSION,
      detail: "this Node does not bundle SQLite (node:sqlite is absent)",
    });
  }
  if (compareDottedVersions(sqliteVersion, ENGINE_SQLITE_MIN_VERSION) < 0) {
    throw new EngineRuntimeUnsupportedError({
      nodeVersion,
      sqliteVersion,
      requiredSqlite: ENGINE_SQLITE_MIN_VERSION,
      detail: "the bundled SQLite predates the WAL-reset corruption fix",
    });
  }
  let sqlite: SqliteModule;
  try {
    sqlite = await (probe.importSqlite ?? (() => import("node:sqlite")))();
  } catch (error) {
    throw new EngineRuntimeUnsupportedError({
      nodeVersion,
      sqliteVersion,
      requiredSqlite: ENGINE_SQLITE_MIN_VERSION,
      detail: "node:sqlite could not be imported",
      cause: error,
    });
  }
  if (typeof sqlite.DatabaseSync !== "function") {
    throw new EngineRuntimeUnsupportedError({
      nodeVersion,
      sqliteVersion,
      requiredSqlite: ENGINE_SQLITE_MIN_VERSION,
      detail: "node:sqlite exposes no DatabaseSync",
    });
  }
  return { sqlite, nodeVersion, sqliteVersion };
}
