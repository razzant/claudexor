import { hashJson } from "@claudexor/util";

export interface OperatorDecisionRecord {
  runId: string;
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
  patchSha256: string;
  decidedAt: string;
}

export interface RecordedOperatorDecision {
  record: OperatorDecisionRecord;
  reused: boolean;
}

export interface DecisionBinding {
  keyDigest: string;
  requestDigest: string;
  runId: string;
}

export interface DecisionMutation {
  decision: OperatorDecisionRecord;
  idempotency?: DecisionBinding;
}

export function parseOperatorDecision(value: unknown): OperatorDecisionRecord {
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

export function parseDecisionMutation(value: unknown): DecisionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid operator decision mutation");
  }
  const input = value as Record<string, unknown>;
  // Accept the pre-idempotency v2 record shape while the release candidate is local-only.
  if (!("decision" in input)) return { decision: parseOperatorDecision(value) };
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
    decision: parseOperatorDecision(input["decision"]),
    ...(idempotency ? { idempotency: { ...(idempotency as DecisionBinding) } } : {}),
  };
}

export function operatorDecisionBinding(
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
