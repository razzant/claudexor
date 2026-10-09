import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

const digest = "a".repeat(64);
const imageRequest = {
  request: {
    model: "gpt-image-2",
    prompt: "an autumn leaf",
    n: 1,
    quality: "auto",
    size: "auto",
    background: "auto",
  },
};
const imageDetail = {
  id: "img-test",
  state: "queued",
  createdAt: "2026-10-08T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  dispatch: { state: "not_started", startedAt: null, route: null },
  response: { state: "absent" },
  usage: { input_tokens: null, output_tokens: null },
  problem: null,
};

async function fixture(services: DaemonControlApiOptions["services"]) {
  const server = new DaemonControlApiServer({
    token: "image-route-test",
    daemon: { enqueue: vi.fn(), status: vi.fn(), list: vi.fn(async () => []), cancel: vi.fn() },
    services,
  });
  servers.push(server);
  const address = await server.start();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer image-route-test",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return request;
}

describe("image operation HTTP family", () => {
  it("advertises the exact family and demands an idempotency key before dispatch", async () => {
    expect(OPERATION_CATALOG.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/v2/image-operations" }),
        expect.objectContaining({ method: "GET", path: "/v2/image-operations/:id/result" }),
        expect.objectContaining({ method: "POST", path: "/v2/image-operations/:id/ack" }),
      ]),
    );
    const create = vi.fn(async () => imageDetail);
    const request = await fixture({ createImageOperation: create });
    expect((await request("/image-operations", imageRequest)).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    const started = await request("/image-operations", imageRequest, {
      "Idempotency-Key": "same-image-op",
    });
    expect(started.status).toBe(202);
    expect(create).toHaveBeenCalledExactlyOnceWith(imageRequest, "same-image-op");
    expect(await started.json()).toMatchObject({ id: "img-test", state: "queued" });
  });

  it("reads private result bytes without implicit ACK; explicit per-image digest and control route remain separate", async () => {
    const bytes = Buffer.from(JSON.stringify({ data: [{ b64_json: "AA==" }] }));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const readImageResult = vi.fn(async () => ({ bytes, sha256 }));
    const acknowledgeImageResult = vi.fn(async () => imageDetail);
    const cancelImageOperation = vi.fn(async () => imageDetail);
    const request = await fixture({
      getImageOperation: async () => imageDetail,
      readImageResult,
      acknowledgeImageResult,
      cancelImageOperation,
    });
    expect((await request("/image-operations/img-test")).status).toBe(200);
    const result = await request("/image-operations/img-test/result");
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
    expect(readImageResult).toHaveBeenCalledExactlyOnceWith("img-test");
    expect(acknowledgeImageResult).not.toHaveBeenCalled();
    expect((await request("/image-operations/img-test/ack", { sha256: digest })).status).toBe(200);
    expect(acknowledgeImageResult).toHaveBeenCalledExactlyOnceWith("img-test", digest);
    expect((await request("/image-operations/img-test/control", { action: "cancel" })).status).toBe(
      200,
    );
    expect(cancelImageOperation).toHaveBeenCalledWith("img-test", undefined);
  });

  it("admits a valid edit body above the ordinary control-plane 10 MiB ceiling", async () => {
    const create = vi.fn(async () => imageDetail);
    const request = await fixture({ createImageOperation: create });
    const edit = {
      ...imageRequest,
      images: [
        { dataUrl: `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024).toString("base64")}` },
      ],
    };
    const reply = await request("/image-operations", edit, { "Idempotency-Key": "large-edit" });
    expect(reply.status).toBe(202);
    expect(create).toHaveBeenCalledExactlyOnceWith(edit, "large-edit");
  });
});
