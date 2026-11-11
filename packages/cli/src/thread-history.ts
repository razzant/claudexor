import { subcommandFlagScopeError } from "./command-scope.js";
import {
  ControlProblem,
  ThreadHistoryInput,
  ThreadHistoryPage,
  ThreadPromptPartInput,
  ThreadPromptPart,
} from "@claudexor/schema";
import { flagStr, requiredStringFlagError, type ParsedArgs } from "./args.js";
import { CliError, controlProblemError, renderCliFailure, usageError } from "./cli-error.js";
import { printJson } from "./cli-io.js";
import { controlApiFetch } from "./live.js";
import { connectForObservation } from "./mcp-run-wait.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

/** CLI and MCP share one bounded existing-daemon read. No fallback hydration. */
export async function threadHistoryQuery(
  raw: Record<string, unknown>,
  prompt = false,
  beltContext = false,
  signal?: AbortSignal,
): Promise<ThreadHistoryPage | ThreadPromptPart> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot inspect threads"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input = prompt ? ThreadPromptPartInput.parse(raw) : ThreadHistoryInput.parse(raw);
  const connection = await connectForObservation(signal);
  if (!connection)
    throw daemonUnavailableError(false, "thread history reads do not start a daemon");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key !== "threadId" && key !== "turnId" && value !== undefined)
      query.set(key, String(value));
  }
  const path = `/threads/${encodeURIComponent(input.threadId)}/${
    prompt
      ? `turns/${encodeURIComponent((input as ThreadPromptPartInput).turnId)}/prompt`
      : "history"
  }?${query}`;
  const timeout = AbortSignal.timeout(5000);
  const response = await controlApiFetch(connection.addr, path, {
    method: "GET",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const problem = ControlProblem.safeParse(body);
    throw controlProblemError(
      response.status,
      problem.success
        ? problem.data
        : {
            code: "thread_history_unavailable",
            message: "use a daemon supporting bounded thread history",
            retryable: true,
          },
      "thread read failed",
    );
  }
  const parsed = prompt ? ThreadPromptPart.safeParse(body) : ThreadHistoryPage.safeParse(body);
  if (!parsed.success || parsed.data.threadId !== input.threadId)
    throw new CliError("operational", "daemon returned an invalid thread history response", {
      code: "invalid_service_response",
    });
  if (prompt) {
    const part = parsed.data as ThreadPromptPart,
      request = input as ThreadPromptPartInput;
    if (
      part.turnId !== request.turnId ||
      part.offset !== request.offset ||
      Buffer.byteLength(part.text) > request.maxBytes
    )
      throw new CliError("operational", "daemon returned a mismatched prompt part", {
        code: "invalid_service_response",
      });
  } else if (
    (input.expectedStoreId &&
      (parsed.data as ThreadHistoryPage).storeId !== input.expectedStoreId) ||
    (parsed.data as ThreadHistoryPage).turns.length > (input as ThreadHistoryInput).limit
  )
    throw new CliError("operational", "daemon returned a mismatched history page", {
      code: "invalid_service_response",
    });
  return parsed.data;
}

export async function threadHistoryCommand(args: ParsedArgs, json: boolean): Promise<number> {
  try {
    const prompt = args._[1] === "prompt";
    const flags = prompt
      ? ["offset", "max-bytes", "expected-store-id"]
      : ["limit", "cursor", "before", "after", "around", "expected-store-id"];
    const error =
      subcommandFlagScopeError("thread", args._[1] ?? "", Object.keys(args.flags)) ??
      requiredStringFlagError(args, flags);
    if (error || args._.length !== (prompt ? 4 : 3) || (!prompt && args._[1] !== "history"))
      throw usageError(
        error ??
          "usage: claudexor thread history <id> [--limit N] [--cursor C | --before ID | --after ID | --around ID] [--json]",
      );
    const input: Record<string, unknown> = { threadId: args._[2] };
    if (prompt) input.turnId = args._[3];
    const names: Record<string, string> = {
      before: "beforeTurnId",
      after: "afterTurnId",
      around: "aroundTurnId",
      "expected-store-id": "expectedStoreId",
      "max-bytes": "maxBytes",
    };
    for (const flag of flags) {
      const value = flagStr(args, flag);
      if (value === undefined) continue;
      const numeric = ["limit", "offset", "max-bytes"].includes(flag);
      if (numeric && !/^(0|[1-9][0-9]*)$/.test(value))
        throw usageError(`--${flag} must be an integer`);
      input[names[flag] ?? flag] = numeric ? Number(value) : value;
    }
    printJson(await threadHistoryQuery(input, prompt));
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor thread:" });
  }
}
