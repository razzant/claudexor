import { z } from "zod/v3";
import { CANCEL_REASON_CODES } from "./cancel-reason.js";
import { Id, IsoTimestamp, NonBlankString } from "./primitives.js";
import { ControlProblem } from "./problem.js";
import {
  ModelAccountChoice,
  ModelDispatch,
  ModelPayloadRef,
  ModelRoute,
} from "./model-operation.js";
import { RunLifecycle } from "./status-projection.js";

/** JSON POST plus up to five base64 edit inputs; shared ingress/daemon ceiling. */
export const IMAGE_REQUEST_LIMIT_BYTES = 144 * 1024 * 1024;

/** Image custody reuses the digest-bound payload-ref shape; same bytes contract, separate purpose. */
export const ImagePayloadRef = ModelPayloadRef.describe(
  "Digest-bound image-purpose resource; never an Agent attachment.",
);
export type ImagePayloadRef = ModelPayloadRef;

export const ImageEditInput = z
  .object({
    dataUrl: z
      .string()
      .max(45 * 1024 * 1024, "Edit input exceeds the 32 MiB decoded-image bound.")
      .regex(
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,
        "Edit inputs are data URLs with a sniffed png/jpeg/webp MIME.",
      ),
  })
  .strict()
  .describe("Caller-owned edit image bytes; never an Agent attachment resource.");
export type ImageEditInput = z.infer<typeof ImageEditInput>;

export const ImageCallRequest = z
  .object({
    request: z
      .object({
        model: NonBlankString,
        prompt: NonBlankString.max(32_000),
        n: z.number().int().min(1).max(10),
        quality: z.enum(["auto", "low", "medium", "high"]),
        size: NonBlankString.max(32),
        background: z.enum(["auto", "opaque", "transparent"]),
      })
      .strict(),
    images: z.array(ImageEditInput).min(1).max(5).optional(),
    account: ModelAccountChoice.optional(),
  })
  .strict()
  .describe(
    "One image generation request. The POST body is this request itself; it is persisted as an image-purpose resource and never rides the command journal.",
  );
export type ImageCallRequest = z.infer<typeof ImageCallRequest>;

export const ImageUsage = z
  .object({
    input_tokens: z.number().int().nonnegative().nullable().default(null),
    output_tokens: z.number().int().nonnegative().nullable().default(null),
  })
  .strict()
  .describe("Provider-reported counters for one image generation; missing counters remain null.");
export type ImageUsage = z.infer<typeof ImageUsage>;

export const ImageDataItem = z
  .object({
    b64_json: NonBlankString,
    generation_id: z.string().optional(),
    size: z.string().optional(),
  })
  .strict();
export type ImageDataItem = z.infer<typeof ImageDataItem>;

export const ImageCallResult = z
  .object({
    outcome: z.enum(["completed", "failed", "unknown"]),
    route: ModelRoute,
    data: z.array(ImageDataItem).nullable(),
    usage: ImageUsage.nullable(),
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "One provider image outcome. data is null unless the provider returned decodable images; base64 payloads live only in the image-purpose result resource.",
  );
export type ImageCallResult = z.infer<typeof ImageCallResult>;

/** Bare hex sha256 of one decoded image payload — the exact digest an ACK names. */
export const ImageContentDigest = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "Image digests are bare lowercase hex sha256 of the decoded image bytes.",
  );

/** Accepts the client's bare hex, or the engine's prefixed spelling; custody stores bare hex. */
export const ControlImageOperationAckRequest = z
  .object({
    sha256: z
      .string()
      .regex(
        /^(?:sha256:)?[a-f0-9]{64}$/,
        "Acknowledgement names the sha256 of one retained image (bare or sha256:-prefixed hex).",
      ),
  })
  .strict();
export type ControlImageOperationAckRequest = z.infer<typeof ControlImageOperationAckRequest>;

export const ImageResponseCustody = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z
      .object({
        state: z.literal("ready"),
        ref: ImagePayloadRef,
        readyAt: IsoTimestamp,
        expiresAt: IsoTimestamp,
        /** One digest per generated image (unique by content); release waits for all. */
        images: z.array(ImageContentDigest).min(1),
        acknowledged: z.array(ImageContentDigest),
      })
      .strict(),
    z
      .object({
        state: z.literal("acknowledged"),
        ref: ImagePayloadRef,
        images: z.array(ImageContentDigest).min(1),
        releasedAt: IsoTimestamp,
      })
      .strict(),
    z
      .object({ state: z.literal("expired"), ref: ImagePayloadRef, releasedAt: IsoTimestamp })
      .strict(),
  ])
  .describe(
    "Result GET does not acknowledge delivery. Each retained image is acknowledged by its own content digest; the response resource is released only after every image digest is acknowledged, or on expiry. Acknowledged/expired bytes never cause another generation.",
  );
export type ImageResponseCustody = z.infer<typeof ImageResponseCustody>;

export const ImageOperationParams = z
  .object({
    kind: z.literal("image"),
    request: ImagePayloadRef,
  })
  .strict();
export type ImageOperationParams = z.infer<typeof ImageOperationParams>;

/** Command-kind discrimination only; execution validates the complete params. */
export function isImageOperation(params: unknown): boolean {
  return (
    typeof params === "object" && params !== null && "kind" in params && params.kind === "image"
  );
}

export const ImageOperationReceipt = z
  .object({
    lifecycle: RunLifecycle.exclude(["queued", "running"]),
    dispatch: ModelDispatch,
    response: ImageResponseCustody,
    usage: ImageUsage,
    problem: ControlProblem.nullable(),
  })
  .strict()
  .describe(
    "Compact command-owned terminal receipt; image request/response bodies never ride journal updates.",
  );
export type ImageOperationReceipt = z.infer<typeof ImageOperationReceipt>;

export const ControlImageOperationCreateRequest = ImageCallRequest;
export type ControlImageOperationCreateRequest = ImageCallRequest;

export const ControlImageOperationControlRequest = z
  .object({
    action: z.literal("cancel"),
    reasonCode: z.enum(CANCEL_REASON_CODES).optional(),
  })
  .strict();
export type ControlImageOperationControlRequest = z.infer<
  typeof ControlImageOperationControlRequest
>;

export const ControlImageOperationDetail = z
  .object({
    id: Id,
    state: RunLifecycle,
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.nullable(),
    finishedAt: IsoTimestamp.nullable(),
    dispatch: ModelDispatch,
    response: ImageResponseCustody,
    usage: ImageUsage,
    problem: ControlProblem.nullable(),
  })
  .strict();
export type ControlImageOperationDetail = z.infer<typeof ControlImageOperationDetail>;
