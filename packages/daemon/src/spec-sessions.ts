import type { DurableJournal } from "@claudexor/journal";
import {
  ControlSpecQuestionsRequest,
  ControlSpecSession as SessionSchema,
  type ControlSpecAnswersRequest,
  type ControlSpecQuestionsRequest as QuestionsRequest,
  type ControlSpecSession,
} from "@claudexor/schema";
import { hashJson, newId, nowIso } from "@claudexor/util";

interface SpecSessionRecord extends ControlSpecSession {
  request: QuestionsRequest;
  planText: string;
  changes: unknown[];
  interruptedFrom?: "grounding" | "freezing" | null;
}

interface SpecSessionRestart {
  action: "grounding" | "freezing";
  session: ControlSpecSession;
}

interface FrozenSpecResult {
  specId: string;
  specDir: string;
  specPath: string;
  specHash: string;
  changes: unknown[];
}

interface SessionBinding {
  keyDigest: string;
  requestDigest: string;
  sessionId: string;
}

interface SessionMutation {
  record: SpecSessionRecord;
  superseded?: SpecSessionRecord[];
  binding?: SessionBinding;
}

const UPSERTED = "spec.session_upserted";

/** Project-journal authority for durable spec interview sessions. */
export class SpecSessionStore {
  private readonly sessions = new Map<string, SpecSessionRecord>();
  private readonly sessionByKey = new Map<string, { requestDigest: string; sessionId: string }>();

  constructor(private readonly journal: DurableJournal) {
    this.replay();
    this.interruptActive();
  }

  list(): ControlSpecSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicSession);
  }

  get(id: string): ControlSpecSession | undefined {
    const record = this.sessions.get(id);
    return record ? publicSession(record) : undefined;
  }

  create(input: { request: QuestionsRequest; idempotencyKey: string; clientId: string }): {
    session: ControlSpecSession;
    reused: boolean;
  } {
    validateKey(input.idempotencyKey);
    const request = ControlSpecQuestionsRequest.parse(input.request);
    const keyDigest = hashJson({
      client: input.clientId,
      partition: this.journal.options.partition,
      operation: "spec.session.create",
      key: input.idempotencyKey,
    });
    const requestDigest = hashJson(request);
    const prior = this.sessionByKey.get(keyDigest);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw conflict();
      const record = this.requireRecord(prior.sessionId);
      return { session: publicSession(record), reused: true };
    }
    const createdAt = nowIso();
    const record: SpecSessionRecord = {
      sessionId: newId("spec-session"),
      threadId: request.threadId ?? null,
      prompt: request.prompt,
      scope: request.scope,
      state: "grounding",
      planRunId: null,
      questions: [],
      answers: [],
      priorDecisions: request.priorDecisions ?? [],
      specId: null,
      specPath: null,
      specHash: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
      request,
      planText: "",
      specDir: null,
      changes: [],
      interruptedFrom: null,
    };
    const superseded = request.threadId
      ? [...this.sessions.values()]
          .filter(
            (session) => session.threadId === request.threadId && session.state !== "cancelled",
          )
          .map((session) => ({
            ...session,
            state: "cancelled" as const,
            error: null,
            interruptedFrom: null,
            updatedAt: createdAt,
          }))
      : [];
    this.commit({
      record,
      ...(superseded.length > 0 ? { superseded } : {}),
      binding: { keyDigest, requestDigest, sessionId: record.sessionId },
    });
    return { session: publicSession(record), reused: false };
  }

  completeGrounding(
    id: string,
    input: { planRunId: string; planText: string; questions: ControlSpecSession["questions"] },
  ): ControlSpecSession {
    const current = this.requireState(id, ["grounding"]);
    return this.update({
      ...current,
      state: "questions",
      planRunId: input.planRunId,
      planText: input.planText,
      questions: input.questions,
      error: null,
      interruptedFrom: null,
    });
  }

  recordAnswers(id: string, input: ControlSpecAnswersRequest): ControlSpecSession {
    const current = this.requireState(id, ["questions", "answered"]);
    return this.update({
      ...current,
      state: "answered",
      answers: structuredClone(input.answers),
      priorDecisions: structuredClone(input.priorDecisions ?? current.priorDecisions),
      error: null,
      interruptedFrom: null,
    });
  }

  beginFreeze(id: string): SpecSessionRecord {
    const current = this.requireState(id, ["answered", "questions"]);
    const next = {
      ...current,
      state: "freezing" as const,
      interruptedFrom: null,
      updatedAt: nowIso(),
    };
    this.commit({ record: next });
    return structuredClone(next);
  }

  completeFreeze(id: string, result: FrozenSpecResult): ControlSpecSession {
    const current = this.requireState(id, ["freezing"]);
    return this.update({
      ...current,
      state: "frozen",
      specId: result.specId,
      specDir: result.specDir,
      specPath: result.specPath,
      specHash: result.specHash,
      changes: structuredClone(result.changes),
      error: null,
      interruptedFrom: null,
    });
  }

  rejectFreeze(id: string, error: string): ControlSpecSession {
    const current = this.requireState(id, ["freezing"]);
    return this.update({
      ...current,
      state: current.answers.length > 0 ? "answered" : "questions",
      error,
      interruptedFrom: null,
    });
  }

  cancel(id: string): ControlSpecSession {
    const current = this.requireRecord(id);
    if (current.state === "cancelled") return publicSession(current);
    return this.update({ ...current, state: "cancelled", error: null, interruptedFrom: null });
  }

  fail(id: string, error: string): ControlSpecSession {
    const current = this.requireRecord(id);
    return this.update({ ...current, state: "failed", error, interruptedFrom: null });
  }

  restart(id: string): SpecSessionRestart {
    const current = this.requireState(id, ["interrupted_unknown", "failed"]);
    if (current.interruptedFrom === "freezing") {
      return {
        action: "freezing",
        session: this.update({
          ...current,
          state: current.answers.length > 0 ? "answered" : "questions",
          error: null,
          interruptedFrom: null,
        }),
      };
    }
    return {
      action: "grounding",
      session: this.update({
        ...current,
        state: "grounding",
        planRunId: null,
        planText: "",
        questions: [],
        answers: [],
        error: null,
        interruptedFrom: null,
      }),
    };
  }

  material(id: string): {
    request: QuestionsRequest;
    planText: string;
    answers: ControlSpecAnswersRequest;
  } {
    const record = this.requireRecord(id);
    return {
      request: structuredClone(record.request),
      planText: record.planText,
      answers: {
        answers: structuredClone(record.answers),
        priorDecisions: structuredClone(record.priorDecisions),
      },
    };
  }

  frozenResult(id: string): (FrozenSpecResult & { sessionId: string; state: "frozen" }) | null {
    const record = this.requireRecord(id);
    if (
      record.state !== "frozen" ||
      !record.specId ||
      !record.specDir ||
      !record.specPath ||
      !record.specHash
    )
      return null;
    return {
      sessionId: id,
      state: "frozen",
      specId: record.specId,
      specDir: record.specDir,
      specPath: record.specPath,
      specHash: record.specHash,
      changes: structuredClone(record.changes),
    };
  }

  validateProjection(): void {
    for (const record of this.sessions.values()) validateRecord(record);
    for (const binding of this.sessionByKey.values()) {
      if (!this.sessions.has(binding.sessionId))
        throw new Error("spec idempotency index is dangling");
    }
  }

  private replay(): void {
    for (const entry of this.journal.records()) {
      if (entry.type !== UPSERTED) continue;
      this.apply(parseMutation(entry.payload));
    }
    this.validateProjection();
  }

  private interruptActive(): void {
    for (const record of [...this.sessions.values()]) {
      if (record.state !== "grounding" && record.state !== "freezing") continue;
      this.update({
        ...record,
        state: "interrupted_unknown",
        error: "daemon restarted before the spec operation completed",
        interruptedFrom: record.state,
      });
    }
  }

  private update(record: SpecSessionRecord): ControlSpecSession {
    const next = { ...record, updatedAt: nowIso() };
    this.commit({ record: next });
    return publicSession(next);
  }

  private commit(mutation: SessionMutation): void {
    const parsed = parseMutation(mutation);
    this.journal.append(UPSERTED, parsed);
    this.apply(parsed);
  }

  private apply(mutation: SessionMutation): void {
    for (const record of mutation.superseded ?? []) {
      this.sessions.set(record.sessionId, structuredClone(record));
    }
    this.sessions.set(mutation.record.sessionId, structuredClone(mutation.record));
    if (!mutation.binding) return;
    const prior = this.sessionByKey.get(mutation.binding.keyDigest);
    if (
      prior &&
      (prior.requestDigest !== mutation.binding.requestDigest ||
        prior.sessionId !== mutation.binding.sessionId)
    ) {
      throw new Error("conflicting spec session idempotency history");
    }
    this.sessionByKey.set(mutation.binding.keyDigest, {
      requestDigest: mutation.binding.requestDigest,
      sessionId: mutation.binding.sessionId,
    });
  }

  private requireRecord(id: string): SpecSessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw Object.assign(new Error(`no such spec session: ${id}`), { status: 404 });
    return record;
  }

  private requireState(id: string, states: SpecSessionRecord["state"][]): SpecSessionRecord {
    const record = this.requireRecord(id);
    if (!states.includes(record.state)) {
      throw Object.assign(new Error(`spec session is ${record.state}`), { status: 409 });
    }
    return record;
  }
}

export function specSessionProjection() {
  return {
    name: "spec-sessions",
    create: (journal: DurableJournal) => new SpecSessionStore(journal),
    validate: (store: SpecSessionStore) => store.validateProjection(),
  };
}

function publicSession(record: SpecSessionRecord): ControlSpecSession {
  const {
    request: _request,
    planText: _planText,
    changes: _changes,
    interruptedFrom: _interruptedFrom,
    ...value
  } = record;
  return SessionSchema.parse(structuredClone(value));
}

function validateRecord(record: SpecSessionRecord): void {
  publicSession(record);
  ControlSpecQuestionsRequest.parse(record.request);
  if (
    typeof record.planText !== "string" ||
    !Array.isArray(record.changes) ||
    ![undefined, null, "grounding", "freezing"].includes(record.interruptedFrom)
  ) {
    throw new Error("invalid spec session material");
  }
}

function parseMutation(value: unknown): SessionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid spec session mutation");
  const input = value as SessionMutation;
  validateRecord(input.record);
  if (input.superseded && !Array.isArray(input.superseded)) {
    throw new Error("invalid superseded spec sessions");
  }
  for (const record of input.superseded ?? []) validateRecord(record);
  if (
    input.binding &&
    (!input.binding.keyDigest || !input.binding.requestDigest || !input.binding.sessionId)
  ) {
    throw new Error("invalid spec session binding");
  }
  return structuredClone(input);
}

function validateKey(key: string): void {
  if (!key || key.length > 256)
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      status: 400,
    });
}

function conflict(): Error {
  return Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}
