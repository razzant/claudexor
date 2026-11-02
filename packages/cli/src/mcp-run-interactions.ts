import {
  ControlInteractionAnswerResponse,
  ControlPendingInteraction,
  ControlProblem,
} from "@claudexor/schema";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { canonicalRunId } from "./mcp-run-projections.js";

/** Complete pending questions of one addressed run, with its canonical id. */
export function projectRunInteractions(
  requested: string,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const runId = canonicalRunId(requested, detail["summary"]);
  const pending = detail["pendingInteractions"];
  const interactions = ControlPendingInteraction.array().safeParse(pending);
  // An absent or malformed list is unknown, never an empty one.
  if (!Array.isArray(pending) || !interactions.success) {
    throw new CliError("operational", `run ${runId} detail carries no valid pending interactions`, {
      code: "invalid_service_response",
      retryable: true,
    });
  }
  return {
    summary: `${interactions.data.length} pending interaction(s) for run ${runId}`,
    runId,
    interactions: interactions.data,
  };
}

const ANSWER_REFUSAL_ACTIONS = {
  already_resolved:
    "already_resolved does not prove this answer was the one delivered; read the run's interaction events before acting again.",
  not_found:
    "Re-read claudexor_run_interactions: the question may have timed out, been withdrawn, or never belonged to this run.",
  rejected:
    "Nothing was committed. Answer again with at most one row per question id listed by claudexor_run_interactions, each carrying a selected label or non-blank free text.",
} as const;

/**
 * One answer submission through the daemon's interaction authority. Answers
 * carry no caller key and are never retried here: a refusal keeps its typed
 * status (not_found, already_resolved, rejected) as the failure code.
 */
export async function answerInteraction(
  addr: ControlApiAddress,
  runId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const interactionId = String(input["interactionId"] ?? "");
  if (!interactionId) throw new Error("interactionId is required");
  const res = await controlApiFetch(
    addr,
    `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: input["answers"] }),
    },
  );
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) {
    const receipt = ControlInteractionAnswerResponse.parse(body);
    return {
      summary: `answer ${receipt.status} for interaction ${interactionId}`,
      runId,
      interactionId,
      ...receipt,
    };
  }
  // The daemon answers refusals as problems; their typed answer status rides in context.
  const problem = ControlProblem.safeParse(body);
  const status = problem.success
    ? ControlInteractionAnswerResponse.shape.status.safeParse(problem.data.context["status"])
    : null;
  if (problem.success && status?.success && status.data !== "delivered") {
    throw new CliError("operational", problem.data.message || `interaction ${status.data}`, {
      code: status.data,
      retryable: false,
      requiredActions: [ANSWER_REFUSAL_ACTIONS[status.data]],
      context: { runId, interactionId, status: status.data },
    });
  }
  throw controlProblemError(res.status, body, `interaction answer failed (HTTP ${res.status})`);
}
