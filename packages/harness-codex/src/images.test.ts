import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialProfile } from "@claudexor/schema";
import { invokeCodexImage, type CodexImageRequest } from "./images.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const image: CodexImageRequest = {
  request: {
    model: "gpt-image-2",
    prompt: "A quiet harbor",
    n: 1,
    quality: "auto",
    size: "auto",
    background: "auto",
  },
};
const token = `fixture.${Buffer.from('{"exp":2100000000}').toString("base64url")}.signature`;

function setup(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const profile = CredentialProfile.parse({
    profile_id: "named",
    harness_id: "codex",
    display_name: "Named",
    credential_kind: "config_dir_login",
    isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "named"),
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => reply(String(url), init!));
  const onDispatch = vi.fn(async () => {});
  const readAuthFile = vi.fn(async () =>
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "account-7",
        access_token: token,
        refresh_token: "NEVER_EXPOSE_THIS",
        id_token: `fixture.${Buffer.from('{"sub":"person-7"}').toString("base64url")}.signature`,
      },
    }),
  );
  const controller = new AbortController();
  return {
    fetcher,
    onDispatch,
    readAuthFile,
    controller,
    context: { profile, signal: controller.signal, onDispatch, imageTurnId: "image-operation-001" },
    deps: { fetch: fetcher, readAuthFile, now: () => 1900000000000 },
  };
}

const generated = () =>
  Response.json({
    data: [{ b64_json: png.toString("base64"), generation_id: "gen-1", size: "1024x1024" }],
    usage: { input_tokens: 20, output_tokens: 40 },
  });

describe("single Codex image generation transport", () => {
  it("does one no-redirect POST after durable dispatch and keeps the exact image envelope", async () => {
    const f = setup((_url, init) => {
      expect(f.onDispatch).toHaveBeenCalledTimes(1);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("ChatGPT-Account-ID")).toBe("account-7");
      expect(headers.get("x-codex-image-turn-id")).toBe("image-operation-001");
      expect(headers.get("originator")).toBe("claudexor");
      expect(headers.get("Content-Length")).toBe(String(Buffer.byteLength(init.body as string)));
      expect(JSON.parse(init.body as string)).toEqual(image.request);
      return generated();
    });
    const result = await invokeCodexImage(image, f.context, f.deps);
    expect(result).toMatchObject({
      outcome: "completed",
      dispatch: "response_received",
      problem: null,
      route: { source: "codex", credentialProfileId: "named", model: "gpt-image-2" },
      response: {
        data: [{ b64_json: png.toString("base64"), generation_id: "gen-1", size: "1024x1024" }],
        usage: { input_tokens: 20, output_tokens: 40 },
      },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("NEVER_EXPOSE_THIS");
  });

  it("translates an image edit data URL and refuses wrong MIME before dispatch", async () => {
    const f = setup((url, init) => {
      expect(url.endsWith("/images/edits")).toBe(true);
      expect(JSON.parse(init.body as string).images).toEqual([{ image_url: dataUrl }]);
      return generated();
    });
    const result = await invokeCodexImage({ ...image, images: [{ dataUrl }] }, f.context, f.deps);
    expect(result.outcome).toBe("completed");
    const invalid = await invokeCodexImage(
      { ...image, images: [{ dataUrl: dataUrl.replace("image/png", "image/jpeg") }] },
      f.context,
      f.deps,
    );
    expect(invalid.problem?.code).toBe("invalid_request");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.onDispatch).toHaveBeenCalledTimes(1);
  });

  it("makes a structured image-specific 429 without cooling down the text account", async () => {
    const f = setup(() =>
      Response.json(
        {
          error: {
            code: "image_generation_limit_reached",
            resets_at: 1900000010,
            message: "private body",
          },
        },
        { status: 429, headers: { "retry-after": "5", "x-request-id": "req-1" } },
      ),
    );
    const result = await invokeCodexImage(image, f.context, f.deps);
    expect(result).toMatchObject({
      outcome: "failed",
      dispatch: "response_received",
      response: null,
      problem: {
        code: "image_generation_limit_reached",
        retryable: false,
        context: {
          vendorCode: "image_generation_limit_reached",
          retryAfterMs: 5000,
          resetsAt: new Date(1900000010000).toISOString(),
          requestId: "req-1",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private body");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries unknown transport outcome, and a rejected response remains received", async () => {
    const f = setup(() => {
      throw new Error("private vendor error");
    });
    const lost = await invokeCodexImage(image, f.context, f.deps);
    expect(lost).toMatchObject({
      outcome: "unknown",
      dispatch: "unknown",
      problem: { code: "image_outcome_unknown" },
    });
    expect(JSON.stringify(lost)).not.toContain("private vendor error");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher.mockResolvedValueOnce(Response.json({ data: [{ b64_json: "broken" }] }));
    const bad = await invokeCodexImage(image, f.context, f.deps);
    expect(bad).toMatchObject({
      outcome: "failed",
      dispatch: "response_received",
      problem: { code: "image_response_invalid" },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not call an interrupted image response a completed delivery", async () => {
    const f = setup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":['));
              controller.error(new Error("private read failure"));
            },
          }),
        ),
    );
    const result = await invokeCodexImage(image, f.context, f.deps);
    expect(result).toMatchObject({
      outcome: "unknown",
      dispatch: "response_received",
      problem: { code: "image_outcome_unknown" },
    });
    expect(JSON.stringify(result)).not.toContain("private read failure");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not send after abort or failed dispatch journal", async () => {
    const f = setup(() => generated());
    f.controller.abort();
    expect(await invokeCodexImage(image, f.context, f.deps)).toMatchObject({
      outcome: "failed",
      dispatch: "not_started",
      problem: { code: "cancelled" },
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    const j = setup(() => generated());
    j.onDispatch.mockRejectedValueOnce(new Error("journal offline"));
    expect(await invokeCodexImage(image, j.context, j.deps)).toMatchObject({
      outcome: "failed",
      dispatch: "not_started",
    });
    expect(j.fetcher).not.toHaveBeenCalled();
  });

  it("bounds response bytes and refuses non-image output after the single send", async () => {
    const f = setup(() =>
      Response.json({ data: [{ b64_json: Buffer.from("text").toString("base64") }] }),
    );
    const bad = await invokeCodexImage(image, f.context, f.deps);
    expect(bad.problem?.code).toBe("image_response_invalid");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    // Stream past the adapter's 144 MiB response cap without a giant test fixture.
    const oversized = setup(() => {
      let chunks = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(chunks++ < 9 ? 16 * 1024 * 1024 : 1));
            if (chunks === 10) controller.close();
          },
        }),
      );
    });
    const result = await invokeCodexImage(image, oversized.context, oversized.deps);
    expect(result).toMatchObject({
      outcome: "failed",
      dispatch: "response_received",
      problem: { code: "image_response_too_large" },
    });
    expect(oversized.fetcher).toHaveBeenCalledTimes(1);
  });
});
