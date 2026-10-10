import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandListQuery } from "@claudexor/schema";
import { publicCommandList } from "../../daemon/src/store/test-support/fixtures/legacy/daemon/command-list-projection.js";
import { publicJobRecord, type JobRecord } from "../../daemon/src/job-record.js";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { chainIdleRunMutation } from "./thread-mutation.js";
import { resolveThreadRecoveryTurn } from "./thread-recovery.js";
import { readCommandIds, readThreadCommands } from "./command-reads.js";
import type { DaemonFacadeClient } from "./run-record.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const at = "2026-10-08T12:00:00.000Z";
function record(id: string, params: Record<string, unknown> = {}): JobRecord {
  return {
    id: `job-${id}`,
    runId: `run-${id}`,
    state: "succeeded",
    createdAt: at,
    params: { mode: "ask", prompt: "ordinary request", ...params },
  };
}
function fixture(poison = true) {
  const root = mkdtempSync(join(tmpdir(), "cx-collection-"));
  roots.push(root);
  const noise = Array.from({ length: 1600 }, (_, i) => ({
    ...record(`noise-${i}`, {
      prompt: "retained work ".repeat(1000),
      arbitrary: {
        get body() {
          if (poison) throw new Error("unrelated params traversed");
          return "opaque";
        },
      },
    }),
    createdAt: "2025-01-01T00:00:00.000Z",
  }));
  const source = record("source", {
    threadId: "thread",
    turnId: "turn",
    mode: "agent",
    scope: { kind: "project", root },
    tests: [],
  });
  source.runDir = join(root, "run");
  mkdirSync(join(source.runDir, "final"), { recursive: true });
  writeFileSync(join(source.runDir, "final", "patch.diff"), "");
  const child = record("child", { delegatedFromRunId: "run-source" });
  const predecessor = record("predecessor", { scope: { kind: "none" } });
  const rows = [source, child, predecessor, ...noise];
  const queries: CommandListQuery[] = [];
  const enqueued: unknown[] = [];
  const daemon: DaemonFacadeClient = {
    list: async (query) => {
      queries.push(query);
      return publicCommandList(rows, query);
    },
    status: async (id) => rows.find((r) => r.id === id)!,
    enqueue: async (params) => {
      enqueued.push(params);
      const next = {
        ...record("next", params as Record<string, unknown>),
        runDir: root,
        taskId: "task-next",
        state: "running" as const,
      };
      rows.push(next);
      return { id: next.id, state: next.state };
    },
    findAccepted: async () => null,
    fenceDelegationParent: async () => ({}),
    cancel: async (id) => {
      const r = rows.find((r) => r.id === id);
      if (r) r.state = "cancelled";
      return {};
    },
  };
  const thread = {
    id: "thread",
    mode: "agent",
    repo: { root },
    run_ids: ["run-source"],
    head_run_id: "run-source",
    created_at: at,
    updated_at: at,
  };
  const turns: Record<string, unknown>[] = [
    { id: "turn", thread_id: "thread", run_id: "run-source", created_at: at },
  ];
  const services: DaemonControlApiOptions["services"] = {
    listThreads: async () => ({ threads: [thread] }),
    threadDetail: async () => ({ thread, turns, sessions: [] }),
    createThreadTurn: async () => ({ id: "new-turn" }),
    purgeThread: async () => ({ ...thread, state: "purged" }),
    applyThread: async () => ({ status: "empty", applied: false }),
    beginDelivery: async () => ({ id: "delivery-fixture", state: "running", reused: false }),
    completeDelivery: async () => {},
    failDelivery: async () => {},
  };
  return { rows, source, child, predecessor, queries, daemon, services, enqueued, turns };
}
async function withApi(
  f: ReturnType<typeof fixture>,
  run: (request: (path: string, body?: unknown) => Promise<Response>) => Promise<void>,
) {
  const token = randomUUID();
  const server = new DaemonControlApiServer({
    token,
    daemon: f.daemon,
    services: f.services,
    pollMs: 5,
  });
  const { host, port } = await server.start();
  try {
    await run((path, body) =>
      fetch(`http://${host}:${port}/v2${path}`, {
        method: body === undefined ? "GET" : "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          authorization: ["Bearer", token].join(" "),
          "X-Claudexor-Protocol-Major": "3",
          "Idempotency-Key": randomUUID(),
          "content-type": "application/json",
        },
      }),
    );
  } finally {
    await server.stop();
  }
}

describe("[INV-142:addressed-reads] collection routes with 1600 unrelated records", () => {
  it("pages, lists threads and hydrates turns including their Delegate children", async () => {
    const f = fixture();
    await withApi(f, async (request) => {
      for (const path of ["/runs?limit=2", "/threads", "/threads/thread"]) {
        const response = await request(path);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          turns: Array<{ run: { delegatedChildRunIds: string[] } }>;
        };
        if (path === "/threads/thread")
          expect(body.turns[0].run.delegatedChildRunIds).toEqual(["run-child"]);
      }
    });
    expect(f.queries).toEqual([
      { page: { limit: 2, cursor: null, state: null } },
      { threadIds: ["thread"] },
      { threadId: "thread" },
    ]);
  });

  it("continues a terminal run and cancels the complete descendant graph", async () => {
    const f = fixture();
    f.source.state = f.child.state = "running";
    const grandchild = record("grandchild", { delegatedFromRunId: "run-child" });
    grandchild.state = "running";
    f.rows.push(grandchild);
    await withApi(f, async (request) => {
      expect(
        (await request("/runs", { continueFrom: "run-predecessor", prompt: "continue" })).status,
      ).toBe(200);
      expect(
        (await request("/runs/run-source/control", { control: { kind: "cancel" } })).status,
      ).toBe(200);
    });
    expect([f.source.state, f.child.state, grandchild.state]).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(f.queries).toContainEqual({ continuationChainOf: "run-predecessor" });
    expect(f.queries).toContainEqual({ delegatedDescendantsOf: "run-source" });
    expect(f.enqueued).toHaveLength(1);
  });

  it("purges only idle threads and applies their addressed contributions", async () => {
    const f = fixture();
    await withApi(f, async (request) => {
      f.source.state = "running";
      expect((await request("/threads/thread/purge", {})).status).toBe(409);
      f.source.state = "succeeded";
      expect((await request("/threads/thread/purge", {})).status).toBe(200);
      expect((await request("/threads/thread/apply", { mode: "apply" })).status).toBe(200);
    });
    expect(f.queries).toContainEqual({ threadId: "thread", activeOnly: true });
    expect(f.queries).toContainEqual({ activeOnly: true });
    expect(f.queries).toContainEqual({ ids: ["run-source"] });
  });

  it("retries a refused turn with its complete prompt and instructions", async () => {
    const f = fixture();
    const params = {
      mode: "ask",
      prompt: "full retry text ".repeat(1000),
      instructions: "full instructions ".repeat(1000),
      threadId: "thread",
      turnId: "turn",
    };
    f.source.params = params;
    f.source.runId = undefined;
    f.source.state = "failed";
    f.turns[0]!.run_id = null;
    f.turns[0]!.enqueue_error = { message: "temporary", retryable: true, failed_at: at };
    await withApi(f, async (request) =>
      expect((await request("/threads/thread/turns/turn/retry", {})).status).toBe(200),
    );
    expect(f.enqueued).toEqual([params]);
    expect(f.queries).toContainEqual({ turnId: "turn" });
  });

  it("fences run mutations and recovery on addressed active thread jobs", async () => {
    const f = fixture();
    for (const recovery of [false, true]) {
      const work = () =>
        recovery
          ? resolveThreadRecoveryTurn(
              f.daemon,
              {
                createThreadTurn: async () => ({ id: "new-turn" }),
                findThreadTurnByIdempotency: async () => null,
              },
              f.source,
              "thread",
              "recover",
              {},
              { key: "recovery", client: "test", request: {} },
            )
          : chainIdleRunMutation(new Map(), f.daemon, f.source, async () => ({ id: "mutated" }));
      f.source.state = "running";
      await expect(work()).rejects.toMatchObject({ code: "thread_busy" });
      f.source.state = "succeeded";
      await expect(work()).resolves.toHaveProperty("id");
    }
    expect(f.queries).toEqual(Array(4).fill({ threadId: "thread", activeOnly: true }));
  });

  it("keeps HTTP run-list bytes equal to the legacy full public-record fixture", async () => {
    const f = fixture(false);
    f.source.params = {
      ...(f.source.params as object),
      prompt: "preview ".repeat(100),
      routingGoal: "quality",
      access: "workspace_write",
      harnesses: ["fake-success"],
      primaryHarness: "fake-success",
      model: "fixture-model",
      n: 2,
      review: true,
      reviewerPanel: [{ harness: "fake-success" }],
      paidBudget: { kind: "unlimited" },
      protectedPathApprovals: [],
      untilClean: true,
    };
    let legacy = "";
    const addressed = f.daemon.list;
    f.daemon.list = async () => f.rows.map(publicJobRecord);
    await withApi(f, async (request) => {
      legacy = await (await request("/runs?limit=3")).text();
    });
    f.daemon.list = addressed;
    await withApi(f, async (request) =>
      expect(await (await request("/runs?limit=3")).text()).toBe(legacy),
    );
    expect(JSON.parse(legacy).runs).toHaveLength(3);
  });

  it("batches ids without imposing a lifetime cap and skips an empty collection", async () => {
    const f = fixture();
    expect(await readCommandIds(f.daemon, [])).toEqual([]);
    expect(await readThreadCommands(f.daemon, [])).toEqual([]);
    expect(f.queries).toHaveLength(0);
    const ids = Array.from({ length: 2001 }, (_, i) => `thread-${i}`);
    await readThreadCommands(
      f.daemon,
      ids.map((id) => ({ id })),
    );
    await readCommandIds(f.daemon, ids);
    expect(
      f.queries.map((q) => ("ids" in q ? q.ids.length : "threadIds" in q ? q.threadIds.length : 0)),
    ).toEqual([1000, 1000, 1, 1000, 1000, 1]);
  });
});
