import type { DurableJournal } from "@claudexor/journal";
import { hashJson } from "@claudexor/util";

export interface OperatorDecisionRecord {
  runId: string;
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
  patchSha256: string;
  decidedAt: string;
}

const RECORDED = "operator.decision_recorded";

interface DecisionBinding {
  keyDigest: string;
  requestDigest: string;
  runId: string;
}

interface DecisionMutation {
  decision: OperatorDecisionRecord;
  idempotency?: DecisionBinding;
}

/** Journal authority for the human decision that may unblock one exact run patch. */
export class OperatorDecisionStore {
  private readonly byRun = new Map<string, OperatorDecisionRecord>();
  private readonly byKey = new Map<string, { requestDigest: string; runId: string }>();

  constructor(private readonly journal: DurableJournal) {
    for (const entry of journal.records()) {
      if (entry.type !== RECORDED) continue;
      const mutation = parseMutation(entry.payload);
      this.apply(mutation);
    }
  }

  get(runId: string): OperatorDecisionRecord | null {
    const decision = this.byRun.get(runId);
    return decision ? structuredClone(decision) : null;
  }

  record(
    input: OperatorDecisionRecord,
    idempotency?: { key: string; client: string; request: unknown },
  ): OperatorDecisionRecord {
    const decision = parseDecision(input);
    const binding = decisionBinding(this.journal.options.partition, decision.runId, idempotency);
    if (binding) {
      const prior = this.byKey.get(binding.keyDigest);
      if (prior) {
        if (prior.requestDigest !== binding.requestDigest) throw conflict();
        const existing = this.byRun.get(prior.runId);
        if (!existing) throw new Error("operator decision idempotency index is dangling");
        return structuredClone(existing);
      }
    }
    const mutation = { decision, ...(binding ? { idempotency: binding } : {}) };
    this.journal.append(RECORDED, mutation);
    this.apply(mutation);
    return structuredClone(decision);
  }

  validateProjection(): void {
    for (const decision of this.byRun.values()) parseDecision(decision);
    for (const binding of this.byKey.values()) {
      if (!this.byRun.has(binding.runId))
        throw new Error("operator decision idempotency index is dangling");
    }
  }

  private apply(mutation: DecisionMutation): void {
    this.byRun.set(mutation.decision.runId, structuredClone(mutation.decision));
    if (mutation.idempotency) {
      const { keyDigest, requestDigest, runId } = mutation.idempotency;
      const prior = this.byKey.get(keyDigest);
      if (prior && (prior.requestDigest !== requestDigest || prior.runId !== runId)) {
        throw new Error("conflicting operator decision idempotency history");
      }
      this.byKey.set(keyDigest, { requestDigest, runId });
    }
  }
}

export function operatorDecisionProjection() {
  return {
    name: "operator-decisions",
    create: (journal: DurableJournal) => new OperatorDecisionStore(journal),
    validate: (store: OperatorDecisionStore) => store.validateProjection(),
  };
}

function parseDecision(value: unknown): OperatorDecisionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid operator decision record");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.runId !== "string" ||
    !input.runId ||
    (input.action !== "accept_risk" && input.action !== "override_needs_human") ||
    !stringArray(input.findingIds) ||
    !stringArray(input.acceptedRisks) ||
    typeof input.patchSha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(input.patchSha256) ||
    typeof input.decidedAt !== "string" ||
    !input.decidedAt
  ) {
    throw new Error("invalid operator decision record");
  }
  return structuredClone(input as unknown as OperatorDecisionRecord);
}

function parseMutation(value: unknown): DecisionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid operator decision mutation");
  }
  const input = value as Record<string, unknown>;
  // Accept the pre-idempotency v2 record shape while the release candidate is local-only.
  if (!("decision" in input)) return { decision: parseDecision(value) };
  const idempotency = input["idempotency"];
  if (
    idempotency !== undefined &&
    (!idempotency ||
      typeof idempotency !== "object" ||
      Array.isArray(idempotency) ||
      typeof (idempotency as DecisionBinding).keyDigest !== "string" ||
      typeof (idempotency as DecisionBinding).requestDigest !== "string" ||
      typeof (idempotency as DecisionBinding).runId !== "string")
  ) {
    throw new Error("invalid operator decision idempotency binding");
  }
  return {
    decision: parseDecision(input["decision"]),
    ...(idempotency ? { idempotency: { ...(idempotency as DecisionBinding) } } : {}),
  };
}

function decisionBinding(
  partition: string,
  runId: string,
  input: { key: string; client: string; request: unknown } | undefined,
): DecisionBinding | undefined {
  if (!input) return undefined;
  if (!input.key || input.key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
  return {
    keyDigest: hashJson({
      client: input.client,
      partition,
      operation: "run.decision",
      key: input.key,
    }),
    requestDigest: hashJson(input.request),
    runId,
  };
}

function conflict(): Error & { code: string; status: number } {
  return Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
