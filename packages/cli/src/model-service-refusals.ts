import { ControlProblem } from "@claudexor/schema";

/** Preserve precise pool causes: catalog absence is not quota and unknown reset stays unknown. */
export function modelError(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status, retryable: false });
}

export const poolExhausted = (
  sourceId: string,
  error: unknown,
  catalogRefusals: Map<string, ControlProblem>,
): Error => {
  const provided = ControlProblem.safeParse(
    error && typeof error === "object" && "problem" in error ? error.problem : null,
  );
  const recordedCauses = provided.success ? provided.data.context.poolCauses : null;
  const causes = new Set(Array.isArray(recordedCauses) ? recordedCauses : []);
  const resets: Array<string | null> = causes.has("quota")
    ? [
        provided.success && typeof provided.data.context.resetsAt === "string"
          ? provided.data.context.resetsAt
          : null,
      ]
    : [];
  for (const refusal of catalogRefusals.values()) {
    // A disabled or removed account cannot become usable by quota or login.
    if (refusal.code === "model_account_unavailable") continue;
    causes.add(
      refusal.code === "auth_required"
        ? "auth"
        : refusal.code === "subscription_window_exhausted"
          ? "quota"
          : refusal.code === "model_unavailable"
            ? "model"
            : "unavailable",
    );
    if (refusal.code === "subscription_window_exhausted")
      resets.push(typeof refusal.context.resetsAt === "string" ? refusal.context.resetsAt : null);
  }
  const poolCause =
    causes.size === 1 && causes.has("quota")
      ? "quota"
      : causes.size === 1 && causes.has("auth")
        ? "auth"
        : causes.size === 2 && causes.has("auth") && causes.has("quota")
          ? "mixed"
          : "unavailable";
  const code =
    poolCause === "quota"
      ? "subscription_window_exhausted"
      : poolCause === "auth"
        ? "auth_required"
        : causes.size === 1 && causes.has("model")
          ? "model_unavailable"
          : "credential_pool_exhausted";
  const message =
    poolCause === "quota"
      ? "Every available model account is blocked by subscription quota"
      : poolCause === "auth"
        ? "Every available model account requires sign-in"
        : "No managed account can currently serve this model request";
  const resetsAt =
    poolCause !== "unavailable" &&
    resets.length > 0 &&
    resets.every((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
      ? resets.reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest))
      : null;
  return Object.assign(modelError(code, message), {
    problem: ControlProblem.parse({
      code,
      message,
      retryable: false,
      context: { source: sourceId, poolCause, resetsAt },
    }),
  });
};
