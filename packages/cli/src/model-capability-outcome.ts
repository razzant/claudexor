import type {
  CapabilityAttempt,
  CapabilityBinding,
  ModelCapabilityLedger,
} from "@claudexor/daemon";
import type { PreProgressRefusalLedger } from "@claudexor/daemon";
import type {
  ControlProblem,
  ModelCallRequest,
  ModelCallResult,
  ModelRoutingEvidence,
} from "@claudexor/schema";

type OutcomeArgs = Parameters<typeof modelCapabilityOutcome>[0];
export interface Alternatives {
  clean: boolean;
  capable: boolean;
}

/** Decorate one result, never invoke. The caller owns the next operation. */
export async function modelCapabilityOutcome(args: {
  request: ModelCallRequest;
  result: ModelCallResult;
  operationId: string;
  binding: CapabilityBinding;
  retry: CapabilityAttempt | null;
  ledger: ModelCapabilityLedger;
  refusals?: PreProgressRefusalLedger;
  routing: ModelRoutingEvidence;
  dispatched: boolean;
  /** One sweep: is an eligible alternative clean (no mark, no live refusal), and
   * is one at least capable (no capability row; a soft observation may still serve)? */
  hasAlternative: () => Promise<Alternatives>;
}): Promise<ModelCallResult> {
  const { request, result, binding, ledger, routing, retry } = args;
  const ownRoute =
    result.route.source === request.source &&
    result.route.credentialProfileId === binding.profileId &&
    result.route.accountFingerprint === binding.fingerprint;
  if (!ownRoute || !ledger.current(binding)) return { ...result, routing };
  const success =
    args.dispatched && result.outcome === "completed" && !result.problem && !result.modelMismatch;
  if (success) {
    ledger.served(binding);
    args.refusals?.clear(binding.harnessId, binding.profileId, request.model);
    if (retry) {
      ledger.settleRetry(request.retryOfOperationId!, "confirmed");
      routing.differentialOutcome = "confirmed";
    }
  }
  const problem = result.problem;
  const beforeGeneration =
    args.dispatched &&
    result.outcome === "failed" &&
    result.message === null &&
    !(result.usage.output_tokens && result.usage.output_tokens > 0) &&
    !(result.usage.reasoning_tokens && result.usage.reasoning_tokens > 0);
  const refusal =
    beforeGeneration &&
    problem?.code === "model_capability_refused" &&
    problem.context.generationStarted === false;
  if (
    !refusal &&
    beforeGeneration &&
    problem &&
    request.account.mode === "auto" &&
    definiteProviderRefusal(problem)
  )
    return unclassifiedRefusal(args, problem);
  if (!refusal || !problem) {
    if (retry && !success) routing.differentialOutcome = "inconclusive";
    return { ...result, routing };
  }
  const current: Record<string, unknown> = {
    credentialProfileId: binding.profileId,
    accountFingerprint: binding.fingerprint,
    providerReason: String(problem.context.providerReason ?? problem.message),
    capabilityKind: problem.context.capabilityKind,
  };
  const accountsTried = retry
    ? [...(retry.problem.context.accountsTried as unknown[]), current]
    : [current];
  const equivalent =
    retry !== null && retry.problem.context.capabilityKind === problem.context.capabilityKind;
  // The correlated retry must repeat this history, and another account rejects
  // it before inference, so offering the retry would only spend the correlation.
  const blockedBy =
    !retry && request.account.mode === "auto" && historyBoundTo(request, binding)
      ? "native_continuation"
      : null;
  const decorated = {
    ...(equivalent ? retry!.problem : problem),
    retryable: false,
    context: {
      ...(equivalent ? retry!.problem.context : problem.context),
      source: request.source,
      operationId: args.operationId,
      requestedModel: request.model,
      credentialProfileId: equivalent ? retry!.binding.profileId : binding.profileId,
      accountFingerprint: equivalent ? retry!.binding.fingerprint : binding.fingerprint,
      accountMode: request.account.mode,
      retryOnOtherAccount: false,
      ...(blockedBy ? { retryBlockedBy: blockedBy } : {}),
      accountsTried,
      nextStep:
        request.account.mode === "pin"
          ? "Choose another account or a model supported by this pinned account."
          : blockedBy
            ? "The history carries native continuation bound to this account, so it cannot move to another account; resend without that continuation or start a new conversation."
            : "Check the requested model and account plan, refresh account catalogs, or choose another model.",
      ...(retry
        ? {
            retryOfOperationId: request.retryOfOperationId,
            differentialOutcome: equivalent ? "equivalent_refusal" : "inconclusive",
          }
        : {}),
    },
  };
  let alternatives: Alternatives | undefined;
  if (equivalent) {
    ledger.settleRetry(request.retryOfOperationId!, "equivalent_refusal");
    // Two deficient accounts do not establish that the request is invalid.
    // Retain A's provisional evidence and record B's own reason/binding.
    ledger.refuse(
      binding,
      args.operationId,
      { ...problem, context: { ...problem.context, retryOnOtherAccount: false } },
      request,
    );
    soften(args);
    routing.differentialOutcome = "equivalent_refusal";
  } else if (request.account.mode === "auto") {
    ledger.refuse(binding, args.operationId, decorated, request);
    soften(args);
    routing.differentialOutcome = retry ? "inconclusive" : "provisional";
    // A correlated retry cannot start another chain. Pinned requests never
    // acquire marks and never ask the host to switch an account.
    if (!retry && !blockedBy) {
      alternatives = await args.hasAlternative();
      decorated.context.retryOnOtherAccount = alternatives.clean;
      if (alternatives.clean) decorated.context.nextStep = RESEND;
    }
  }
  return { ...result, problem: await withModelMarks(args, decorated, alternatives), routing };
}

const RESEND =
  "Re-send the same generation input once in auto mode with retryOfOperationId set to this operation id.";

/** The shared pre-progress observation: this account orders after the others for
 * this model, Agent runs included, until it serves it. An older in-flight request
 * must not undo the service of a newer one. Pins never reach here. */
function soften(args: OutcomeArgs): void {
  const { binding, ledger, request } = args;
  if (ledger.servedAfter(binding)) return;
  args.refusals?.record({
    harness_id: binding.harnessId,
    profile_id: binding.profileId,
    requested_model: request.model,
  });
}

/** The live marks for this model and whether an account without one remains.
 * A row's `since` is its episode: renewals and probes keep it; success, a
 * catalog or an identity change start a new one. Hosts can tell one ongoing
 * case from a new one, and "every other account is marked" from "another may
 * serve" (a recently refusing account may: its refusal can belong to one
 * request). The alternative is discovered first: live discovery can clear marks. */
async function withModelMarks<T extends { context: Record<string, unknown> }>(
  args: OutcomeArgs,
  problem: T,
  alternatives?: Alternatives,
): Promise<T> {
  const { binding, ledger, request } = args;
  if (request.account.mode === "auto")
    problem.context.alternativeRemains = (alternatives ?? (await args.hasAlternative())).capable;
  problem.context.modelMarks = ledger
    .live()
    .filter(
      (mark) => mark.harness_id === binding.harnessId && mark.requested_model === request.model,
    )
    .map((mark) => ({
      credentialProfileId: mark.profile_id,
      accountFingerprint: mark.account_fingerprint,
      providerReason: mark.provider_reason,
      since: mark.observed_at,
      state: mark.state,
    }));
  return problem;
}

/** Codes another channel already owns (sign-in, quota, rate limits, the
 * processing fallback, the engine's own request and correlation checks, the
 * recognized capability refusal) or that type the request itself as the fault. */
const NOT_ACCOUNT_REFUSALS = new Set([
  "auth_required",
  "auth_refresh_failed",
  "auth_revoked",
  "auth_changed",
  "credential_unusable",
  "subscription_window_exhausted",
  "rate_limited",
  "processing_unavailable",
  "unsupported_parameter",
  "model_request_invalid",
  "model_retry_invalid",
  "invalid_continuation",
  "model_capability_refused",
]);

/** A provider's definite HTTP 4xx refusal of a dispatched request that may be
 * the account's. Sign-in (401), timeouts and conflicts (408, 409), rate limits
 * and quota (429, typed quota codes) and server-side failures (5xx: overload,
 * outages) keep their own mechanisms;
 * stream errors carry no HTTP status; typed request faults (a named non-model
 * parameter, an exceeded context length) never demote an account. */
function definiteProviderRefusal(problem: ControlProblem): boolean {
  const { httpStatus: status, vendorCode, parameter } = problem.context;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429 &&
    !NOT_ACCOUNT_REFUSALS.has(problem.code) &&
    vendorCode !== "context_length_exceeded" &&
    (parameter === undefined || parameter === "model")
  );
}

/**
 * Any other refusal before generation on an auto account, whatever its wording:
 * the account at once orders after the others for this model (soften) and the
 * host may send the one correlated retry. Served elsewhere proves the account at fault and becomes an ordinary
 * confirmed mark (ledger.settleRetry); refused there too marks nothing, because
 * the request itself may be at fault. The provider's code is kept as is.
 */
async function unclassifiedRefusal(
  args: OutcomeArgs,
  problem: ControlProblem,
): Promise<ModelCallResult> {
  const { request, result, binding, ledger, routing, retry } = args;
  soften(args);
  // Only structural diagnostics: the engine's message and the vendor's typed code.
  const vendor = typeof problem.context.vendorCode === "string" ? problem.context.vendorCode : "";
  const reason = String(
    problem.context.providerReason ?? (vendor ? `${problem.message} (${vendor})` : problem.message),
  );
  const current = {
    credentialProfileId: binding.profileId,
    accountFingerprint: binding.fingerprint,
    providerReason: reason,
    capabilityKind: "unclassified",
  };
  const accountsTried = retry
    ? [...((retry.problem.context.accountsTried as unknown[] | undefined) ?? []), current]
    : [current];
  const blockedBy = !retry && historyBoundTo(request, binding) ? "native_continuation" : null;
  const decorated = {
    ...problem,
    context: {
      ...problem.context,
      source: request.source,
      operationId: args.operationId,
      requestedModel: request.model,
      credentialProfileId: binding.profileId,
      accountFingerprint: binding.fingerprint,
      accountMode: request.account.mode,
      generationStarted: false,
      capabilityKind: "unclassified",
      retryOnOtherAccount: false,
      ...(blockedBy ? { retryBlockedBy: blockedBy } : {}),
      accountsTried,
      nextStep: blockedBy
        ? "The history carries native continuation bound to this account, so it cannot move to another account; resend without that continuation or start a new conversation."
        : "The provider refused this request before generation; check the request, the requested model and the account plan.",
      ...(retry
        ? { retryOfOperationId: request.retryOfOperationId, differentialOutcome: "inconclusive" }
        : {}),
    },
  };
  if (retry) {
    routing.differentialOutcome = "inconclusive";
    return { ...result, problem: await withModelMarks(args, decorated), routing };
  }
  let alternatives: Alternatives | undefined;
  if (!blockedBy) {
    alternatives = await args.hasAlternative();
    decorated.context.retryOnOtherAccount = alternatives.clean;
    if (alternatives.clean) decorated.context.nextStep = RESEND;
    // The mark a confirming service creates keeps this diagnostic as its reason;
    // the public context does not repeat the problem's message.
    const offered = { ...decorated, context: { ...decorated.context, providerReason: reason } };
    ledger.offer(binding, args.operationId, offered, request);
  }
  return { ...result, problem: await withModelMarks(args, decorated, alternatives), routing };
}

/** Historical assistant continuation replays only on the account that produced it. */
export function historyBoundTo(
  request: Pick<ModelCallRequest, "messages">,
  binding: Pick<CapabilityBinding, "profileId" | "fingerprint">,
): boolean {
  return request.messages.some(({ nativeContinuation }) => {
    const route = nativeContinuation?.route;
    return (
      route !== undefined &&
      (route.credentialProfileId === binding.profileId ||
        (binding.fingerprint !== null && route.accountFingerprint === binding.fingerprint))
    );
  });
}
