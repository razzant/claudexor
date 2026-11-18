/**
 * #307: claudexor_run_result returns the final-messages outcome only to a host
 * that asks; every other read keeps its run-id-only input and exact keys. The
 * declared outputSchema admits the address or a typed gap, never error text.
 */
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { FINAL_MESSAGES_PATH } from "@claudexor/schema";
import { releasedRunReader } from "../../schema/fixtures/run-results-6.2.0.js";
import { beltClaudexorTools, type DelegationPolicy } from "./delegation-belt.js";
import { defaultClaudexorTools, serveClaudexorMcp, type McpTool, type RunnerFn } from "./index.js";

const pointer = {
  path: FINAL_MESSAGES_PATH,
  state: "complete",
  count: 1,
  bytes: 300,
  sha256: `sha256:${"d".repeat(64)}`,
  throughEventSeq: 5,
};

/** One tools/call over the real stdio wire of the served factory. */
async function wireCall(
  tools: McpTool[],
  args: Record<string, unknown>,
  name = "claudexor_run_result",
  protocolVersion = "2025-06-18",
) {
  const read = new PassThrough();
  const write = new PassThrough();
  const handle = serveClaudexorMcp({ version: "0.0.0-test", tools, transport: { read, write } });
  const lines = createInterface({ input: write });
  const responses = lines[Symbol.asyncIterator]();
  async function receive(id: number | string) {
    for (;;) {
      const next = await responses.next();
      if (next.done) throw new Error("MCP transport closed before the response");
      const body = JSON.parse(next.value) as {
        id?: unknown;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      if (body.id === id) return body;
    }
  }
  const send = (message: unknown) => read.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test-host", version: "1.0" },
    },
  });
  try {
    await receive("init");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return await receive(1);
  } finally {
    await handle.close();
    lines.close();
  }
}

const policy: DelegationPolicy = {
  parentRunId: "run-parent",
  repoRoot: "/project",
  depth: 0,
  maxSubRuns: 2,
  parentBudget: { kind: "unlimited" },
};

describe("claudexor_run_result final-messages opt-in", () => {
  it("declares a boolean opt-in on the result read only and forwards it only when true", async () => {
    const runner = vi.fn<RunnerFn>(async () => ({ summary: "done", runId: "run-1" }));
    const tools = defaultClaudexorTools(runner);
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    expect(tool("claudexor_run_result").inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["runId"],
      properties: { runId: { type: "string" }, includeFinalMessages: { type: "boolean" } },
    });
    for (const name of ["claudexor_run_status", "claudexor_inspect"])
      expect(Object.keys(tool(name).inputSchema["properties"] as object)).toEqual(["runId"]);
    const result = tool("claudexor_run_result");
    await result.handler({ runId: "run-1" }, {});
    await result.handler({ runId: "run-1", includeFinalMessages: false }, {});
    await result.handler({ runId: "run-1", includeFinalMessages: true }, {});
    expect(runner.mock.calls.map((call) => call[0])).toEqual([
      { mode: "__run_result", runId: "run-1" },
      { mode: "__run_result", runId: "run-1" },
      { mode: "__run_result", runId: "run-1", includeFinalMessages: true },
    ]);
  });

  it.each(["ordinary", "Delegate"])(
    "serves the same requested outcome in %s MCP text and structured content",
    async (surface) => {
      const oldReader = releasedRunReader("McpRunHandleResult");
      for (const outcome of [
        pointer,
        { ...pointer, state: "partial" },
        { state: "unavailable", reason: "publication_failed" },
        null,
      ]) {
        const runner = vi.fn<RunnerFn>(async () => ({
          summary: "Note saved.",
          runId: "run-1",
          finalMessages: outcome,
        }));
        const tools =
          surface === "Delegate"
            ? beltClaudexorTools(runner, policy)
            : defaultClaudexorTools(runner);
        const options = outcome === pointer ? [undefined, false, true] : [true];
        for (const flag of options) {
          const option = flag === undefined ? {} : { includeFinalMessages: flag };
          const requested = flag === true;
          const reply = await wireCall(tools, { runId: "run-1", ...option });
          expect(reply.error).toBeUndefined();
          expect(reply.result?.["isError"]).not.toBe(true);
          const body = reply.result?.["structuredContent"];
          expect(oldReader(body)).toBe(!requested);
          const content = reply.result?.["content"] as Array<{ text: string }>;
          if (requested) {
            expect(body).toMatchObject({ finalMessages: outcome });
            const [text, address] = content[0]!.text.split("\n\nfinalMessages: ");
            expect(text).toContain("Note saved.");
            expect(JSON.parse(address!)).toEqual(outcome);
          } else {
            expect(body).not.toHaveProperty("finalMessages");
            expect(content[0]!.text).toBe("Note saved.\n\nrunId: run-1");
          }
          const forwarded = runner.mock.lastCall?.[0];
          expect(forwarded).toEqual({
            mode: "__run_result",
            runId: "run-1",
            ...(requested ? { includeFinalMessages: true } : {}),
            ...(surface === "Delegate" ? { delegatedFromRunId: "run-parent" } : {}),
          });
        }
      }
    },
  );

  it.each(["ordinary", "Delegate"])(
    "serves a readable address to an older %s MCP client",
    async (surface) => {
      const runner: RunnerFn = async () => ({
        summary: "Note saved.",
        runId: "run-1",
        finalMessages: pointer,
      });
      const tools =
        surface === "Delegate" ? beltClaudexorTools(runner, policy) : defaultClaudexorTools(runner);
      const reply = await wireCall(
        tools,
        { runId: "run-1", includeFinalMessages: true },
        "claudexor_run_result",
        "2024-11-05",
      );
      const content = reply.result?.["content"] as Array<{ text: string }>;
      const [summary, json] = content[0]!.text.split("\n\nfinalMessages: ");
      expect(summary).toBe("Note saved.\n\nrunId: run-1");
      expect(JSON.parse(json!)).toEqual(pointer);
    },
  );

  it.each(["claudexor_run_status", "claudexor_inspect"])(
    "preserves the released %s response for a richer internal result",
    async (name) => {
      const read = releasedRunReader("McpRunHandleResult");
      const tools = defaultClaudexorTools(async () => ({
        summary: "Note saved.",
        runId: "run-1",
        finalMessages: pointer,
      }));
      const reply = await wireCall(tools, { runId: "run-1" }, name);
      expect(read(reply.result?.["structuredContent"])).toBe(true);
      expect(reply.result?.["content"]).toEqual([
        { type: "text", text: "Note saved.\n\nrunId: run-1" },
      ]);
    },
  );

  it("keeps queued and immediately completed launches readable by the 6.2.0 SDK", async () => {
    const read = releasedRunReader("McpRunToolResult");
    for (const status of ["queued", "succeeded"]) {
      const tools = defaultClaudexorTools(async () => ({
        summary: "Note saved.",
        runId: status === "queued" ? null : "run-1",
        jobId: "job-1",
        status,
        finalMessages: pointer,
      }));
      const reply = await wireCall(tools, { prompt: "Read the note." }, "claudexor_ask");
      expect(reply.result?.["isError"]).not.toBe(true);
      const body = reply.result?.["structuredContent"];
      expect(read(body), JSON.stringify(read.errors)).toBe(true);
      expect(body).not.toHaveProperty("finalMessages");
    }
  });

  it("requires the existing Delegate parent even for an explicit result read", async () => {
    const runner = vi.fn<RunnerFn>();
    const tools = beltClaudexorTools(runner, { ...policy, parentRunId: null });
    const reply = await wireCall(tools, { runId: "run-1", includeFinalMessages: true });
    expect(reply.result?.["content"]).toEqual([
      { type: "text", text: expect.stringContaining("parent run id is missing") },
    ]);
    expect(reply.result).not.toHaveProperty("structuredContent");
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses error text in the outcome and a non-boolean opt-in", async () => {
    const leaky = { state: "unavailable", reason: "publication_failed", error: "EIO" };
    const leaking = defaultClaudexorTools(async () => ({ summary: "done", finalMessages: leaky }));
    const refused = await wireCall(leaking, { runId: "run-1", includeFinalMessages: true });
    expect(refused?.result?.["isError"]).toBe(true);
    let called = false;
    const counting = defaultClaudexorTools(async () => {
      called = true;
      return { summary: "done" };
    });
    const typed = await wireCall(counting, { runId: "run-1", includeFinalMessages: "yes" });
    expect(typed?.error ?? typed?.result?.["isError"]).toBeTruthy();
    expect(called).toBe(false);
  });
});
