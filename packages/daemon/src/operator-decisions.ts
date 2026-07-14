import type { DurableJournal } from "@claudexor/journal";

export interface OperatorDecisionRecord {
  runId: string;
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
  patchSha256: string;
  decidedAt: string;
}

const RECORDED = "operator.decision_recorded";

/** Journal authority for the human decision that may unblock one exact run patch. */
export class OperatorDecisionStore {
  private readonly byRun = new Map<string, OperatorDecisionRecord>();

  constructor(private readonly journal: DurableJournal) {
    for (const entry of journal.records()) {
      if (entry.type !== RECORDED) continue;
      const decision = parseDecision(entry.payload);
      this.byRun.set(decision.runId, decision);
    }
  }

  get(runId: string): OperatorDecisionRecord | null {
    const decision = this.byRun.get(runId);
    return decision ? structuredClone(decision) : null;
  }

  record(input: OperatorDecisionRecord): OperatorDecisionRecord {
    const decision = parseDecision(input);
    this.journal.append(RECORDED, decision);
    this.byRun.set(decision.runId, structuredClone(decision));
    return structuredClone(decision);
  }

  validateProjection(): void {
    for (const decision of this.byRun.values()) parseDecision(decision);
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
