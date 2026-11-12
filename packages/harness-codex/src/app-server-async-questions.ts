/**
 * The live owner of Codex asynchronous questions (`request_user_input_async`,
 * #628) in one app-server run, around the pure translation in
 * async-questions.ts.
 *
 * `observe` receives the root thread's frames only (the run loop's ownership
 * filter), so a sub-agent's question never takes the root's identity: it stays
 * a sub-agent message. A root carrier becomes ONE pending interaction through
 * the run's existing interaction channel, registered once per native item id
 * and only while its turn is the active root turn. The channel is never
 * awaited here: the event pump and the inactivity watchdog keep running,
 * because the agent does. A committed answer is steered into the turn that
 * asked, as the desktop's reply envelope, under the stable client message id
 * `interaction-answer:<interaction id>`; each send gets one receipt, and no
 * answer ever starts a turn. Silence, a decline, an expiry, a withdrawal and
 * the run's end send nothing. The asking turn's end and `close()` withdraw the
 * open questions. The terminal never waits: `takeEvents` hands over the queued
 * records and reports a send whose outcome was still unknown at `close()`.
 */
import { randomUUID } from "node:crypto";
import { InteractionChannelError, interactionChannelFromSpec } from "@claudexor/core";
import {
  InteractionAnswerSet,
  type HarnessEvent,
  type HarnessRunSpec,
  type InteractionRequest,
} from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { answerUnavailable } from "./app-server-approvals.js";
import { asObject, type CodexSteerFn, type JsonObject } from "./app-server-protocol.js";
import {
  CODEX_ASYNC_QUESTION_TOOL,
  codexAsyncAnswer,
  codexAsyncAnswerMessageId,
  codexAsyncAnswerReceipt,
  codexAsyncQuestion,
  isCodexAsyncAgentMessage,
  type CodexAsyncAnswer,
} from "./async-questions.js";

/** The run facts this owner reads. */
export interface CodexAsyncQuestionRun {
  spec: HarnessRunSpec;
  threadId(): string | null;
  /** The root thread's active turn. */
  turnId(): string | null;
  enqueue(notification: JsonObject): void;
}

interface OpenQuestion {
  request: InteractionRequest;
  /** The root turn that asked; its answer goes only there. */
  turnId: string;
  abort: AbortController;
  /** The channel refused it at once, so it was never announced. */
  refused: boolean;
}

type UnansweredReason = "unreadable_question" | "no_answer_channel" | "no_active_turn";

const UNANSWERED: Record<UnansweredReason, string> = {
  unreadable_question: "Claudexor cannot read its questions",
  no_answer_channel: "this run has no answer channel",
  no_active_turn: "the turn that asked it is not the active root turn",
};

export class CodexAsyncQuestions {
  private readonly channel;
  /** Native item ids already seen; a replayed carrier never reopens a question. */
  private readonly seen = new Set<string>();
  private readonly open = new Map<string, OpenQuestion>();
  /** Answers handed to the steer whose native outcome is not known yet. */
  private readonly sending = new Map<string, string>();
  private readonly records = new WeakMap<JsonObject, HarnessEvent>();
  private closed = false;

  constructor(
    private readonly run: CodexAsyncQuestionRun,
    private readonly steer: CodexSteerFn,
  ) {
    this.channel = interactionChannelFromSpec(run.spec);
  }

  /** One root frame, in arrival order, before the run loop's turn bookkeeping. */
  observe(method: unknown, params: JsonObject | null): void {
    const turn = asObject(params?.["turn"])?.["id"];
    if (method === "turn/started") this.withdraw((asked) => asked !== turn);
    if (method === "turn/completed") {
      const ended = turn ?? this.run.turnId();
      this.withdraw((asked) => asked === ended);
    }
    const item = asObject(params?.["item"]);
    if (method !== "item/completed" || this.closed || !isCodexAsyncAgentMessage(item)) return;
    const asked = codexAsyncQuestion(item, randomUUID());
    if (asked.kind === "none") return;
    const rawId = item?.["id"];
    const itemId = typeof rawId === "string" && rawId ? rawId : null;
    if (itemId !== null) {
      if (this.seen.has(itemId)) return;
      this.seen.add(itemId);
    }
    if (asked.kind === "unrecognized")
      return this.unanswered(itemId, "unreadable_question", asked.reason);
    const nativeTurn = params?.["turnId"];
    const turnId = typeof nativeTurn === "string" ? nativeTurn : this.run.turnId();
    if (!turnId || turnId !== this.run.turnId()) return this.unanswered(itemId, "no_active_turn");
    if (!this.channel) return this.unanswered(itemId, "no_answer_channel");
    this.ask(asked.request, turnId);
  }

  events(notification: JsonObject): HarnessEvent[] | null {
    const record = this.records.get(notification);
    return record ? [record] : null;
  }

  /** Withdraws every open question; a send still in flight stays unknown. */
  close(): void {
    this.closed = true;
    this.withdraw(() => true);
  }

  /** The terminal's records, without waiting: the queued ones in order, then
   * each answer whose send had no known outcome when the owner closed. */
  takeEvents(queue: JsonObject[]): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (let index = 0; index < queue.length;) {
      const record = this.records.get(queue[index]!);
      if (record) {
        queue.splice(index, 1);
        events.push(record);
      } else index += 1;
    }
    for (const [interactionId, messageId] of this.sending)
      events.push(
        codexAsyncAnswerReceipt({
          sessionId: this.run.spec.session_id,
          interactionId,
          messageId,
          result: { outcome: "delivery_unknown", reason: "run_terminal" },
        }),
      );
    this.sending.clear();
    return events;
  }

  private ask(request: InteractionRequest, turnId: string): void {
    const id = request.interaction_id;
    const question: OpenQuestion = {
      request,
      turnId,
      abort: new AbortController(),
      refused: false,
    };
    this.open.set(id, question);
    let answer: Promise<unknown>;
    try {
      // The channel registers the question before it returns; nothing awaits the answer here.
      answer = this.channel!.request(request, question.abort.signal);
    } catch (error) {
      answer = Promise.reject(error);
    }
    void answer.then(
      (answers) => this.settle(id, question, answers),
      (error: unknown) => this.failed(id, question, error),
    );
    // A refusal at once settles first (a job queued before this one): such a
    // question was never registered, so it is not announced either.
    queueMicrotask(() => {
      if (!question.refused)
        this.record({
          type: "interaction_requested",
          session_id: this.run.spec.session_id,
          ts: nowIso(),
          interaction: request,
        });
    });
  }

  private settle(id: string, question: OpenQuestion, answers: unknown): void {
    const current = this.open.get(id) === question;
    if (current) this.open.delete(id);
    const parsed = InteractionAnswerSet.nullable().safeParse(answers);
    const reply: CodexAsyncAnswer = parsed.success
      ? codexAsyncAnswer(question.request, parsed.data)
      : { kind: "refused", reason: "the answer set is not a valid interaction answer set" };
    // Null or an empty set answers nothing; the channel's events say why.
    if (reply.kind === "none") return;
    const messageId = codexAsyncAnswerMessageId(id);
    const notSent = (reason: string) =>
      this.receipt(id, messageId, { outcome: "not_sent", reason });
    if (reply.kind === "refused") return notSent(reply.reason);
    if (!current || this.closed || this.run.turnId() !== question.turnId)
      return notSent("the turn that asked the question is no longer active");
    this.sending.set(id, messageId);
    void this.steer({ messageId, text: reply.text })
      .catch(() => ({ outcome: "delivery_unknown" as const }))
      .then((result) => {
        // After close the outcome is reported once, as unknown, by takeEvents.
        if (this.closed || !this.sending.delete(id)) return;
        this.receipt(id, messageId, result);
      });
  }

  private failed(id: string, question: OpenQuestion, error: unknown): void {
    question.refused = true;
    if (this.open.get(id) === question) this.open.delete(id);
    const failure =
      error instanceof InteractionChannelError ? error : new InteractionChannelError(error);
    this.record(answerUnavailable(this.run.spec.session_id, question.request, failure));
  }

  private withdraw(ended: (askedIn: string) => boolean): void {
    for (const [id, question] of this.open) {
      if (!ended(question.turnId)) continue;
      this.open.delete(id);
      question.abort.abort();
    }
  }

  private receipt(
    interactionId: string,
    messageId: string,
    result: Parameters<typeof codexAsyncAnswerReceipt>[0]["result"],
  ): void {
    this.record(
      codexAsyncAnswerReceipt({
        sessionId: this.run.spec.session_id,
        interactionId,
        messageId,
        result,
      }),
    );
  }

  /** The adapter's own observation that nobody can answer this carrier. */
  private unanswered(itemId: string | null, reason: UnansweredReason, detail?: string): void {
    this.record({
      type: "status",
      session_id: this.run.spec.session_id,
      ts: nowIso(),
      text: `${CODEX_ASYNC_QUESTION_TOOL}${itemId ? ` ${itemId}` : ""} could not be answered: ${UNANSWERED[reason]}${detail ? ` (${detail})` : ""}`,
      payload: {
        code: "interaction_answer_unavailable",
        reason,
        ...(itemId ? { item_id: itemId } : {}),
        ...(detail ? { error: detail } : {}),
      },
    });
  }

  private record(event: HarnessEvent): void {
    const notification = {
      method: "claudexor/interaction",
      params: { threadId: this.run.threadId() },
    };
    this.records.set(notification, event);
    this.run.enqueue(notification);
  }
}
