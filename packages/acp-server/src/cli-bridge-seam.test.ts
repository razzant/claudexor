import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { acpBridgeServer } from "../../cli/src/bridge-serve.js";

/**
 * #546 at the production seam (X1, X2): the server `claudexor acp serve` builds
 * (`acpBridgeServer`: the SDK projection over the daemon-thread session runner
 * and its run event feed), driven by a receiving ACP client. Only the daemon is
 * replaced: job status, run detail and its HTTP answers are stubbed, and the
 * run's event stream replays the rows the real Cursor parser and journal
 * projection store for the #546 fixture, once per try of a two-try race that
 * reuses the native call ids. Not a live vendor, daemon or third-party client.
 */
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/cursor-background-completion-transcript.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { rows: Array<{ seq: number; ts: string; type: string; payload: Record<string, any> }> };

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The run's stored rows as the Control API streams them: each try's rows, stamped
 * with the run id the event log writes, one SSE frame per row. */
function runEventStream(): string {
  const tries = [
    { attempt_id: "a01", session_id: "ses-fixture" },
    { attempt_id: "a02", session_id: "ses-fixture-2" },
  ];
  const rows = tries.flatMap((owner) =>
    fixture.rows.map((row) => ({
      ...row,
      run_id: "run-seam",
      payload: { ...row.payload, ...owner },
    })),
  );
  return (
    ": connected\n\n" +
    rows
      .map((row, index) => ({ ...row, seq: index + 1 }))
      .map((row) => `id: ${row.seq}\nevent: harness.event\ndata: ${JSON.stringify(row)}\n\n`)
      .join("") +
    "event: end\ndata: {}\n\n"
  );
}

describe("claudexor acp serve: tool activity reaches a receiving ACP client", () => {
  it("opens, closes and refines each try's own calls through the production runner and feed", async () => {
    const project = mkdtempSync(join(tmpdir(), "claudexor-acp-seam-"));
    directories.push(project);
    const daemonRun = await import("../../cli/src/daemon-run.js");
    const live = await import("../../cli/src/live.js");
    const addr = { baseUrl: "http://127.0.0.1:1", token: "fixture" };
    const ensure = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {
        status: vi
          .fn()
          .mockResolvedValueOnce({ state: "running", runId: "run-seam" })
          .mockResolvedValue({ state: "succeeded", runId: "run-seam" }),
      },
      addr,
    } as never);
    const detail = vi.spyOn(daemonRun, "fetchRunDetail").mockResolvedValue(null);
    const requests: string[] = [];
    const http = vi.spyOn(live, "controlApiFetch").mockImplementation(async (_addr, path, init) => {
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/threads/thread-seam")
        return Response.json({ thread: { id: "thread-seam", repoRoot: project } });
      if (path === "/threads/thread-seam/turns") return Response.json({ jobId: "job-seam" });
      if (path === "/runs/run-seam/events") return new Response(runEventStream());
      if (path === "/runs/run-seam") return Response.json({ pendingInteractions: [] });
      throw new Error(`unexpected request ${path}`);
    });
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();
    const serving = acpBridgeServer({ read: clientToAgent, write: agentToClient }).serve();
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: "claudexor-seam-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    try {
      const response = await client.connectWith(
        acp.ndJsonStream(
          Writable.toWeb(clientToAgent) as globalThis.WritableStream<Uint8Array>,
          Readable.toWeb(agentToClient) as globalThis.ReadableStream<Uint8Array>,
        ),
        (agent) =>
          agent.request(acp.methods.agent.session.prompt, {
            sessionId: "thread-seam",
            prompt: [{ type: "text", text: "Run both sleeps." }],
          }),
      );
      expect(response.stopReason).toBe("end_turn");
    } finally {
      clientToAgent.end();
      await serving;
      ensure.mockRestore();
      detail.mockRestore();
      http.mockRestore();
    }
    expect(requests).toContain("GET /runs/run-seam/events");

    const tools = updates
      .map((note) => note.update)
      .filter((update) => "toolCallId" in update) as Array<Record<string, any>>;
    const ids = [...new Set(tools.map((update) => update["toolCallId"] as string))];
    expect(ids).toEqual([
      "run-seam/a01/ses-fixture/call-foreground-sleep",
      "run-seam/a01/ses-fixture/call-background-sleep",
      "run-seam/a02/ses-fixture-2/call-foreground-sleep",
      "run-seam/a02/ses-fixture-2/call-background-sleep",
    ]);
    const label = {
      "call-foreground-sleep": [
        "Handed off to background after its 30s timeout; completion not observed · shell 148478 · pid 148480",
        "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480",
      ],
      "call-background-sleep": [
        "Handed off to background; completion not observed · shell 148490 · pid 148492",
        "Completion reported; exit code unknown · handed off to background · shell 148490 · pid 148492",
      ],
    } as const;
    for (const id of ids) {
      const [opened, closed, refined, ...rest] = tools.filter(
        (update) => update["toolCallId"] === id,
      );
      const [handoff, completion] = label[id.split("/").at(-1) as keyof typeof label];
      expect(rest).toEqual([]);
      expect(opened).toMatchObject({ sessionUpdate: "tool_call", status: "in_progress" });
      expect(closed).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
      expect(closed?.["content"]?.[0]?.["content"]?.["text"]).toBe(handoff);
      // Content and _meta only: the terminal `failed` stands.
      expect(refined).not.toHaveProperty("status");
      expect(refined?.["content"]?.[0]?.["content"]?.["text"]).toBe(completion);
      expect(refined?.["_meta"]?.["claudexor"]?.["commandOutcome"]).toMatchObject({
        state: "completion_reported",
        completion_status: "success",
      });
    }
    // Narration stays out: the turn's answer reaches the client once, at its end.
    const said = updates
      .map((note) => note.update)
      .flatMap((update) =>
        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
          ? [update.content.text]
          : [],
      );
    expect(said).toHaveLength(1);
    expect(said.join("\n")).not.toContain("background shells");
  });
});
