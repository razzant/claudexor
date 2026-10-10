import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { BLOB_OWNER_PREDICATE } from "./blob-files.js";
import { sqlitePrimaryCode } from "./errors.js";
import { STORE_WORKER_DATA_KEY } from "./flusher-protocol.js";
import { loadEngineRuntime } from "./runtime.js";
import type {
  ExportReport,
  IntegrityReport,
  MaintenanceRequest,
  MaintenanceResponse,
  MaintenanceWorkerData,
  SweepCandidate,
  SweepCandidates,
} from "./maintenance.js";

const BLOB_NAME = /^[0-9a-f]{64}$/;
const PART_NAME = /^(.+)\.part$/;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** Read-only snapshot pre-filter: a blob file is owned only when a reverse
 * index or an open publish obligation points at it (A3/A4). A bare `blob`
 * row is NOT an owner — the file and its row go together through the C10 loop. */
const SWEEP_OWNER_SQL = `SELECT (${BLOB_OWNER_PREDICATE}) AS owned`;

function integrityCheck(db: DatabaseSync): IntegrityReport {
  const started = performance.now();
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const problems = rows.map((row) => row.integrity_check).filter((text) => text !== "ok");
    return {
      ok: rows.length === 1 && problems.length === 0,
      problems,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    // A malformed page can abort the check itself: that IS the failed verdict.
    const primary = sqlitePrimaryCode(error);
    if (primary !== SQLITE_CORRUPT && primary !== SQLITE_NOTADB) throw error;
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
      durationMs: performance.now() - started,
    };
  }
}

function vacuumInto(db: DatabaseSync, target: string): ExportReport {
  const started = performance.now();
  db.prepare("VACUUM INTO ?").run(target);
  return { target, bytes: statSync(target).size, durationMs: performance.now() - started };
}

/** Enumerate files older than the process start that no row in this snapshot owns. Decisions happen on main. */
function sweepCandidates(
  db: DatabaseSync,
  request: Extract<MaintenanceRequest, { kind: "sweep_candidates" }>,
): SweepCandidates {
  const started = performance.now();
  const owned = db.prepare(SWEEP_OWNER_SQL);
  const result: SweepCandidates = {
    scanned: 0,
    keptYoung: 0,
    keptOwned: 0,
    candidates: [],
    durationMs: 0,
  };
  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const oldRegularFile = (path: string): boolean => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return false;
    if (stat.mtimeMs >= request.olderThanMs) {
      result.keptYoung += 1;
      return false;
    }
    return true;
  };
  const push = (candidate: SweepCandidate): void => void result.candidates.push(candidate);
  for (const name of entries(request.blobsDir)) {
    result.scanned += 1;
    const path = join(request.blobsDir, name);
    if (name.endsWith(".tmp")) {
      if (oldRegularFile(path)) push({ kind: "tmp", path });
      continue;
    }
    if (!BLOB_NAME.test(name) || !oldRegularFile(path)) continue;
    if (Number((owned.get(name) as { owned: number | bigint }).owned) === 1) {
      result.keptOwned += 1;
      continue;
    }
    push({ kind: "blob", path, sha: name });
  }
  for (const name of entries(request.uploadsDir)) {
    result.scanned += 1;
    const path = join(request.uploadsDir, name);
    if (name.endsWith(".tmp")) {
      if (oldRegularFile(path)) push({ kind: "tmp", path });
      continue;
    }
    const part = PART_NAME.exec(name);
    if (!part || !oldRegularFile(path)) continue;
    push({ kind: "part", path, uploadId: part[1]! });
  }
  result.durationMs = performance.now() - started;
  return result;
}

/** `node:sqlite` is imported lazily: the daemon package must load on a Node without it. */
export async function runMaintenanceWorker(
  port: MessagePort,
  data: MaintenanceWorkerData,
): Promise<void> {
  const { sqlite } = await loadEngineRuntime();
  const db: DatabaseSync = new sqlite.DatabaseSync(data.dbPath, { readOnly: true, timeout: 0 });
  port.on("message", (request: MaintenanceRequest) => {
    let response: MaintenanceResponse;
    try {
      switch (request.kind) {
        case "integrity_check":
          response = { id: request.id, ok: true, result: integrityCheck(db) };
          break;
        case "vacuum_into":
          response = { id: request.id, ok: true, result: vacuumInto(db, request.target) };
          break;
        case "sweep_candidates":
          response = { id: request.id, ok: true, result: sweepCandidates(db, request) };
          break;
      }
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    port.postMessage(response);
  });
}

const spawnData = workerData as Partial<MaintenanceWorkerData> | null | undefined;
if (!isMainThread && parentPort && spawnData?.[STORE_WORKER_DATA_KEY] === "maintenance") {
  void runMaintenanceWorker(parentPort, spawnData as MaintenanceWorkerData).catch(
    (error: unknown) => {
      throw error;
    },
  );
}
