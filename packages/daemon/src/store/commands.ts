import { RunEvent, type RunTelemetry } from "@claudexor/schema";
import {
  commandDigests,
  validateCommandKey,
  type AcceptCommand,
  type FindCommand,
} from "../command-store.js";
import { journaledRunEventCopy } from "../journaled-run-events.js";
import type { JobRecord } from "../job-record.js";
import type { CommandStorePort } from "../store-contracts.js";
import {
  recoveredTerminalFacts,
  terminalCommandResult,
  terminalResultMatches,
} from "../terminal-authority.js";
import type { BlobFiles } from "./blob-files.js";
import {
  applyCommandInTx,
  commandRow,
  hydrateCommand,
  prepareCommandRow,
  type CommandRow,
} from "./command-rows.js";
import { SqlCommandPruner } from "./command-prune.js";
import { collectReleasedBodies, eventBody, SqlEventLedger } from "./event-store.js";
import { bindIdempotencyInTx, lookupIdempotency } from "./idempotency.js";
import {
  MutationPostCommitError,
  requireTransaction,
  runMutation,
  type MutationContext,
} from "./mutation.js";
import type { Obligations } from "./obligations.js";
import type { PartitionGeneration } from "./partitions.js";
import type { EngineStore } from "./store.js";
import type { SqlTerminalFiles } from "./terminal-files.js";
import { applyTerminalInTx, storedTerminal } from "./run-events.js";
import {
  claimResourceUsesInTx,
  markTurnDispatchedInTx,
  referencedResourceIds,
  turnDispatchUses,
  type ResourceUseHolder,
} from "./resource-uses.js";

/** A purged thread is terminal: no new work of it is accepted. Its accepted
 * commands still answer their replay, which every caller looks up first, and a
 * `delivery` command (apply, discard, revert or a message receipt of a run's
 * retained result) is not new work, so it stays as available as before purge. */
function assertThreadAdmits(tx: MutationContext, row: CommandRow): void {
  if (row.kind === "delivery" || row.thread_id === null) return;
  const thread = tx.prepare("SELECT state FROM thread WHERE id=?").get(row.thread_id) as
    { state: string } | undefined;
  if (thread?.state === "purged")
    throw Object.assign(new Error(`thread ${row.thread_id} was purged; it admits no new work`), {
      code: "thread_purged",
      status: 409,
      retryable: false,
    });
}

/** The command record a durable terminal settles, derived from its RunFacts. */
function terminalRecord(current: JobRecord, event: RunEvent): JobRecord {
  const { facts } = recoveredTerminalFacts(current, event);
  return {
    ...current,
    state: facts.outcome.lifecycle,
    finishedAt: event.ts,
    result: terminalCommandResult(current, facts),
  };
}

/** Partition-scoped SQL command writes. Collection reads live in the separate
 * addressed query owner, not an enumerable in-memory command cache. */
export class SqlCommandStore implements CommandStorePort {
  private readonly events: SqlEventLedger;
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    readonly generation: Pick<PartitionGeneration, "pid" | "name" | "epoch">,
    private readonly options: {
      isLive: () => boolean;
      obligations: Obligations;
      terminalFiles: SqlTerminalFiles;
      pruner: SqlCommandPruner;
    },
  ) {
    this.events = new SqlEventLedger(store, blobs, generation);
  }

  accept(input: AcceptCommand): { record: JobRecord; reused: boolean } {
    const prior = this.find(input);
    if (prior) return { record: prior, reused: true };
    const prepared = this.prepareAcceptance(input);
    return runMutation(this.store, (tx) => this.acceptInTx(tx, prepared));
  }

  /** All body preparation precedes the synchronous acceptance transaction. */
  prepareAcceptance(input: AcceptCommand) {
    const digests = commandDigests(this.generation.name, input);
    const record = this.acceptanceRecord(input);
    const prepared = this.prepare(
      record,
      undefined,
      input.operation ?? "run.create",
      input.clientId,
    );
    const event = this.events.prepare("command.accepted", { record, ...digests });
    return { input: structuredClone(input), digests, record, prepared, event };
  }

  /** Compose acceptance with its owner's other row reducers; never starts a
   * transaction or publishes a queue entry. Replay remains first. `resourcesFrom`:
   * the accepted owner whose managed resources this command inherits (a draft); a
   * thread turn's first dispatch inherits the turn's own (`turnDispatchUses`). Only
   * product work references resources: a delivery of a run's retained result (whose
   * params are that run's) and model or maintenance commands take no hold. */
  acceptInTx(
    tx: MutationContext,
    acceptance: ReturnType<SqlCommandStore["prepareAcceptance"]>,
    resourcesFrom?: ResourceUseHolder,
  ) {
    requireTransaction(tx);
    const { input, digests, record, prepared, event } = acceptance;
    const prior = this.find(input);
    if (prior) return { record: prior, reused: true };
    assertThreadAdmits(tx, prepared.row);
    if (prepared.row.kind === "product") {
      const refs = (record.params as { attachments?: unknown } | null)?.attachments;
      const turn = turnDispatchUses(tx, prepared.row.turn_id);
      claimResourceUsesInTx(
        tx,
        { owner: "command", id: record.id },
        [...new Set([...referencedResourceIds(refs), ...turn.ids])],
        resourcesFrom ?? turn.from,
      );
      if (prepared.row.turn_id) markTurnDispatchedInTx(tx, prepared.row.turn_id, record.createdAt);
    }
    applyCommandInTx(tx, prepared, "accept");
    bindIdempotencyInTx(tx, {
      owner: "command",
      pid: this.generation.pid,
      ...digests,
      operation: input.operation ?? "run.create",
      targetId: record.id,
      createdAt: record.createdAt,
    });
    this.events.appendInTx(tx, event);
    tx.changes.blobChanged(prepared.row.params_sha, prepared.row.result_sha);
    return { record, reused: false };
  }

  private acceptanceRecord(input: AcceptCommand): JobRecord {
    return {
      id: input.id,
      state: "queued",
      params: structuredClone(input.params),
      createdAt: input.createdAt ?? this.store.now().toISOString(),
    };
  }

  /**
   * Off the request thread, before the synchronous `accept`: write the large
   * bodies it will own (`BlobFiles.stageBody`), so its same-tick preparation
   * finds them. Best effort; replay, admission and the write stay with `accept`.
   */
  async stageAcceptance(input: AcceptCommand): Promise<string> {
    const record = this.acceptanceRecord(input);
    const accepted = { record, ...commandDigests(this.generation.name, input) };
    await this.stageBodies(() => [...this.rowBodies(record), eventBody(accepted)]);
    return record.createdAt;
  }

  /** The `update` twin of `stageAcceptance`, for bodies known before the update. */
  async stageUpdate(id: string, patch: Partial<JobRecord>): Promise<void> {
    await this.stageBodies(() => {
      const row = commandRow(this.store, id, this.generation.pid);
      if (!row) return [];
      const next = this.nextRecord(row, patch);
      const { params: _params, ...record } = next;
      return [...this.rowBodies(next, row), eventBody({ record })];
    });
  }

  private async stageBodies(bodies: () => Uint8Array[]): Promise<void> {
    let staged: Uint8Array[];
    try {
      staged = bodies();
    } catch {
      return; // the synchronous mutation decides and reports
    }
    await Promise.all(staged.map((bytes) => this.blobs.stageBody(bytes)));
  }

  /** The bodies a row write of `record` prepares, collected instead of written. */
  private rowBodies(record: JobRecord, previous?: CommandRow): Uint8Array[] {
    const bodies: Uint8Array[] = [];
    prepareCommandRow(
      record,
      { pid: this.generation.pid, live: true, operation: "stage", clientId: null, previous },
      (bytes) => {
        bodies.push(bytes);
        return { sha256: "", size: bytes.byteLength, inline: null, file: null, generation: null };
      },
    );
    return bodies;
  }

  find(input: FindCommand): JobRecord | null {
    validateCommandKey(input.idempotencyKey);
    const { keyDigest, requestDigest } = commandDigests(this.generation.name, input);
    const binding = lookupIdempotency(
      this.store,
      { owner: "command", pid: this.generation.pid, keyDigest },
      requestDigest,
    );
    if (!binding) return null;
    const record = this.get(binding.targetId);
    if (!record)
      throw new Error(`idempotency record points to missing command ${binding.targetId}`);
    return record;
  }

  get(id: string): JobRecord | undefined {
    const row = commandRow(this.store, id, this.generation.pid);
    return row ? hydrateCommand(row, this.blobs) : undefined;
  }

  flushed(): Promise<void> {
    return this.store.flushed();
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    const row = commandRow(this.store, id, this.generation.pid);
    if (!row) throw new Error(`no such job: ${id}`);
    return this.writeUpdate(row, this.nextRecord(row, patch));
  }

  /** The record an update writes: the patch over the row, with a durable
   * terminal's RunFacts outcome winning over the patch. */
  private nextRecord(row: CommandRow, patch: Partial<JobRecord>): JobRecord {
    const current = hydrateCommand(row, this.blobs);
    let next: JobRecord = {
      ...current,
      ...structuredClone(patch),
      id: current.id,
      params: current.params,
    };
    const terminal = current.runId
      ? storedTerminal(this.store, current.runId, this.generation.pid)
      : undefined;
    if (terminal && Object.hasOwn(terminal.payload, "run_facts")) {
      const { facts } = recoveredTerminalFacts(current, terminal);
      const extra =
        next.result && typeof next.result === "object" && !Array.isArray(next.result)
          ? next.result
          : {};
      next = {
        ...next,
        state: facts.outcome.lifecycle,
        finishedAt: terminal.ts,
        result: { ...extra, ...terminalCommandResult(current, facts) },
      };
    }
    return next;
  }

  prune(ids: readonly string[]): void {
    this.options.pruner.prune(ids, this.generation.pid);
  }

  prunedScopeRoots(): string[] {
    return (
      this.store.prepare("SELECT root FROM pruned_root ORDER BY root").all() as Array<{
        root: string;
      }>
    ).map((row) => row.root);
  }

  /**
   * Off the request thread, before the synchronous `persistTerminal`: write the
   * large bodies it will own (BlobFiles.stageBody) and the receipts its file
   * step will publish (SqlTerminalFiles.stage). Best effort; persistTerminal
   * still decides, commits and writes whatever was not staged or has changed.
   */
  async stageTerminal(id: string, raw: RunEvent, telemetry: RunTelemetry | null): Promise<void> {
    let current: JobRecord, event: RunEvent, bodies: Uint8Array[];
    try {
      event = RunEvent.parse(raw);
      const row = commandRow(this.store, id, this.generation.pid);
      if (!row) return;
      current = hydrateCommand(row, this.blobs);
      const next = terminalRecord(current, event);
      const { params: _params, ...record } = next;
      bodies = [
        ...this.rowBodies(next, row),
        eventBody({ record }),
        eventBody(journaledRunEventCopy(event)),
      ];
    } catch {
      return;
    }
    await Promise.all([
      ...bodies.map((bytes) => this.blobs.stageBody(bytes)),
      this.options.terminalFiles.stage(current, event, telemetry),
    ]);
  }

  /** The synchronous EventLog hook: one SQL terminal then immediate file repair.
   * Returning pending means SQL committed; EventLog must never roll it back or
   * emit another terminal. A second terminal INSERT is a constraint failure. */
  persistTerminal(
    id: string,
    raw: RunEvent,
    telemetry: RunTelemetry | null,
  ): { state: "materialized" } | { state: "pending"; error: unknown } {
    const event = RunEvent.parse(raw);
    const row = commandRow(this.store, id, this.generation.pid);
    if (!row) throw new Error(`no such job: ${id}`);
    const current = hydrateCommand(row, this.blobs);
    const next = terminalRecord(current, event);
    const prepared = this.prepare(next, row);
    const { params: _params, ...record } = next;
    const updated = this.events.prepare("command.updated", { record });
    const run = this.events.prepare("run.event", journaledRunEventCopy(event));
    try {
      runMutation(this.store, (tx) => {
        applyCommandInTx(tx, prepared, "update");
        applyTerminalInTx(tx, this.generation.pid, event);
        this.options.obligations.create("terminal_files", event.run_id, this.generation.pid, {
          telemetry,
        });
        this.events.appendInTx(tx, updated);
        this.events.appendInTx(tx, run);
        tx.changes.blobChanged(
          row.params_sha,
          row.result_sha,
          prepared.row.params_sha,
          prepared.row.result_sha,
        );
        if (row.result_sha && row.result_sha !== prepared.row.result_sha)
          tx.changes.afterCommit(() =>
            collectReleasedBodies(this.store, this.blobs, [row.result_sha!]),
          );
      });
    } catch (error) {
      // Notification failure cannot authorize EventLog's pre-COMMIT rollback.
      // The terminal and its pending file obligation are already durable rows.
      if (error instanceof MutationPostCommitError) return { state: "pending", error };
      throw error;
    }
    try {
      this.options.terminalFiles.materialize(event.run_id);
    } catch {
      try {
        this.options.terminalFiles.materialize(event.run_id);
      } catch (error) {
        return { state: "pending", error };
      }
    }
    return { state: "materialized" };
  }

  recoverDurableTerminal(id: string): JobRecord | null {
    const current = this.get(id);
    if (!current?.runId) return null;
    const terminal = storedTerminal(this.store, current.runId, this.generation.pid);
    if (!terminal) return null;
    if (!Object.hasOwn(terminal.payload, "run_facts")) {
      if (current.state !== "queued" && current.state !== "running") return current;
      return this.update(id, {
        state: "interrupted",
        error: "daemon restarted after a legacy terminal event without recoverable RunFacts",
        errorCode: "legacy_terminal_recovery_unavailable",
        errorStatus: 503,
        errorRetryable: false,
        finishedAt: this.store.now().toISOString(),
      });
    }
    const { facts } = recoveredTerminalFacts(current, terminal);
    const active = current.state === "queued" || current.state === "running";
    let recovered = current;
    if (active || current.errorCode === "terminal_recovery_required") {
      const row = commandRow(this.store, id, this.generation.pid)!;
      recovered = this.writeUpdate(
        row,
        {
          ...current,
          state: facts.outcome.lifecycle,
          result: terminalCommandResult(current, facts),
          error:
            facts.outcome.lifecycle === "failed" || facts.outcome.lifecycle === "interrupted"
              ? `recovered durable ${facts.outcome.lifecycle} terminal after daemon restart`
              : undefined,
          errorCode: undefined,
          errorStatus: undefined,
          errorRetryable: undefined,
          errorRequiredActions: undefined,
          errorContext: undefined,
          finishedAt: terminal.ts,
        },
        this.options.terminalFiles.prepareRecoveryTelemetry(current.runDir!, facts),
      );
    } else if (
      current.state !== facts.outcome.lifecycle ||
      !terminalResultMatches(current.result, terminalCommandResult(current, facts))
    ) {
      throw new Error("terminal command result conflicts with durable terminal authority");
    }
    if (this.options.terminalFiles.pending(current.runId))
      this.options.terminalFiles.materialize(current.runId);
    return recovered;
  }

  recoverAfterStartup(): void {
    const rows = this.store
      .prepare("SELECT id FROM command WHERE pid=? AND live=1 AND state IN ('queued','running')")
      .all(this.generation.pid) as Array<{ id: string }>;
    for (const { id } of rows)
      if (!this.recoverDurableTerminal(id))
        this.update(id, {
          state: "interrupted",
          error: "daemon restarted before command completion was durably observed",
          finishedAt: this.store.now().toISOString(),
        });
  }

  private prepare(
    record: JobRecord,
    previous?: CommandRow,
    operation = "legacy",
    clientId: string | null = null,
  ) {
    return prepareCommandRow(
      record,
      {
        pid: this.generation.pid,
        live: previous ? previous.live === 1 && this.options.isLive() : this.options.isLive(),
        operation,
        clientId,
        previous,
      },
      (bytes) => this.blobs.prepareBody(bytes),
    );
  }

  private writeUpdate(
    row: CommandRow,
    next: JobRecord,
    recoveryTelemetry?: RunTelemetry | null,
  ): JobRecord {
    const prepared = this.prepare(next, row);
    const { params: _params, ...record } = next;
    const event = this.events.prepare("command.updated", { record });
    runMutation(this.store, (tx) => {
      applyCommandInTx(tx, prepared, "update");
      if (
        recoveryTelemetry !== undefined &&
        next.runId &&
        !this.options.obligations.get("terminal_files", next.runId)
      )
        this.options.obligations.create("terminal_files", next.runId, this.generation.pid, {
          telemetry: recoveryTelemetry,
        });
      this.events.appendInTx(tx, event);
      tx.changes.blobChanged(
        row.params_sha,
        row.result_sha,
        prepared.row.params_sha,
        prepared.row.result_sha,
      );
    });
    if (row.result_sha && row.result_sha !== prepared.row.result_sha)
      collectReleasedBodies(this.store, this.blobs, [row.result_sha]);
    return next;
  }
}
