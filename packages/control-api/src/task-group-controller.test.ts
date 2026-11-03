import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { RunWaitManyResult, TaskGroupRunsResult } from "@claudexor/schema";
import { DaemonServer, type RunnerFn } from "../../daemon/src/server.js";
import { readRunObservations } from "../../daemon/src/run-observation.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { taskGroupRunsTool } from "../../mcp-server/src/task-group-runs-tool.js";
import { runsWaitTool } from "../../mcp-server/src/runs-wait-tool.js";
import type { McpToolOutput, RunnerFn as McpRunner } from "../../mcp-server/src/index.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import { readTaskGroupRuns } from "./task-group-routes.js";
import type { RunObservationListener } from "./run-wait-many.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

const GROUP = "11111111-1111-4111-8111-111111111111";
const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
function structured(output: McpToolOutput): unknown {
  if (typeof output === "string") throw new Error("expected structured MCP result");
  expect(output.isError).not.toBe(true);
  return output.structured;
}
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const close of cleanup.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
    vi.restoreAllMocks();
  };
});

// This trace uses a Unix-domain HTTP socket; Windows named-pipe coverage is separate.
const itUnix = it.skipIf(process.platform === "win32");
itUnix(
  "recovers with only group/store over MCP handlers and HTTP, keeping healthy targets beside problems",
  async () => {
    // A short private Unix socket avoids opening a host TCP port. This fixture
    // exercises the actual HTTP request handler, not listener discovery or stdio.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx498-controller-")));
    removals.push(() => rmSync(root, { recursive: true, force: true }));
    const f = await sqlFixture(root);
    cleanup.push(f.close);
    const repo = join(root, "project");
    mkdirSync(repo);
    f.graph.projects.register({ root: repo, idempotencyKey: "project", clientId: "fixture" });
    const signals: AbortSignal[] = [];
    const runners = vi.fn<RunnerFn>(async (params, ctx) => {
      const name = (params as { prompt: string }).prompt;
      const runId = `run-${name}`;
      signals.push(ctx.signal);
      ctx.onRunStart({ runId, taskId: `task-${name}`, runDir: join(root, runId) });
      await f.graph.interactions.register(
        {
          runId,
          taskId: `task-${name}`,
          attemptId: "a01",
          harnessId: "fake",
          request: {
            interaction_id: `question-${name}`,
            source_tool: "AskUserQuestion",
            questions: [],
          },
          requestedAt: new Date().toISOString(),
          timeoutAt: null,
          signal: ctx.signal,
        },
        params,
      );
      return { lifecycle: ctx.signal.aborted ? "cancelled" : "succeeded" };
    });
    const daemon = new DaemonServer({
      socketPath: join(root, "unused.sock"),
      token: "fixture",
      commands: f.graph.commands,
      maxConcurrent: 1,
      runner: runners,
      onRunTerminal: (id) => f.graph.interactions.dropForRun(id),
    });
    cleanup.push(() => daemon.stop());
    // The producer owns the launch keys and receipts. The recovering function
    // below receives neither; no launch operation is available on its adapter.
    async function producer() {
      const accepted = [];
      for (const name of ["a", "b"]) {
        accepted.push(
          await daemon.dispatch("claudexor.enqueue", {
            request: {
              mode: "ask",
              prompt: name,
              scope: { kind: "project", root: repo },
              taskGroupId: GROUP,
            },
            idempotencyKey: `launch-${name}`,
            clientId: "producer",
          }),
        );
      }
      expect(accepted).toHaveLength(2);
      return { taskGroupId: GROUP, storeId: f.store.storeId! };
    }
    const saved = await producer();
    expect(runners).toHaveBeenCalledOnce();
    rmSync(repo, { recursive: true }); // Discovery must not need the original root.
    const listeners = new Set<RunObservationListener>();
    const snapshot = (ids: readonly string[], signal?: AbortSignal) =>
      readRunObservations(
        f.graph.commands.queries,
        f.graph.interactions,
        f.store.storeId!,
        ids,
        signal,
      );
    const forbidden = vi.fn((): never => {
      throw new Error("observation attempted a control action");
    });
    const api = new DaemonControlApiServer({
      token: "fixture",
      storeId: () => f.store.storeId,
      daemon: { enqueue: forbidden, cancel: forbidden, list: forbidden, status: forbidden },
      services: { answerInteraction: forbidden, sendRunMessage: forbidden },
      runObservations: snapshot,
      taskGroupRuns: (input, signal) =>
        readTaskGroupRuns(
          input,
          {
            storeId: () => f.store.storeId,
            page: (query) => f.graph.commands.queries.taskGroupPage!(query),
            snapshot,
          },
          signal,
        ),
      // The store's own post-commit feed; `listeners` only counts observers.
      runObservationChanges: (listener) => {
        listeners.add(listener);
        const unsubscribe = f.store.observations.subscribe(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    });
    const handler = Reflect.get(api, "onRequest") as (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void;
    const http = createServer((req, res) => handler.call(api, req, res));
    const socketPath = join(root, "http.sock");
    await new Promise<void>((done, reject) => {
      http.once("error", reject);
      http.listen(socketPath, () => {
        http.off("error", reject);
        done();
      });
    });
    cleanup.push(async () => {
      await api.stop();
      await new Promise<void>((done, reject) =>
        http.close((error) => (error ? reject(error) : done())),
      );
    });
    function json(
      method: string,
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const req = request(
          {
            socketPath,
            method,
            path,
            signal,
            headers: {
              host: "localhost",
              authorization: "Bearer fixture",
              "x-claudexor-protocol-major": "3",
              "content-type": "application/json",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () => {
              const value = JSON.parse(Buffer.concat(chunks).toString());
              if (res.statusCode !== 200) reject(Object.assign(new Error("HTTP refusal"), value));
              else resolve(value);
            });
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    const calls: string[] = [];
    const runner: McpRunner = async (input, context) => {
      calls.push(input.mode);
      if (input.mode === "__task_group_runs") {
        const query = new URLSearchParams({
          expectedStoreId: String(input.expectedStoreId),
          limit: String(input.limit),
        });
        if (input.cursor) query.set("cursor", String(input.cursor));
        return json(
          "GET",
          `/v2/task-groups/${input.taskGroupId}/runs?${query}`,
          undefined,
          context?.signal,
        );
      }
      if (input.mode === "__runs_wait")
        return json(
          "POST",
          "/v2/runs/wait-many",
          { targets: input.targets, waitMs: input.waitMs },
          context?.signal,
        );
      throw new Error("recovering controller has no launch adapter");
    };
    const groupTool = taskGroupRunsTool(runner),
      waitTool = runsWaitTool(runner);
    async function recover(only: { taskGroupId: string; storeId: string }) {
      const members: TaskGroupRunsResult["members"] = [];
      let cursor: string | undefined;
      do {
        const response = await groupTool.handler(
          {
            taskGroupId: only.taskGroupId,
            expectedStoreId: only.storeId,
            limit: 1,
            ...(cursor ? { cursor } : {}),
          },
          {},
        );
        const page = TaskGroupRunsResult.parse(structured(response));
        members.push(...page.members);
        cursor = page.hasMore ? page.nextCursor! : undefined;
      } while (cursor);
      return members;
    }
    const members = await recover(saved);
    expect(members).toHaveLength(2);
    const queued = members.find((row) => row.runId === null)!;
    const active = members.find((row) => row.runId !== null)!;
    expect(queued.observation).toMatchObject({ status: "queued", pending: false });
    expect(active.observation).toMatchObject({ status: "running", pending: true });
    expect(forbidden).not.toHaveBeenCalled();
    expect(runners).toHaveBeenCalledOnce();
    const targets = [
      { runId: active.jobId },
      { runId: queued.jobId },
      { runId: "obsolete-receipt" },
    ];
    const first = RunWaitManyResult.parse(
      structured(await waitTool.handler({ targets, waitMs: 0 }, {})),
    );
    expect(first.attention).toEqual([0]);
    expect(first.summaries[2]!.problem).toBe("not_found");
    const seen = targets.map((target, i) => ({
      ...target,
      ...(first.summaries[i]!.token ? { seen: first.summaries[i]!.token! } : {}),
    }));
    const problem = RunWaitManyResult.parse(
      structured(await waitTool.handler({ targets: seen, waitMs: 500 }, {})),
    );
    expect(problem.wakeReason).toBe("problems");
    expect(problem.summaries.slice(0, 2)).toEqual(first.summaries.slice(0, 2));
    // Reconcile only the obsolete receipt; retain healthy targets and their tokens.
    const healthy = seen.filter((_, i) => problem.summaries[i]!.problem === null);
    const pendingRead = vi.spyOn(f.graph.commands, "interactionsForRun");
    pendingRead.mockImplementationOnce(() => {
      throw new Error("injected temporary read failure");
    });
    const unknown = RunWaitManyResult.parse(
      structured(await waitTool.handler({ targets: healthy, waitMs: 0 }, {})),
    );
    expect(unknown.summaries[0]!.problem).toBe("snapshot_unavailable");
    expect(unknown.summaries[1]!.status).toBe("queued");
    pendingRead.mockRestore(); // A later read recovers; never resubmit the command.
    expect((await snapshot([active.jobId]))[0]!.problem).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    expect((await snapshot([active.jobId], aborted.signal))[0]!.problem).toBe("not_observed");

    // Losing one HTTP observation closes only that read. The fake worker remains
    // blocked on its own pending question, and the queued job remains accepted.
    const disconnect = new AbortController();
    const read = json(
      "POST",
      "/v2/runs/wait-many",
      { targets: healthy, waitMs: 1000 },
      disconnect.signal,
    );
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    disconnect.abort();
    await rejected;
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(f.graph.interactions.pendingForRun(active.runId!)).toHaveLength(1);
    expect(runners).toHaveBeenCalledOnce();

    // Four observers retain the queued job handle through a binding whose future
    // run ID they do not know. Unrelated notifications are never attention.
    let settled = 0;
    const waits = Array.from({ length: 4 }, () =>
      waitTool
        .handler(
          {
            targets: [{ runId: queued.jobId, seen: queued.observation.token }],
            waitMs: 1500,
          },
          {},
        )
        .then((result) => {
          settled++;
          return RunWaitManyResult.parse(structured(result));
        }),
    );
    await vi.waitFor(() => expect(listeners.size).toBe(4));
    for (let i = 0; i < 20; i++) for (const listener of listeners) listener(new Set(["unrelated"]));
    expect(settled).toBe(0);
    mkdirSync(repo); // The fixture producer explicitly releases A; recovery did not.
    expect(
      f.graph.interactions.answer(active.runId!, "question-a", {
        interaction_id: "question-a",
        answers: [],
      }).status,
    ).toBe("delivered");
    // Binding B and registering its question commit notices that wake the waits.
    await vi.waitFor(() => expect(runners).toHaveBeenCalledTimes(2));
    for (const result of await Promise.all(waits)) {
      expect(result.attention).toEqual([0]);
      expect(result.summaries[0]).toMatchObject({
        status: "running",
        pending: true,
        problem: null,
      });
      expect(result.summaries[0]!.token).not.toBe(queued.observation.token);
    }
    expect(listeners.size).toBe(0);
    const bound = await recover(saved);
    expect(bound.find((row) => row.jobId === queued.jobId)?.runId).toBe("run-b");
    expect(new Set(bound.map((row) => row.jobId))).toEqual(
      new Set(members.map((row) => row.jobId)),
    );
    expect(calls.every((mode) => ["__task_group_runs", "__runs_wait"].includes(mode))).toBe(true);
    expect(forbidden).not.toHaveBeenCalled();
  },
);
