/**
 * #307 on the CLI-hosted surfaces. Only a requested result read projects
 * the recorded outcome, even when the in-process run detail knows it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FINAL_MESSAGES_PATH,
  McpRunHandleResult,
  McpRunResultRead,
  McpRunToolResult,
  type FinalMessagesPointer,
} from "@claudexor/schema";
import { structuredRunResult } from "../../mcp-server/src/run-result-format.js";
import { OPERATION_CATALOG } from "@claudexor/control-api";
import { acpSessionQuery, projectTerminalTurnDetail } from "./acp-surface-runner.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import {
  projectDegradedRecoveryRunDetail,
  projectImmediateRunDetail,
  projectRecoveryRunDetail,
} from "./mcp-run-projections.js";
import { projectTerminalDetailFields } from "./run-facts-projection.js";
import { runDetailPath } from "./run-detail-path.js";

const pointer: FinalMessagesPointer = {
  path: FINAL_MESSAGES_PATH,
  state: "partial",
  count: 2,
  bytes: 4096,
  sha256: `sha256:${"c".repeat(64)}`,
  throughEventSeq: 9,
};
const gap = { state: "unavailable", reason: "artifact_unavailable" } as const;
const summary = { runId: "run-1", taskId: "task-1", state: "succeeded" };
const detail = (finalMessages: unknown) => ({ summary, finalMessages });
const malformed = [
  detail({ ...pointer, sha256: "c".repeat(64) }),
  detail({ ...gap, error: "ENOENT: no such file" }),
  detail({ ...pointer, state: "unavailable", reason: "publication_failed" }),
];
const addr = { baseUrl: "http://127.0.0.1:1", token: "t" } as never;

function catalogResponse(supported: boolean): Response {
  const op = OPERATION_CATALOG.operations.find((entry) => entry.id === "get:runs.id")!;
  return Response.json({
    ...OPERATION_CATALOG,
    operations: [supported ? op : { ...op, parameters: [] }],
  });
}

describe("final-messages outcome on CLI-hosted result surfaces", () => {
  it("keeps the released immediate launch shape even for an enriched internal detail", () => {
    for (const input of [detail(pointer), detail(gap), detail(null), null, ...malformed])
      expect(projectImmediateRunDetail(input)).not.toHaveProperty("finalMessages");
    const handle = { runId: "run-1", status: "succeeded", summary: "done" };
    const known = structuredRunResult({ ...handle, finalMessages: pointer });
    expect(known).not.toHaveProperty("finalMessages");
    expect(McpRunToolResult.parse(known)).not.toHaveProperty("finalMessages");
  });

  it("the strict recovery handle keeps its keys unless the read asks for the outcome", () => {
    const plain = projectRecoveryRunDetail("__run_result", "run-1", detail(pointer));
    expect(plain).not.toHaveProperty("finalMessages");
    expect(McpRunHandleResult.parse(plain)).not.toHaveProperty("finalMessages");

    const ask = { includeFinalMessages: true };
    const asked = (outcome: unknown) =>
      projectRecoveryRunDetail("__run_result", "run-1", detail(outcome), undefined, ask);
    for (const outcome of [pointer, gap, null]) {
      expect(asked(outcome)["finalMessages"]).toEqual(outcome);
      expect(McpRunResultRead.parse(asked(outcome)).finalMessages).toEqual(outcome);
    }

    const degraded = projectDegradedRecoveryRunDetail("run-1", new Error("detail unreadable"), ask);
    expect(degraded["finalMessages"]).toBeNull();
    expect(McpRunResultRead.parse(degraded)).toEqual(degraded);
    expect(projectDegradedRecoveryRunDetail("run-1", new Error("x"))).not.toHaveProperty(
      "finalMessages",
    );
  });

  it("keeps the CLI terminal envelope independent of result-read options", () => {
    for (const input of [detail(pointer), detail(gap), detail(null), ...malformed])
      expect(projectTerminalDetailFields(input)).toEqual({ runFacts: null });
  });

  it("the ACP turn projection reads the outcome from the same single detail read", async () => {
    const daemonRun = await import("./daemon-run.js");
    const detailSpy = vi.spyOn(daemonRun, "fetchRunDetail");
    try {
      for (const outcome of [pointer, gap]) {
        detailSpy.mockResolvedValueOnce(detail(outcome));
        const projected = await projectTerminalTurnDetail(addr, "run-1", "succeeded", true);
        expect(projected.finalMessages).toEqual(outcome);
      }
      detailSpy.mockResolvedValueOnce(detail(pointer));
      expect(await projectTerminalTurnDetail(addr, "run-1", "succeeded")).not.toHaveProperty(
        "finalMessages",
      );
      detailSpy.mockResolvedValueOnce(malformed[1]!);
      expect(
        (await projectTerminalTurnDetail(addr, "run-1", "succeeded", true)).finalMessages,
      ).toBeNull();
      expect(detailSpy).toHaveBeenCalledTimes(4);
    } finally {
      detailSpy.mockRestore();
    }
  });

  it.each(["advertised", "older", "unavailable"])(
    "uses a %s catalog for result recovery and ACP turns",
    async (catalog) => {
      const supported = catalog === "advertised";
      const daemonRun = await import("./daemon-run.js");
      const addr = { baseUrl: "http://notes.invalid", token: `fixture-${catalog}` };
      const conn = {
        client: { status: async () => ({ state: "succeeded", runId: "run-1" }) },
        addr,
        engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
      };
      const connection = async () => ({ ...conn, addr: { ...addr } }) as never;
      const connect = vi.spyOn(daemonRun, "connectDaemonIfRunning").mockImplementation(connection);
      const ensure = vi.spyOn(daemonRun, "ensureDaemon").mockImplementation(connection);
      const paths: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const path = url.slice(addr.baseUrl.length);
        paths.push(path);
        if (path === "/v2/operations") {
          if (catalog === "unavailable") return new Response(null, { status: 503 });
          return catalogResponse(supported);
        }
        if (path === "/v2/threads/notes")
          return Response.json({
            thread: { id: "notes", repoRoot: "/notes" },
            turns: [
              { prompt: "Read.", runId: "run-1" },
              { prompt: "Read again.", runId: "run-1" },
            ],
          });
        if (path === "/v2/threads/notes/turns") {
          expect(JSON.parse(init.body as string)).toEqual({ prompt: "Read." });
          return Response.json({ jobId: "job-1", runId: "run-1" });
        }
        const plain = "/v2/runs/run-1";
        const enriched = path === plain + "?includeFinalMessages=true";
        if (path !== plain && !(supported && enriched)) throw new Error(`Unexpected read ${path}`);
        return Response.json({
          summary: { ...summary, jobId: "job-1", delegatedFromRunId: "parent" },
          primaryOutput: { kind: "answer", path: "final/answer.md", text: "Selected note." },
          ...(enriched ? { finalMessages: pointer } : {}),
        });
      });
      try {
        const recovery = mcpSurfaceRunner();
        const args = { mode: "__run_result", runId: "run-1" };
        expect(await recovery(args)).not.toHaveProperty("finalMessages");
        expect(await recovery({ ...args, includeFinalMessages: false })).not.toHaveProperty(
          "finalMessages",
        );
        expect(paths).toEqual(["/v2/runs/run-1", "/v2/runs/run-1"]);
        const expected = supported ? pointer : null;
        const selected = { ...args, includeFinalMessages: true };
        expect(await recovery(selected)).toMatchObject({
          summary: "Selected note.",
          finalMessages: expected,
        });
        expect(await mcpSurfaceRunner({ delegationParentRunId: "parent" })(selected)).toMatchObject(
          { finalMessages: expected },
        );
        await expect(
          mcpSurfaceRunner({ delegationParentRunId: "another-parent" })(selected),
        ).rejects.toMatchObject({
          code: "delegation_child_scope_violation",
        });

        const session = { sessionId: "notes", repoPath: "/notes", includeFinalMessages: true };
        const replay = await acpSessionQuery(
          { ...session, mode: "__acp_session_load" },
          undefined,
          {} as never,
        );
        expect(replay).toMatchObject({
          turns: [
            { run: { runId: "run-1", finalMessages: expected } },
            { run: { runId: "run-1", finalMessages: expected } },
          ],
        });
        const prompt = await acpSessionQuery(
          { ...session, mode: "__acp_session_prompt", prompt: "Read." },
          undefined,
          {} as never,
        );
        expect(prompt).toMatchObject({ summary: "Selected note.", finalMessages: expected });
        expect(paths.filter((p) => p === "/v2/operations")).toHaveLength(
          catalog === "unavailable" ? 6 : 1,
        );
        expect(paths.filter((p) => p.startsWith("/v2/runs/")).slice(2)).toEqual(
          Array(6).fill(supported ? "/v2/runs/run-1?includeFinalMessages=true" : "/v2/runs/run-1"),
        );
      } finally {
        vi.unstubAllGlobals();
        ensure.mockRestore();
        connect.mockRestore();
      }
    },
  );
});

describe("final-message capability discovery", () => {
  it.each(["transport", "response", "json", "catalog"])(
    "coalesces a %s failure, then retries only when another reader opts in",
    async (failure) => {
      const address = { baseUrl: "http://notes.invalid", token: failure };
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => {
        if (failure === "transport") throw new Error("offline");
        if (failure === "response") return new Response(null, { status: 503 });
        if (failure === "json") return new Response("unreadable");
        return Response.json({ operations: [] });
      });
      fetch.mockResolvedValueOnce(catalogResponse(true));
      vi.stubGlobal("fetch", fetch);
      try {
        expect(await Promise.all(["a", "b"].map((id) => runDetailPath(address, id, true)))).toEqual(
          ["/runs/a", "/runs/b"],
        );
        expect(await runDetailPath(address, "c")).toBe("/runs/c");
        expect(fetch).toHaveBeenCalledTimes(1);
        for (const id of ["d", "e"]) {
          expect(await runDetailPath({ ...address }, id, true)).toBe(
            `/runs/${id}?includeFinalMessages=true`,
          );
        }
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps the current serving mode's catalog when an earlier lookup finishes late", async () => {
    const address = { baseUrl: "http://notes.invalid", token: "serving-modes" };
    const normal = { engineVersion: "6.2.0", engineBuildSha: null, servingMode: "normal" } as const;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(catalogResponse(false));
    vi.stubGlobal("fetch", fetch);
    try {
      const old = runDetailPath(address, "old", true, { ...normal, servingMode: "recovery_only" });
      const current = runDetailPath(address, "first", true, normal);
      expect(fetch).toHaveBeenCalledTimes(2);
      finish(new Response(null, { status: 503 }));
      expect(await current).toBe("/runs/first");
      expect(await old).toBe("/runs/old");
      expect(await runDetailPath({ ...address }, "second", true, { ...normal })).toBe(
        "/runs/second",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
