import {
  operatorDecisionBinding,
  parseDecisionMutation,
  parseOperatorDecision,
  type DecisionMutation,
  type OperatorDecisionRecord,
  type RecordedOperatorDecision,
} from "../operator-decisions.js";
import type { SqlEventLedger } from "./event-store.js";
import { bindIdempotencyInTx, lookupIdempotency } from "./idempotency.js";
import { requireTransaction, runMutation, type SqlWriteContext } from "./mutation.js";
import type { EngineStore } from "./store.js";

/** Latest decision and every original request binding share the row transaction. */
export function applyDecisionInTx(
  sql: SqlWriteContext,
  pid: number,
  input: DecisionMutation,
): void {
  requireTransaction(sql);
  const mutation = parseDecisionMutation(input);
  const result = sql
    .prepare(
      "INSERT INTO operator_decision(run_id,pid,body) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body WHERE operator_decision.pid=excluded.pid",
    )
    .run(mutation.decision.runId, pid, Buffer.from(JSON.stringify(mutation.decision)));
  if (Number(result.changes) !== 1)
    throw new Error("operator decision belongs to a different partition");
  if (mutation.idempotency) {
    const { keyDigest, requestDigest, runId } = mutation.idempotency;
    const binding = bindIdempotencyInTx(sql, {
      owner: "decision",
      pid,
      keyDigest,
      requestDigest,
      targetId: runId,
      operation: "run.decision",
      createdAt: mutation.decision.decidedAt,
    });
    if (binding.targetId !== runId)
      throw new Error("conflicting operator decision idempotency history");
  }
}

export class SqlOperatorDecisionStore {
  constructor(
    private readonly store: EngineStore,
    private readonly events: SqlEventLedger,
  ) {}

  get(runId: string): OperatorDecisionRecord | null {
    const row = this.store
      .prepare("SELECT body FROM operator_decision WHERE run_id=? AND pid=?")
      .get(runId, this.events.generation.pid) as { body: Uint8Array } | undefined;
    return row ? parseOperatorDecision(JSON.parse(Buffer.from(row.body).toString("utf8"))) : null;
  }

  findByIdempotency(
    runId: string,
    idempotency: { key: string; client: string; request: unknown },
  ): OperatorDecisionRecord | null {
    const key = operatorDecisionBinding(this.events.generation.name, runId, idempotency)!;
    const binding = lookupIdempotency(
      this.store,
      { owner: "decision", pid: this.events.generation.pid, keyDigest: key.keyDigest },
      key.requestDigest,
    );
    if (!binding) return null;
    const decision = this.get(binding.targetId);
    if (!decision) throw new Error("operator decision idempotency index is dangling");
    return decision;
  }

  record(
    input: OperatorDecisionRecord,
    idempotency?: { key: string; client: string; request: unknown },
  ): RecordedOperatorDecision {
    const decision = parseOperatorDecision(input);
    const binding = operatorDecisionBinding(
      this.events.generation.name,
      decision.runId,
      idempotency,
    );
    if (idempotency) {
      const prior = this.findByIdempotency(decision.runId, idempotency);
      if (prior) return { record: prior, reused: true };
    }
    const mutation = { decision, ...(binding ? { idempotency: binding } : {}) };
    const event = this.events.prepare("operator.decision_recorded", mutation);
    runMutation(this.store, (tx) => {
      applyDecisionInTx(tx, this.events.generation.pid, mutation);
      this.events.appendInTx(tx, event);
    });
    return { record: decision, reused: false };
  }
}
