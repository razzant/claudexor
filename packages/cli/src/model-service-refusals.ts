import { ControlProblem } from "@claudexor/schema";

/** Preserve precise pool causes: catalog absence is not quota and unknown reset stays unknown. */
export function modelError(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status, retryable: false });
}

/** A refusal's own typed problem, or one stating its code and message. */
export const refusalProblem = (error: Error & { code?: string; problem?: unknown }) =>
  ControlProblem.safeParse(error.problem).data ??
  ControlProblem.parse({ code: error.code, message: error.message, retryable: false });

/** The HTTP serializer reads the error fields, the operation receipt reads `problem`. */
export function modelRefusal(
  input: Pick<ControlProblem, "code" | "message" | "retryable" | "context">,
): Error {
  const problem = ControlProblem.parse(input);
  return Object.assign(new Error(problem.message), problem, { status: 409, problem });
}

export const poolExhausted = (
  sourceId: string,
  error: unknown,
  catalogRefusals: Map<string, ControlProblem>,
): Error => {
  const context = ControlProblem.safeParse(
    error && typeof error === "object" && "problem" in error ? error.problem : null,
  ).data?.context;
  const poolCauses = Array.isArray(context?.poolCauses) ? context.poolCauses : [];
  const tried = [...catalogRefusals.values()];
  if (tried.length && tried.every((refusal) => refusal.context.cause === "network")) {
    const errorCode = tried[0]!.context.errorCode;
    return modelRefusal({
      code: "catalog_unavailable",
      message: `The model provider could not be reached from this machine (${String(errorCode)}); every account tried failed to connect`,
      retryable: true,
      context: { source: sourceId, poolCause: "network", cause: "network", errorCode, poolCauses },
    });
  }
  const causes = new Set(poolCauses);
  const resets: Array<string | null> = [];
  if (causes.has("quota"))
    resets.push(typeof context?.resetsAt === "string" ? context.resetsAt : null);
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
  return modelRefusal({
    code,
    message,
    retryable: false,
    context: { source: sourceId, poolCause, resetsAt },
  });
};
