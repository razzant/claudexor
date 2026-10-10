import { daemonOwner, daemonUnavailableMessage } from "./daemon-owner.js";

const MUTATING_RECOVERY_MODES = new Set(["__run_cancel", "__run_answer", "__apply_check"]);

export const BELT_DAEMON_LOST =
  "the Claudexor delegation belt cannot reach its parent daemon; retry the parent run after repairing or restarting the runtime";

/** Typed absent-daemon refusal for an action that must not boot a daemon. */
export function daemonUnavailableError(beltContext: boolean, outcome: string): Error {
  return Object.assign(
    new Error(beltContext ? BELT_DAEMON_LOST : daemonUnavailableMessage(outcome)),
    { code: "daemon_unavailable", retryable: true },
  );
}

/** Project one absent-daemon fact without letting mutating recovery look successful. */
export function absentDaemonRecovery(mode: string, beltContext = false): { summary: string } {
  if (MUTATING_RECOVERY_MODES.has(mode) || (!beltContext && daemonOwner() === "external")) {
    throw daemonUnavailableError(beltContext, "this action was not performed");
  }
  return {
    summary: beltContext
      ? BELT_DAEMON_LOST
      : daemonUnavailableMessage(
          "there are no live daemon-tracked runs to recover (start one with `claudexor daemon start` or run a mutating tool first)",
        ),
  };
}
