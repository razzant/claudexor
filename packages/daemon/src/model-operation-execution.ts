import type { ModelAdapterContext } from "@claudexor/core";
import {
  ControlProblem,
  ImageCallRequest,
  ImageCallResult,
  ModelCallRequest,
  ModelCallResult,
  ModelOperationReceipt,
  ModelUsage,
  type ModelOperationParams,
  type ModelDispatch,
  type ModelPayloadRef,
} from "@claudexor/schema";
import { errorCode, redactSecrets } from "@claudexor/util";
import { commandStoreForId } from "./command-authority.js";
import type { ModelOperationDependencies, ModelPayloadStore } from "./model-operations.js";
import type { RunContext } from "./server.js";

const RESPONSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type Evidence = Omit<ModelOperationReceipt, "lifecycle">;

export const emptyDispatch = (): ModelDispatch => ({
  state: "not_started",
  startedAt: null,
  route: null,
});
const emptyEvidence = (): Evidence => ({
  dispatch: emptyDispatch(),
  response: { state: "absent" },
  usage: ModelUsage.parse({}),
  cost: null,
  problem: null,
});

export function operationError(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status, retryable: false });
}

function problemFrom(error: unknown): ControlProblem {
  const candidate = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const provided = ControlProblem.safeParse(candidate.problem);
  if (provided.success) return provided.data;
  const context: Record<string, unknown> = {};
  for (const key of ["resetsAt", "retryAfterMs", "httpStatus", "requestId"]) {
    if (typeof candidate[key] === "string" || typeof candidate[key] === "number") {
      context[key] =
        typeof candidate[key] === "string" ? redactSecrets(candidate[key]) : candidate[key];
    }
  }
  return ControlProblem.parse({
    code: errorCode(error) || "model_operation_failed",
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
    retryable: candidate.retryable === true,
    context,
  });
}

/** A problem names the requested model: the bytes this execution parsed, or before
 * it read them the params declaration (create's parsed bytes, or a raw enqueue's
 * unverified claim). route.model keeps only a provider-observed model, so a
 * failure never pretends one (#649). */
function withRequestedModel(problem: ControlProblem, model: string | null): ControlProblem;
function withRequestedModel(
  problem: ControlProblem | null,
  model: string | null,
): ControlProblem | null;
function withRequestedModel(problem: ControlProblem | null, model: string | null) {
  return problem && model !== null
    ? { ...problem, context: { ...problem.context, requestedModel: model } }
    : problem;
}

export async function executeModelOperation(
  params: ModelOperationParams,
  ctx: RunContext,
  deps: ModelOperationDependencies,
  update: (evidence: Evidence) => void,
): Promise<ModelOperationReceipt> {
  const now = () => (deps.now ?? (() => new Date()))();
  let evidence = emptyEvidence();
  let dispatchAttempted = false;
  let barrierProblem: ControlProblem | null = null;
  // The params declaration (create's parsed bytes, or a raw enqueue's unverified
  // claim), until this execution reads the digest-bound bytes: from then only
  // they name it, and bytes that do not parse name none.
  let requestedModel: string | null = params.requestedModel ?? null;
  try {
    const onDispatch: ModelAdapterContext["onDispatch"] = async (route) => {
      ctx.signal.throwIfAborted();
      if (dispatchAttempted) {
        throw operationError(
          "duplicate_model_dispatch",
          "A model operation may send inference only once",
        );
      }
      dispatchAttempted = true;
      const dispatch: ModelDispatch = {
        state: "started",
        startedAt: now().toISOString(),
        route,
      };
      update({ ...evidence, dispatch });
      // The adapter cannot POST until this callback returns. A rejected
      // journal write therefore never becomes evidence of a response.
      evidence.dispatch = dispatch;
      try {
        await commandStoreForId(deps.commands, ctx.jobId)!.flushed();
      } catch (error) {
        barrierProblem = withRequestedModel(
          ControlProblem.parse({
            code: "store_flush_unavailable",
            retryable: true,
            message: redactSecrets(error instanceof Error ? error.message : String(error)),
          }),
          requestedModel,
        );
        evidence = {
          ...evidence,
          dispatch: { ...dispatch, state: "not_started" },
          problem: barrierProblem,
        };
        update(evidence);
        throw Object.assign(new Error(barrierProblem.message), { problem: barrierProblem });
      }
      if (ctx.signal.aborted) {
        // The adapter is still waiting inside this callback: no POST occurred.
        evidence.dispatch = { ...dispatch, state: "not_started" };
        update(evidence);
        ctx.signal.throwIfAborted();
      }
    };
    const result = await invokeModelOperation(
      params,
      deps,
      ctx.signal,
      onDispatch,
      ctx.jobId,
      (model) => (requestedModel = model),
    );
    // An adapter may translate the callback rejection into its normal failed
    // response. The durable no-dispatch proof still owns this failure.
    if (barrierProblem)
      return ModelOperationReceipt.parse({
        lifecycle: "failed",
        ...evidence,
        problem: barrierProblem,
      });
    // Strict same-major clients keep the legacy receipt, detail and result shape.
    if ("routing" in result && result.routing && params.captureRoutingEvidence === true)
      evidence.routing = result.routing;
    evidence.usage = result.usage;
    evidence.cost = result.cost;
    // Before publication: GET bytes, digest, receipt and detail carry one problem.
    result.problem = withRequestedModel(result.problem, requestedModel);
    evidence.problem = result.problem;
    const notDelivered =
      result.outcome === "failed" &&
      result.problem?.code === "transport_not_delivered" &&
      result.problem.context.generationStarted === false &&
      (result.problem.context.requestDelivery as { state?: unknown } | undefined)?.state ===
        "not_delivered";
    if (evidence.dispatch.state === "started" && !notDelivered) {
      evidence.dispatch = {
        ...evidence.dispatch,
        state: result.outcome === "unknown" ? "unknown" : "response_received",
        route: result.route,
      };
    }
    // Preserve a useful response even when Cancel won before the daemon's
    // durable terminal barrier. Provider completion and caller cancellation
    // are different facts; a later cancel cannot rewrite a committed receipt.
    const lifecycle = ctx.signal.aborted
      ? "cancelled"
      : "images" in result
        ? result.outcome === "completed" && result.images.length > 0 && result.problem === null
          ? "succeeded"
          : result.outcome === "unknown"
            ? "interrupted"
            : "failed"
        : result.problem?.code === "response_rejected" && result.message === null
          ? "failed"
          : result.outcome === "completed"
            ? "succeeded"
            : result.outcome === "unknown" || result.outcome === "incomplete"
              ? "interrupted"
              : "failed";
    // Freeze the negotiated shape BEFORE publication; GET must keep its digest-bound bytes.
    if ("effortResolution" in result && params.captureEffortEvidence !== true)
      delete result.effortResolution;
    if ("routing" in result && params.captureRoutingEvidence !== true) delete result.routing;
    const ref = deps.resources().publishModel(Buffer.from(JSON.stringify(result), "utf8"));
    const ready = now();
    evidence.response = {
      state: "ready",
      ref,
      readyAt: ready.toISOString(),
      expiresAt: new Date(ready.getTime() + RESPONSE_RETENTION_MS).toISOString(),
    };
    // Refine only a complete terminal proof. The earlier attempted-send
    // stamp/route survive; a crash or publication failure still reads unknown.
    if (notDelivered && evidence.dispatch.state === "started") {
      evidence.dispatch = { ...evidence.dispatch, state: "not_started" };
    }
    // DaemonServer's existing terminal update atomically publishes this
    // compact receipt. Bodies never enter JobRecord.params/result.
    return ModelOperationReceipt.parse({ lifecycle, ...evidence });
  } catch (error) {
    const sent = evidence.dispatch.state !== "not_started";
    evidence.problem = withRequestedModel(barrierProblem ?? problemFrom(error), requestedModel);
    if (sent && evidence.dispatch.state !== "response_received") {
      evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
    }
    return ModelOperationReceipt.parse({
      lifecycle: ctx.signal.aborted ? "cancelled" : sent ? "interrupted" : "failed",
      ...evidence,
    });
  }
}

function parseModelPayload<T>(
  bytes: Buffer,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  name: string,
): T {
  let parsed: { success: true; data: T } | { success: false } | undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = schema.safeParse(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError) && errorCode(error) !== "ERR_ENCODING_INVALID_ENCODED_DATA")
      throw error;
  }
  if (!parsed?.success) {
    throw operationError(
      "model_request_invalid",
      `The uploaded model request must be valid UTF-8 JSON matching ${name}.`,
      400,
    );
  }
  return parsed.data;
}

/** Result reads stay here: an async read would race acknowledgement. */
export function readModelPayload<T>(
  resources: ModelPayloadStore,
  ref: ModelPayloadRef,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  name: string,
): T {
  // Preserve resource/digest/I/O failures; they are not invalid caller JSON.
  return parseModelPayload(resources.readModel(ref), schema, name);
}

/** Create and dispatch. The same parse as `readModelPayload`, after an off-thread read. */
export async function readModelPayloadAsync<T>(
  resources: ModelPayloadStore,
  ref: ModelPayloadRef,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  name: string,
): Promise<T> {
  return parseModelPayload(await resources.readModelAsync(ref), schema, name);
}

/** Execution's own read: once the bytes are read only they name the model, so a
 * params claim never outlives them and bytes that do not parse name none (#649). */
async function readOwnRequest<T extends { model: string }>(
  deps: ModelOperationDependencies,
  ref: ModelPayloadRef,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  name: string,
  named: (model: string | null) => void,
): Promise<T> {
  const bytes = await deps.resources().readModelAsync(ref);
  named(null);
  const request = parseModelPayload(bytes, schema, name);
  named(request.model);
  return request;
}

/** Only request parsing and adapter invocation differ; dispatch, publication and
 * terminal custody have one owner for both payload kinds. */
async function invokeModelOperation(
  params: ModelOperationParams,
  deps: ModelOperationDependencies,
  signal: AbortSignal,
  onDispatch: ModelAdapterContext["onDispatch"],
  operationId: string,
  named: (model: string | null) => void,
): Promise<ModelCallResult | ImageCallResult> {
  if (params.requestKind === "image") {
    if (params.request.sizeBytes > 144 * 1024 * 1024)
      throw operationError("image_request_too_large", "The image request exceeds 144 MiB", 413);
    const request = await readOwnRequest(
      deps,
      params.request,
      ImageCallRequest,
      "ImageCallRequest",
      named,
    );
    signal.throwIfAborted();
    if (!deps.resolveImage)
      throw operationError("model_source_unavailable", "No image-capable model source", 404);
    const { adapter, profile } = await deps.resolveImage(request, signal);
    if (!adapter.image)
      throw operationError(
        "model_source_unavailable",
        "The selected model source declares no image operations",
        404,
      );
    signal.throwIfAborted();
    return ImageCallResult.parse(
      await adapter.image.invoke(request, {
        profile,
        signal,
        onDispatch,
        imageTurnId: `img-${operationId}`,
      }),
    );
  }
  const request = await readOwnRequest(
    deps,
    params.request,
    ModelCallRequest,
    "ModelCallRequest",
    named,
  );
  signal.throwIfAborted();
  const { adapter, profile } = await deps.resolve(request, signal, operationId);
  signal.throwIfAborted();
  return ModelCallResult.parse(
    await adapter.invoke(request, {
      profile,
      signal,
      onDispatch,
      ...(params.captureFailureEvidence ? { captureFailureEvidence: true } : {}),
    }),
  );
}
