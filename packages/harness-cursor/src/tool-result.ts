import { commandOutcomeUnconfirmed, type ToolRef } from "@claudexor/schema";

type NativeObject = Record<string, unknown>;
type CommandFacts = Pick<ToolRef, "exit_code" | "command_outcome">;

const isRecord = (value: unknown): value is NativeObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): number | undefined =>
  Number.isInteger(value) ? (value as number) : undefined;

/** `agent.v1.ShellBackgroundReason` names as cursor-agent serializes them. */
const BACKGROUND_REASONS: Partial<Record<string, "timeout" | "requested">> = {
  SHELL_BACKGROUND_REASON_TIMEOUT: "timeout",
  SHELL_BACKGROUND_REASON_USER_REQUEST: "requested",
};

export interface CursorToolResult {
  status: NonNullable<ToolRef["status"]>;
  facts: CommandFacts;
  /** Complete native shell result, kept exactly, when the command end is unconfirmed. */
  payload?: { native_result: unknown };
}

/**
 * Classify one completed Cursor tool result. Denials and native failures keep
 * their existing mapping; a spawn error is a failure. For the shell, the
 * native `agent.v1.ShellResult` oneof (success/failure/timeout/rejected/
 * spawnError/permissionDenied, cursor-agent 2026.08.11) also yields the
 * command outcome (#450). stream-json carries protobuf defaults, so the
 * exitCode 0 of a background handoff is never read as an exit.
 */
export function classifyCursorToolResult(
  subtype: string,
  variant: string,
  result: unknown,
): CursorToolResult {
  const native = isRecord(result) ? result : {};
  const failure = native["failure"];
  const denied = Boolean(native["rejected"]) || Boolean(native["permissionDenied"]);
  const failed =
    subtype === "failed" ||
    (isRecord(failure) && ("exitCode" in failure || "error" in failure)) ||
    Boolean(native["error"]) ||
    isRecord(native["spawnError"]);
  const status = denied ? "denied" : failed ? "error" : "ok";
  const facts = variant === "shell" && !denied ? shellFacts(native, status) : {};
  if (!commandOutcomeUnconfirmed(facts.command_outcome)) return { status, facts };
  const evidence = result === undefined ? null : (JSON.parse(JSON.stringify(result)) as unknown);
  return { status, facts, payload: { native_result: evidence } };
}

function shellFacts(native: NativeObject, status: CursorToolResult["status"]): CommandFacts {
  const success = native["success"];
  const failure = native["failure"];
  const timeout = native["timeout"];
  if (isRecord(success)) {
    const reason = BACKGROUND_REASONS[String(success["backgroundReason"])];
    const shellId = integer(success["shellId"]);
    if (reason || shellId !== undefined || native["isBackground"] === true) {
      const pid = integer(success["pid"]) ?? integer(native["pid"]);
      const waited = integer(success["msToWait"]);
      return {
        command_outcome: {
          state: "backgrounded",
          ...(reason ? { background_reason: reason } : {}),
          ...(reason === "timeout" && waited !== undefined && waited >= 0
            ? { timeout_ms: waited }
            : {}),
          ...(shellId !== undefined ? { shell_id: String(shellId) } : {}),
          ...(pid !== undefined && pid > 0 ? { pid } : {}),
        },
      };
    }
    return exited(success, false);
  }
  if (isRecord(failure)) {
    const aborted = failure["aborted"] === true;
    if (aborted && failure["abortReason"] === "SHELL_ABORT_REASON_TIMEOUT")
      return { command_outcome: { state: "timed_out" } };
    return exited(failure, aborted);
  }
  if (isRecord(timeout)) {
    const ms = integer(timeout["timeoutMs"]);
    return {
      command_outcome: {
        state: "timed_out",
        ...(ms !== undefined && ms >= 0 ? { timeout_ms: ms } : {}),
      },
    };
  }
  // A spawn error never started the command; an error result says enough.
  return status === "ok" ? { command_outcome: { state: "unknown" } } : {};
}

/** An observed end. An aborted command's exit code is Cursor's sentinel. */
function exited(end: NativeObject, aborted: boolean): CommandFacts {
  const code = aborted ? undefined : integer(end["exitCode"]);
  const signal = typeof end["signal"] === "string" && end["signal"] ? end["signal"] : undefined;
  return {
    ...(code !== undefined ? { exit_code: code } : {}),
    command_outcome: { state: "exited", ...(signal ? { signal } : {}) },
  };
}
