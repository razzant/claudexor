import type { ControlProblem, CredentialProfile, ModelRoute } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  prepareCodexModelAuth,
  type CodexModelAuth,
  type CodexModelAuthDeps,
} from "./model-auth.js";
import { CodexModelError, providerProblem, record, text } from "./responses.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/images";
const MAX_REQUEST_BYTES = 144 * 1024 * 1024;
// Ten ordinary images can exceed 64 MiB encoded; bound the complete JSON body
// separately from each 32 MiB decoded image (matching the prototype's 144 MiB ceiling).
const MAX_RESPONSE_BYTES = 144 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FAILURE_BYTES = 64 * 1024;

/** Input is schema-validated by the engine; the adapter translates it to Codex's wire shape. */
export interface CodexImageRequest {
  request: {
    model: string;
    prompt: string;
    n: number;
    quality: "auto" | "low" | "medium" | "high";
    size: string;
    background: "auto" | "opaque" | "transparent";
  };
  images?: Array<{ dataUrl: string }>;
}

export interface CodexImageResponse {
  data: Array<{ b64_json: string; generation_id?: string; size?: string }>;
  usage: { input_tokens: number | null; output_tokens: number | null } | null;
}

export interface CodexImageResult {
  outcome: "completed" | "failed" | "unknown";
  /** The engine owns dispatch and result custody; this is adapter evidence, not a retry instruction. */
  dispatch: "not_started" | "response_received" | "unknown";
  route: ModelRoute;
  response: CodexImageResponse | null;
  problem: ControlProblem | null;
}

export interface CodexImageContext {
  profile: CredentialProfile;
  signal: AbortSignal;
  /** Durable dispatch callback must complete before the sole generation POST. */
  onDispatch: (route: ModelRoute) => Promise<void>;
  /** The engine's stable identity for this image operation, never reminted on rejoin. */
  imageTurnId: string;
}

export interface CodexImageDeps extends CodexModelAuthDeps {
  fetch?: typeof fetch;
}

function imageHeaders(auth: CodexModelAuth, turnId: string, length: number): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    "Content-Type": "application/json",
    originator: "claudexor",
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

function mimeOf(data: Buffer): string | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

function imageBytes(base64: string, code = "image_response_invalid"): Buffer {
  if (
    !base64.length ||
    base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new CodexModelError(code, "An image has invalid or oversized bytes.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || !mimeOf(bytes))
    throw new CodexModelError(code, "An image has an unsupported format or size.");
  return bytes;
}

function responsePayload(raw: unknown): CodexImageResponse {
  const body = record(raw);
  const entries = body?.data;
  if (!Array.isArray(entries) || entries.length < 1)
    throw new CodexModelError("image_response_invalid", "Codex returned an invalid image list.");
  const data = entries.map((item: unknown) => {
    const row = record(item);
    const base64 = text(row?.b64_json);
    if (!base64)
      throw new CodexModelError("image_response_invalid", "Codex returned an image without bytes.");
    imageBytes(base64);
    return {
      b64_json: base64,
      ...(text(row?.generation_id) ? { generation_id: row!.generation_id as string } : {}),
      ...(text(row?.size) ? { size: row!.size as string } : {}),
    };
  });
  const usage = record(body?.usage);
  const counter = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    data,
    usage: usage
      ? { input_tokens: counter(usage.input_tokens), output_tokens: counter(usage.output_tokens) }
      : null,
  };
}

function requestBody(input: CodexImageRequest): string {
  const { request, images } = input;
  if (images && (images.length < 1 || images.length > 5))
    throw new CodexModelError("invalid_request", "Image edits require one to five input images.");
  const edited = images?.map(({ dataUrl }) => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match || mimeOf(imageBytes(match[2], "invalid_request")) !== match[1])
      throw new CodexModelError(
        "invalid_request",
        "An image edit input has invalid bytes or MIME.",
      );
    return { image_url: dataUrl };
  });
  const body = JSON.stringify({ ...request, ...(edited ? { images: edited } : {}) });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
    throw new CodexModelError("invalid_request", "The image request exceeded its byte limit.");
  return body;
}

/** One provider generation. Authentication refresh may precede it; it never retries this POST. */
export async function invokeCodexImage(
  input: CodexImageRequest,
  context: CodexImageContext,
  deps: CodexImageDeps = {},
): Promise<CodexImageResult> {
  let route: ModelRoute = {
    source: "codex",
    credentialProfileId: context.profile.profile_id,
    accountFingerprint: null,
    model: input.request.model,
  };
  let dispatched = false;
  let responded = false;
  try {
    context.signal.throwIfAborted();
    const body = requestBody(input);
    const auth = await prepareCodexModelAuth(context.profile, context.signal, deps);
    route = { ...route, accountFingerprint: auth.accountFingerprint };
    const headers = imageHeaders(auth, context.imageTurnId, Buffer.byteLength(body));
    context.signal.throwIfAborted();
    await context.onDispatch(route);
    dispatched = true;
    const response = await (deps.fetch ?? globalThis.fetch)(
      `${ENDPOINT}/${input.images ? "edits" : "generations"}`,
      { method: "POST", body, headers, signal: context.signal, redirect: "error" },
    );
    responded = true;
    if (!response.ok) {
      let raw: unknown = null;
      try {
        raw = JSON.parse((await boundedBody(response, MAX_FAILURE_BYTES)).toString("utf8"));
      } catch {
        // Status remains authoritative even when its body cannot be read.
      }
      const upstream = providerProblem(response.status, raw, response.headers);
      const problem: ControlProblem =
        response.status === 429
          ? {
              ...upstream,
              code: "image_generation_limit_reached",
              retryable: false,
              message:
                "Codex image generation is rate-limited; text account availability is unchanged.",
            }
          : response.status === 401 &&
              (auth.expiresAt === null || auth.expiresAt <= (deps.now ?? Date.now)())
            ? {
                ...upstream,
                code: "auth_refresh_failed",
                retryable: false,
                message: "Codex refused access credentials whose freshness could not be confirmed.",
              }
            : upstream;
      return { outcome: "failed", dispatch: "response_received", route, response: null, problem };
    }
    const bytes = await boundedBody(response, MAX_RESPONSE_BYTES);
    let payload: CodexImageResponse;
    try {
      payload = responsePayload(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof CodexModelError) throw error;
      throw new CodexModelError(
        "image_response_invalid",
        "Codex returned an invalid image response.",
      );
    }
    return {
      outcome: "completed",
      dispatch: "response_received",
      route,
      response: payload,
      problem: null,
    };
  } catch (error) {
    // A body reader may fail after headers arrived. Headers prove an HTTP
    // response existed, not that its image bytes were received or usable.
    const unknownAfterDispatch = dispatched && !(error instanceof CodexModelError);
    const problem =
      error instanceof CodexModelError
        ? error.problem
        : new CodexModelError(
            unknownAfterDispatch
              ? "image_outcome_unknown"
              : context.signal.aborted
                ? "cancelled"
                : "image_unavailable",
            unknownAfterDispatch
              ? "The Codex image generation outcome is unknown; it was not retried."
              : context.signal.aborted
                ? "The image operation was cancelled before dispatch."
                : "The Codex image request could not be prepared.",
          ).problem;
    // A received HTTP response is provider evidence even when its body is rejected.
    // A transport exception after onDispatch cannot claim the request never arrived.
    const outcome = unknownAfterDispatch ? "unknown" : "failed";
    return {
      outcome,
      dispatch: responded ? "response_received" : dispatched ? "unknown" : "not_started",
      route,
      response: null,
      problem,
    };
  }
}
