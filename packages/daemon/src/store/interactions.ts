import { ControlPendingInteraction } from "@claudexor/schema";
import {
  interactionKey,
  parseInteractionResolution,
  pendingInteraction,
  type InteractionContext,
  type InteractionTerminal,
} from "../interactions.js";
import type { InteractionStorePort } from "../store-contracts.js";
import type { SqlEventLedger } from "./event-store.js";
import { requireTransaction, runMutation, type SqlWriteContext } from "./mutation.js";
import type { EngineStore } from "./store.js";

/** Pure import/runtime reducer. Resolution is retained in state after its
 * event pair folds away, so a restart still answers already_resolved. */
export function applyInteractionInTx(
  sql: SqlWriteContext,
  pid: number,
  type: "interaction.requested" | "interaction.resolved",
  payload: unknown,
): void {
  requireTransaction(sql);
  if (type === "interaction.requested") {
    const value = ControlPendingInteraction.parse(payload);
    sql
      .prepare("INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,?,'pending',?)")
      .run(
        interactionKey(value.runId, value.interactionId),
        pid,
        value.runId,
        Buffer.from(JSON.stringify(value)),
      );
    return;
  }
  const value = parseInteractionResolution(payload);
  for (const id of value.interactionIds) {
    const result = sql
      .prepare(
        "UPDATE interaction SET state=?,resolution=? WHERE id=? AND pid=? AND state='pending'",
      )
      .run(
        value.terminal === "interrupted" ? "interrupted" : "resolved",
        Buffer.from(JSON.stringify(value)),
        interactionKey(value.runId, id),
        pid,
      );
    if (Number(result.changes) !== 1) throw new Error("interaction resolution precedes request");
  }
}

export class SqlInteractionStore implements InteractionStorePort {
  constructor(
    private readonly store: EngineStore,
    private readonly events: SqlEventLedger,
  ) {}

  request(ctx: InteractionContext): ControlPendingInteraction {
    const value = pendingInteraction(ctx);
    if (this.status(value.runId, value.interactionId) !== "missing")
      throw new Error(`duplicate interaction '${value.interactionId}' for run '${value.runId}'`);
    const event = this.events.prepare("interaction.requested", value);
    runMutation(this.store, (tx) => {
      applyInteractionInTx(tx, this.events.generation.pid, "interaction.requested", value);
      this.events.appendInTx(tx, event);
    });
    return value;
  }

  resolve(
    runId: string,
    interactionId: string,
    terminal: InteractionTerminal,
  ): "resolved" | "not_found" | "already_resolved" {
    const state = this.status(runId, interactionId);
    if (state !== "pending") return state === "missing" ? "not_found" : "already_resolved";
    this.commitResolution(runId, [interactionId], terminal);
    return "resolved";
  }

  resolveRun(
    runId: string,
    terminal: Extract<InteractionTerminal, "run_terminal" | "interrupted">,
  ): string[] {
    const ids = this.pendingForRun(runId).map((value) => value.interactionId);
    if (ids.length) this.commitResolution(runId, ids, terminal);
    return ids;
  }

  status(runId: string, interactionId: string): "pending" | "resolved" | "missing" {
    const row = this.store
      .prepare("SELECT state FROM interaction WHERE id=? AND pid=?")
      .get(interactionKey(runId, interactionId), this.events.generation.pid) as
      { state: string } | undefined;
    return row ? (row.state === "pending" ? "pending" : "resolved") : "missing";
  }

  pendingForRun(runId: string): ControlPendingInteraction[] {
    return (
      this.store
        .prepare(
          "SELECT request FROM interaction WHERE run_id=? AND pid=? AND state='pending' ORDER BY rowid",
        )
        .all(runId, this.events.generation.pid) as Array<{ request: Uint8Array }>
    ).map((row) =>
      ControlPendingInteraction.parse(JSON.parse(Buffer.from(row.request).toString("utf8"))),
    );
  }

  recoverAfterStartup(): void {
    const rows = this.store
      .prepare("SELECT DISTINCT run_id FROM interaction WHERE pid=? AND state='pending'")
      .all(this.events.generation.pid) as Array<{ run_id: string }>;
    for (const row of rows) this.resolveRun(row.run_id, "interrupted");
  }

  private commitResolution(
    runId: string,
    interactionIds: string[],
    terminal: InteractionTerminal,
  ): void {
    const value = parseInteractionResolution({ runId, interactionIds, terminal });
    const event = this.events.prepare("interaction.resolved", value);
    runMutation(this.store, (tx) => {
      applyInteractionInTx(tx, this.events.generation.pid, "interaction.resolved", value);
      this.events.appendInTx(tx, event);
    });
  }
}
