import type { RunEvent, RunTelemetry } from "@claudexor/schema";
import type { CommandBackend } from "../command-authority.js";
import {
  beginDeliveryCommand,
  completeDeliveryCommand,
  failDeliveryCommand,
} from "../delivery-command.js";
import type { OperatorDecisionRecord } from "../operator-decisions.js";
import type { ProjectThreadPort } from "../store-contracts.js";
import { SqlCommandQueries } from "./command-queries.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlCommandStore } from "./commands.js";
import { SqlEventLedger } from "./event-store.js";
import { isServedPid } from "./generations.js";
import { SqlInteractionStore } from "./interactions.js";
import type { Obligations } from "./obligations.js";
import { SqlOperatorDecisionStore } from "./operator-decisions.js";
import { partitionById, type PartitionGeneration } from "./partitions.js";
import { SqlProjectRouter } from "./project-router.js";
import type { SqlProjectStore } from "./projects.js";
import { SqlRunEventStore } from "./run-events.js";
import type { SqlTerminalFiles } from "./terminal-files.js";

/** One addressed router over current generations. These lightweight writers
 * carry no restored history or separate partition cache. */
export class SqlCommandRouter
  extends SqlProjectRouter
  implements CommandBackend, ProjectThreadPort
{
  readonly queries: SqlCommandQueries;
  constructor(
    projects: SqlProjectStore,
    private readonly persistence: {
      obligations: Obligations;
      terminalFiles: SqlTerminalFiles;
      pruner: SqlCommandPruner;
    },
  ) {
    super(projects);
    this.queries = new SqlCommandQueries(this.store, projects.blobs);
  }

  commandStore(generation: PartitionGeneration): SqlCommandStore {
    return new SqlCommandStore(this.store, this.projects.blobs, generation, {
      ...this.persistence,
      isLive: () => isServedPid(this.store, generation.pid),
    });
  }
  current(): SqlCommandStore {
    return this.commandStore(this.projects.global());
  }
  forRequest(params: unknown): SqlCommandStore {
    return this.commandStore(this.generationForRequest(params));
  }
  findById(id: string): SqlCommandStore | undefined {
    const generation = this.generationForCommand(id);
    return generation ? this.commandStore(generation) : undefined;
  }
  pruneHistory(cap: number, retentionMs: number, now: number): string[] {
    return this.persistence.pruner.pruneHistory(cap, retentionMs, now);
  }
  ledger(generation: Pick<PartitionGeneration, "pid" | "name" | "epoch">): SqlEventLedger {
    return new SqlEventLedger(this.store, this.projects.blobs, generation);
  }
  interactionsForRequest(params: unknown): SqlInteractionStore {
    return new SqlInteractionStore(this.store, this.ledger(this.generationForRequest(params)));
  }
  interactionsForRun(runId: string): SqlInteractionStore | undefined {
    // The interaction index also addresses a retained imported interaction
    // whose command is absent, matching the former store lookup semantics.
    const rows = this.store
      .prepare("SELECT DISTINCT pid FROM interaction WHERE run_id=?")
      .all(runId) as Array<{ pid: number }>;
    const row = rows.find(({ pid }) => isServedPid(this.store, pid));
    const generation = row ? partitionById(this.store, row.pid) : null;
    return generation ? new SqlInteractionStore(this.store, this.ledger(generation)) : undefined;
  }
  private decisions(params: unknown): SqlOperatorDecisionStore {
    return new SqlOperatorDecisionStore(this.store, this.ledger(this.generationForRequest(params)));
  }
  operatorDecision(params: unknown, runId: string) {
    return this.decisions(params).get(runId);
  }
  findOperatorDecisionByIdempotency(
    params: unknown,
    runId: string,
    input: { key: string; client: string; request: unknown },
  ) {
    return this.decisions(params).findByIdempotency(runId, input);
  }
  recordOperatorDecision(
    params: unknown,
    decision: OperatorDecisionRecord,
    input?: { key: string; client: string; request: unknown },
  ) {
    return this.decisions(params).record(decision, input);
  }
  recordRunEvent(params: unknown, event: RunEvent): RunEvent {
    return new SqlRunEventStore(this.ledger(this.generationForRequest(params))).record(event);
  }
  persistTerminal(jobId: string, event: RunEvent, telemetry: RunTelemetry | null) {
    const owner = this.findById(jobId);
    if (!owner) throw new Error(`terminal authority lost command ${jobId}`);
    return owner.persistTerminal(jobId, event, telemetry);
  }
  beginDelivery(
    params: unknown,
    input: { key: string; client: string; operation: string; request: unknown },
  ) {
    return beginDeliveryCommand(this.forRequest(params), params, input);
  }
  completeDelivery(id: string, result: unknown): void {
    completeDeliveryCommand(this.findById(id), id, result);
  }
  failDelivery(id: string, error: unknown): void {
    failDeliveryCommand(this.findById(id), id, error);
  }
}
