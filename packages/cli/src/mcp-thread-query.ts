import {
  ControlThread,
  ControlThreadDetail,
  ControlThreadTurnResponse,
  type McpThreadTurnResult,
} from "@claudexor/schema";
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

/** Thin MCP thread translation: the daemon owns turns, keys and route selection. */
export async function threadQuery(
  input: Record<string, unknown>,
  requireExistingDaemon: boolean,
  beltContext = false,
): Promise<Record<string, unknown>> {
  const creating = input["mode"] === "__thread_create";
  const reading = input["mode"] === "__thread_read";
  // Reads never boot a daemon: an absent one is a typed, retryable refusal.
  const connection =
    requireExistingDaemon || reading ? await connectDaemonIfRunning() : await ensureDaemon();
  if (!connection)
    throw daemonUnavailableError(
      beltContext,
      "thread read does not start one (start it with `claudexor daemon start` or call a mutating tool first)",
    );
  const threadId = typeof input["threadId"] === "string" ? input["threadId"] : "";
  const path = creating
    ? "/threads"
    : `/threads/${encodeURIComponent(threadId)}${reading ? "" : "/turns"}`;
  if (reading) {
    const response = await controlApiFetch(connection.addr, path);
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw controlProblemError(
        response.status,
        result,
        `thread read failed (HTTP ${response.status})`,
      );
    const parsed = ControlThreadDetail.safeParse(result);
    if (!parsed.success)
      throw controlProblemError(
        502,
        { code: "invalid_response", error: "daemon returned an invalid thread detail" },
        "daemon returned an invalid thread detail",
      );
    return { ...parsed.data, summary: `thread ${threadId}: ${parsed.data.turns.length} turn(s)` };
  }
  const body: Record<string, unknown> = creating
    ? {
        ...(input["title"] ? { title: input["title"] } : {}),
        scope: { kind: "project", root: String(input["repoPath"] ?? process.cwd()) },
        ...(input["defaultMode"] ? { mode: input["defaultMode"] } : {}),
        ...(input["workspace"] ? { workspace: input["workspace"] } : {}),
        ...(input["workspaceRoot"] ? { workspaceRoot: input["workspaceRoot"] } : {}),
        ...(input["credentialProfileId"]
          ? { credentialProfileId: input["credentialProfileId"] }
          : {}),
        ...(input["primaryHarness"] ? { primaryHarness: input["primaryHarness"] } : {}),
        ...(input["eligibleHarnesses"] ? { eligibleHarnesses: input["eligibleHarnesses"] } : {}),
        ...(input["access"] ? { access: input["access"] } : {}),
      }
    : {
        prompt: String(input["prompt"] ?? ""),
        ...(input["runMode"] ? { mode: input["runMode"] } : {}),
        ...(input["harness"] ? { harnesses: [input["harness"]] } : {}),
        ...(input["primaryHarness"] ? { primaryHarness: input["primaryHarness"] } : {}),
        ...(input["model"] ? { model: input["model"] } : {}),
        ...(input["effort"] ? { effort: input["effort"] } : {}),
        ...(input["credentialProfileId"]
          ? { credentialProfileId: input["credentialProfileId"] }
          : {}),
        ...(input["access"] ? { access: input["access"] } : {}),
        ...(input["web"] ? { web: input["web"] } : {}),
        ...(input["maxSeconds"] ? { maxSeconds: input["maxSeconds"] } : {}),
      };
  const response = await controlApiFetch(connection.addr, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(typeof input["idempotencyKey"] === "string"
        ? { "Idempotency-Key": input["idempotencyKey"] }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw controlProblemError(
      response.status,
      result,
      `thread ${creating ? "create" : "turn"} failed (HTTP ${response.status})`,
    );
  }
  if (creating) {
    const parsed = ControlThread.safeParse(result);
    if (!parsed.success) {
      throw controlProblemError(
        502,
        { code: "invalid_response", error: "daemon returned an invalid thread response" },
        "daemon returned an invalid thread response",
      );
    }
    const project = parsed.data.repoRoot ?? "project path unavailable";
    const location =
      parsed.data.workspaceMode === "in_place"
        ? `Write turns edit the project directory directly: ${project}.`
        : parsed.data.workspaceMode === "delegated"
          ? `Every turn executes in the caller-owned workspace ${parsed.data.workspaceRoot ?? "(unavailable)"} under delegated authority, with project ${project} as identity. Claudexor never applies, resets, or deletes that workspace.`
          : `Write turns use this thread's isolated persistent worktree for project ${project}; it is created on the first write turn. Use thread Apply to merge changes into the project.`;
    return {
      ...parsed.data,
      threadId: parsed.data.id,
      summary: `created thread ${parsed.data.id}\nworkspace: ${parsed.data.workspaceMode}\n${location}\nNo model was started.`,
    };
  }
  const parsed = ControlThreadTurnResponse.safeParse(result);
  if (!parsed.success) {
    throw controlProblemError(
      502,
      { code: "invalid_response", error: "daemon returned an invalid thread-turn response" },
      "daemon returned an invalid thread-turn response",
    );
  }
  const turn: McpThreadTurnResult = {
    ...parsed.data,
    summary: `queued turn ${parsed.data.turnId} on thread ${parsed.data.threadId}`,
  };
  return turn;
}
