import { hashJson } from "@claudexor/util";
import { idempotencyWireProjection } from "./idempotency-wire-projection.js";
import { JOB_STATES, type JobRecord } from "./job-record.js";

export interface FindCommand {
  params: unknown;
  idempotencyKey: string;
  clientId: string;
  operation?: string;
  idempotencyParams?: unknown;
}
export interface AcceptCommand extends FindCommand {
  id: string;
}

export function validateCommandRecord(record: Omit<JobRecord, "params">): void {
  if (!record || typeof record !== "object" || !record.id || !record.createdAt) {
    throw new Error("invalid command record");
  }
  // One SSOT for the valid job states (the run lifecycle set, D8).
  const states: readonly string[] = JOB_STATES;
  if (!states.includes(record.state)) throw new Error(`invalid command state '${record.state}'`);
}

export function validateCommandKey(key: string): void {
  if (!key || key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
}

export function commandDigests(
  partition: string,
  input: FindCommand,
): { requestDigest: string; keyDigest: string } {
  return {
    requestDigest: hashJson(idempotencyWireProjection(input.idempotencyParams ?? input.params)),
    keyDigest: hashJson({
      client: input.clientId,
      partition,
      operation: input.operation ?? "run.create",
      key: input.idempotencyKey,
    }),
  };
}
