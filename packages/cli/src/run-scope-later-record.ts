import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunProcessScopeLater } from "@claudexor/schema";
import { runScopeFacts } from "@claudexor/orchestrator";
import type { LaterScopeSettlement, LaterSettlementListener } from "./run-scope-late-settlement.js";

/** Beside the run's terminal `final/process_scope.yaml`, which stays historical. */
export const LATER_PROCESS_SCOPE = "final/process_scope_later.yaml";

/** The latest later attempt, atomically (JSON text, which every YAML reader accepts). */
export function writeLaterProcessScope(runDir: string, settlement: LaterScopeSettlement): void {
  const record = RunProcessScopeLater.parse({
    attempt: settlement.attempt,
    at: settlement.at,
    outcome: runScopeFacts(settlement.marker, settlement.outcome),
  });
  const path = join(runDir, LATER_PROCESS_SCOPE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Composition of #613: each later attempt is recorded in its run (run detail
 * projects it), and a settled one tells the deferred owner, which returns only
 * an unchanged draft held for that unknown custody. A run with no directory has
 * nothing to record and nothing to return. A record or return that fails throws,
 * so the settlement owner owes this report and repeats it, never the reap.
 */
export function bindLaterScopeSettlements(
  source: { onLaterSettlement(listener: LaterSettlementListener): () => void },
  deps: {
    run: (runId: string) => { id: string; runDir?: string | null } | undefined;
    settled: (jobId: string) => Promise<void>;
    log: (message: string) => void;
  },
): () => void {
  return source.onLaterSettlement(async (settlement: LaterScopeSettlement) => {
    const record = deps.run(settlement.runId);
    if (!record?.runDir) return;
    try {
      writeLaterProcessScope(record.runDir, settlement);
      if (settlement.outcome.settled) await deps.settled(record.id);
    } catch (error) {
      deps.log(`later process-scope report of ${settlement.runId} is owed: ${String(error)}`);
      throw error;
    }
  });
}
