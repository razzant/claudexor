import { flagBool, flagStr, type ParsedArgs } from "./args.js";

/** The five typed RunDecisionAction values, mapped from their CLI action flags. */
const ACTION_FLAGS: { flag: string; action: string }[] = [
  { flag: "accept-risk", action: "accept_risk" },
  { flag: "override", action: "override_needs_human" },
  { flag: "revert", action: "revert_run" },
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
        "one action is required (--accept-risk | --override | --revert | --accept-clean-patch | --rerun)",
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
