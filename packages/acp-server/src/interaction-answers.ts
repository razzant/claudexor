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
 * the run stays paused on the question set; once some questions are answered,
 * the message says those answers will be submitted as a partial answer, which
 * closes the whole set if the daemon accepts it. The message goes out before
 * the caller submits, so it cannot report the outcome.
 */
export async function requestInteractionAnswers(
  client: acp.AgentContext,
  sessionId: string,
  ctx: any,
  say: (text: string) => Promise<void>,
): Promise<any | null> {
  const request = ctx?.request;
  const runId = typeof ctx?.run_id === "string" ? ctx.run_id : "";
  const questions: any[] = Array.isArray(request?.questions) ? request.questions : [];
  const answers: any[] = [];
  const left: LeftOut[] = [];
  for (const [index, question] of questions.entries()) {
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
        { toolCallId, title: toolTitle, content: questionContent(question, options) },
        choices,
        answered,
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
  if (left.length > 0) await say(leftOutMessage(left, answers.length > 0, runId, ctx?.timeoutAt));
  return answers.length > 0
    ? { interaction_id: String(request?.interaction_id ?? ""), answers }
    : null;
}

/** One permission round as a pending tool call; the selected option id, if any.
 * The tool call ends `completed` when `answered` accepts the pick. */
async function ask(
  client: acp.AgentContext,
  sessionId: string,
  call: { toolCallId: string; title: string; content: acp.ToolCallContent[] },
  options: acp.PermissionOption[],
  answered: (picked: string | null) => boolean,
): Promise<string | null> {
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "tool_call", ...call, kind: "other", status: "pending" },
  });
  const response = (await client.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: call,
    options,
  })) as acp.RequestPermissionResponse;
  const outcome = response.outcome;
  const picked = outcome.outcome === "selected" ? outcome.optionId : null;
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: call.toolCallId,
      status: answered(picked) ? "completed" : "failed",
    },
  });
  return picked;
}

/** The question in full as text: its header, its text and every option with
 * its description. */
function questionContent(question: any, options: Option[]): acp.ToolCallContent[] {
  const lines: string[] = [];
  if (typeof question?.header === "string" && question.header) lines.push(question.header, "");
  lines.push(String(question?.question ?? ""), "");
  for (const option of options)
    lines.push(`- ${option.name}${option.description ? `: ${option.description}` : ""}`);
  return [{ type: "content", content: { type: "text", text: lines.join("\n") } }];
}

function leftOutMessage(
  left: LeftOut[],
  partial: boolean,
  runId: string,
  timeoutAt: unknown,
): string {
  const list = left.map((item, i) => `${i + 1}. ${item.question} (${item.reason})`).join("\n");
  const follow = runId ? `\`claudexor follow ${runId}\`` : "`claudexor follow <run>`";
  const answerElsewhere = `${follow} or POST /v2/runs/:id/interactions/:id/answer`;
  const expiry =
    typeof timeoutAt === "string"
      ? ` If nobody answers by ${timeoutAt}, it is declined automatically and the model continues with stated assumptions.`
      : timeoutAt === null
        ? " It has no automatic expiry."
        : "";
  // Said before the answer is submitted, so it states the effect conditionally.
  if (partial)
    return `The chosen answers will now be submitted as a partial answer. Once it is accepted, it closes this question set, and these question(s) can no longer be answered in this run:\n\n${list}\n\nUntil then the set stays pending and can be answered with ${answerElsewhere}.${expiry}`;
  return `No answer was sent, so this run stays paused on its question(s):\n\n${list}\n\nAnswer them with ${answerElsewhere} (ACP presents choices only).${expiry}`;
}
