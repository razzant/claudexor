import { describe, expect, it } from "vitest";
import { createAppServerClient, REFUSED_SERVER_REQUEST } from "./codex-appserver-client.mjs";
import { startupWarnings } from "./linux-codex-appserver-cell.mjs";

function harness() {
  const written = [];
  const recorded = [];
  const client = createAppServerClient({
    write: (line) => written.push(line),
    record: (direction, line) => recorded.push([direction, line]),
  });
  const sent = () => written.map((line) => JSON.parse(line));
  return { client, written, recorded, sent };
}

describe("app-server JSON-RPC client", () => {
  it("frames initialize and initialized as the managed adapter does and resolves by id", async () => {
    const { client, written, sent } = harness();
    const params = {
      clientInfo: { name: "claudexor", version: "4.8.2" },
      capabilities: { experimentalApi: true },
    };
    const pending = client.request("initialize", params);
    expect(written).toEqual([`${JSON.stringify({ id: 1, method: "initialize", params })}\n`]);
    client.receive(JSON.stringify({ id: 1, result: { userAgent: "x", platformOs: "linux" } }));
    await expect(pending).resolves.toEqual({
      state: "result",
      result: { userAgent: "x", platformOs: "linux" },
      afterNotifications: 0,
    });
    client.notify("initialized", null);
    expect(sent()[1]).toEqual({ method: "initialized", params: null });
  });

  it("keeps every frame verbatim in both directions", async () => {
    const { client, recorded } = harness();
    const pending = client.request("command/exec", { command: ["/bin/cat", "x"] });
    const reply = '{"id":1,"result":{"exitCode":0,"stdout":"n\\n","stderr":""}}';
    client.receive(reply);
    await pending;
    expect(recorded).toEqual([
      [
        "out",
        JSON.stringify({ id: 1, method: "command/exec", params: { command: ["/bin/cat", "x"] } }),
      ],
      ["in", reply],
    ]);
  });

  it("orders output notifications before the command/exec response they precede", async () => {
    const { client } = harness();
    const pending = client.request("command/exec", { command: ["/bin/cat", "x"] });
    client.receive(
      JSON.stringify({
        method: "command/exec/outputDelta",
        params: { stream: "stdout", deltaBase64: "bg==" },
      }),
    );
    client.receive(
      JSON.stringify({
        method: "command/exec/outputDelta",
        params: { stream: "stderr", deltaBase64: "" },
      }),
    );
    client.receive(JSON.stringify({ id: 1, result: { exitCode: 0, stdout: "", stderr: "" } }));
    client.receive(JSON.stringify({ method: "thread/started", params: {} }));
    const outcome = await pending;
    expect(outcome.afterNotifications).toBe(2);
    expect(client.notifications.map((n) => n.method)).toEqual([
      "command/exec/outputDelta",
      "command/exec/outputDelta",
      "thread/started",
    ]);
  });

  it("captures configWarning before the remote-control frame that settles the startup list", async () => {
    const { client } = harness();
    client.receive(
      JSON.stringify({
        method: "configWarning",
        params: {
          summary:
            "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
          details: null,
        },
      }),
    );
    expect(startupWarnings(client.notifications).settled).toBe(false);
    const anchor = client.waitForNotification((n) => n.method === "remoteControl/status/changed", {
      timeoutMs: 1_000,
    });
    client.receive(
      JSON.stringify({ method: "remoteControl/status/changed", params: { status: "disabled" } }),
    );
    await expect(anchor).resolves.toMatchObject({ method: "remoteControl/status/changed" });
    expect(startupWarnings(client.notifications)).toEqual({
      settled: true,
      configWarnings: [
        {
          summary:
            "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
          details: null,
        },
      ],
      warnings: [],
    });
  });

  it("refuses a server request with a JSON-RPC error and keeps it", () => {
    const { client, sent } = harness();
    client.receive(
      JSON.stringify({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { itemId: "a" },
      }),
    );
    expect(sent()).toEqual([{ id: 7, error: REFUSED_SERVER_REQUEST }]);
    expect(client.snapshot().serverRequests).toHaveLength(1);
    expect(client.notifications).toHaveLength(0);
  });

  it("turns an RPC error into an error outcome, not a capture problem", async () => {
    const { client } = harness();
    const pending = client.request("command/exec", {});
    client.receive(
      JSON.stringify({ id: 1, error: { code: -32600, message: "command must not be empty" } }),
    );
    await expect(pending).resolves.toMatchObject({ state: "error", error: { code: -32600 } });
    expect(client.snapshot().captureProblems).toEqual([]);
  });

  it("marks unreadable frames and stray responses as capture problems", () => {
    const { client } = harness();
    client.receive("not json");
    client.receive("[1,2]");
    client.receive(JSON.stringify({ id: 99, result: {} }));
    client.receive(JSON.stringify({ hello: true }));
    expect(client.snapshot().captureProblems).toHaveLength(4);
  });

  it("times a request out as unknown and keeps a late response", async () => {
    const { client } = harness();
    const outcome = await client.request(
      "command/exec",
      { command: ["/bin/true"] },
      { timeoutMs: 5 },
    );
    expect(outcome).toEqual({ state: "timeout", timeoutMs: 5 });
    client.receive(JSON.stringify({ id: 1, result: { exitCode: 0, stdout: "", stderr: "" } }));
    const snapshot = client.snapshot();
    expect(snapshot.lateResponses).toHaveLength(1);
    expect(snapshot.captureProblems).toEqual(["response for an id nobody waits for: 1"]);
  });

  it("resolves open requests as closed and refuses new ones after the connection ends", async () => {
    const { client, written } = harness();
    const pending = client.request("turn/start", { threadId: "t" });
    const waiting = client.waitForNotification((n) => n.method === "turn/completed", {
      timeoutMs: 1_000,
    });
    client.close("app-server exited");
    await expect(pending).resolves.toEqual({ state: "closed", reason: "app-server exited" });
    await expect(waiting).resolves.toBeNull();
    await expect(client.request("command/exec", {})).resolves.toEqual({
      state: "closed",
      reason: "app-server exited",
    });
    expect(written).toHaveLength(1);
  });
});
