import {
  ControlImageOperationDetail,
  ControlProblem,
  ImageCallRequest,
  ImageCallResult,
  IMAGE_REQUEST_LIMIT_BYTES,
  ImageOperationParams,
  ImageOperationReceipt,
  ImageUsage,
  isImageOperation,
  isTerminalLifecycle,
  type CancelReasonCode,
  type CredentialProfile,
  type ImagePayloadRef,
  type ImageResponseCustody,
  type ModelDispatch,
} from "@claudexor/schema";
import { errorCode, redactSecrets } from "@claudexor/util";
import { commandStoreForId, commandStores, type CommandAuthority } from "./command-authority.js";
import { findAcceptedCommand } from "./command-rpc.js";
import type { ResourceStore } from "./resource-store.js";
import type { JobRecord, RunContext } from "./server.js";
import { createHash } from "node:crypto";

export const IMAGE_OPERATION_ID = "image.operation.create";
const RESPONSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ImageOperationDependencies {
  commands: CommandAuthority;
  /** Existing ResourceStore supplies purpose-bound image byte custody. */
  resources: () => Pick<
    ResourceStore,
    "readImage" | "publishImage" | "releaseImage" | "listImageResources"
  >;
  enqueue(envelope: {
    request: ImageOperationParams;
    operation: string;
    idempotencyKey: string;
    clientId: string;
    idempotencyRequest: unknown;
  }): Promise<{ id: string }>;
  cancel(id: string, reason?: CancelReasonCode): Promise<unknown>;
  resolve(
    request: ImageCallRequest,
    signal: AbortSignal,
  ): Promise<{
    profile: CredentialProfile;
    invoke(
      request: ImageCallRequest,
      context: {
        profile: CredentialProfile;
        signal: AbortSignal;
        onDispatch: (route: ImageDispatchRoute) => Promise<void>;
        imageTurnId: string;
      },
    ): Promise<ImageCallResult>;
  }>;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** Route evidence at dispatch; shape mirrors the adapter's onDispatch payload. */
export type ImageDispatchRoute = {
  source: string;
  credentialProfileId: string;
  accountFingerprint: string | null;
  model: string | null;
};

type Evidence = Omit<ImageOperationReceipt, "lifecycle">;

const emptyDispatch = (): ModelDispatch => ({ state: "not_started", startedAt: null, route: null });
const emptyUsage = (): ImageUsage => ImageUsage.parse({ input_tokens: null, output_tokens: null });
const emptyEvidence = (): Evidence => ({
  dispatch: emptyDispatch(),
  response: { state: "absent" },
  usage: emptyUsage(),
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
    code: errorCode(error) || "image_operation_failed",
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
    retryable: candidate.retryable === true,
    context,
  });
}

/** Bare-hex sha256 digests of the DECODED image payloads, unique by content. */
function imageDigests(result: ImageCallResult): string[] {
  if (!result.data) return [];
  const digests = new Set<string>();
  for (const item of result.data) {
    const bytes = Buffer.from(item.b64_json, "base64");
    digests.add(createHash("sha256").update(bytes).digest("hex"));
  }
  return [...digests];
}

/** An image operation reuses daemon queue/cancel/command authority exactly like
 * a model operation: one physical generation, journal-owned lifecycle, and
 * per-image digest custody. No scheduler or retry of its own (INV-014). */
export class ImageOperations {
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly startedAt: number;

  constructor(private readonly deps: ImageOperationDependencies) {
    this.startedAt = this.now().getTime();
  }

  /** The POST body IS the request. Only its compact ref reaches the journal. */
  async create(
    request: ImageCallRequest,
    idempotencyKey: string,
  ): Promise<ControlImageOperationDetail> {
    if (this.closed) throw operationError("daemon_stopping", "Image operations are stopping", 503);
    const parsed = ImageCallRequest.parse(request);
    const payload = Buffer.from(JSON.stringify(parsed), "utf8");
    if (payload.length > IMAGE_REQUEST_LIMIT_BYTES)
      throw operationError("image_request_too_large", "The image request exceeds 144 MiB", 413);
    const ref = this.deps.resources().publishImage(payload);
    const envelope = {
      request: ImageOperationParams.parse({ kind: "image", request: ref }),
      operation: IMAGE_OPERATION_ID,
      idempotencyKey,
      clientId: "control-api",
      // Identical request bytes are the same idempotent request.
      idempotencyRequest: { kind: "image", sha256: ref.sha256, sizeBytes: ref.sizeBytes },
    };
    try {
      const replay = findAcceptedCommand(this.deps.commands, envelope);
      const id = replay?.id ?? (await this.deps.enqueue(envelope)).id;
      // Re-published identical bytes do not become an accepted command's input.
      const canonical = ImageOperationParams.parse(this.record(id).params).request;
      if (canonical.resourceId !== ref.resourceId) this.releaseIfUnused(ref);
      return this.inspect(id);
    } catch (error) {
      // An idempotency conflict or failed admission leaves no new owner for
      // this upload. If an ACK was lost after acceptance, live refs protect it.
      this.releaseIfUnused(ref);
      throw error;
    }
  }

  async execute(raw: unknown, ctx: RunContext): Promise<ImageOperationReceipt> {
    const params = ImageOperationParams.parse(raw);
    let evidence = emptyEvidence();
    try {
      const request = this.readRequest(params.request);
      ctx.signal.throwIfAborted();
      const { profile, invoke } = await this.deps.resolve(request, ctx.signal);
      ctx.signal.throwIfAborted();
      const result = ImageCallResult.parse(
        await invoke(request, {
          profile,
          signal: ctx.signal,
          imageTurnId: `img-${ctx.jobId}`,
          onDispatch: async (route) => {
            ctx.signal.throwIfAborted();
            if (evidence.dispatch.state !== "not_started") {
              throw operationError(
                "duplicate_image_dispatch",
                "An image operation may send generation only once",
              );
            }
            const dispatch: ModelDispatch = {
              state: "started",
              startedAt: this.now().toISOString(),
              route,
            };
            this.update(ctx.jobId, { ...evidence, dispatch });
            // The adapter cannot POST until this callback returns; a rejected
            // journal write never becomes evidence of a response.
            evidence.dispatch = dispatch;
          },
        }),
      );
      evidence.usage = result.usage ?? emptyUsage();
      evidence.problem = result.problem;
      if (evidence.dispatch.state === "started") {
        evidence.dispatch = {
          ...evidence.dispatch,
          state: result.outcome === "unknown" ? "unknown" : "response_received",
          route: result.route,
        };
      }
      const lifecycle = ctx.signal.aborted
        ? "cancelled"
        : result.outcome === "completed"
          ? "succeeded"
          : result.outcome === "unknown"
            ? "interrupted"
            : "failed";
      // Custody exists only when decodable images came back. A failed or
      // unknown outcome retains its compact receipt; there is nothing to ACK.
      const digests = imageDigests(result);
      if (digests.length > 0) {
        const ref = this.deps.resources().publishImage(Buffer.from(JSON.stringify(result), "utf8"));
        const ready = this.now();
        evidence.response = {
          state: "ready",
          ref,
          readyAt: ready.toISOString(),
          expiresAt: new Date(ready.getTime() + RESPONSE_RETENTION_MS).toISOString(),
          images: digests,
          acknowledged: [],
        };
      }
      return ImageOperationReceipt.parse({ lifecycle, ...evidence });
    } catch (error) {
      const sent = evidence.dispatch.state !== "not_started";
      evidence.problem = problemFrom(error);
      if (sent && evidence.dispatch.state !== "response_received") {
        evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
      }
      return ImageOperationReceipt.parse({
        lifecycle: ctx.signal.aborted ? "cancelled" : sent ? "interrupted" : "failed",
        ...evidence,
      });
    }
  }

  inspect(id: string): ControlImageOperationDetail {
    const record = this.record(id);
    const evidence = this.evidence(record);
    const response = this.responseAt(evidence.response, this.now().getTime());
    return ControlImageOperationDetail.parse({
      id,
      state: record.state,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      ...evidence,
      response,
    });
  }

  /** Full private result envelope while custody is ready. A fully
   * acknowledged or expired result is gone: repeat reads never regenerate. */
  readResult(id: string): { bytes: Buffer; sha256: string } {
    const detail = this.inspect(id);
    if (!isTerminalLifecycle(detail.state) || detail.response.state === "absent") {
      throw operationError("image_result_not_ready", "The image operation has no ready result");
    }
    if (detail.response.state !== "ready") {
      throw operationError(
        "image_result_released",
        "The image result was fully acknowledged or expired",
        410,
      );
    }
    return {
      bytes: this.deps.resources().readImage(detail.response.ref),
      sha256: detail.response.ref.sha256,
    };
  }

  /** One image at a time; the response resource is released only after every
   * retained image digest has been acknowledged (INV-064 image form). */
  acknowledge(id: string, sha256: string): ControlImageOperationDetail {
    const record = this.record(id);
    if (!isTerminalLifecycle(record.state))
      throw operationError("image_result_not_ready", "The operation is still running");
    const evidence = this.evidence(record);
    const digest = sha256.replace(/^sha256:/, "");
    if (evidence.response.state === "acknowledged") {
      if (!evidence.response.images.includes(digest))
        throw operationError(
          "image_result_digest_mismatch",
          "Acknowledgement names an unknown image",
        );
      return this.inspect(id);
    }
    evidence.response = this.responseAt(evidence.response, this.now().getTime());
    if (evidence.response.state !== "ready")
      throw operationError(
        evidence.response.state === "absent" ? "image_result_not_ready" : "image_result_released",
        evidence.response.state === "absent"
          ? "The image operation has no result"
          : "The image result was fully acknowledged or expired",
        evidence.response.state === "absent" ? 409 : 410,
      );
    if (!evidence.response.images.includes(digest)) {
      throw operationError(
        "image_result_digest_mismatch",
        "Acknowledgement must name the sha256 of one retained image",
      );
    }
    if (!evidence.response.acknowledged.includes(digest)) {
      const acknowledged = [...evidence.response.acknowledged, digest];
      if (evidence.response.images.every((image) => acknowledged.includes(image))) {
        const ref = evidence.response.ref;
        evidence.response = {
          state: "acknowledged",
          ref,
          images: evidence.response.images,
          releasedAt: this.now().toISOString(),
        };
        this.update(id, ImageOperationReceipt.parse({ lifecycle: record.state, ...evidence }));
        this.releaseIfUnused(ref);
        this.armExpiry();
        return this.inspect(id);
      }
      evidence.response = { ...evidence.response, acknowledged };
      this.update(id, ImageOperationReceipt.parse({ lifecycle: record.state, ...evidence }));
    }
    return this.inspect(id);
  }

  async cancel(id: string, reason?: CancelReasonCode): Promise<ControlImageOperationDetail> {
    const record = this.record(id);
    if (!isTerminalLifecycle(record.state)) await this.deps.cancel(id, reason);
    return this.inspect(id);
  }

  /** Called by the daemon terminal boundary, queued cancellations included. */
  onCommandTerminal(record: JobRecord): void {
    if (!isImageOperation(record.params) || !isTerminalLifecycle(record.state)) return;
    try {
      this.releaseIfUnused(ImageOperationParams.parse(record.params).request);
      this.armExpiry();
    } catch (error) {
      this.deps.warn?.(
        `Image payload reconciliation remains pending: ${redactSecrets(String(error))}`,
      );
    }
  }

  /** Image-purpose GC only: it never lists or releases model-purpose bytes,
   * and model GC never lists image bytes (separate custody domains). */
  reconcileResources(dryRun = false): { released: string[]; errors: string[] } {
    const report = { released: [] as string[], errors: [] as string[] };
    const now = this.now().getTime();
    const records = this.records();
    const terminalRefs = new Set<string>();
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) continue;
      const params = ImageOperationParams.safeParse(record.params);
      if (!params.success) continue;
      terminalRefs.add(params.data.request.resourceId);
      const response = this.responseAt(this.evidence(record).response, now);
      if (response.state !== "absent") terminalRefs.add(response.ref.resourceId);
      if (response.state === "expired" && !dryRun) {
        const evidence = this.evidence(record);
        if (evidence.response.state === "ready") {
          this.update(
            record.id,
            ImageOperationReceipt.parse({
              lifecycle: record.state,
              ...evidence,
              response,
            }),
          );
        }
      }
    }
    const liveRefs = this.retainedResources(now, records);
    for (const ref of this.deps.resources().listImageResources()) {
      if (liveRefs.has(ref.resourceId)) continue;
      const boundTerminal = terminalRefs.has(ref.resourceId);
      if (!boundTerminal && Date.parse(ref.createdAt) >= this.startedAt) continue;
      report.released.push(ref.resourceId);
      if (!dryRun) {
        try {
          const { createdAt: _createdAt, ...payload } = ref;
          this.deps.resources().releaseImage(payload);
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

  private readRequest(ref: ImagePayloadRef): ImageCallRequest {
    const bytes = this.deps.resources().readImage(ref);
    let parsed: ReturnType<typeof ImageCallRequest.safeParse> | undefined;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = ImageCallRequest.safeParse(JSON.parse(text));
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        errorCode(error) !== "ERR_ENCODING_INVALID_ENCODED_DATA"
      )
        throw error;
    }
    if (!parsed?.success) {
      throw operationError(
        "image_request_invalid",
        "The stored image request must be valid UTF-8 JSON matching ImageCallRequest.",
        400,
      );
    }
    return parsed.data;
  }

  private records(): JobRecord[] {
    return commandStores(this.deps.commands)
      .flatMap((store) => store.records())
      .filter((record) => isImageOperation(record.params));
  }

  private record(id: string): JobRecord {
    const record = commandStoreForId(this.deps.commands, id)?.get(id);
    if (!record || !ImageOperationParams.safeParse(record.params).success) {
      throw operationError("image_operation_not_found", "No such image operation", 404);
    }
    return record;
  }

  private evidence(record: JobRecord): Evidence {
    const result =
      record.result && typeof record.result === "object"
        ? (record.result as Partial<ImageOperationReceipt>)
        : {};
    const evidence: Evidence = {
      dispatch: result.dispatch ?? emptyDispatch(),
      response: result.response ?? { state: "absent" },
      usage: result.usage ?? emptyUsage(),
      problem: result.problem ?? null,
    };
    if (isTerminalLifecycle(record.state) && evidence.dispatch.state === "started") {
      evidence.dispatch = { ...evidence.dispatch, state: "unknown" };
    }
    if (!evidence.problem && record.error)
      evidence.problem = ControlProblem.parse({
        code: record.errorCode || "image_operation_interrupted",
        message: redactSecrets(record.error),
        retryable: false,
      });
    return evidence;
  }

  private update(id: string, evidence: Evidence | ImageOperationReceipt): void {
    const store = commandStoreForId(this.deps.commands, id);
    if (!store) throw operationError("image_operation_not_found", "No such image operation", 404);
    store.update(id, { result: evidence });
  }

  private responseAt(response: ImageResponseCustody, now: number): ImageResponseCustody {
    return response.state === "ready" && Date.parse(response.expiresAt) <= now
      ? { state: "expired", ref: response.ref, releasedAt: response.expiresAt }
      : response;
  }

  private retainedResources(now: number, records = this.records()): Set<string> {
    const refs = new Set<string>();
    for (const record of records) {
      if (!isTerminalLifecycle(record.state)) {
        const params = ImageOperationParams.safeParse(record.params);
        if (params.success) refs.add(params.data.request.resourceId);
      }
      const response = this.responseAt(this.evidence(record).response, now);
      if (response.state === "ready") refs.add(response.ref.resourceId);
    }
    return refs;
  }

  private releaseIfUnused(ref: ImagePayloadRef): void {
    if (this.retainedResources(this.now().getTime()).has(ref.resourceId)) return;
    try {
      this.deps.resources().releaseImage(ref);
    } catch (error) {
      this.deps.warn?.(`Image payload cleanup remains pending: ${redactSecrets(String(error))}`);
    }
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.closed) return;
    const due = this.records()
      .map((record) => this.evidence(record).response)
      .filter(
        (response): response is Extract<ImageResponseCustody, { state: "ready" }> =>
          response.state === "ready",
      )
      .map((response) => Date.parse(response.expiresAt))
      .filter(Number.isFinite);
    if (!due.length) return;
    const next = due.reduce((earliest, value) => Math.min(earliest, value), Infinity);
    const delay = Math.max(1, Math.min(2_147_483_647, next - this.now().getTime()));
    this.expiryTimer = setTimeout(() => {
      try {
        this.reconcileResources();
      } catch (error) {
        this.deps.warn?.(`Image payload maintenance failed: ${redactSecrets(String(error))}`);
      }
    }, delay);
    this.expiryTimer.unref?.();
  }
}
