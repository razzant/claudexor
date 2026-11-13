import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { CredentialProfile, ImageCallRequest, ImageCallResult } from "@claudexor/schema";
import {
  CODEX_IMAGE_CAPABILITY,
  buildImageRequest,
  createCodexImageFacet,
  parseImageResponse,
  sniffImageMime,
  validateImageInputs,
} from "./images.js";

// Smallest real PNG header + IHDR prefix; enough for a magic-byte sniff.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]);
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const input = (bytes = PNG, mime: ImageCallRequest["images"][number]["mime"] = "image/png") => ({
  mime,
  sha256: sha(bytes),
  dataBase64: bytes.toString("base64"),
});

/** The upstream recorded response fixture (codex-api endpoint/images.rs tests). */
const upstreamResponse = (data: unknown[] = [{ b64_json: PNG.toString("base64") }]) => ({
  created: 1778832973,
  background: "opaque",
  data,
  output_format: "png",
  quality: "medium",
  size: "1024x1536",
  usage: {
    input_tokens: 1474,
    input_tokens_details: { image_tokens: 1457, text_tokens: 17 },
    output_tokens: 1372,
    output_tokens_details: { image_tokens: 1372, text_tokens: 0 },
    total_tokens: 2846,
  },
});

function request(overrides: Partial<ImageCallRequest> = {}): ImageCallRequest {
  return ImageCallRequest.parse({
    source: "codex",
    model: "gpt-image-1.5",
    account: { mode: "pin", profileId: "work" },
    prompt: "a red fox in a field",
    ...overrides,
  });
}

function setup(
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const profile = CredentialProfile.parse({
    profile_id: "work",
    harness_id: "codex",
    display_name: "Work",
    credential_kind: "config_dir_login",
    isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "work"),
  });
  const onDispatch = vi.fn(async () => {});
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`;
  const readAuthFile = vi.fn(async () =>
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "account-one",
        access_token: token,
        id_token: `fixture.${Buffer.from('{"sub":"user-one"}').toString("base64url")}.signature`,
      },
    }),
  );
  const posts: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe("POST");
    expect(onDispatch).toHaveBeenCalledTimes(1);
    posts.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: await new Response(init?.body).text(),
    });
    return respond(String(url), init);
  });
  const facet = createCodexImageFacet({
    fetch: fetcher,
    readAuthFile,
    now: () => 1900000000000,
  });
  return {
    facet,
    fetcher,
    onDispatch,
    posts,
    context: {
      profile,
      onDispatch,
      signal: new AbortController().signal,
      imageTurnId: "turn-fixture",
    },
  };
}

describe("codex image wire", () => {
  it("sniffs the three accepted formats and nothing else", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  it("serializes exactly the upstream generation request with only explicit options", () => {
    expect(
      buildImageRequest(
        request({ options: { background: "opaque", quality: "medium", size: "1024x1536" } }),
      ),
    ).toEqual({
      path: "images/generations",
      operation: "generate",
      body: {
        prompt: "a red fox in a field",
        model: "gpt-image-1.5",
        background: "opaque",
        quality: "medium",
        size: "1024x1536",
      },
    });
    // No engine defaults: an empty options object sends no size/quality/background/n.
    expect(buildImageRequest(request()).body).toEqual({
      prompt: "a red fox in a field",
      model: "gpt-image-1.5",
    });
    // n is an optional upstream field; one POST still means one dispatch.
    expect(buildImageRequest(request({ options: { n: 2 } })).body).toMatchObject({ n: 2 });
  });

  it("serializes the upstream edit request with caller bytes verbatim as data URLs", () => {
    const first = input();
    const second = input(JPEG, "image/jpeg");
    const built = buildImageRequest(request({ prompt: "add a red hat", images: [first, second] }));
    expect(built).toEqual({
      path: "images/edits",
      operation: "edit",
      body: {
        images: [
          { image_url: `data:image/png;base64,${first.dataBase64}` },
          { image_url: `data:image/jpeg;base64,${second.dataBase64}` },
        ],
        prompt: "add a red hat",
        model: "gpt-image-1.5",
      },
    });
  });

  it("refuses bad base64, mime/magic disagreement, digest mismatch and too many references before dispatch", () => {
    const bad = (images: unknown[]) => () =>
      validateImageInputs(request({ images: images as ImageCallRequest["images"] }));
    expect(bad([{ ...input(), dataBase64: "@@@@" }])).toThrow(/not valid base64/);
    expect(bad([{ ...input(), mime: "image/jpeg" }])).toThrow(/do not match its declared MIME/);
    expect(bad([{ ...input(), sha256: sha(JPEG) }])).toThrow(/declared digest/);
    const six = Array.from({ length: CODEX_IMAGE_CAPABILITY.maxInputImages + 1 }, () => input());
    expect(bad(six)).toThrow(/at most 5 edit reference images/);
    expect(() => validateImageInputs(request({ images: [input()] }))).not.toThrow();
  });

  it("retains every returned item with sniffed mime, digest and generation ids", () => {
    const parsed = parseImageResponse(
      upstreamResponse([
        { b64_json: PNG.toString("base64"), generation_id: "gen-first" },
        { b64_json: JPEG.toString("base64"), generation_id: "gen-second" },
        { b64_json: WEBP.toString("base64") },
      ]),
    );
    expect(parsed.images.map((image) => [image.mime, image.generationId, image.sizeBytes])).toEqual(
      [
        ["image/png", "gen-first", PNG.length],
        ["image/jpeg", "gen-second", JPEG.length],
        ["image/webp", null, WEBP.length],
      ],
    );
    expect(parsed.images[0]!.sha256).toBe(sha(PNG));
    expect(parsed.appliedOptions).toEqual({
      background: "opaque",
      quality: "medium",
      size: "1024x1536",
    });
    expect(parsed.usage).toMatchObject({ input_tokens: 1474, output_tokens: 1372 });
    expect(() => parseImageResponse({ created: 1 })).toThrow(/no image data array/);
    expect(parseImageResponse(upstreamResponse([{ b64_json: "R0lGODlh" }]))).toMatchObject({
      images: [],
      problem: { code: "response_rejected", context: { rejectedIndexes: [0] } },
    });
  });
});

describe("codex image facet over the real adapter path", () => {
  it("POSTs once to images/generations with the model headers and completes with all items", async () => {
    const f = setup(() => {
      const response = Response.json(upstreamResponse());
      response.headers.set("x-codex-imagegen-request-id", "req-imagegen-123");
      response.headers.set("x-request-id", "req-outer-456");
      return response;
    });
    const result = ImageCallResult.parse(
      await f.facet.invoke(request({ options: { quality: "medium" } }), f.context),
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.posts[0]!.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(f.posts[0]!.headers.get("authorization")).toMatch(/^Bearer fixture\./);
    expect(f.posts[0]!.headers.get("chatgpt-account-id")).toBe("account-one");
    expect(f.posts[0]!.headers.get("x-codex-image-turn-id")).toBe("turn-fixture");
    // The image request is not compressed; only the inference body is.
    expect(f.posts[0]!.headers.has("content-encoding")).toBe(false);
    expect(f.posts[0]!.headers.get("content-length")).toBe(
      String(Buffer.byteLength(f.posts[0]!.body)),
    );
    expect(JSON.parse(f.posts[0]!.body)).toEqual({
      prompt: "a red fox in a field",
      model: "gpt-image-1.5",
      quality: "medium",
    });
    expect(result).toMatchObject({
      outcome: "completed",
      operation: "generate",
      requestedModel: "gpt-image-1.5",
      route: { source: "codex", credentialProfileId: "work", model: null },
      providerRequestId: "req-imagegen-123",
      problem: null,
      usage: { input_tokens: 1474, output_tokens: 1372 },
      cost: { knowledge: "unknown", cashUsd: null, source: "codex.images" },
    });
    expect(result.route.accountFingerprint).toEqual(expect.any(String));
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.dataBase64).toBe(PNG.toString("base64"));
  });

  it("maps an edit to images/edits with the caller's exact base64", async () => {
    const reference = input();
    const f = setup(() => Response.json(upstreamResponse()));
    const result = await f.facet.invoke(
      request({ prompt: "add a red hat", images: [reference] }),
      f.context,
    );
    expect(f.posts[0]!.url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(f.posts[0]!.body).images).toEqual([
      { image_url: `data:image/png;base64,${reference.dataBase64}` },
    ]);
    expect(result.operation).toBe("edit");
    expect(result.outcome).toBe("completed");
  });

  it("refuses invalid references before auth or dispatch", async () => {
    const f = setup(() => Response.json(upstreamResponse()));
    const result = await f.facet.invoke(
      request({ images: [{ ...input(), sha256: sha(JPEG) }] }),
      f.context,
    );
    expect(result).toMatchObject({ outcome: "failed", problem: { code: "invalid_request" } });
    expect(f.onDispatch).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("keeps a completed empty or unusable response as provider finality with response_rejected", async () => {
    const empty = setup(() => Response.json(upstreamResponse([])));
    const none = await empty.facet.invoke(request(), empty.context);
    expect(none).toMatchObject({
      outcome: "completed",
      images: [],
      usage: { input_tokens: 1474 },
      problem: { code: "response_rejected" },
    });
    const garbage = setup(() => Response.json(upstreamResponse([{ b64_json: "R0lGODlh" }])));
    const bad = await garbage.facet.invoke(request(), garbage.context);
    expect(bad).toMatchObject({
      outcome: "completed",
      images: [],
      usage: { input_tokens: 1474 },
      problem: { code: "response_rejected", context: { index: 0 } },
    });
  });

  it("types an image_gen window refusal with its family and reset without touching text quota", async () => {
    const f = setup(() => {
      const response = Response.json(
        { error: { type: "usage_limit_reached", resets_at: 1900003600, plan_type: "plus" } },
        { status: 429 },
      );
      response.headers.set("x-codex-active-limit", "image_gen");
      response.headers.set("x-image-gen-primary-used-percent", "100");
      response.headers.set("x-image-gen-primary-window-minutes", "1440");
      response.headers.set("x-image-gen-primary-reset-at", "1900003600");
      return response;
    });
    const result = await f.facet.invoke(request(), f.context);
    expect(result).toMatchObject({
      outcome: "failed",
      images: [],
      problem: {
        code: "image_generation_limit_reached",
        context: {
          httpStatus: 429,
          vendorCode: "usage_limit_reached",
          limitId: "image_gen",
          resetsAt: new Date(1900003600 * 1000).toISOString(),
        },
      },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["1900003600", "9".repeat(400)])(
    "reads image-family reset headers without inventing malformed dates (%s)",
    async (reset) => {
      const f = setup(() =>
        Response.json(
          { error: { type: "usage_limit_reached" } },
          {
            status: 429,
            headers: { "x-codex-active-limit": "image_gen", "x-image-gen-primary-reset-at": reset },
          },
        ),
      );
      const result = await f.facet.invoke(request(), f.context);
      expect(result).toMatchObject({
        outcome: "failed",
        problem: { code: "image_generation_limit_reached", context: { limitId: "image_gen" } },
      });
      expect(result.problem?.context.resetsAt).toBe(
        reset.length < 20 ? new Date(Number(reset) * 1000).toISOString() : undefined,
      );
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("maps 401 to auth, 5xx to provider failure, and never retries", async () => {
    const unauthorized = setup(() => Response.json({ error: { code: "x" } }, { status: 401 }));
    expect(await unauthorized.facet.invoke(request(), unauthorized.context)).toMatchObject({
      outcome: "failed",
      problem: { code: "auth_required" },
    });
    const failing = setup(() => new Response("upstream", { status: 503 }));
    expect(await failing.facet.invoke(request(), failing.context)).toMatchObject({
      outcome: "failed",
      problem: { code: "provider_failed", retryable: true },
    });
    expect(failing.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["image gen", "image/gen", "image:gen", "image,gen", "imáge_gen"])(
    "keeps a received 429 when the active-limit value %s cannot name a header",
    async (activeLimit) => {
      const f = setup(() =>
        Response.json(
          { error: { type: "usage_limit_reached" } },
          { status: 429, headers: { "x-codex-active-limit": activeLimit } },
        ),
      );
      expect(await f.facet.invoke(request(), f.context)).toMatchObject({
        outcome: "failed",
        problem: {
          code: "image_generation_limit_reached",
          context: { httpStatus: 429, limitId: activeLimit },
        },
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a torn 200 body as unknown, not completed and not free", async () => {
    const f = setup(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"created":1,"data":[{"b64_json":"'));
          controller.error(new Error("socket reset"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await f.facet.invoke(request(), f.context);
    expect(result).toMatchObject({
      outcome: "unknown",
      images: [],
      cost: { knowledge: "unknown" },
      problem: { code: "transport_unknown" },
    });
  });

  /** Runs `body` with a dispatcher that answers each dispatch with `reply`. */
  async function withDispatcher<T>(
    reply: (options: Record<string, unknown>, handler: Dispatcher.DispatchHandler) => void,
    body: () => Promise<T>,
  ): Promise<T> {
    const original = getGlobalDispatcher();
    setGlobalDispatcher(
      new Proxy(original, {
        get(target, key) {
          if (key === "dispatch")
            return (options: Record<string, unknown>, handler: Dispatcher.DispatchHandler) => {
              reply(options, handler);
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    try {
      return await body();
    } finally {
      setGlobalDispatcher(original);
    }
  }
  const dispatchOnce = (init: RequestInit | undefined) =>
    (init!.dispatcher as unknown as Dispatcher).dispatch(
      { origin: "http://localhost", path: "/", method: "POST" },
      { onConnect() {}, onError() {} },
    );

  it("leaves the image request's timeouts to the dispatcher", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withDispatcher(
      (options) => seen.push(options),
      async () => {
        const f = setup((_url, init) => {
          dispatchOnce(init);
          return Response.json(upstreamResponse());
        });
        await f.facet.invoke(request(), f.context);
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("headersTimeout");
    expect(seen[0]).not.toHaveProperty("bodyTimeout");
  });

  it.each([
    [
      "before the request began to be written: not delivered, whatever the error's code",
      false,
      {
        outcome: "failed",
        problem: {
          code: "transport_not_delivered",
          context: {
            generationStarted: false,
            requestDelivery: { basis: "connect_failure", errorCodes: ["EHOSTUNREACH"] },
          },
        },
      },
    ],
    [
      "after the request began to be written: unknown",
      true,
      { outcome: "unknown", problem: { code: "transport_unknown" } },
    ],
  ] as const)("reads a dispatcher error %s", async (_when, started, expected) => {
    const result = await withDispatcher(
      (_options, handler) => {
        if (started) handler.onConnect?.(() => {});
        handler.onError?.(Object.assign(new Error("fixture"), { code: "EHOSTUNREACH" }));
      },
      async () => {
        const f = setup((_url, init) => {
          dispatchOnce(init);
          throw new TypeError("fetch failed");
        });
        return f.facet.invoke(request(), f.context);
      },
    );
    expect(result).toMatchObject(expected);
  });

  it("refuses a route/profile mismatch without dispatch", async () => {
    const f = setup(() => Response.json(upstreamResponse()));
    const result = await f.facet.invoke(
      request({ account: { mode: "pin", profileId: "other" } }),
      f.context,
    );
    expect(result).toMatchObject({ outcome: "failed", problem: { code: "invalid_request" } });
    expect(f.onDispatch).not.toHaveBeenCalled();
  });
});

// Donor transport guarantees retained on the shared adapter facet.
describe("bounded image transport and operation identity", () => {
  it("cancels an oversized response stream after exactly one send", async () => {
    const cancel = vi.fn();
    const f = setup(() => {
      let chunks = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(chunks++ < 9 ? 16 * 1024 * 1024 : 1));
          },
          cancel,
        }),
      );
    });
    const result = await f.facet.invoke(request(), f.context);
    expect(result).toMatchObject({
      outcome: "unknown",
      images: [],
      problem: { code: "image_response_too_large" },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.posts[0]!.headers.get("x-codex-image-turn-id")).toBe(f.context.imageTurnId);
  });
  it("rejects oversized input and bad turn identity before auth or dispatch", async () => {
    const bytes = Buffer.alloc(32 * 1024 * 1024 + 1);
    PNG.copy(bytes);
    const f = setup(() => Response.json(upstreamResponse()));
    expect(
      (await f.facet.invoke(request({ images: [input(bytes)] }), f.context)).problem?.code,
    ).toBe("invalid_request");
    expect(
      (await f.facet.invoke(request(), { ...f.context, imageTurnId: "bad\nheader" })).problem?.code,
    ).toBe("invalid_request");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.onDispatch).not.toHaveBeenCalled();
  });
  it("keeps only observed model identity and all good siblings with usage", async () => {
    const f = setup(() =>
      Response.json({
        ...upstreamResponse([
          { b64_json: PNG.toString("base64") },
          { b64_json: "@@@" },
          { b64_json: JPEG.toString("base64") },
        ]),
        model: "provider-observed-image",
      }),
    );
    const result = await f.facet.invoke(request(), f.context);
    expect(result.route.model).toBe("provider-observed-image");
    expect(result.requestedModel).toBe("gpt-image-1.5");
    expect(result.images).toHaveLength(2);
    expect(result.problem?.context.rejectedIndexes).toEqual([1]);
    expect(result.usage.output_tokens).toBe(1372);
  });
  it("keeps HTTP refusal authoritative when its bounded body is oversized", async () => {
    const f = setup(
      () => new Response("x".repeat(65537), { status: 429, headers: { "retry-after": "12" } }),
    );
    const onQuota = vi.fn();
    const result = await f.facet.invoke(request(), { ...f.context, onQuota });
    expect(result.problem?.code).toBe("image_generation_limit_reached");
    expect(onQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "codex_image_response",
        constraints: [expect.objectContaining({ applies_to_request_kinds: ["image"] })],
      }),
    );
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
