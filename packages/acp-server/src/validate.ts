/**
 * ACP session/prompt run-control validation — ACP-specific rules first
 * (mode/harness/n/booleans), then the SHARED semantic run-control rules
 * (one owner in @claudexor/schema). Pure functions, no server state.
 */
import { ModeKind, validateOptionalNonEmptyString, validateSurfaceRunControls } from "@claudexor/schema";
import { assertNoInlineSecretValues, errorCode } from "@claudexor/util";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
    "n",
    "race",
    "untilClean",
    "swarm",
    "create",
    "tests",
    "maxUsd",
    "access",
    "protectedPathApprovals",
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
  if (params.mode !== undefined && (typeof params.mode !== "string" || !ModeKind.safeParse(params.mode).success)) {
    return msg("mode must be a valid mode");
  }
  const harnessError = validateOptionalNonEmptyString(params.harness, "harness");
  if (harnessError) return msg(harnessError);
  for (const flag of ["race", "untilClean", "swarm", "create"] as const) {
    if (params[flag] !== undefined && typeof params[flag] !== "boolean") {
      return msg(`${flag} must be a boolean`);
    }
  }
  if (params.n !== undefined) {
    // A race needs >= 2 candidates; other routes accept any positive width.
    const min = params.race === true ? 2 : 1;
    if (!Number.isInteger(params.n) || (params.n as number) < min) {
      return msg(params.race === true ? "race n must be an integer >= 2" : "n must be a positive integer");
    }
  }
  const shared = validateSurfaceRunControls(params);
  if (shared) return msg(shared);
  return validateNoInlineSecrets(params, "ACP session/prompt params");
}

function validateNoInlineSecrets(value: unknown, context: string): RunControlError | null {
  try {
    assertNoInlineSecretValues(value, "$", context);
    return null;
  } catch (err) {
    const code = errorCode(err);
    return { message: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) };
  }
}
