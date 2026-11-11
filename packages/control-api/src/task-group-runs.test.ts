import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlOperationCatalog,
  ControlProblem,
  TASK_GROUP_CURSOR_CHARS,
  TASK_GROUP_RUNS_RESULT_BYTES,
  TaskGroupRunsResult,
  decodeTaskGroupCursor,
  type RunObservationRecord,
  type TaskGroupPageQuery,
  type TaskGroupRunsInput,
} from "@claudexor/schema";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { readTaskGroupRuns } from "./task-group-routes.js";

const GROUP = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const headers = { authorization: "Bearer group-http-fixture", "X-Claudexor-Protocol-Major": "3" };
const result = {
  taskGroupId: GROUP,
  storeId: STORE,
  visibility: "current_served_generations" as const,
  retention: "retained_only" as const,
  viewToken: "A".repeat(43),
  members: [
    {
      jobId: "job-queued",
      runId: null,
      createdAt: "2026-10-22T00:00:00.000Z",
      observation: {
        status: null,
        pending: null,
        token: null,
        problem: "snapshot_unavailable" as const,
      },
    },
  ],
  hasMore: true,
  nextCursor: "opaque-next-page",
};
const cleanup: Array<() => Promise<void>> = [];
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("group HTTP fixture did not settle")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(available = true) {
  const forbidden = {
    list: vi.fn(),
    status: vi.fn(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
    answerInteraction: vi.fn(),
    sendRunMessage: vi.fn(),
    createThreadTurn: vi.fn(),
    applyThread: vi.fn(),
    beginDelivery: vi.fn(),
    recordOperatorDecision: vi.fn(),
  };
  const page = vi.fn(async (_input: TaskGroupRunsInput, _signal?: AbortSignal) => result);
  const options: DaemonControlApiOptions = {
    token: "group-http-fixture",
    daemon: forbidden,
    services: forbidden,
    taskGroupRuns: available ? page : undefined,
  };
  const server = new DaemonControlApiServer(options);
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  cleanup.push(async () => {
    await server.stop();
    for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
  });
  return {
    base,
    page,
    get: (suffix = "") => fetch(`${base}/v2/task-groups/${GROUP}/runs${suffix}`, { headers }),
  };
}

describe("GET /v2/task-groups/:id/runs", () => {
  it("returns exactly one compact page with retention qualifiers and nullable run identity", async () => {
    const f = await fixture();
    const response = await f.get(
      `?limit=2&state=queued&cursor=opaque%2B%2F%3D%26&expectedStoreId=${STORE}`,
    );
    expect(response.status).toBe(200);
    expect(TaskGroupRunsResult.parse(await response.json())).toEqual(result);
    expect(f.page).toHaveBeenCalledExactlyOnceWith(
      {
        taskGroupId: GROUP,
        limit: 2,
        state: "queued",
        cursor: "opaque+/=&",
        expectedStoreId: STORE,
      },
      expect.any(AbortSignal),
    );
  });

  it("admits a default limit of 50 without changing existing unfiltered APIs", async () => {
    const f = await fixture();
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(f.page).toHaveBeenCalledExactlyOnceWith(
      { taskGroupId: GROUP, limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it("admits opaque store identity syntax and returns actual composition store mismatch as 409 before selection", async () => {
    const f = await fixture();
    f.page.mockResolvedValueOnce({ ...result, storeId: "store:opaque/non-uuid" });
    const accepted = await f.get("?expectedStoreId=store%3Aopaque%2Fnon-uuid");
    expect(accepted.status).toBe(200);
    const select = vi.fn(() => {
      throw new Error("wrong store must not select commands");
    });
    const snapshot = vi.fn(async () => []);
    f.page.mockImplementationOnce(
      (input, signal) =>
        readTaskGroupRuns(
          input,
          { storeId: () => STORE, page: select, snapshot },
          signal,
        ) as Promise<typeof result>,
    );
    const mismatch = await f.get("?expectedStoreId=foreign-nonempty-store");
    expect(mismatch.status).toBe(409);
    expect(ControlProblem.parse(await mismatch.json()).code).toBe("store_mismatch");
    expect(select).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it.each([
    "?unknown=true",
    "?projectId=p",
    "?limit=0",
    "?limit=201",
    "?limit=1.5",
    "?limit=1x",
    "?limit=1e1",
    "?limit=+5",
    "?limit=0x10",
    "?limit=05",
    "?limit=",
    "?limit=2&limit=3",
    "?state=pending",
    "?state=running&state=queued",
    `?expectedStoreId=`,
    "?cursor=" + "c".repeat(2049),
    "?cursor=a&cursor=b",
  ])("rejects strict query %s before collection selection", async (query) => {
    const f = await fixture();
    const response = await f.get(query);
    expect(response.status).toBe(400);
    ControlProblem.parse(await response.json());
    expect(f.page).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID path before invoking the projection", async () => {
    const f = await fixture();
    const response = await fetch(`${f.base}/v2/task-groups/not-a-uuid/runs`, { headers });
    expect(response.status).toBe(400);
    ControlProblem.parse(await response.json());
    expect(f.page).not.toHaveBeenCalled();
  });

  it("returns typed unsupported/unavailable when the backend cannot provide a group page", async () => {
    const f = await fixture(false);
    const response = await f.get();
    expect([501, 503]).toContain(response.status);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(ControlProblem.parse(await response.json())).toMatchObject({
      code: expect.stringMatching(/unavailable|unsupported/),
      retryable: false,
    });
    expect(f.page).not.toHaveBeenCalled();
  });

  it.each(["stale_cursor", "store_mismatch", "store_busy"])(
    "preserves typed %s rather than empty success",
    async (code) => {
      const f = await fixture();
      f.page.mockRejectedValueOnce(
        Object.assign(new Error("group read refused"), {
          code,
          status: code === "store_busy" ? 503 : 409,
          retryable: code === "store_busy",
        }),
      );
      const response = await f.get();
      expect(response.status).toBe(code === "store_busy" ? 503 : 409);
      expect(ControlProblem.parse(await response.json()).code).toBe(code);
      expect(f.page).toHaveBeenCalledOnce();
    },
  );

  it("advertises a schema-owned naturally idempotent read operation", async () => {
    const f = await fixture();
    const response = await fetch(`${f.base}/v2/operations`, { headers });
    const catalog = ControlOperationCatalog.parse(await response.json());
    const operations = catalog.operations.filter((op) => op.path === "/v2/task-groups/:id/runs");
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      method: "GET",
      mutability: "read_only",
      idempotency: "natural",
      requestSchema: null,
      responseSchema: "TaskGroupRunsResult",
      errorSchema: "ControlProblem",
    });
    expect(operations[0]!.parameters).toHaveLength(4);
    for (const name of ["limit", "state", "cursor", "expectedStoreId"])
      expect(operations[0]!.parameters.find((param) => param.name === name)).toMatchObject({
        location: "query",
        required: false,
        repeatable: false,
        schemaRef: `TaskGroupRunsInput#/properties/${name}`,
      });
  });

  it("refuses an expanded service response instead of sending prompt bodies over the collection route", async () => {
    const f = await fixture();
    const malformed = {
      ...result,
      members: [{ ...result.members[0]!, prompt: "must not escape" }],
    };
    f.page.mockResolvedValueOnce(malformed);
    const response = await f.get();
    expect(response.status).toBe(500);
    ControlProblem.parse(await response.json());
    expect(f.page).toHaveBeenCalledOnce();
  });

  it("aborts only the pending read on an actual socket disconnect", async () => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let readSignal: AbortSignal | undefined;
    f.page.mockImplementationOnce(async (_input, signal) => {
      readSignal = signal;
      entered();
      await new Promise<void>((resolve) => {
        if (signal!.aborted) return resolve();
        signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      settled();
      return result;
    });
    const client = request(`${f.base}/v2/task-groups/${GROUP}/runs`, { headers });
    client.on("error", () => {});
    client.end();
    try {
      await bounded(started);
      expect(readSignal?.aborted).toBe(false);
      client.destroy();
      await bounded(done);
      expect(readSignal?.aborted).toBe(true);
      expect(f.page).toHaveBeenCalledOnce();
    } finally {
      client.destroy();
    }
  });
});

describe("readTaskGroupRuns page building", () => {
  const observation = {
    status: "running" as const,
    pending: false,
    token: "T".repeat(43),
    problem: null,
  };
  const record = (jobId: string): RunObservationRecord => ({
    jobId,
    runId: `run-${jobId}`,
    partition: "global",
    epoch: "e".repeat(32),
    state: "running",
    createdAt: "2026-10-22T00:00:00.000Z",
    taskGroupId: GROUP,
  });
  function host(records: RunObservationRecord[], hasMore: boolean) {
    return {
      storeId: () => STORE,
      page: vi.fn((_query: TaskGroupPageQuery) => ({
        records,
        hasMore,
        viewToken: "V".repeat(43),
      })),
      snapshot: vi.fn(async (ids: readonly string[]) => ids.map(() => observation)),
    };
  }

  it("serves the store's canonical rows for any spelling of the group and echoes the caller's", async () => {
    const lettered = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const upper = lettered.toUpperCase();
    const h = host(
      [record("job-a"), record("job-b")].map((row) => ({ ...row, taskGroupId: lettered })),
      true,
    );
    const first = await readTaskGroupRuns({ taskGroupId: upper, limit: 1 }, h);
    expect(first).toMatchObject({ taskGroupId: upper, hasMore: true });
    expect(first.members.map((member) => member.jobId)).toEqual(["job-a"]);
    // A cursor from one spelling continues the page of another.
    const next = await readTaskGroupRuns(
      { taskGroupId: lettered, limit: 1, cursor: first.nextCursor! },
      h,
    );
    expect(next.taskGroupId).toBe(lettered);
    expect(h.page.mock.calls[1]![0].cursor).toMatchObject({ taskGroupId: upper });
  });

  it("refuses a page row from another group as an invalid service response", async () => {
    const h = host(
      [{ ...record("job-a"), taskGroupId: "33333333-3333-4333-8333-333333333333" }],
      false,
    );
    await expect(readTaskGroupRuns({ taskGroupId: GROUP, limit: 5 }, h)).rejects.toMatchObject({
      code: "invalid_service_response",
      status: 500,
    });
  });

  it("answers a typed 500 when a first member cannot fit the page or a cursor cannot be encoded", async () => {
    const huge = host([record("x".repeat(TASK_GROUP_RUNS_RESULT_BYTES))], false);
    await expect(readTaskGroupRuns({ taskGroupId: GROUP, limit: 5 }, huge)).rejects.toMatchObject({
      code: "task_group_member_too_large",
      status: 500,
    });
    // The page fits, but the cursor naming its last member would exceed 2048 characters.
    const long = host([record("y".repeat(TASK_GROUP_CURSOR_CHARS)), record("job-next")], true);
    await expect(readTaskGroupRuns({ taskGroupId: GROUP, limit: 1 }, long)).rejects.toMatchObject({
      code: "invalid_service_response",
      status: 500,
    });
  });

  it("keeps the longest byte-bounded prefix with room for its cursor, serializing each member once", async () => {
    const id = (i: number) => `${String(i).padStart(3, "0")}-${"é".repeat(250)}`;
    const records = Array.from({ length: 201 }, (_, i) => record(id(i)));
    const h = host(records, true);
    const original = JSON.stringify.bind(JSON);
    let serialized = 0;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      const text = original(...(args as Parameters<typeof JSON.stringify>));
      serialized += text?.length ?? 0;
      return text;
    });
    const result = await readTaskGroupRuns({ taskGroupId: GROUP, limit: 200 }, h);
    stringify.mockRestore();
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThanOrEqual(TASK_GROUP_RUNS_RESULT_BYTES);
    expect(result.members.length).toBeGreaterThan(0);
    expect(result.members.length).toBeLessThan(200);
    expect(result.hasMore).toBe(true);
    expect(decodeTaskGroupCursor(result.nextCursor!).last.id).toBe(result.members.at(-1)!.jobId);
    // One more member would not fit beside a cursor of the largest size.
    const following = records[result.members.length]!;
    const grown = {
      ...result,
      members: [
        ...result.members,
        {
          jobId: following.jobId,
          runId: following.runId,
          createdAt: following.createdAt,
          observation,
        },
      ],
      nextCursor: "c".repeat(TASK_GROUP_CURSOR_CHARS),
    };
    expect(Buffer.byteLength(JSON.stringify(grown), "utf8")).toBeGreaterThan(
      TASK_GROUP_RUNS_RESULT_BYTES,
    );
    // Re-serializing the page per member would be quadratic in its size.
    expect(serialized).toBeLessThan(5 * bytes);
  });
});
