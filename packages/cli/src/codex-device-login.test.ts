import { describe, expect, it } from "vitest";
import {
  classifyCompletion,
  deviceCodeDurableMarker,
  startCodexDeviceLogin,
  type CodexAppServerConnection,
  type JsonRpcFrame,
} from "./codex-device-login.js";

/**
 * Scripted fake of the codex app-server JSON-RPC connection (D-17 transport
 * core). It records outgoing frames and lets a test push responses and
 * notifications, so the device-code driver is exercised with typed frames and
 * no real codex process.
 */
class FakeAppServer implements CodexAppServerConnection {
  readonly sent: JsonRpcFrame[] = [];
  private frameHandler: ((frame: JsonRpcFrame) => void) | null = null;
  private closeHandlers: Array<(error?: Error) => void> = [];
  /** Auto-responder keyed by method; return null to leave a call pending. */
  autoRespond: (frame: JsonRpcFrame) => JsonRpcFrame | null = () => null;

  send(frame: JsonRpcFrame): void {
    this.sent.push(frame);
    if (typeof frame.id === "number") {
      const reply = this.autoRespond(frame);
      if (reply) queueMicrotask(() => this.frameHandler?.(reply));
    }
  }
  onFrame(handler: (frame: JsonRpcFrame) => void): void {
    this.frameHandler = handler;
  }
  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }
  close(): void {}

  /** Push a server → client notification into the driver. */
  notify(method: string, params: unknown): void {
    this.frameHandler?.({ method, params });
  }
  /** Simulate transport loss. */
  drop(error?: Error): void {
    for (const handler of this.closeHandlers) handler(error);
  }

  lastRequest(method: string): JsonRpcFrame | undefined {
    return this.sent.filter((f) => f.method === method).at(-1);
  }
}

function okHandshake(server: FakeAppServer, startResult: unknown): void {
  server.autoRespond = (frame) => {
    if (frame.method === "initialize") return { id: frame.id, result: {} };
    if (frame.method === "account/login/start") return { id: frame.id, result: startResult };
    return null;
  };
}

describe("codex device-login transport core (D-17)", () => {
  it("initializes, starts device-code auth, and surfaces the typed disclosure", async () => {
    const server = new FakeAppServer();
    okHandshake(server, {
      loginId: "login-1",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "ABCD-1234",
    });

    const start = await startCodexDeviceLogin(server);
    expect(start.kind).toBe("started");
    if (start.kind !== "started") throw new Error("unreachable");
    expect(start.disclosure).toEqual({
      loginId: "login-1",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "ABCD-1234",
    });

    // Handshake order: initialize → initialized notification → login/start.
    expect(server.sent.map((f) => f.method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
    ]);
    expect(server.lastRequest("account/login/start")?.params).toEqual({
      type: "chatgptDeviceCode",
    });
  });

  it("selects the browser-callback flow and tolerates a URL-only (no userCode) disclosure", async () => {
    const server = new FakeAppServer();
    okHandshake(server, { loginId: "login-2", authUrl: "https://auth.openai.com/cb" });

    const start = await startCodexDeviceLogin(server, { flow: "chatgpt" });
    expect(start.kind).toBe("started");
    if (start.kind !== "started") throw new Error("unreachable");
    expect(server.lastRequest("account/login/start")?.params).toEqual({ type: "chatgpt" });
    expect(start.disclosure.verificationUrl).toBe("https://auth.openai.com/cb");
    expect(start.disclosure.userCode).toBe("");
  });

  it("maps JSON-RPC method-not-found to the typed capability-probe fallback", async () => {
    const server = new FakeAppServer();
    server.autoRespond = (frame) => {
      if (frame.method === "initialize") return { id: frame.id, result: {} };
      if (frame.method === "account/login/start")
        return { id: frame.id, error: { code: -32601, message: "method not found" } };
      return null;
    };

    const start = await startCodexDeviceLogin(server);
    expect(start.kind).toBe("not_supported");
    if (start.kind !== "not_supported") throw new Error("unreachable");
    expect(start.detail).toContain("method not found");
  });

  it("throws (not a capability fallback) on a non-method-not-found start error", async () => {
    const server = new FakeAppServer();
    server.autoRespond = (frame) => {
      if (frame.method === "initialize") return { id: frame.id, result: {} };
      if (frame.method === "account/login/start")
        return { id: frame.id, error: { code: -32000, message: "device auth disabled" } };
      return null;
    };
    await expect(startCodexDeviceLogin(server)).rejects.toThrow(/device auth disabled/);
  });

  it("resolves completion on account/login/completed for the disclosed login", async () => {
    const server = new FakeAppServer();
    okHandshake(server, { loginId: "login-9", verificationUrl: "u", userCode: "ZZ-99" });
    const start = await startCodexDeviceLogin(server);
    if (start.kind !== "started") throw new Error("unreachable");
    const done = start.awaitCompletion();
    // A completion for a DIFFERENT login is ignored; the matching one resolves.
    server.notify("account/login/completed", { loginId: "other" });
    server.notify("account/login/completed", { loginId: "login-9" });
    expect(await done).toEqual({ kind: "completed" });
  });

  it("cancels the vendor login and reports cancelled on abort", async () => {
    const server = new FakeAppServer();
    okHandshake(server, { loginId: "login-cancel", verificationUrl: "u", userCode: "CC-11" });
    const controller = new AbortController();
    const start = await startCodexDeviceLogin(server, { signal: controller.signal });
    if (start.kind !== "started") throw new Error("unreachable");
    const done = start.awaitCompletion();
    controller.abort();
    expect(await done).toEqual({ kind: "cancelled" });
    expect(server.lastRequest("account/login/cancel")?.params).toEqual({ loginId: "login-cancel" });
  });

  it("reports failure when the transport drops before completion", async () => {
    const server = new FakeAppServer();
    okHandshake(server, { loginId: "login-drop", verificationUrl: "u", userCode: "DD-22" });
    const start = await startCodexDeviceLogin(server);
    if (start.kind !== "started") throw new Error("unreachable");
    const done = start.awaitCompletion();
    server.drop(new Error("app-server exited: code=1"));
    expect(await done).toEqual({ kind: "failed", detail: "app-server exited: code=1" });
  });

  it("the durable marker carries THAT a code exists, never the code, url, or loginId", () => {
    const marker = deviceCodeDurableMarker({
      loginId: "login-secret",
      verificationUrl: "https://chatgpt.com/device",
      userCode: "SECRET-CODE",
    });
    expect(marker).toEqual({ disclosed: true });
    // Journal-is-authority discipline: no field of the durable marker may leak
    // the transient one-time code (or its verification URL / loginId).
    const serialized = JSON.stringify(marker);
    expect(serialized).not.toContain("SECRET-CODE");
    expect(serialized).not.toContain("chatgpt.com");
    expect(serialized).not.toContain("login-secret");
  });

  it("account/updated only completes when it reports an authenticated account", () => {
    expect(classifyCompletion("account/updated", {}, "x")).toBeNull();
    expect(classifyCompletion("account/updated", { authenticated: false }, "x")).toBeNull();
    expect(classifyCompletion("account/updated", { authMethod: "chatgpt" }, "x")).toEqual({
      kind: "completed",
    });
    expect(
      classifyCompletion("account/login/completed", { loginId: "x", success: false }, "x"),
    ).toEqual({ kind: "failed", detail: expect.stringContaining("did not succeed") });
  });
});
