import * as acp from "@agentclientprotocol/sdk";

type Option = { optionId: string; name: string; description: string | null };
type LeftOut = { question: string; reason: string };

/**
 * Collect answers to one pending interaction through ACP permission requests.
 * Choice and multi-select questions are asked inline (multi-select as one
 * include/skip round per option); a title and option names cannot carry a
 * question's header or its options' descriptions, so each prompt also carries
 * them as tool-call text content, every option of the question in every round.
 * ACP cannot collect free text. Every question left without an answer (free
 * text, every option skipped, dismissed) is named in one turn-text message
 * instead of being skipped silently: with nothing chosen no answer is sent and
 * a blocking question set keeps the agent waiting, while an async one leaves
 * the agent working with its question still open; once some questions are
 * answered, the message says those answers will be submitted as a partial
 * answer, which closes the whole set if the daemon accepts it. The message goes
 * out before the caller submits, so it cannot report the outcome. `ctx.signal`
 * (the question resolved elsewhere, the caller cancelled or the run ended)
 * cancels the open permission request and ends the round without waiting for the
 * client's reply: its open call closes as failed, nothing further is asked, and
 * it returns no answer and sends no message. A permission
 * request that fails otherwise answered nothing: its call is closed as failed,
 * still showing the question and saying it stays open, and the round fails with
 * that error (with the close's own error too, if the close could not be sent).
 */
export async function requestInteractionAnswers(
  client: acp.AgentContext,
  sessionId: string,
  ctx: any,
  say: (text: string) => Promise<void>,
): Promise<any | null> {
  const request = ctx?.request;
  const runId = typeof ctx?.run_id === "string" ? ctx.run_id : "";
  const signal: AbortSignal | undefined =
    ctx?.signal instanceof AbortSignal ? ctx.signal : undefined;
  const isAsync = request?.delivery === "async";
  const questions: any[] = Array.isArray(request?.questions) ? request.questions : [];
  const answers: any[] = [];
  const left: LeftOut[] = [];
  for (const [index, question] of questions.entries()) {
    if (signal?.aborted) return null;
    const rawOptions = Array.isArray(question?.options) ? question.options : [];
    const options: Option[] = rawOptions.map((option: any, optionIndex: number) => ({
      optionId: `opt-${optionIndex + 1}`,
      name: String(option?.label ?? `option ${optionIndex + 1}`),
      description: typeof option?.description === "string" ? option.description : null,
    }));
    const title = String(question?.question ?? "Question");
    if (options.length === 0) {
      left.push({
        question:
          typeof question?.header === "string" && question.header
            ? `${question.header}\n\n${title}`
            : title,
        reason: "free text, which ACP cannot collect",
      });
      continue;
    }
    const prompt = (
      toolCallId: string,
      toolTitle: string,
      choices: acp.PermissionOption[],
      answered: (picked: string | null) => boolean,
    ) =>
      ask(
        client,
        sessionId,
        runId,
        { toolCallId, title: toolTitle, content: questionContent(question, options, isAsync) },
        choices,
        answered,
        signal,
      );
    const toolCallId = `${String(request?.interaction_id ?? "interaction")}:${String(question?.id ?? index)}`;
    if (question?.multi_select === true) {
      // One include/skip round per option, so the client can pick MORE THAN ONE
      // label (a single requestPermission returns exactly one optionId). Each
      // round shows every option, so no choice is made without its siblings.
      const selectedLabels: string[] = [];
      for (const option of options) {
        const include = await prompt(
          `${toolCallId}:${option.optionId}`,
          `${title} — include "${option.name}"?`,
          [
            { optionId: "include", name: `Include ${option.name}`, kind: "allow_once" as const },
            { optionId: "skip", name: `Skip ${option.name}`, kind: "reject_once" as const },
          ],
          () => true,
        );
        // Closed during this option: the rest of the round must not be asked.
        if (signal?.aborted) return null;
        if (include === "include") selectedLabels.push(option.name);
      }
      if (selectedLabels.length === 0)
        left.push({ question: title, reason: "every option skipped" });
      else
        answers.push({
          question_id: String(question?.id ?? ""),
          selected_labels: selectedLabels,
          free_text: null,
        });
      continue;
    }
    const picked = await prompt(
      toolCallId,
      title,
      options.map(({ optionId, name }) => ({ optionId, name, kind: "allow_once" as const })),
      (picked) => options.some((option) => option.optionId === picked),
    );
    const selected = options.find((option) => option.optionId === picked);
    if (!selected) left.push({ question: title, reason: "dismissed without a choice" });
    else
      answers.push({
        question_id: String(question?.id ?? ""),
        selected_labels: [selected.name],
        free_text: null,
      });
  }
  // A closed round's question was resolved elsewhere or its run ended.
  if (signal?.aborted) return null;
  if (left.length > 0)
    await say(leftOutMessage(left, answers.length > 0, runId, ctx?.timeoutAt, isAsync));
  return answers.length > 0
    ? { interaction_id: String(request?.interaction_id ?? ""), answers }
    : null;
}

/** One permission round as a pending tool call; the selected option id, if any.
 * The tool call ends `completed` when `answered` accepts the pick while the
 * round is still open. A closed round opens no call and sends no request once
 * it knows, and a call it did open ends `failed`. */
async function ask(
  client: acp.AgentContext,
  sessionId: string,
  runId: string,
  call: { toolCallId: string; title: string; content: acp.ToolCallContent[] },
  options: acp.PermissionOption[],
  answered: (picked: string | null) => boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "tool_call", ...call, kind: "other", status: "pending" },
  });
  let picked: string | null = null;
  if (!signal?.aborted) {
    try {
      const response = await untilRoundCloses(
        client.request(
          acp.methods.client.session.requestPermission,
          { sessionId, toolCall: call, options },
          signal ? { cancellationSignal: signal } : undefined,
        ) as Promise<acp.RequestPermissionResponse>,
        signal,
      );
      const outcome = response?.outcome;
      picked = outcome?.outcome === "selected" ? outcome.optionId : null;
    } catch (error) {
      // A cancelled request settles with the client's cancellation below. Any
      // other failure answered nothing: close the call as failed where the
      // connection still carries updates, then fail with the request's error,
      // and with the close's too when that could not be sent either.
      if (!signal?.aborted) {
        try {
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: call.toolCallId,
              status: "failed",
              content: [...call.content, textContent(failedPromptText(runId, error))],
            },
          });
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            `permission request failed (${errorText(error)}) and its prompt could not be closed (${errorText(closeError)})`,
          );
        }
        throw error;
      }
    }
  }
  // A pick that crossed the cancellation is dropped with the round, so the call
  // cannot claim it was answered.
  const roundClosed = signal?.aborted === true;
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: call.toolCallId,
      status: !roundClosed && answered(picked) ? "completed" : "failed",
    },
  });
  return picked;
}

/** The SDK's cancellation only sends `$/cancel_request`: the request stays open
 * until the client replies, and a client may never reply to a stale prompt. */
function untilRoundCloses<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | null> {
  if (!signal) return request;
  return new Promise<T | null>((resolve, reject) => {
    const closed = () => resolve(null);
    if (signal.aborted) closed();
    else signal.addEventListener("abort", closed, { once: true });
    const settled = () => signal.removeEventListener("abort", closed);
    request.then(
      (value) => {
        settled();
        resolve(value);
      },
      (error: unknown) => {
        settled();
        reject(error);
      },
    );
  });
}

/** The question in full as text: its header, its text and every option with
 * its description; an async question also says the agent keeps working. */
function questionContent(question: any, options: Option[], isAsync = false): acp.ToolCallContent[] {
  const lines: string[] = [];
  if (isAsync) lines.push("The agent keeps working while you answer.", "");
  if (typeof question?.header === "string" && question.header) lines.push(question.header, "");
  lines.push(String(question?.question ?? ""), "");
  for (const option of options)
    lines.push(`- ${option.name}${option.description ? `: ${option.description}` : ""}`);
  return [textContent(lines.join("\n"))];
}

function textContent(text: string): acp.ToolCallContent {
  return { type: "content", content: { type: "text", text } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where a question this surface could not settle can still be answered. */
function answerElsewhere(runId: string): string {
  const follow = runId ? `\`claudexor follow ${runId}\`` : "`claudexor follow <run>`";
  return `${follow} or POST /v2/runs/:id/interactions/:id/answer`;
}

/** The closing text of a prompt whose permission request failed. */
function failedPromptText(runId: string, error: unknown): string {
  return `This question could not be asked here: the permission request failed (${errorText(error)}). Nothing was answered or declined, and it stays open: answer it with ${answerElsewhere(runId)}.`;
}

function leftOutMessage(
  left: LeftOut[],
  partial: boolean,
  runId: string,
  timeoutAt: unknown,
  isAsync: boolean,
): string {
  const list = left.map((item, i) => `${i + 1}. ${item.question} (${item.reason})`).join("\n");
  const elsewhere = answerElsewhere(runId);
  const expiry =
    typeof timeoutAt === "string"
      ? isAsync
        ? ` If nobody answers by ${timeoutAt}, it closes and nothing is sent to the agent.`
        : ` If nobody answers by ${timeoutAt}, it is declined automatically and the model continues with stated assumptions.`
      : timeoutAt === null
        ? " It has no automatic expiry."
        : "";
  // Said before the answer is submitted, so it states the effect conditionally.
  if (partial)
    return `The chosen answers will now be submitted as a partial answer. Once it is accepted, it closes this question set, and these question(s) can no longer be answered in this run:\n\n${list}\n\nUntil then the set stays pending and can be answered with ${elsewhere}.${expiry}`;
  if (isAsync)
    return `No answer was sent. The agent keeps working, and its question(s) stay open:\n\n${list}\n\nAnswer them with ${elsewhere} (ACP presents choices only).${expiry}`;
  return `No answer was sent, so this run stays paused on its question(s):\n\n${list}\n\nAnswer them with ${elsewhere} (ACP presents choices only).${expiry}`;
}
