import type { ModelAdapter } from "@claudexor/core";
import {
  ControlModelOperationDetail,
  ControlProblem,
  ModelCallRequest,
  ModelCallResult,
  ModelOperationParams,
  ModelOperationReceipt,
  ModelUsage,
  isTerminalLifecycle,
  isModelOperation,
  type CancelReasonCode,
  type CredentialProfile,
  type ModelDispatch,
  type ModelPayloadRef,
  type ModelResponseCustody,
} from "@claudexor/schema";
import { errorCode, redactSecrets } from "@claudexor/util";
import {
  commandStoreForId,
  commandStores,
  type CommandAuthority,
  type LegacyCommandAuthority,
} from "./command-authority.js";
import { findAcceptedCommand } from "./command-rpc.js";
import type { JobRecord, RunContext } from "./server.js";
import type { ModelResourceQueries } from "./store/command-queries.js";

export const MODEL_OPERATION_ID = "model.operation.create";
const RESPONSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Existing ResourceStore supplies these purpose-bound byte operations. */
export interface ModelPayloadStore {
  readModel(ref: ModelPayloadRef): Buffer;
  publishModel(bytes: Uint8Array): ModelPayloadRef;
  releaseModel(ref: ModelPayloadRef): void;
  expireModel(ref: ModelPayloadRef, expiredAt: string): void;
  listModelResources(): Array<ModelPayloadRef & { createdAt: string }>;
}

interface ModelOperationServices {
  resources: () => ModelPayloadStore;
  enqueue(envelope: {
    request: ModelOperationParams;
    operation: string;
    idempotencyKey: string;
    clientId: string;
    idempotencyRequest: unknown;
  }): Promise<{ id: string }>;
  cancel(id: string, reason?: CancelReasonCode): Promise<unknown>;
  resolve(
    request: ModelCallRequest,
    signal: AbortSignal,
  ): Promise<{
    adapter: ModelAdapter;
    profile: CredentialProfile;
  }>;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** A SQL authority must supply addressed custody queries. Only the explicit
 * legacy branch retains its enumerable journal projection. */
export type ModelOperationPersistence =
  | { commands: LegacyCommandAuthority; resourceQueries?: undefined }
  | { commands: CommandAuthority; resourceQueries: ModelResourceQueries };
export type ModelOperationDependencies = ModelOperationServices & ModelOperationPersistence;

type Evidence = Omit<ModelOperationReceipt, "lifecycle">;

const emptyDispatch = (): ModelDispatch => ({ state: "not_started", startedAt: null, route: null });
const emptyEvidence = (): Evidence => ({
  dispatch: emptyDispatch(),
  response: { state: "absent" },
  usage: ModelUsage.parse({}),
  cost: null,
  problem: null,
});

function operationError(code: string, message: string, status = 409): Error {
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

/** A model command reuses daemon queue/cancel/command authority. This owns only
 * the generation's payload custody; it has no scheduler or conversation cache. */
export class ModelOperations {
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly startedAt: number;

  constructor(private readonly deps: ModelOperationDependencies) {
    this.startedAt = this.now().getTime();
  }

  async create(
    request: ModelPayloadRef,
    idempotencyKey: string,
    captureFailureEvidence?: boolean,
    captureEffortEvidence?: boolean,
  ): Promise<ControlModelOperationDetail> {
    if (this.closed) throw operationError("daemon_stopping", "Model operations are stopping", 503);
    // Omission and false retain the historical command and idempotency bytes.
    const capture = {
      ...(captureFailureEvidence === true ? { captureFailureEvidence: true as const } : {}),
      ...(captureEffortEvidence === true ? { captureEffortEvidence: true as const } : {}),
    };
    const envelope = {
      request: ModelOperationParams.parse({ kind: "model", request, ...capture }),
      operation: MODEL_OPERATION_ID,
      idempotencyKey,
      clientId: "control-api",
      // Uploaded copies of identical bytes are the same idempotent request.
      idempotencyRequest: {
        kind: "model",
        sha256: request.sha256,
        sizeBytes: request.sizeBytes,
        ...capture,
      },
    };
    const replay = findAcceptedCommand(this.deps.commands, envelope);
    let id = replay?.id;
    if (!id) {
      // Validate only a NEW request. A settled replay's input has been released.
      // model_request_invalid from this boundary proves no command was accepted:
      // the idempotency lookup above succeeded and validation precedes enqueue.
      this.readRequest(request);
      id = (await this.deps.enqueue(envelope)).id;
    }
    // Re-uploaded copies can lose either the early lookup or the enqueue race.
    // Release only the unused copy; another live command may still own it.
    const canonical = ModelOperationParams.parse(this.record(id).params).request;
    if (canonical.resourceId !== request.resourceId) this.releaseIfUnused(request);
    return this.inspect(id);
  }

  async execute(raw: unknown, ctx: RunContext): Promise<ModelOperationReceipt> {
    const params = ModelOperationParams.parse(raw);
    let evidence = emptyEvidence();
    let dispatchAttempted = false;
    let barrierProblem: ControlProblem | null = null;
    try {
      const request = this.readRequest(params.request);
      ctx.signal.throwIfAborted();
      const { adapter, profile } = await this.deps.resolve(request, ctx.signal);
      ctx.signal.throwIfAborted();
      const result = ModelCallResult.parse(
        await adapter.invoke(request, {
          profile,
          signal: ctx.signal,
          ...(params.captureFailureEvidence ? { captureFailureEvidence: true } : {}),
          onDispatch: async (route) => {
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
              startedAt: this.now().toISOString(),
              route,
            };
            this.update(ctx.jobId, { ...evidence, dispatch });
            // The adapter cannot POST until this callback returns. A rejected
            // journal write therefore never becomes evidence of a response.
            evidence.dispatch = dispatch;
            try {
              await commandStoreForId(this.deps.commands, ctx.jobId)!.flushed();
            } catch (error) {
              barrierProblem = ControlProblem.parse({
                code: "store_flush_unavailable",
                retryable: true,
                message: redactSecrets(error instanceof Error ? error.message : String(error)),
              });
              evidence = {
                ...evidence,
                dispatch: { ...dispatch, state: "not_started" },
                problem: barrierProblem,
              };
              this.update(ctx.jobId, evidence);
              throw Object.assign(new Error(barrierProblem.message), { problem: barrierProblem });
            }
            if (ctx.signal.aborted) {
              // The adapter is still waiting inside this callback: no POST occurred.
              evidence.dispatch = { ...dispatch, state: "not_started" };
              this.update(ctx.jobId, evidence);
              ctx.signal.throwIfAborted();
            }
          },
        }),
      );
      // An adapter may translate the callback rejection into its normal failed
      // response. The durable no-dispatch proof still owns this failure.
      if (barrierProblem)
        return ModelOperationReceipt.parse({
          lifecycle: "failed",
          ...evidence,
          problem: barrierProblem,
        });
      evidence.usage = result.usage;
      evidence.cost = result.cost;
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
        : result.problem?.code === "response_rejected" && result.message === null
          ? "failed"
          : result.outcome === "completed"
            ? "succeeded"
            : result.outcome === "unknown" || result.outcome === "incomplete"
              ? "interrupted"
              : "failed";
      // Freeze the negotiated shape BEFORE publication; GET must keep its digest-bound bytes.
      if (params.captureEffortEvidence !== true) delete result.effortResolution;
      const ref = this.deps.resources().publishModel(Buffer.from(JSON.stringify(result), "utf8"));
      const ready = this.now();
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
      evidence.problem = barrierProblem ?? problemFrom(error);
      if (sent && evidence.dispatch.state !== "response_received") {
        evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
      }
      return ModelOperationReceipt.parse({
        lifecycle: ctx.signal.aborted ? "cancelled" : sent ? "interrupted" : "failed",
        ...evidence,
      });
    }
  }

  inspect(id: string): ControlModelOperationDetail {
    const record = this.record(id);
    const evidence = this.evidence(record);
    const response = this.responseAt(evidence.response, this.now().getTime());
    return ControlModelOperationDetail.parse({
      id,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      ...evidence,
      response,
    });
  }

  readResult(id: string): { bytes: Buffer; sha256: string } {
    const detail = this.inspect(id);
    if (!isTerminalLifecycle(detail.state) || detail.response.state === "absent") {
      throw operationError("model_result_not_ready", "The model operation has no ready result");
    }
    if (detail.response.state !== "ready") {
      throw operationError(
        "model_result_released",
        "The model result was acknowledged or expired",
        410,
      );
    }
    return {
      bytes: this.deps.resources().readModel(detail.response.ref),
      sha256: detail.response.ref.sha256,
    };
  }

  acknowledge(id: string, sha256: string): ControlModelOperationDetail {
    const record = this.record(id);
    if (!isTerminalLifecycle(record.state))
      throw operationError("model_result_not_ready", "The operation is still running");
    const evidence = this.evidence(record);
    if (evidence.response.state === "absent")
      throw operationError("model_result_not_ready", "The operation has no result");
    const expected = evidence.response.ref.sha256;
    if (sha256 !== expected)
      throw operationError(
        "model_result_digest_mismatch",
        "Acknowledgement must name the received result digest",
      );
    if (evidence.response.state === "acknowledged" || evidence.response.state === "expired")
      return this.inspect(id);
    const ref = evidence.response.ref;
    evidence.response = this.responseAt(evidence.response, this.now().getTime());
    if (evidence.response.state === "ready") {
      evidence.response = { state: "acknowledged", ref, releasedAt: this.now().toISOString() };
    }
    this.update(id, ModelOperationReceipt.parse({ lifecycle: record.state, ...evidence }));
    this.releaseIfUnused(ref);
    this.armExpiry();
    return this.inspect(id);
  }

  async cancel(id: string, reason?: CancelReasonCode): Promise<ControlModelOperationDetail> {
    const record = this.record(id);
    if (!isTerminalLifecycle(record.state)) await this.deps.cancel(id, reason);
    return this.inspect(id);
  }

  /** Called by the existing daemon terminal boundary, queued cancellations included. */
  onCommandTerminal(record: JobRecord): void {
    const params = ModelOperationParams.safeParse(record.params);
    if (!params.success || !isTerminalLifecycle(record.state)) return;
    try {
      this.releaseIfUnused(params.data.request);
      this.armExpiry();
    } catch (error) {
      this.deps.warn?.(
        `Model payload reconciliation remains pending: ${redactSecrets(String(error))}`,
      );
    }
  }

  /** Existing maintenance invokes this after journal recovery/admission. Live
   * command refs protect bytes; operational blobs cannot recreate a terminal. */
  reconcileResources(dryRun = false): { released: string[]; errors: string[] } {
    const report = { released: [] as string[], errors: [] as string[] };
    const now = this.now().getTime();
    const queries = this.deps.resourceQueries;
    const records = queries
      ? queries.expiredResponses(new Date(now).toISOString()).map((id) => this.record(id))
      : this.records();
    const terminalRefs = new Set<string>();
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) continue;
      const params = ModelOperationParams.safeParse(record.params);
      // A malformed raw command is refused by execution; it owns no valid
      // payload ref and cannot prevent unrelated resource reconciliation.
      if (!params.success) continue;
      terminalRefs.add(params.data.request.resourceId);
      const evidence = this.evidence(record);
      const response = this.responseAt(evidence.response, now);
      if (response.state !== "absent") terminalRefs.add(response.ref.resourceId);
      if (response.state === "expired" && evidence.response.state === "ready" && !dryRun) {
        this.update(
          record.id,
          ModelOperationReceipt.parse({ lifecycle: record.state, ...evidence, response }),
        );
      }
    }
    const liveRefs = queries
      ? { has: (id: string) => queries.retainsResourceBytes(id, new Date(now).toISOString()) }
      : this.retainedResources(now, records);
    for (const ref of this.deps.resources().listModelResources()) {
      if (liveRefs.has(ref.resourceId)) continue;
      // A newly finalized input may still be on its way to create. Unbound
      // resources from before this daemon's birth are crash residue.
      const boundTerminal = queries
        ? queries.hasTerminalResourceReceipt(ref.resourceId)
        : terminalRefs.has(ref.resourceId);
      if (!boundTerminal && Date.parse(ref.createdAt) >= this.startedAt) continue;
      report.released.push(ref.resourceId);
      if (!dryRun) {
        try {
          const { createdAt: _createdAt, ...payload } = ref;
          this.releasePayload(payload, records);
        } catch (error) {
          report.errors.push(redactSecrets(String(error)));
        }
      }
    }
    if (!dryRun) this.armExpiry();
    return report;
  }

  close(): void {
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private readRequest(ref: ModelPayloadRef): ModelCallRequest {
    // Preserve resource/digest/I/O failures; they are not invalid caller JSON.
    const bytes = this.deps.resources().readModel(ref);
    let parsed: ReturnType<typeof ModelCallRequest.safeParse> | undefined;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = ModelCallRequest.safeParse(JSON.parse(text));
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        errorCode(error) !== "ERR_ENCODING_INVALID_ENCODED_DATA"
      )
        throw error;
    }
    if (!parsed?.success) {
      throw operationError(
        "model_request_invalid",
        "The uploaded model request must be valid UTF-8 JSON matching ModelCallRequest.",
        400,
      );
    }
    return parsed.data;
  }

  private records(): JobRecord[] {
    if (this.deps.resourceQueries) throw new Error("SQL model custody must use addressed queries");
    return commandStores(this.deps.commands)
      .flatMap((store) => store.records())
      .filter((record) => isModelOperation(record.params));
  }

  private record(id: string): JobRecord {
    const record = commandStoreForId(this.deps.commands, id)?.get(id);
    if (!record || !ModelOperationParams.safeParse(record.params).success) {
      throw operationError("model_operation_not_found", "No such model operation", 404);
    }
    return record;
  }

  private evidence(record: JobRecord): Evidence {
    const result =
      record.result && typeof record.result === "object"
        ? (record.result as Partial<ModelOperationReceipt>)
        : {};
    const evidence: Evidence = {
      dispatch: result.dispatch ?? emptyDispatch(),
      response: result.response ?? { state: "absent" },
      usage: result.usage ?? ModelUsage.parse({}),
      cost: result.cost ?? null,
      problem: result.problem ?? null,
    };
    if (isTerminalLifecycle(record.state) && evidence.dispatch.state === "started") {
      evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
    }
    if (!evidence.problem && record.error)
      evidence.problem = ControlProblem.parse({
        code: record.errorCode || "model_operation_interrupted",
        message: redactSecrets(record.error),
        retryable: false,
      });
    return evidence;
  }

  private update(id: string, evidence: Evidence | ModelOperationReceipt): void {
    const store = commandStoreForId(this.deps.commands, id);
    if (!store) throw operationError("model_operation_not_found", "No such model operation", 404);
    store.update(id, { result: evidence });
  }

  private responseAt(response: ModelResponseCustody, now: number): ModelResponseCustody {
    return response.state === "ready" && Date.parse(response.expiresAt) <= now
      ? { state: "expired", ref: response.ref, releasedAt: response.expiresAt }
      : response;
  }

  private retainedResources(now: number, records = this.records()): Set<string> {
    const refs = new Set<string>();
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) {
        const params = ModelOperationParams.safeParse(record.params);
        if (params.success) refs.add(params.data.request.resourceId);
      }
      const response = this.responseAt(this.evidence(record).response, now);
      if (response.state === "ready") refs.add(response.ref.resourceId);
    }
    return refs;
  }

  private releaseIfUnused(ref: ModelPayloadRef): void {
    const retained = this.deps.resourceQueries
      ? this.deps.resourceQueries.retainsResourceBytes(ref.resourceId, this.now().toISOString())
      : this.retainedResources(this.now().getTime()).has(ref.resourceId);
    if (retained) return;
    try {
      this.releasePayload(ref);
    } catch (error) {
      this.deps.warn?.(`Model payload cleanup remains pending: ${redactSecrets(String(error))}`);
    }
  }

  private releasePayload(ref: ModelPayloadRef, records?: JobRecord[]): void {
    const now = this.now().getTime();
    const responses = (
      this.deps.resourceQueries?.responsesForResource(ref.resourceId) ??
      records ??
      this.records()
    )
      .map((record) => this.responseAt(this.evidence(record).response, now))
      .filter(
        (response) => response.state !== "absent" && response.ref.resourceId === ref.resourceId,
      );
    // A recorded expiry remains the release instant after a failed cleanup or
    // restart. Shared response owners must all expire; an ACK uses ordinary release.
    const expiries = responses.flatMap((response) =>
      response.state === "expired" ? [response.releasedAt] : [],
    );
    if (expiries.length && expiries.length === responses.length) {
      const latest = expiries.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
      this.deps.resources().expireModel(ref, latest);
    } else this.deps.resources().releaseModel(ref);
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.closed) return;
    const nextSql = this.deps.resourceQueries?.nextResponseExpiry();
    const due = (
      this.deps.resourceQueries
        ? nextSql
          ? [Date.parse(nextSql)]
          : []
        : this.records()
            .map((record) => this.evidence(record).response)
            .filter(
              (response): response is Extract<ModelResponseCustody, { state: "ready" }> =>
                response.state === "ready",
            )
            .map((response) => Date.parse(response.expiresAt))
    ).filter(Number.isFinite);
    if (!due.length) return;
    const next = due.reduce((earliest, value) => Math.min(earliest, value), Infinity);
    const delay = Math.max(1, Math.min(2_147_483_647, next - this.now().getTime()));
    this.expiryTimer = setTimeout(() => {
      try {
        this.reconcileResources();
      } catch (error) {
        this.deps.warn?.(`Model payload maintenance failed: ${redactSecrets(String(error))}`);
      }
    }, delay);
    this.expiryTimer.unref?.();
  }
}
