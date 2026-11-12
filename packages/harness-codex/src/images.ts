import { createHash } from "node:crypto";
import type { ModelImageFacet } from "@claudexor/core";
import type {
  GeneratedImage,
  ImageCallOptions,
  ImageCallRequest,
  ImageCallResult,
  ImageGenerationCapability,
  ImageMime,
  ModelRoute,
} from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { ResponseFailureCapture } from "./failure-evidence.js";
import {
  prepareCodexModelAuth,
  type CodexModelAuth,
  type CodexModelAuthDeps,
} from "./model-auth.js";
import { RequestDelivery } from "./request-delivery.js";
import { CodexModelError, providerProblem, record, responseUsage, text } from "./responses.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex";
const CLIENT = "claudexor";
const MAX_REQUEST_BYTES = 144 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 144 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FAILURE_BYTES = 64 * 1024;

/**
 * Source-established wire (openai/codex@6f6e80bc, codex-rs/codex-api/src/images.rs
 * and endpoint/images.rs; ext/image-generation/src/tool.rs, backend.rs). The
 * upstream CLI's own tool pins `gpt-image-2` and refuses more than five edit
 * references; those are CLIENT facts, so they are published as a presence
 * hint and a labelled bound, never as a provider maximum or refusal list.
 * Live qualification is one generate and one edit on one managed account
 * (docs/FEATURES.md); the embedding application still runs its own narrow
 * probe before declaring the backend working.
 */
export const CODEX_IMAGE_CAPABILITY: ImageGenerationCapability = {
  models: ["gpt-image-2"],
  modelsProvenance:
    "openai/codex@6f6e80bcddab56a4e6518eb5adef0079ed30bb2b ext/image-generation/src/tool.rs IMAGE_MODEL",
  inputMimes: ["image/png", "image/jpeg", "image/webp"],
  maxInputImages: 5,
  maxInputImagesProvenance:
    "openai/codex@6f6e80bcddab56a4e6518eb5adef0079ed30bb2b ext/image-generation/src/tool.rs MAX_EDIT_IMAGES (upstream tool bound, not a proven endpoint maximum)",
  supportedOptions: ["size", "quality", "background", "n"],
};

export interface CodexImageDeps extends CodexModelAuthDeps {
  fetch?: typeof fetch;
}

function imageHeaders(auth: CodexModelAuth, turnId: string, length: number): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    "Content-Type": "application/json",
    originator: CLIENT,
    "User-Agent": `claudexor/${CLAUDEXOR_VERSION}`,
    "Content-Length": String(length),
  });
  // Header construction validates syntax before onDispatch; do not log the id or credentials.
  if (!turnId || turnId.length > 128)
    throw new CodexModelError("invalid_request", "Invalid image turn identity.");
  try {
    headers.set("x-codex-image-turn-id", turnId);
  } catch {
    throw new CodexModelError("invalid_request", "Invalid image turn identity.");
  }
  return headers;
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body)
    throw new CodexModelError("image_response_invalid", "The image response was empty.");
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new CodexModelError(
          "image_response_too_large",
          "The Codex image response exceeded its byte limit.",
        );
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Magic-byte sniff of decoded image bytes; null when the bytes are none of the accepted kinds. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Strict standard base64: a decode that would silently drop characters is a refusal. */
function decodeBase64(value: string): Buffer | null {
  if (
    !value.length ||
    value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_IMAGE_BYTES && bytes.toString("base64") === value ? bytes : null;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Caller input validation; runs before any auth work or dispatch. */
export function validateImageInputs(
  request: ImageCallRequest,
  capability: ImageGenerationCapability = CODEX_IMAGE_CAPABILITY,
): void {
  if (request.images.length > capability.maxInputImages) {
    throw new CodexModelError(
      "unsupported_parameter",
      `This source accepts at most ${capability.maxInputImages} edit reference images (${capability.maxInputImagesProvenance}).`,
      { parameter: "images", maxInputImages: capability.maxInputImages },
    );
  }
  request.images.forEach((image, index) => {
    const bytes = decodeBase64(image.dataBase64);
    if (!bytes || bytes.length === 0)
      throw new CodexModelError("invalid_request", "An edit reference image is not valid base64.", {
        parameter: `images[${index}].dataBase64`,
      });
    const sniffed = sniffImageMime(bytes);
    if (sniffed !== image.mime)
      throw new CodexModelError(
        "invalid_request",
        "An edit reference image's bytes do not match its declared MIME type.",
        { parameter: `images[${index}].mime`, declared: image.mime, sniffed },
      );
    if (digest(bytes) !== image.sha256)
      throw new CodexModelError(
        "invalid_request",
        "An edit reference image's bytes do not match its declared digest.",
        { parameter: `images[${index}].sha256` },
      );
  });
}

/** Exact upstream request shapes; only explicit options are serialized. */
export function buildImageRequest(request: ImageCallRequest): {
  path: "images/generations" | "images/edits";
  operation: "generate" | "edit";
  body: Record<string, unknown>;
} {
  const options = request.options;
  const common = {
    prompt: request.prompt,
    model: request.model,
    ...(options.background !== undefined ? { background: options.background } : {}),
    ...(options.n !== undefined ? { n: options.n } : {}),
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    ...(options.size !== undefined ? { size: options.size } : {}),
  };
  if (request.images.length === 0)
    return { path: "images/generations", operation: "generate", body: common };
  return {
    path: "images/edits",
    operation: "edit",
    body: {
      images: request.images.map((image) => ({
        image_url: `data:${image.mime};base64,${image.dataBase64}`,
      })),
      ...common,
    },
  };
}

function emptyImageResult(
  request: ImageCallRequest,
  operation: "generate" | "edit",
  route: ModelRoute,
): ImageCallResult {
  return {
    outcome: "failed",
    operation,
    requestedModel: request.model,
    images: [],
    route,
    appliedOptions: {},
    usage: responseUsage(null),
    cost: {
      knowledge: "unknown",
      billing: "unknown",
      source: "codex.images",
      provenance: ["Codex image endpoints report no incremental cash or token valuation."],
      estimatedUsd: null,
      cashUsd: null,
      valuationUsd: null,
      valuationKnowledge: "unknown",
    },
    providerRequestId: null,
    problem: null,
  };
}

function appliedImageOptions(body: Record<string, unknown>): ImageCallOptions {
  const quality = text(body.quality);
  const background = text(body.background);
  const size = text(body.size);
  return {
    ...(quality && ["low", "medium", "high", "auto"].includes(quality)
      ? { quality: quality as ImageCallOptions["quality"] }
      : {}),
    ...(background && ["transparent", "opaque", "auto"].includes(background)
      ? { background: background as ImageCallOptions["background"] }
      : {}),
    ...(size?.trim() ? { size } : {}),
  };
}

/** Provider finality precedes host conversion: retain usable siblings in order
 * and diagnose rejected items without losing reported usage or dispatch. */
export function parseImageResponse(body: unknown): {
  images: GeneratedImage[];
  appliedOptions: ImageCallOptions;
  usage: ReturnType<typeof responseUsage>;
  problem: ImageCallResult["problem"];
} {
  const response = record(body);
  if (!response || !Array.isArray(response.data))
    throw new CodexModelError("response_rejected", "Codex returned no image data array.");
  const images: GeneratedImage[] = [];
  const rejectedIndexes: number[] = [];
  response.data.forEach((item, index) => {
    const entry = record(item);
    const b64 = text(entry?.b64_json);
    const bytes = b64 ? decodeBase64(b64) : null;
    const mime = bytes && bytes.length > 0 ? sniffImageMime(bytes) : null;
    if (!entry || !b64 || !bytes || !mime) {
      rejectedIndexes.push(index);
      return;
    }
    images.push({
      mime,
      sha256: digest(bytes),
      sizeBytes: bytes.length,
      dataBase64: b64,
      generationId: text(entry.generation_id),
    });
  });
  return {
    images,
    appliedOptions: appliedImageOptions(response),
    usage: responseUsage(response.usage),
    problem:
      rejectedIndexes.length > 0
        ? new CodexModelError(
            "response_rejected",
            "Codex returned image items that are not decodable PNG, JPEG or WebP; usable items are retained.",
            { index: rejectedIndexes[0], rejectedIndexes },
          ).problem
        : images.length === 0
          ? new CodexModelError(
              "response_rejected",
              "Codex completed the image request but returned no images.",
            ).problem
          : null,
  };
}

/** One image POST per operation through the existing Codex managed-auth, header,
 * exact-body delivery and typed-problem owners. No retry, no text catalog read. */
export function createCodexImageFacet(deps: CodexImageDeps = {}): ModelImageFacet {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  return {
    capability: CODEX_IMAGE_CAPABILITY,
    async invoke(request, context) {
      const { path, operation, body } = buildImageRequest(request);
      let route: ModelRoute = {
        source: "codex",
        credentialProfileId: context.profile.profile_id,
        accountFingerprint: null,
        model: null,
      };
      let dispatched = false;
      let delivery: RequestDelivery | undefined;
      const capture = new ResponseFailureCapture(context.captureFailureEvidence);
      const withRequestId = (result: ImageCallResult, response?: Response): ImageCallResult => ({
        ...result,
        providerRequestId:
          response?.headers.get("x-codex-imagegen-request-id") ??
          response?.headers.get("x-request-id") ??
          result.providerRequestId,
      });
      try {
        if (
          request.source !== "codex" ||
          (request.account.mode === "pin" &&
            request.account.profileId !== context.profile.profile_id)
        ) {
          throw new CodexModelError(
            "invalid_request",
            "The selected profile does not match the requested Codex route.",
          );
        }
        validateImageInputs(request);
        const payload = JSON.stringify(body);
        if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES)
          throw new CodexModelError(
            "invalid_request",
            "The image request exceeded its byte limit.",
          );
        const auth = await prepareCodexModelAuth(context.profile, context.signal, deps);
        route = { ...route, accountFingerprint: auth.accountFingerprint };
        delivery = new RequestDelivery(Buffer.from(payload, "utf8"));
        const requestHeaders = imageHeaders(auth, context.imageTurnId, delivery.bytes.length);
        context.signal.throwIfAborted();
        await context.onDispatch(route);
        dispatched = true;
        const response = await fetcher(`${ENDPOINT}/${path}`, {
          method: "POST",
          headers: requestHeaders,
          ...delivery.request(),
          signal: context.signal,
          redirect: "error",
        });
        if (!response.ok) {
          const result = emptyImageResult(request, operation, route);
          let error: unknown = null;
          try {
            error = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                await boundedBody(response, MAX_FAILURE_BYTES),
              ),
            );
          } catch {
            /* HTTP status remains evidence when the bounded error body is unavailable. */
          }
          const problem = providerProblem(response.status, error, response.headers);
          // The image family has its own window. Expose the typed family so a
          // caller can tell an image_gen refusal from text quota; the caller's
          // text routing never ingests it (see cli model-services).
          const activeLimit = response.headers.get("x-codex-active-limit");
          if (activeLimit) problem.context.limitId = activeLimit;
          const limitHeader = (activeLimit ?? "image_gen").replaceAll("_", "-");
          // A provider value may be valid header content but not a header name.
          const resetAt = /^[!#$%&'*+.^`|~0-9A-Za-z-]+$/.test(limitHeader)
            ? response.headers.get(`x-${limitHeader}-primary-reset-at`)
            : null;
          const resetDate =
            resetAt && /^\d+$/.test(resetAt) ? new Date(Number(resetAt) * 1000) : null;
          if (
            resetDate &&
            Number.isFinite(resetDate.getTime()) &&
            problem.context.resetsAt === undefined
          )
            problem.context.resetsAt = resetDate.toISOString();
          if (response.status === 429) {
            problem.code = "image_generation_limit_reached";
            problem.retryable = false;
            const reset =
              typeof problem.context.resetsAt === "string" ? problem.context.resetsAt : null;
            const delay =
              typeof problem.context.retryAfterMs === "number"
                ? problem.context.retryAfterMs
                : null;
            const until = reset ?? (delay !== null ? new Date(now() + delay).toISOString() : null);
            if (until && Number.isFinite(Date.parse(until)))
              context.onQuota?.({
                subject: {
                  harness: "codex",
                  credential_route: "vendor_native",
                  subject_id: context.profile.profile_id,
                  plan_label: null,
                },
                source: "codex_image_response",
                observed_at: new Date(now()).toISOString(),
                freshness: "fresh",
                constraints: [
                  {
                    id: `${activeLimit ?? "image_gen"}:primary`,
                    label: "Image generation",
                    applies_to_request_kinds: ["image"],
                    used_ratio: null,
                    window_seconds: null,
                    resets_at: reset,
                    cooldown_until: until,
                  },
                ],
              });
          }
          result.problem =
            response.status === 401 && (auth.expiresAt === null || auth.expiresAt <= now())
              ? new CodexModelError(
                  "auth_refresh_failed",
                  "Codex refused access credentials whose freshness could not be confirmed.",
                  problem.context,
                ).problem
              : problem;
          return withRequestId(capture.finish(result), response);
        }
        capture.response(response);
        capture.stage = "read";
        const result = emptyImageResult(request, operation, route);
        result.outcome = "unknown";
        let json: unknown;
        try {
          const raw = await boundedBody(response, MAX_RESPONSE_BYTES);
          capture.receive(raw);
          capture.bodyComplete = true;
          capture.stage = "json";
          json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        } catch (error) {
          capture.caught(error);
          result.problem =
            error instanceof CodexModelError
              ? error.problem
              : new CodexModelError(
                  "transport_unknown",
                  "Codex image response body was interrupted or malformed.",
                ).problem;
          return withRequestId(capture.finish(result), response);
        }
        // A parsed 200 body is provider finality, whatever its items contain.
        result.outcome = "completed";
        result.route = { ...route, model: text(record(json)?.model)?.trim() || null };
        capture.terminalStatus = "completed";
        capture.stage = "images";
        try {
          const parsed = parseImageResponse(json);
          result.images = parsed.images;
          result.appliedOptions = parsed.appliedOptions;
          result.usage = parsed.usage;
          result.problem = parsed.problem;
        } catch (error) {
          capture.caught(error);
          result.usage = responseUsage(record(json)?.usage);
          result.problem =
            error instanceof CodexModelError
              ? error.problem
              : new CodexModelError(
                  "response_rejected",
                  "Codex returned an image response whose items could not be used.",
                ).problem;
        }
        return withRequestId(capture.finish(result), response);
      } catch (error) {
        const result = emptyImageResult(request, operation, route);
        const proof = dispatched ? delivery?.notDelivered() : null;
        result.outcome = dispatched && !proof ? "unknown" : "failed";
        result.problem = proof
          ? new CodexModelError(
              "transport_not_delivered",
              "The complete Codex image request was not delivered; generation did not start.",
              { generationStarted: false, requestDelivery: proof },
              true,
            ).problem
          : error instanceof CodexModelError
            ? error.problem
            : new CodexModelError(
                dispatched
                  ? "transport_unknown"
                  : context.signal.aborted
                    ? "cancelled"
                    : "model_unavailable",
                dispatched
                  ? "The Codex image generation outcome is unknown; it was not retried."
                  : context.signal.aborted
                    ? "The image operation was cancelled before dispatch."
                    : "The Codex image request could not be prepared.",
              ).problem;
        if (dispatched) {
          capture.caught(error);
          if (delivery && !proof && result.problem)
            result.problem.context.requestDelivery = delivery.facts();
        }
        return dispatched ? capture.finish(result) : result;
      }
    },
  };
}
