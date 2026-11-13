import type { ModelAdapter } from "@claudexor/core";
import {
  ControlModelOperationDetail,
  ControlProblem,
  ImageCallRequest,
  ModelCallRequest,
  ModelOperationParams,
  ModelOperationReceipt,
  ModelUsage,
  isTerminalLifecycle,
  type CancelReasonCode,
  type CredentialProfile,
  type ModelOperationRequestKind,
  type ModelPayloadRef,
  type ModelResponseCustody,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { commandStoreForId, type CommandAuthority } from "./command-authority.js";
import { findAcceptedCommand } from "./command-rpc.js";
import type { JobRecord, RunContext } from "./server.js";
import type { ModelResourceQueries } from "./store/command-queries.js";
import {
  emptyDispatch,
  operationError,
  readModelPayloadAsync,
  executeModelOperation,
  type Evidence,
} from "./model-operation-execution.js";

export const MODEL_OPERATION_ID = "model.operation.create";

/** Existing ResourceStore supplies these purpose-bound byte operations. */
export interface ModelPayloadStore {
  readModel(ref: ModelPayloadRef): Buffer;
  readModelAsync(ref: ModelPayloadRef): Promise<Buffer>;
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
    operationId: string,
  ): Promise<{
    adapter: ModelAdapter;
    profile: CredentialProfile;
  }>;
  /** Image selection: pin/pool admission only, no text catalog read. Absent
   * means this engine composition has no image sources. */
  resolveImage?(
    request: ImageCallRequest,
    signal: AbortSignal,
  ): Promise<{
    adapter: ModelAdapter;
    profile: CredentialProfile;
  }>;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** Addressed custody queries are part of the persistence contract. */
export interface ModelOperationPersistence {
  commands: CommandAuthority;
  resourceQueries: ModelResourceQueries;
}
export type ModelOperationDependencies = ModelOperationServices & ModelOperationPersistence;

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
    requestKind?: ModelOperationRequestKind,
    captureRoutingEvidence?: boolean,
  ): Promise<ControlModelOperationDetail> {
    if (this.closed) throw operationError("daemon_stopping", "Model operations are stopping", 503);
    if (
      requestKind !== undefined &&
      (captureFailureEvidence || captureEffortEvidence || captureRoutingEvidence)
    ) {
      // Image results carry no SSE/effort/routing evidence; refusing is honest, ignoring is not.
      throw operationError(
        "unsupported_parameter",
        "requestKind=image cannot be combined with captureFailureEvidence, captureEffortEvidence or captureRoutingEvidence",
        400,
      );
    }
    // Omission and false retain the historical command and idempotency bytes.
    const capture = {
      ...(captureFailureEvidence === true ? { captureFailureEvidence: true as const } : {}),
      ...(captureEffortEvidence === true ? { captureEffortEvidence: true as const } : {}),
      ...(captureRoutingEvidence === true ? { captureRoutingEvidence: true as const } : {}),
      ...(requestKind !== undefined ? { requestKind } : {}),
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
      // The read yields to the event loop, so a same-key call may be accepted, settle
      // and release this input meanwhile: a failed read asks the idempotency record
      // again and answers with that accepted handle. Only when none exists does the
      // failure stand, and then model_request_invalid proves no command was accepted.
      let requestedModel: string | undefined;
      try {
        requestedModel = (
          requestKind === "image"
            ? await this.readImageRequest(request)
            : await this.readRequest(request)
        ).model;
      } catch (error) {
        const accepted = findAcceptedCommand(this.deps.commands, envelope);
        if (!accepted) throw error;
        id = accepted.id;
      }
      // The bytes just validated name the model in the durable params, outside
      // idempotency identity, for a terminal whose execution never reads them (#649).
      id ??= (
        await this.deps.enqueue({ ...envelope, request: { ...envelope.request, requestedModel } })
      ).id;
    }
    // Re-uploaded copies can lose either the early lookup or the enqueue race.
    // Release only the unused copy; another live command may still own it.
    const canonical = ModelOperationParams.parse(this.record(id).params).request;
    if (canonical.resourceId !== request.resourceId) this.releaseIfUnused(request);
    return this.inspect(id);
  }

  async execute(raw: unknown, ctx: RunContext): Promise<ModelOperationReceipt> {
    return executeModelOperation(ModelOperationParams.parse(raw), ctx, this.deps, (evidence) =>
      this.update(ctx.jobId, evidence),
    );
  }

  inspect(id: string, includePreparation = false): ControlModelOperationDetail {
    const record = this.record(id);
    const evidence = this.evidence(record);
    if (!includePreparation) delete evidence.preparation;
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

  reconcileResources(dryRun = false): { released: string[]; errors: string[] } {
    const report = { released: [] as string[], errors: [] as string[] };
    const now = this.now().getTime();
    const queries = this.deps.resourceQueries;
    const records = queries
      .expiredResponses(new Date(now).toISOString())
      .map((id) => this.record(id));
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) continue;
      const params = ModelOperationParams.safeParse(record.params);
      // A malformed raw command is refused by execution; it owns no valid
      // payload ref and cannot prevent unrelated resource reconciliation.
      if (!params.success) continue;
      const evidence = this.evidence(record);
      const response = this.responseAt(evidence.response, now);
      if (response.state === "expired" && evidence.response.state === "ready" && !dryRun) {
        this.update(
          record.id,
          ModelOperationReceipt.parse({ lifecycle: record.state, ...evidence, response }),
        );
      }
    }
    const liveRefs = {
      has: (id: string) => queries.retainsResourceBytes(id, new Date(now).toISOString()),
    };
    for (const ref of this.deps.resources().listModelResources()) {
      if (liveRefs.has(ref.resourceId)) continue;
      // A newly finalized input may still be on its way to create. Unbound
      // resources from before this daemon's birth are crash residue.
      const boundTerminal = queries.hasTerminalResourceReceipt(ref.resourceId);
      if (!boundTerminal && Date.parse(ref.createdAt) >= this.startedAt) continue;
      report.released.push(ref.resourceId);
      if (!dryRun) {
        try {
          const { createdAt: _createdAt, ...payload } = ref;
          this.releasePayload(payload);
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

  private readRequest(ref: ModelPayloadRef): Promise<ModelCallRequest> {
    return readModelPayloadAsync(this.deps.resources(), ref, ModelCallRequest, "ModelCallRequest");
  }

  private readImageRequest(ref: ModelPayloadRef): Promise<ImageCallRequest> {
    if (ref.sizeBytes > 144 * 1024 * 1024)
      throw operationError("image_request_too_large", "The image request exceeds 144 MiB", 413);
    return readModelPayloadAsync(this.deps.resources(), ref, ImageCallRequest, "ImageCallRequest");
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
      ...(result.routing ? { routing: result.routing } : {}),
      ...(result.preparation ? { preparation: result.preparation } : {}),
    };
    if (isTerminalLifecycle(record.state) && evidence.dispatch.state === "started") {
      evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
    }
    // A terminal without an execution receipt (queued cancel, restart recovery)
    // names the params declaration (create's parsed bytes, or a raw enqueue's
    // unverified claim); historical params carry none, so they read as before
    // (#649).
    const params = ModelOperationParams.safeParse(record.params);
    const requestedModel = params.success ? params.data.requestedModel : undefined;
    if (!evidence.problem && record.error)
      evidence.problem = ControlProblem.parse({
        code: record.errorCode || "model_operation_interrupted",
        message: redactSecrets(record.error),
        retryable: false,
        context: requestedModel ? { requestedModel } : {},
      });
    else if (
      !evidence.problem &&
      requestedModel &&
      record.state === "cancelled" &&
      evidence.dispatch.startedAt === null &&
      evidence.response.state === "absent"
    )
      // Cancelled before any send was attempted: an honest cancellation, never a failure.
      evidence.problem = ControlProblem.parse({
        code: "model_operation_cancelled",
        message: "The model operation was cancelled before it started; nothing was sent.",
        retryable: false,
        context: { requestedModel },
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

  private releaseIfUnused(ref: ModelPayloadRef): void {
    const retained = this.deps.resourceQueries.retainsResourceBytes(
      ref.resourceId,
      this.now().toISOString(),
    );
    if (retained) return;
    try {
      this.releasePayload(ref);
    } catch (error) {
      this.deps.warn?.(`Model payload cleanup remains pending: ${redactSecrets(String(error))}`);
    }
  }

  private releasePayload(ref: ModelPayloadRef): void {
    const now = this.now().getTime();
    const responses = this.deps.resourceQueries
      .responsesForResource(ref.resourceId)
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
    const nextExpiry = this.deps.resourceQueries.nextResponseExpiry();
    const due = (nextExpiry ? [Date.parse(nextExpiry)] : []).filter(Number.isFinite);
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
