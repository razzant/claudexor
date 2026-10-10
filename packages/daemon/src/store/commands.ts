import { RunEvent, type RunTelemetry } from "@claudexor/schema";
import { commandDigests, validateCommandKey, type CommandStore } from "../command-store.js";
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
import { collectReleasedBodies, SqlEventLedger } from "./event-store.js";
import { bindIdempotencyInTx, lookupIdempotency } from "./idempotency.js";
import { runMutation } from "./mutation.js";
import type { Obligations } from "./obligations.js";
import type { PartitionGeneration } from "./partitions.js";
import type { EngineStore } from "./store.js";
import type { SqlTerminalFiles } from "./terminal-files.js";
import { applyTerminalInTx, storedTerminal } from "./run-events.js";

type AcceptCommand = Parameters<CommandStore["accept"]>[0];
type FindCommand = Parameters<CommandStore["find"]>[0];

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
    const digests = commandDigests(this.generation.name, input);
    const record: JobRecord = {
      id: input.id,
      state: "queued",
      params: structuredClone(input.params),
      createdAt: this.store.now().toISOString(),
    };
    const prepared = this.prepare(
      record,
      undefined,
      input.operation ?? "run.create",
      input.clientId,
    );
    const event = this.events.prepare("command.accepted", { record, ...digests });
    runMutation(this.store, (tx) => {
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
    });
    return { record, reused: false };
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
    return this.writeUpdate(row, next);
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
    const { facts } = recoveredTerminalFacts(current, event);
    const next: JobRecord = {
      ...current,
      state: facts.outcome.lifecycle,
      finishedAt: event.ts,
      result: terminalCommandResult(current, facts),
    };
    const prepared = this.prepare(next, row);
    const { params: _params, ...record } = next;
    const updated = this.events.prepare("command.updated", { record });
    const run = this.events.prepare("run.event", journaledRunEventCopy(event));
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
    });
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
    if (active) {
      const row = commandRow(this.store, id, this.generation.pid)!;
      recovered = this.writeUpdate(
        row,
        {
          ...current,
          state: facts.outcome.lifecycle,
          result: terminalCommandResult(current, facts),
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
