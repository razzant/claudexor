import type { DurableJournal } from "@claudexor/journal";
import { hashJson } from "@claudexor/util";
import type { JobRecord, JobState } from "./server.js";

interface AcceptedCommand {
  record: JobRecord;
  keyDigest: string;
  requestDigest: string;
}

interface CommandUpdate {
  record: Omit<JobRecord, "result">;
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
    const { requestDigest, keyDigest } = digests(input);
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
  }): JobRecord | null {
    validateKey(input.idempotencyKey);
    const { requestDigest, keyDigest } = digests(input);
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
    for (const record of this.recordsById.values()) {
      if (record.state !== "queued" && record.state !== "running") continue;
      this.update(record.id, {
        state: "interrupted_unknown",
        error: "daemon restarted before command completion was durably observed",
        finishedAt: this.now().toISOString(),
      });
    }
  }

  private drop(ids: readonly string[]): void {
    const removed = new Set(ids);
    for (const id of removed) this.recordsById.delete(id);
    for (const [digest, entry] of this.idByKeyDigest) {
      if (removed.has(entry.id)) this.idByKeyDigest.delete(digest);
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

function persisted(record: JobRecord): Omit<JobRecord, "result"> {
  const { result: _result, ...value } = record;
  return structuredClone(value);
}

function validateRecord(record: JobRecord): void {
  if (!record || typeof record !== "object" || !record.id || !record.createdAt) {
    throw new Error("invalid command record");
  }
  const states: readonly string[] = [
    "queued",
    "running",
    "blocked",
    "succeeded",
    "no_op",
    "ungated",
    "review_not_run",
    "failed",
    "cancelled",
    "interrupted_unknown",
    "exhausted",
    "not_converged",
    "stuck_no_progress",
  ] satisfies readonly JobState[];
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

function digests(input: {
  params: unknown;
  idempotencyKey: string;
  clientId: string;
  operation?: string;
  idempotencyParams?: unknown;
}): { requestDigest: string; keyDigest: string } {
  return {
    requestDigest: hashJson(input.idempotencyParams ?? input.params),
    keyDigest: hashJson({
      client: input.clientId,
      partition: "global",
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
