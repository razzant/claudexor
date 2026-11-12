/**
 * ACP session/prompt run-control validation — ACP-specific rules first
 * (mode/harness/n/booleans), then the SHARED semantic run-control rules
 * (one owner in @claudexor/schema). Pure functions, no server state.
 */
import {
  ModeKind,
  validateOptionalNonEmptyString,
  validateSurfaceRunControls,
} from "@claudexor/schema";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function runControlsFromMeta(meta: unknown): Record<string, unknown> {
  if (!isPlainRecord(meta)) return {};
  return isPlainRecord(meta.claudexor) ? meta.claudexor : {};
}

/** Typed validation verdict: message for humans, optional machine code. */
export interface RunControlError {
  message: string;
  code?: string;
}

const msg = (message: string): RunControlError => ({ message });

export function validateRunControls(params: unknown): RunControlError | null {
  if (!isPlainRecord(params)) return null;
  const allowedKeys = new Set([
    "sessionId",
    "prompt",
    "mode",
    "harness",
    "primaryHarness",
    "web",
    "externalContextPolicy",
    "model",
    "effort",
    "processingPreference",
    "maxSeconds",
    "timeLimitMode",
    "execution",
    "n",
    "race",
    "untilClean",
    "deepScan",
    "create",
    "council",
    "tests",
    "paidBudget",
    "access",
    "credentialProfileId",
    "protectedPathApprovals",
    "review",
    "reviewerPanel",
    "reviewerModels",
    "reviewerEfforts",
  ]);
  for (const key of Object.keys(params)) {
    // `_meta` is the PROTOCOL's forward-compat envelope (other parties'
    // standard field), not a Claudexor knob — tolerate it, reject the rest.
    // Unknown CLAUDEXOR fields still fail loudly (typo'd knobs never no-op).
    if (key === "_meta") continue;
    if (!allowedKeys.has(key)) return msg(`unknown session/prompt field: ${key}`);
  }
  if (
    params.mode !== undefined &&
    (typeof params.mode !== "string" || !ModeKind.safeParse(params.mode).success)
  ) {
    return msg("mode must be a valid mode");
  }
  if (params.race === true && (params.mode ?? "agent") !== "agent") {
    return msg(`race is an Agent strategy; mode is '${String(params.mode)}'`);
  }
  const harnessError = validateOptionalNonEmptyString(params.harness, "harness");
  if (harnessError) return msg(harnessError);
  for (const flag of ["race", "untilClean", "deepScan", "create", "council"] as const) {
    if (params[flag] !== undefined && typeof params[flag] !== "boolean") {
      return msg(`${flag} must be a boolean`);
    }
  }
  if (params.n !== undefined) {
    // A race needs >= 2 candidates; other routes accept any positive width.
    const min = params.race === true ? 2 : 1;
    if (!Number.isInteger(params.n) || (params.n as number) < min) {
      return msg(
        params.race === true ? "race n must be an integer >= 2" : "n must be a positive integer",
      );
    }
  }
  const shared = validateSurfaceRunControls(params);
  return shared ? msg(shared) : null;
}
