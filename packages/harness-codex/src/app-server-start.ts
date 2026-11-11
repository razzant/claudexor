import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { CLAUDEXOR_VERSION, nowIso } from "@claudexor/util";
import { codexAppServerInput } from "./attachments.js";
import { asObject, type JsonObject, type CodexAppServerRunInput } from "./app-server-protocol.js";
import { codexAppServerThreadRequest, codexTurnParams } from "./app-server-session.js";
import { ownsNotification } from "./app-server-threads.js";

/** Start under the run's policy and bind the receipt to the root turn, not a child. */
export async function startCodexTurn(input: {
  spec: HarnessRunSpec;
  threadId: string;
  /** The run's auxiliary-root turn policy; undefined keeps the thread's own sandbox. */
  sandboxPolicy?: JsonObject;
  requiredMcpServers: string[];
  request(method: string, params: JsonObject): Promise<JsonObject>;
  nextNotification(
    method: string,
    accept: (params: JsonObject | null) => boolean,
    consume: boolean,
  ): Promise<JsonObject>;
}): Promise<HarnessEvent> {
  const { spec, threadId, request, nextNotification } = input;
  const turnResult = await request("turn/start", {
    threadId,
    ...codexTurnParams(spec, input.sandboxPolicy),
    input: codexAppServerInput(spec),
    ...(spec.output_schema != null ? { outputSchema: spec.output_schema } : {}),
  });
  const requestedTurnId = asObject(turnResult["turn"])?.["id"];
  const started = await nextNotification(
    "turn/started",
    (params) =>
      ownsNotification(params, threadId) &&
      (typeof requestedTurnId !== "string" ||
        asObject(params?.["turn"])?.["id"] === requestedTurnId),
    // Preserve arrival order so an earlier completion sees the new start queued.
    false,
  );
  const turnId =
    typeof requestedTurnId === "string"
      ? requestedTurnId
      : asObject(asObject(started["params"])?.["turn"])?.["id"];
  if (typeof turnId !== "string") throw new Error("Codex app-server omitted active turn id");
  return {
    type: "started",
    session_id: spec.session_id,
    ts: nowIso(),
    payload: {
      native_session_id: threadId,
      native_turn_id: turnId,
      ...(input.requiredMcpServers.length
        ? {
            mcp_servers: input.requiredMcpServers.map((name) => ({ name, status: "connected" })),
          }
        : {}),
    },
  };
}

/** Initialize the server and record its own version before starting or resuming a thread. */
export async function startCodexThread(
  input: Pick<CodexAppServerRunInput, "spec" | "effort">,
  request: (method: string, params: JsonObject) => Promise<JsonObject>,
  notify: (method: string, params: JsonObject | null) => Promise<void>,
  observeVersion: (version: unknown) => void,
): Promise<{ threadResult: JsonObject; threadId: string }> {
  const initialized = await request("initialize", {
    clientInfo: { name: "claudexor", version: CLAUDEXOR_VERSION },
    capabilities: { experimentalApi: true },
  });
  // The leading server-built token is authoritative; the parenthesized client version is ours.
  const userAgent = initialized["userAgent"];
  if (typeof userAgent === "string") observeVersion(/^[^/\s]+\/([^\s]+)/.exec(userAgent)?.[1]);
  await notify("initialized", null);
  const threadResult = await request(...codexAppServerThreadRequest(input.spec, input.effort));
  const threadId = asObject(threadResult["thread"])?.["id"];
  if (typeof threadId !== "string") throw new Error("Codex app-server omitted thread id");
  return { threadResult, threadId };
}
