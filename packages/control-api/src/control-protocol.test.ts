import { CONTROL_PROTOCOL_MAJOR, ControlHandshakeResponse } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { resolveControlProtocol } from "./control-protocol.js";

const MAJOR = String(CONTROL_PROTOCOL_MAJOR);

function boundary(input: {
  method?: string;
  requestPath: string;
  requestedMajor?: string;
  servingMode?: "normal" | "recovery_only";
  storeId?: string;
  wantsStoreId?: boolean;
  body?: unknown;
}) {
  return resolveControlProtocol({
    method: input.method ?? "GET",
    requestPath: input.requestPath,
    requestedMajor: input.requestedMajor ?? MAJOR,
    readBody: async () => input.body ?? {},
    servingMode: input.servingMode,
    storeId: () => input.storeId,
    wantsStoreId: input.wantsStoreId ?? true,
  });
}

describe("control protocol recovery-only gate (issue #165 D5)", () => {
  it("reads the current store after receiving the handshake body", async () => {
    let storeId = "old-store";
    const result = await resolveControlProtocol({
      method: "POST",
      requestPath: "/v2/handshake",
      requestedMajor: undefined,
      storeId: () => storeId,
      wantsStoreId: true,
      readBody: async () => {
        storeId = "new-store";
        return { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" };
      },
    });
    expect(result).toMatchObject({ status: 200, body: { storeId: "new-store" } });
  });

  it("keeps storeId optional and carries the current identity in recovery mode", async () => {
    for (const storeId of [undefined, "11111111-1111-4111-8111-111111111111"]) {
      const result = await boundary({
        method: "POST",
        requestPath: "/v2/handshake",
        servingMode: "recovery_only",
        storeId,
        body: { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" },
      });
      expect(result.kind).toBe("response");
      if (result.kind !== "response") throw new Error("handshake did not respond");
      const body = ControlHandshakeResponse.parse(result.body);
      expect(body.storeId).toBe(storeId);
      expect(Object.hasOwn(body, "storeId")).toBe(storeId !== undefined);
      expect(ControlHandshakeResponse.safeParse({ ...body, storeId: 123 }).success).toBe(false);
    }
  });

  it("keeps the legacy handshake shape for a client that did not opt in to storeId", async () => {
    // The pre-storeId response schema was strict: an unsolicited key would fail an older client.
    const legacy = ControlHandshakeResponse.omit({ storeId: true }).strict();
    for (const wantsStoreId of [false, true]) {
      const result = await boundary({
        method: "POST",
        requestPath: "/v2/handshake",
        servingMode: "recovery_only",
        storeId: "11111111-1111-4111-8111-111111111111",
        wantsStoreId,
        body: { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" },
      });
      if (result.kind !== "response") throw new Error("handshake did not respond");
      const body = result.body as Record<string, unknown>;
      expect(Object.hasOwn(body, "storeId")).toBe(wantsStoreId);
      expect(legacy.safeParse(body).success).toBe(!wantsStoreId);
      expect(body.servingMode).toBe("recovery_only");
    }
  });

  it("carries servingMode in the handshake from the canonical admission snapshot", async () => {
    const recovery = await boundary({
      method: "POST",
      requestPath: "/v2/handshake",
      servingMode: "recovery_only",
      body: { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" },
    });
    expect(recovery).toMatchObject({
      kind: "response",
      status: 200,
      body: { compatible: true, servingMode: "recovery_only" },
    });
    const normal = await boundary({
      method: "POST",
      requestPath: "/v2/handshake",
      body: { protocolMajor: CONTROL_PROTOCOL_MAJOR, client: "test" },
    });
    expect(normal).toMatchObject({
      kind: "response",
      status: 200,
      body: { compatible: true, servingMode: "normal" },
    });
  });

  it("typed-refuses every product route while serving recovery only", async () => {
    for (const requestPath of ["/v2/runs", "/v2/threads", "/v2/settings", "/v2/projects"]) {
      const result = await boundary({ requestPath, servingMode: "recovery_only" });
      expect(result).toMatchObject({
        kind: "response",
        status: 503,
        contentType: "application/problem+json",
        body: { code: "daemon_recovery_only", retryable: true },
      });
    }
  });

  it("keeps the journal recovery surface and the operations catalog reachable", async () => {
    await expect(
      boundary({ requestPath: "/v2/recovery/partitions/global", servingMode: "recovery_only" }),
    ).resolves.toEqual({ kind: "route", path: "/recovery/partitions/global" });
    await expect(
      boundary({
        method: "POST",
        requestPath: "/v2/recovery/partitions/global/quarantine",
        servingMode: "recovery_only",
      }),
    ).resolves.toEqual({ kind: "route", path: "/recovery/partitions/global/quarantine" });
    await expect(
      boundary({ requestPath: "/v2/operations", servingMode: "recovery_only" }),
    ).resolves.toMatchObject({ kind: "response", status: 200 });
  });

  it("routes product paths normally once admission is open (and when unwired)", async () => {
    await expect(boundary({ requestPath: "/v2/runs", servingMode: "normal" })).resolves.toEqual({
      kind: "route",
      path: "/runs",
    });
    await expect(boundary({ requestPath: "/v2/runs" })).resolves.toEqual({
      kind: "route",
      path: "/runs",
    });
  });
});
