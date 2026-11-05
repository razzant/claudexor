import { flagBool, flagStr, type ParsedArgs } from "./args.js";

/** Typed RunDecisionAction values, mapped from their CLI action flags. */
const ACTION_FLAGS: { flag: string; action: string }[] = [
  { flag: "accept-risk", action: "accept_risk" },
  { flag: "override", action: "override_needs_human" },
  { flag: "revert", action: "revert_run" },
  { flag: "discard", action: "discard" },
  { flag: "taken", action: "taken" },
  { flag: "accept-clean-patch", action: "accept_clean_patch" },
  { flag: "rerun", action: "rerun_with_feedback" },
];

const APPLY_MODES = ["apply", "branch", "commit", "pr"];

export type DecisionResolution =
  { ok: true; action: string; body: Record<string, unknown> } | { ok: false; message: string };

/**
 * Pure mapping of `claudexor decision` flags to a typed RunDecisionAction
 * request body. Exactly one action flag is required; rerun needs --feedback;
 * accept-clean-patch may carry a validated --apply-mode. Returns an honest
 * error message instead of a body when the flags are invalid (the command
 * surfaces it on stderr and exits 2).
 */
export function resolveDecisionBody(args: ParsedArgs): DecisionResolution {
  const chosen = ACTION_FLAGS.filter((f) => flagBool(args, f.flag));
  if (chosen.length === 0) {
    return {
      ok: false,
      message:
        "one action is required (--accept-risk | --override | --revert | --discard | --taken | --accept-clean-patch | --rerun)",
    };
  }
  if (chosen.length > 1) {
    return {
      ok: false,
      message: `only one action at a time (got ${chosen.map((c) => `--${c.flag}`).join(", ")})`,
    };
  }
  const action = chosen[0]!.action;
  const body: Record<string, unknown> = { action };
  if (action === "taken") body["reason"] = "captured_result";
  if (action === "rerun_with_feedback") {
    const feedback = flagStr(args, "feedback");
    if (!feedback || !feedback.trim()) {
      return { ok: false, message: '--rerun requires --feedback "<text>"' };
    }
    body["feedback"] = feedback;
  }
  if (action === "accept_clean_patch") {
    const applyMode = flagStr(args, "apply-mode");
    if (applyMode !== undefined) {
      if (!APPLY_MODES.includes(applyMode)) {
        return {
          ok: false,
          message: `invalid --apply-mode '${applyMode}' (expected apply|branch|commit|pr)`,
        };
      }
      body["applyMode"] = applyMode;
    }
  }
  return { ok: true, action, body };
}

/** Human lines for a decision answer. A rerun answered before its run binds
 * names the follow-up job, so the user can still follow it. */
export function decisionAnswerLines(
  action: string,
  runId: string,
  data: Record<string, unknown>,
): string[] {
  const verdict = data["accepted"] === true ? "accepted" : "rejected";
  const lines = [`decision ${action} on ${runId}: ${verdict} [${String(data["status"] ?? "?")}]`];
  if (typeof data["newRunId"] === "string") lines.push(`  new run: ${data["newRunId"]}`);
  else if (typeof data["newJobId"] === "string") lines.push(`  new job: ${data["newJobId"]}`);
  if (typeof data["message"] === "string") lines.push(`  ${data["message"]}`);
  return lines;
}
