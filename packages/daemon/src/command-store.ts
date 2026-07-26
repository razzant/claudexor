import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type { DurableJournal } from "@claudexor/journal";
import {
  RunEvent as RunEventSchema,
  RunTelemetry,
  needsOperatorAttention,
  validateRunFactsInvariants,
  type RunEvent,
  type RunFacts,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { JOB_STATES, type JobRecord } from "./server.js";

interface AcceptedCommand {
  record: JobRecord;
  keyDigest: string;
  requestDigest: string;
}

interface CommandUpdate {
  record: JobRecord;
}

const ACCEPTED = "command.accepted";
const UPDATED = "command.updated";
const PRUNED = "command.pruned";

/** Journal-backed authority for daemon commands. A returned mutation is fsynced. */
export class CommandStore {
  private readonly recordsById = new Map<string, JobRecord>();
  private readonly idByKeyDigest = new Map<string, { id: string; requestDigest: string }>();

  constructor(
    private readonly journal: DurableJournal,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.replay();
    this.interruptUnknownCommands();
  }

  accept(input: {
    id: string;
    params: unknown;
    idempotencyKey: string;
    clientId: string;
    operation?: string;
    idempotencyParams?: unknown;
  }): { record: JobRecord; reused: boolean } {
    validateKey(input.idempotencyKey);
    const { requestDigest, keyDigest } = digests(this.journal.options.partition, input);
    const prior = this.idByKeyDigest.get(keyDigest);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw conflict();
      const record = this.recordsById.get(prior.id);
      if (!record) throw new Error(`idempotency record points to missing command ${prior.id}`);
      return { record, reused: true };
    }
    const record: JobRecord = {
      id: input.id,
      state: "queued",
      params: structuredClone(input.params),
      createdAt: this.now().toISOString(),
    };
    this.journal.append<AcceptedCommand>(ACCEPTED, {
      record: persisted(record),
      keyDigest,
      requestDigest,
    });
    this.recordsById.set(record.id, record);
    this.idByKeyDigest.set(keyDigest, { id: record.id, requestDigest });
    return { record, reused: false };
  }

  find(input: {
    params: unknown;
    idempotencyKey: string;
    clientId: string;
    operation?: string;
    idempotencyParams?: unknown;
  }): JobRecord | null {
    validateKey(input.idempotencyKey);
    const { requestDigest, keyDigest } = digests(this.journal.options.partition, input);
    const prior = this.idByKeyDigest.get(keyDigest);
    if (!prior) return null;
    if (prior.requestDigest !== requestDigest) throw conflict();
    return this.recordsById.get(prior.id) ?? null;
  }

  get(id: string): JobRecord | undefined {
    return this.recordsById.get(id);
  }

  records(): JobRecord[] {
    return [...this.recordsById.values()];
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    const current = this.recordsById.get(id);
    if (!current) throw new Error(`no such job: ${id}`);
    const next = { ...current, ...structuredClone(patch), id: current.id };
    this.journal.append<CommandUpdate>(UPDATED, { record: persisted(next) });
    this.recordsById.set(id, next);
    return next;
  }

  prune(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.journal.append(PRUNED, { ids: [...ids] });
    this.drop(ids);
  }

  /**
   * Reconcile one command after the partition journal accepted its terminal
   * but local receipt/tail finalization failed.
   */
  recoverDurableTerminal(id: string): JobRecord | null {
    const record = this.recordsById.get(id);
    if (!record?.runId) return null;
    const terminal = this.durableTerminalEvents().get(record.runId);
    return terminal ? this.reconcileTerminal(record, terminal) : null;
  }

  validateProjection(): void {
    for (const record of this.recordsById.values()) validateRecord(record);
    for (const entry of this.idByKeyDigest.values()) {
      if (!this.recordsById.has(entry.id)) throw new Error("command idempotency index is dangling");
    }
  }

  private replay(): void {
    for (const entry of this.journal.records()) {
      if (entry.type === ACCEPTED) {
        const payload = entry.payload as AcceptedCommand;
        validateRecord(payload.record);
        if (!payload.keyDigest || !payload.requestDigest)
          throw new Error("invalid accepted command");
        const prior = this.idByKeyDigest.get(payload.keyDigest);
        if (
          prior &&
          (prior.id !== payload.record.id || prior.requestDigest !== payload.requestDigest)
        ) {
          throw new Error("conflicting command idempotency history");
        }
        this.recordsById.set(payload.record.id, structuredClone(payload.record));
        this.idByKeyDigest.set(payload.keyDigest, {
          id: payload.record.id,
          requestDigest: payload.requestDigest,
        });
      } else if (entry.type === UPDATED) {
        const record = (entry.payload as CommandUpdate).record;
        validateRecord(record);
        if (!this.recordsById.has(record.id)) throw new Error("command update precedes acceptance");
        this.recordsById.set(record.id, structuredClone(record));
      } else if (entry.type === PRUNED) {
        const ids = (entry.payload as { ids?: unknown }).ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
          throw new Error("invalid command prune record");
        }
        this.drop(ids);
      }
    }
  }

  private interruptUnknownCommands(): void {
    const terminals = this.durableTerminalEvents();
    for (const record of this.recordsById.values()) {
      const terminal = record.runId ? terminals.get(record.runId) : undefined;
      if (terminal) {
        this.reconcileTerminal(record, terminal);
        continue;
      }
      if (record.state !== "queued" && record.state !== "running") continue;
      this.update(record.id, {
        // A job still queued/running when the daemon restarted was interrupted
        // (D8 crash lifecycle) — its terminal was never durably observed.
        state: "interrupted",
        error: "daemon restarted before command completion was durably observed",
        finishedAt: this.now().toISOString(),
      });
    }
  }

  private reconcileTerminal(record: JobRecord, terminal: RunEvent): JobRecord {
    const hasRunFacts = Object.prototype.hasOwnProperty.call(terminal.payload, "run_facts");
    if (!hasRunFacts) {
      // Pre-RunFacts journals remain readable across the upgrade. An
      // already-terminal command has its historical command.updated
      // authority; an active command cannot reconstruct the new
      // byte-equivalent receipt and therefore follows the legacy crash path.
      if (record.state !== "queued" && record.state !== "running") return record;
      return this.update(record.id, {
        state: "interrupted",
        error: "daemon restarted after a legacy terminal event without recoverable RunFacts",
        errorCode: "legacy_terminal_recovery_unavailable",
        errorStatus: 503,
        errorRetryable: false,
        finishedAt: this.now().toISOString(),
      });
    }

    const facts = this.recoverTerminalArtifacts(record, terminal);
    const lifecycle = facts.outcome.lifecycle;
    const recoveredResult = {
      lifecycle,
      facts: facts.outcome,
      runId: facts.run_id,
      taskId: facts.task_id,
      runDir: record.runDir!,
    };
    const provisionalRecovery =
      record.state !== "queued" &&
      record.state !== "running" &&
      record.errorCode === "terminal_recovery_required";
    if (record.state !== "queued" && record.state !== "running" && !provisionalRecovery) {
      if (record.state !== lifecycle || !terminalResultMatches(record.result, recoveredResult)) {
        throw new Error("terminal command result conflicts with durable terminal authority");
      }
      return record;
    }
    return this.update(record.id, {
      state: lifecycle,
      result: recoveredResult,
      error:
        lifecycle === "failed" || lifecycle === "interrupted"
          ? `recovered durable ${lifecycle} terminal after daemon restart`
          : undefined,
      errorCode: undefined,
      errorStatus: undefined,
      errorRetryable: undefined,
      finishedAt: terminal.ts,
    });
  }

  private durableTerminalEvents(): Map<string, RunEvent> {
    const terminals = new Map<string, RunEvent>();
    for (const entry of this.journal.records()) {
      if (entry.type !== "run.event") continue;
      const event = RunEventSchema.parse(entry.payload);
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.blocked"
      ) {
        if (terminals.has(event.run_id)) {
          throw new Error(`multiple durable terminal events for run ${event.run_id}`);
        }
        terminals.set(event.run_id, event);
      }
    }
    return terminals;
  }

  private recoverTerminalArtifacts(record: JobRecord, terminal: RunEvent): RunFacts {
    if (!record.runId || !record.taskId || !record.runDir) {
      throw new Error("durable terminal recovery is missing the command run identity or directory");
    }
    const facts = validateRunFactsInvariants(terminal.payload["run_facts"]);
    if (
      typeof terminal.seq !== "number" ||
      !Number.isSafeInteger(terminal.seq) ||
      terminal.seq <= 0
    ) {
      throw new Error("durable terminal event has no valid sequence");
    }
    const terminalSeq = terminal.seq;
    const expectedTerminalType =
      facts.outcome.lifecycle !== "succeeded"
        ? "run.failed"
        : needsOperatorAttention(facts.outcome, false)
          ? "run.blocked"
          : "run.completed";
    if (
      facts.run_id !== terminal.run_id ||
      facts.task_id !== terminal.task_id ||
      facts.run_id !== record.runId ||
      facts.task_id !== record.taskId ||
      hashJson(facts.outcome) !== hashJson(terminal.payload["facts"]) ||
      terminal.type !== expectedTerminalType ||
      terminal.payload["lifecycle"] !== facts.outcome.lifecycle ||
      terminal.payload["reason"] !== facts.outcome.reason
    ) {
      throw new Error("durable terminal RunFacts identity, envelope, or outcome mismatch");
    }
    const rootStat = lstatSync(record.runDir);
    const finalDir = join(record.runDir, "final");
    const finalStat = lstatSync(finalDir);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      finalStat.isSymbolicLink() ||
      !finalStat.isDirectory()
    ) {
      throw new Error("durable terminal run directory is not a canonical directory");
    }
    const receiptPath = join(finalDir, "run_facts.yaml");
    const receiptStat = lstatOrNull(receiptPath);
    if (!receiptStat) {
      // JSON is valid YAML and avoids a second schema-to-presentation owner.
      replaceFileDurably(receiptPath, `${JSON.stringify(facts, null, 2)}\n`);
    } else {
      if (receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
        throw new Error("durable terminal RunFacts receipt is not a regular file");
      }
      const receiptText = readFileSync(receiptPath, "utf8");
      let existing: RunFacts | null = null;
      try {
        existing = validateRunFactsInvariants(parseYaml(receiptText));
      } catch {
        // Older direct writers could crash mid-file. The complete journal
        // payload is the durable authority, so a syntactically torn receipt is
        // safely reconstructible; a valid-but-different receipt is not.
        replaceFileDurably(receiptPath, `${JSON.stringify(facts, null, 2)}\n`);
      }
      if (existing && hashJson(existing) !== hashJson(facts)) {
        throw new Error("durable terminal RunFacts receipt does not match journal authority");
      }
    }
    const telemetryPath = join(finalDir, "telemetry.yaml");
    const telemetryStat = lstatOrNull(telemetryPath);
    if (telemetryStat) {
      if (telemetryStat.isSymbolicLink() || !telemetryStat.isFile()) {
        throw new Error("durable terminal telemetry is not a regular file");
      }
      const telemetry = RunTelemetry.parse(parseYaml(readFileSync(telemetryPath, "utf8")));
      if (telemetry.run_facts) {
        if (hashJson(telemetry.run_facts) !== hashJson(facts)) {
          throw new Error("durable terminal telemetry does not match journal authority");
        }
      } else {
        replaceFileDurably(
          telemetryPath,
          stringifyYaml(RunTelemetry.parse({ ...telemetry, run_facts: facts })),
        );
      }
    }
    const eventsPath = join(record.runDir, "events.jsonl");
    const eventsStat = lstatOrNull(eventsPath);
    let eventsBytes = Buffer.alloc(0);
    if (eventsStat) {
      if (eventsStat.isSymbolicLink() || !eventsStat.isFile()) {
        throw new Error("durable terminal event log is not a regular file");
      }
      eventsBytes = readFileSync(eventsPath);
    }
    const normalizedLines: string[] = [];
    let terminalOccurrences = 0;
    let previousSeq = 0;
    const rawLines = splitLines(eventsBytes);
    const finalNonEmptyIndex = rawLines.findLastIndex((line) => !isAsciiWhitespace(line));
    const canonicalTerminalLine = JSON.stringify(terminal);
    const canonicalTerminalBytes = Buffer.from(canonicalTerminalLine, "utf8");
    const endsWithNewline = eventsBytes.at(-1) === 0x0a;
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    for (const [index, lineBytes] of rawLines.entries()) {
      if (isAsciiWhitespace(lineBytes)) continue;
      let event: RunEvent;
      try {
        const line = utf8.decode(lineBytes);
        event = RunEventSchema.parse(JSON.parse(line));
      } catch {
        const tornFinalLine =
          index === finalNonEmptyIndex &&
          !endsWithNewline &&
          terminalOccurrences === 0 &&
          isBufferPrefix(canonicalTerminalBytes, lineBytes);
        if (tornFinalLine) break;
        throw new Error("per-run event log contains malformed committed evidence");
      }
      if (event.run_id !== terminal.run_id || event.task_id !== terminal.task_id) {
        throw new Error("per-run event identity conflicts with durable terminal authority");
      }
      if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq <= 0) {
        throw new Error("per-run event has no valid sequence");
      }
      const eventSeq = event.seq;
      if (eventSeq <= previousSeq) {
        throw new Error("per-run event sequence is duplicate or non-monotonic");
      }
      const sameEvent = hashJson(event) === hashJson(terminal);
      if (terminalOccurrences === 0 && !sameEvent && eventSeq >= terminalSeq) {
        throw new Error("per-run event sequence conflicts with durable terminal authority");
      }
      if (terminalOccurrences > 0 && !sameEvent && !isPostTerminalControlAudit(event.type)) {
        throw new Error("per-run event appears after terminal authority");
      }
      const eventIsTerminal =
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.blocked";
      if (eventIsTerminal) {
        if (!sameEvent) {
          throw new Error("per-run terminal event conflicts with durable journal authority");
        }
        terminalOccurrences += 1;
        if (terminalOccurrences > 1) {
          throw new Error("per-run event log contains multiple terminal events");
        }
      }
      previousSeq = eventSeq;
      normalizedLines.push(JSON.stringify(event));
    }
    if (terminalOccurrences === 0) {
      normalizedLines.push(JSON.stringify(terminal));
    }
    const normalizedEvents = normalizedLines.length > 0 ? `${normalizedLines.join("\n")}\n` : "";
    if (!Buffer.from(normalizedEvents, "utf8").equals(eventsBytes)) {
      replaceFileDurably(eventsPath, normalizedEvents);
    }
    return facts;
  }

  private drop(ids: readonly string[]): void {
    const removed = new Set(ids);
    for (const id of removed) this.recordsById.delete(id);
    for (const [digest, entry] of this.idByKeyDigest) {
      if (removed.has(entry.id)) this.idByKeyDigest.delete(digest);
    }
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function splitLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  lines.push(bytes.subarray(start));
  return lines;
}

function isAsciiWhitespace(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0b && byte !== 0x0c && byte !== 0x0d && byte !== 0x20) {
      return false;
    }
  }
  return true;
}

function isBufferPrefix(whole: Buffer, prefix: Buffer): boolean {
  return prefix.length <= whole.length && whole.subarray(0, prefix.length).equals(prefix);
}

function isPostTerminalControlAudit(type: string): boolean {
  return type === "control.requested" || type === "control.applied" || type === "control.rejected";
}

function terminalResultMatches(
  result: unknown,
  expected: {
    lifecycle: RunFacts["outcome"]["lifecycle"];
    facts: RunFacts["outcome"];
    runId: string;
    taskId: string;
    runDir: string;
  },
): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  return (
    value["lifecycle"] === expected.lifecycle &&
    value["runId"] === expected.runId &&
    value["taskId"] === expected.taskId &&
    value["runDir"] === expected.runDir &&
    hashJson(value["facts"]) === hashJson(expected.facts)
  );
}

function replaceFileDurably(path: string, text: string): void {
  const parent = dirname(path);
  const tmp = join(parent, `.claudexor-recovery-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    const parentFd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function commandProjection() {
  return {
    name: "commands",
    create: (journal: DurableJournal) => new CommandStore(journal),
    validate: (store: CommandStore) => store.validateProjection(),
  };
}

function persisted(record: JobRecord): JobRecord {
  return structuredClone(record);
}

function validateRecord(record: JobRecord): void {
  if (!record || typeof record !== "object" || !record.id || !record.createdAt) {
    throw new Error("invalid command record");
  }
  // One SSOT for the valid job states (the run lifecycle set, D8).
  const states: readonly string[] = JOB_STATES;
  if (!states.includes(record.state)) throw new Error(`invalid command state '${record.state}'`);
}

function validateKey(key: string): void {
  if (!key || key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
}

function digests(
  partition: string,
  input: {
    params: unknown;
    idempotencyKey: string;
    clientId: string;
    operation?: string;
    idempotencyParams?: unknown;
  },
): { requestDigest: string; keyDigest: string } {
  return {
    requestDigest: hashJson(input.idempotencyParams ?? input.params),
    keyDigest: hashJson({
      client: input.clientId,
      partition,
      operation: input.operation ?? "run.create",
      key: input.idempotencyKey,
    }),
  };
}

function conflict(): Error & { code: string; status: number } {
  return Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}
