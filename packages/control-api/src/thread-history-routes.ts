import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ThreadHistoryInput,
  ThreadHistoryPage,
  ThreadPromptPartInput,
  ThreadPromptPart,
  threadHistoryProblem,
} from "@claudexor/schema";
import type { OperationDraft } from "./operation-draft.js";
import { queryParam } from "./operation-parameters.js";
import { requestGone } from "./request-liveness.js";

export interface ThreadHistoryServices {
  threadHistory(input: ThreadHistoryInput): ThreadHistoryPage;
  threadPromptPart(input: ThreadPromptPartInput): ThreadPromptPart;
}
interface Context {
  threadHistoryReads?: ThreadHistoryServices;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallback?: 400 | 500): void;
}
export async function handleThreadHistoryRoute(
  ctx: Context,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const historyMatch = /^\/threads\/([^/]+)\/history$/.exec(path);
  const promptMatch = /^\/threads\/([^/]+)\/turns\/([^/]+)\/prompt$/.exec(path);
  if (!((method === "GET" && historyMatch) || (method === "GET" && promptMatch))) return false;
  try {
    const match = (historyMatch ?? promptMatch)!;
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        throw threadHistoryProblem("invalid_thread_history_query", 400, "malformed addressed id");
      }
    };
    const query: Record<string, unknown> = { threadId: decode(match[1]!) };
    if (promptMatch) query.turnId = decode(match[2]!);
    const allowed = historyMatch
      ? ["limit", "cursor", "beforeTurnId", "afterTurnId", "aroundTurnId", "expectedStoreId"]
      : ["offset", "maxBytes", "expectedStoreId"];
    for (const [key, value] of new URL(req.url ?? "/", "http://localhost").searchParams) {
      if (!allowed.includes(key) || Object.hasOwn(query, key))
        throw threadHistoryProblem(
          "invalid_thread_history_query",
          400,
          "unknown or repeated history query parameter",
        );
      if (["limit", "offset", "maxBytes"].includes(key)) {
        if (!/^(0|[1-9][0-9]*)$/.test(value))
          throw threadHistoryProblem(
            "invalid_thread_history_query",
            400,
            "byte offsets and limits must be integers",
          );
        query[key] = Number(value);
      } else query[key] = value;
    }
    const parsed = historyMatch
      ? ThreadHistoryInput.safeParse(query)
      : ThreadPromptPartInput.safeParse(query);
    if (!parsed.success)
      throw threadHistoryProblem(
        "invalid_thread_history_query",
        400,
        "invalid history selectors or bounds",
      );
    const input = parsed.data;
    if (!ctx.threadHistoryReads)
      throw threadHistoryProblem(
        "thread_history_unavailable",
        503,
        "indexed history is unavailable",
      );
    if (!requestGone(req, res)) {
      const result = historyMatch
        ? ctx.threadHistoryReads.threadHistory(input as ThreadHistoryInput)
        : ctx.threadHistoryReads.threadPromptPart(input as ThreadPromptPartInput);
      ctx.json(res, 200, result);
    }
  } catch (error) {
    if (!requestGone(req, res)) ctx.requestError(res, error, 500);
  }
  return true;
}

const parameters = (names: string[], schema: string) =>
  names.map((name) =>
    queryParam({
      name,
      schemaRef: `${schema}#/properties/${name}`,
      description: `Optional ${name}; validated by ${schema}.`,
    }),
  );
export const THREAD_HISTORY_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/threads/:id/history",
    summary: "Read an addressed bounded page of thread turns with answers and receipt facts.",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ThreadHistoryPage",
    responseKind: "json",
    parameters: parameters(
      ["limit", "cursor", "beforeTurnId", "afterTurnId", "aroundTurnId", "expectedStoreId"],
      "ThreadHistoryInput",
    ),
  },
  {
    method: "GET",
    path: "/v2/threads/:id/turns/:id/prompt",
    summary: "Read a UTF-8 part of a turn's complete stored prompt, including refused turns.",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ThreadPromptPart",
    responseKind: "json",
    parameters: parameters(["offset", "maxBytes", "expectedStoreId"], "ThreadPromptPartInput"),
  },
];
