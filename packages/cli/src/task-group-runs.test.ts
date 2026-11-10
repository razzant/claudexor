import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskGroupRunsInput,
  TaskGroupRunsResult,
  encodeTaskGroupCursor,
  decodeTaskGroupCursor,
  type TaskGroupRunsInput as GroupInput,
} from "@claudexor/schema";
import { InteractionRegistry, digestPendingIdentities } from "../../daemon/src/interactions.js";
import { readRunObservations } from "../../daemon/src/run-observation.js";
import { applyCommandInTx, prepareCommandRow } from "../../daemon/src/store/command-rows.js";
import { SqlCommandQueries } from "../../daemon/src/store/command-queries.js";
import { SqlEventLedger } from "../../daemon/src/store/event-store.js";
import { setGlobalGenerationInTx } from "../../daemon/src/store/generations.js";
import { SqlInteractionStore } from "../../daemon/src/store/interactions.js";
import { runMutation } from "../../daemon/src/store/mutation.js";
import { createPartition } from "../../daemon/src/store/partitions.js";
import { resourceFixture } from "../../daemon/src/store/test-support/resource-fixture.js";
import { parseArgs } from "./args.js";
import { CLI_COMMANDS, VALUE_FLAGS } from "./command-registry.js";
import { commandFlagScopeError, commandPositionalError } from "./command-scope.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { sqlControlReadSources } from "./sql-daemon-queries.js";
import { taskGroupRunsCommand, taskGroupRunsQuery } from "./task-group-runs.js";

const daemon = vi.hoisted(() => ({
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
vi.mock("./daemon-run.js", () => daemon);
const GROUP = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TIME = "2026-10-22T00:00:00.000Z";
const body = {
  taskGroupId: GROUP,
  storeId: STORE,
  visibility: "current_served_generations" as const,
  retention: "retained_only" as const,
  viewToken: "A".repeat(43),
  members: [
    {
      jobId: "job-a",
      runId: null,
      createdAt: TIME,
      observation: {
        status: "queued" as const,
        pending: false,
        token: "B".repeat(43),
        problem: null,
      },
    },
  ],
  hasMore: true,
  nextCursor: "next-page",
};

describe("thin CLI task-group-runs adapter", () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  let stdout = "";
  let stderr = "";
  beforeEach(() => {
    vi.resetAllMocks();
    stdout = "";
    stderr = "";
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    daemon.connectDaemonIfRunning.mockResolvedValue({
      addr: { baseUrl: "http://task-group.invalid", token: "fixture-token" },
    });
    fetch.mockResolvedValue(Response.json(body));
  });
  afterEach(() => {
    expect(daemon.ensureDaemon).not.toHaveBeenCalled();
    expect(daemon.enqueueAndAwait).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends one authenticated GET page with encoded filters and never follows hasMore", async () => {
    const input = {
      taskGroupId: GROUP,
      limit: 2,
      state: "queued",
      cursor: "opaque+/=&",
      expectedStoreId: STORE,
    };
    expect(await taskGroupRunsQuery(input)).toEqual(body);
    expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [target, init] = fetch.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.origin + url.pathname).toBe(
      `http://task-group.invalid/v2/task-groups/${GROUP}/runs`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "2",
      state: "queued",
      cursor: "opaque+/=&",
      expectedStoreId: STORE,
    });
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-token");
    expect(headers.has("Idempotency-Key")).toBe(false);
  });

  it("prints a single schema-valid JSON page from positional UUID and spec flags", async () => {
    const code = await taskGroupRunsCommand(
      parseArgs([
        "task-group-runs",
        GROUP,
        "--limit",
        "2",
        "--state",
        "queued",
        "--cursor",
        "opaque+/=&",
        "--expected-store-id",
        STORE,
        "--json",
      ]),
      true,
    );
    expect(code).toBe(0);
    expect(TaskGroupRunsResult.parse(JSON.parse(stdout))).toEqual(body);
    expect(stderr).toBe("");
    expect(fetch).toHaveBeenCalledOnce();
    const query = new URL(String(fetch.mock.calls[0]![0])).searchParams;
    expect(query.get("limit")).toBe("2");
    expect(query.get("state")).toBe("queued");
    expect(query.get("cursor")).toBe("opaque+/=&");
    expect(query.get("expectedStoreId")).toBe(STORE);
  });

  it.each([
    [],
    ["not-a-uuid"],
    [GROUP, "--limit"],
    [GROUP, "--limit", "0"],
    [GROUP, "--limit", "201"],
    [GROUP, "--limit", "1.5"],
    [GROUP, "--limit", "2x"],
    [GROUP, "--state", "pending"],
    [GROUP, "--cursor"],
    [GROUP, "--cursor", "c".repeat(2049)],
    [GROUP, "--expected-store-id", ""],
  ])("rejects malformed CLI case %# before discovery", async (...args) => {
    expect(
      await taskGroupRunsCommand(parseArgs(["task-group-runs", ...args, "--json"]), true),
    ).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: "invalid_argument", exitCode: 2 });
    expect(stderr).toBe("");
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { taskGroupId: "bad" },
    { taskGroupId: GROUP, limit: "2" },
    { taskGroupId: GROUP, total: true },
    { taskGroupId: GROUP, state: "pending" },
  ])("rejects strict direct input before discovery: %j", async (input) => {
    await expect(taskGroupRunsQuery(input)).rejects.toBeDefined();
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails typed when no daemon is running", async () => {
    daemon.connectDaemonIfRunning.mockResolvedValue(null);
    await expect(taskGroupRunsQuery({ taskGroupId: GROUP })).rejects.toMatchObject({
      code: "daemon_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([404, 503])(
    "preserves HTTP %i typed failures without list fallback or retry",
    async (status) => {
      fetch.mockResolvedValue(
        Response.json(
          {
            code: "task_group_runs_unavailable",
            message: "unsupported backend",
            retryable: false,
            requiredActions: ["use a supporting daemon"],
            fieldErrors: {},
            evidenceRefs: [],
            context: {},
          },
          { status },
        ),
      );
      await expect(taskGroupRunsQuery({ taskGroupId: GROUP })).rejects.toMatchObject({
        code: "task_group_runs_unavailable",
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(["text", "legacy-json"])(
    "reports a legacy %s missing route as a typed failure",
    async (format) => {
      fetch.mockResolvedValue(
        format === "text"
          ? new Response("Not Found", { status: 404 })
          : Response.json({ error: "Not Found" }, { status: 404 }),
      );
      await expect(taskGroupRunsQuery({ taskGroupId: GROUP })).rejects.toMatchObject({
        code: "task_group_runs_unavailable",
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ...body, taskGroupId: OTHER },
    { ...body, storeId: OTHER },
    { ...body, total: 3 },
    { ...body, retention: "all_history" },
    { ...body, members: [{ ...body.members[0]!, prompt: "body" }] },
    {
      ...body,
      members: [
        {
          ...body.members[0]!,
          observation: {
            status: null,
            pending: false,
            token: null,
            problem: "snapshot_unavailable",
          },
        },
      ],
    },
  ])("refuses wrong authority or expanded daemon response case %#", async (reply) => {
    fetch.mockResolvedValue(Response.json(reply));
    await expect(
      taskGroupRunsQuery({ taskGroupId: GROUP, expectedStoreId: STORE }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("routes MCP through the same one-page CLI query with the host signal", async () => {
    const host = new AbortController();
    expect(
      await mcpSurfaceRunner()(
        { mode: "__task_group_runs", taskGroupId: GROUP, limit: 1 },
        { signal: host.signal },
      ),
    ).toEqual(body);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts before discovery and forwards cancellation to only the pending HTTP read", async () => {
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      taskGroupRunsQuery({ taskGroupId: GROUP }, false, stopped.signal),
    ).rejects.toBeDefined();
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    const host = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
          enter();
        }),
    );
    const pending = taskGroupRunsQuery({ taskGroupId: GROUP }, false, host.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await entered;
    host.abort();
    await rejected;
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the collection read outside Delegate authority", async () => {
    await expect(taskGroupRunsQuery({ taskGroupId: GROUP }, true)).rejects.toMatchObject({
      code: "delegation_forbidden",
    });
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({
        mode: "__task_group_runs",
        taskGroupId: GROUP,
      }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("registers one positional UUID read verb and only recovery flags", () => {
    const commands = CLI_COMMANDS.filter((entry) => entry.id === "task-group-runs");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ mutability: "read" });
    expect(commands[0]!.flags).toEqual(
      expect.arrayContaining(["limit", "state", "cursor", "expected-store-id", "json"]),
    );
    expect(commandPositionalError("task-group-runs", [GROUP])).toBeNull();
    expect(commandPositionalError("task-group-runs", [])).not.toBeNull();
    expect(commandPositionalError("task-group-runs", [GROUP, OTHER])).not.toBeNull();
    for (const flag of ["limit", "state", "cursor", "expected-store-id"])
      expect(VALUE_FLAGS).toContain(flag);
    for (const flag of ["resume", "delegate", "harness", "max-seconds", "prompt-file"])
      expect(commandFlagScopeError("task-group-runs", [flag])).toContain(`--${flag}`);
  });
});

const closeSql: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closeSql.splice(0).reverse()) await close();
});

async function sqlFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-task-group-projection-")));
  // The parent supplies an isolated TMPDIR; retain scratch after resource teardown.
  const f = await resourceFixture(root, { manualTick: true, now: () => new Date(TIME) });
  closeSql.push(() => f.close());
  const generation = f.store.transaction(() => {
    const p = createPartition(f.store, "global", { epoch: "a".repeat(32) });
    setGlobalGenerationInTx(f.store, p.pid);
    return p;
  });
  const queries = new SqlCommandQueries(f.store, f.blobs);
  const snapshotPendingIdentities = vi.fn(
    async (ids: readonly string[]) =>
      new Map(
        ids.map(
          (id) =>
            [
              id,
              id === "run-unavailable"
                ? new Error("identities unavailable")
                : digestPendingIdentities(id === "run-question" ? ["question-a"] : []),
            ] as const,
        ),
      ),
  );
  const graph = {
    store: f.store,
    commands: { queries },
    interactions: { snapshotPendingIdentities },
    terminalFiles: {
      pending: vi.fn(() => {
        throw new Error("group observation attempted output-readiness hydration");
      }),
    },
  };
  const current = vi.fn(
    () => graph as unknown as ReturnType<Parameters<typeof sqlControlReadSources>[0]>,
  );
  let storeId: string | undefined = STORE;
  const source = sqlControlReadSources(current, () => storeId);
  function seed(id: string, runId: string | null = `run-${id}`, createdAt = TIME) {
    const row = prepareCommandRow(
      {
        id,
        state: runId ? "running" : "queued",
        runId: runId ?? undefined,
        createdAt,
        params: { mode: "ask", taskGroupId: GROUP, prompt: "must not hydrate" },
      },
      { pid: generation.pid, live: true, operation: "ask", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, row, "accept"));
  }
  const input = (extra: Partial<GroupInput> = {}) =>
    TaskGroupRunsInput.parse({ taskGroupId: GROUP, ...extra });
  return {
    ...f,
    generation,
    queries,
    source,
    seed,
    input,
    current,
    graph,
    snapshotPendingIdentities,
    changeStore: (id?: string) => {
      storeId = id;
    },
  };
}

describe("daemon-owned group projection over real SQLite and shared observations", () => {
  it("feeds the daemon's waits from the engine store's committed notices", async () => {
    const f = await sqlFixture();
    const notices: string[][] = [];
    const unsubscribe = f.source.runObservationChanges((changed) =>
      notices.push([...(changed ?? [])].sort()),
    );
    const row = prepareCommandRow(
      {
        id: "job-fed",
        state: "running",
        runId: "run-fed",
        createdAt: TIME,
        params: { mode: "ask" },
      },
      { pid: f.generation.pid, live: true, operation: "ask", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    runMutation(f.store, (tx) => applyCommandInTx(tx, row, "accept"));
    expect(notices).toEqual([["job-fed", "run-fed"]]);
    unsubscribe();
  });

  it("keeps group members compact while the same composition answers the wait-many opt-in (#628)", async () => {
    const f = await sqlFixture();
    const pending = new SqlInteractionStore(
      f.store,
      new SqlEventLedger(f.store, f.blobs, f.generation),
    );
    const registry = new InteractionRegistry({
      forRequest: () => pending,
      forRun: () => pending,
    });
    (f.graph as { interactions: unknown }).interactions = registry;
    f.seed("job-async", "run-async");
    f.seed("job-blocking", "run-blocking");
    const asked = (["async", "blocking"] as const).map((delivery) =>
      registry.register(
        {
          runId: `run-${delivery}`,
          taskId: "task",
          attemptId: "a01",
          harnessId: "codex",
          request: { interaction_id: "q", source_tool: "fixture", delivery, questions: [] },
          requestedAt: TIME,
          timeoutAt: null,
        },
        {},
      ),
    );
    const page = await f.source.taskGroupRuns(f.input());
    expect(TaskGroupRunsResult.parse(page)).toEqual(page);
    expect(page.members.map((member) => Object.keys(member.observation))).toEqual([
      ["status", "pending", "token", "problem"],
      ["status", "pending", "token", "problem"],
    ]);
    expect(page.members.map((member) => member.observation.pending)).toEqual([true, true]);
    const ids = page.members.map((member) => member.jobId);
    const marked = await f.source.runObservations(ids, undefined, { includeBlocking: true });
    expect(marked.map((row) => [row.token, "blocking" in row && row.blocking])).toEqual(
      page.members.map((member) => [
        member.observation.token,
        member.jobId === "job-async" ? false : true,
      ]),
    );
    expect(await f.source.runObservations(ids)).toEqual(
      page.members.map((member) => member.observation),
    );
    for (const runId of ["run-async", "run-blocking"]) registry.dropForRun(runId);
    await Promise.all(asked);
  });

  it("selects one bounded page and projects canonical job/run handles with the shared snapshot tokens", async () => {
    const f = await sqlFixture();
    f.seed("job-a", "run-question");
    f.seed("job-b", "run-unavailable");
    f.seed("job-c", null);
    const page = vi.spyOn(f.queries, "taskGroupPage");
    const blobs = vi.spyOn(f.blobs, "read");
    const detail = vi.spyOn(f.queries, "getByRunId");
    const result = await f.source.taskGroupRuns(f.input());
    expect(TaskGroupRunsResult.parse(result)).toEqual(result);
    expect(page).toHaveBeenCalledExactlyOnceWith({
      taskGroupId: GROUP,
      limit: 50,
      state: null,
      cursor: null,
      storeId: STORE,
    });
    expect(result.members.map((m) => [m.jobId, m.runId])).toEqual([
      ["job-c", null],
      ["job-b", "run-unavailable"],
      ["job-a", "run-question"],
    ]);
    expect(result.members.map((m) => m.observation)).toEqual(
      await readRunObservations(
        f.queries,
        f.graph.interactions,
        STORE,
        result.members.map((m) => m.jobId),
      ),
    );
    expect(result.members[1]!.observation).toEqual({
      status: null,
      pending: null,
      token: null,
      problem: "snapshot_unavailable",
    });
    expect(result.members[2]!.observation).toMatchObject({
      status: "running",
      pending: true,
      problem: null,
    });
    expect(blobs).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });

  it("returns an honestly scoped empty page and refuses missing/swapped store authority before selection", async () => {
    const f = await sqlFixture();
    const page = vi.spyOn(f.queries, "taskGroupPage");
    const result = await f.source.taskGroupRuns(f.input());
    expect(result).toMatchObject({
      taskGroupId: GROUP,
      storeId: STORE,
      visibility: "current_served_generations",
      retention: "retained_only",
      members: [],
      hasMore: false,
      nextCursor: null,
    });
    page.mockClear();
    await expect(
      f.source.taskGroupRuns(f.input({ expectedStoreId: "foreign-nonempty-store" })),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/store.*mismatch|mismatch.*store/),
      status: 409,
    });
    expect(page).not.toHaveBeenCalled();
    f.changeStore();
    await expect(f.source.taskGroupRuns(f.input())).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(page).not.toHaveBeenCalled();
  });

  it("serves an opaque non-UUID store identity through the actual composition", async () => {
    const f = await sqlFixture();
    f.changeStore("store:opaque/non-uuid");
    f.seed("job-a");
    f.seed("job-b");
    const first = await f.source.taskGroupRuns(
      f.input({ expectedStoreId: "store:opaque/non-uuid", limit: 1 }),
    );
    expect(first.storeId).toBe("store:opaque/non-uuid");
    expect(decodeTaskGroupCursor(first.nextCursor!).storeId).toBe(first.storeId);
  });

  it("byte-paginates once, advances only returned keys and eventually returns every retained row", async () => {
    const f = await sqlFixture();
    const expected: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `job-${String(i).padStart(3, "0")}-${"j".repeat(420)}`;
      expected.push(id);
      f.seed(id, `run-${"r".repeat(420)}-${i}`);
    }
    const page = vi.spyOn(f.queries, "taskGroupPage");
    let cursor: string | undefined;
    let pages = 0;
    const actual: string[] = [];
    do {
      const result = await f.source.taskGroupRuns(
        f.input({ limit: 200, ...(cursor ? { cursor } : {}) }),
      );
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(131_072);
      expect(result.members.length).toBeGreaterThan(0);
      actual.push(...result.members.map((m) => m.jobId));
      if (result.hasMore) {
        expect(result.members.length).toBeLessThan(200);
        const decoded = decodeTaskGroupCursor(result.nextCursor!);
        expect(decoded.last).toEqual({
          id: result.members.at(-1)!.jobId,
          createdAt: result.members.at(-1)!.createdAt,
        });
        expect(decoded).toMatchObject({
          taskGroupId: GROUP,
          state: null,
          storeId: STORE,
          viewToken: result.viewToken,
        });
      } else expect(result.nextCursor).toBeNull();
      cursor = result.nextCursor ?? undefined;
      expect(page).toHaveBeenCalledTimes(++pages);
      expect(pages).toBeLessThanOrEqual(200);
    } while (cursor);
    expect(actual).toEqual(expected.reverse());
    expect(new Set(actual).size).toBe(200);
  });

  it.each(["oversized", "malformed"])(
    "rejects the first %s member with a typed error rather than skipping it",
    async (kind) => {
      const f = await sqlFixture();
      f.seed("job-first", kind === "oversized" ? "界".repeat(45_000) : "run-first");
      if (kind === "malformed")
        f.store.transaction(() =>
          f.store.prepare("UPDATE command SET created_at='' WHERE id='job-first'").run(),
        );
      await expect(f.source.taskGroupRuns(f.input())).rejects.toMatchObject({
        code: expect.any(String),
      });
      expect(f.store.prepare("SELECT id FROM command WHERE id='job-first'").get()).toMatchObject({
        id: "job-first",
      });
    },
  );

  it("leaves an oversized unreturned member at the next cursor rather than skipping to a smaller sibling", async () => {
    const f = await sqlFixture();
    f.seed("job-z", "run-small-first");
    f.seed("job-y", "界".repeat(45_000));
    f.seed("job-x", "run-small-last");
    const first = await f.source.taskGroupRuns(f.input());
    expect(first.members.map((m) => m.jobId)).toEqual(["job-z"]);
    expect(first.hasMore).toBe(true);
    expect(decodeTaskGroupCursor(first.nextCursor!).last).toEqual({ id: "job-z", createdAt: TIME });
    await expect(
      f.source.taskGroupRuns(f.input({ cursor: first.nextCursor! })),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });

  it.each(["group", "state", "store", "view", "extra"] as const)(
    "strictly refuses foreign/stale cursor %s binding without fallback",
    async (field) => {
      const f = await sqlFixture();
      f.seed("job-a");
      f.seed("job-b");
      const first = await f.source.taskGroupRuns(f.input({ limit: 1 }));
      const cursor = decodeTaskGroupCursor(first.nextCursor!);
      const changed = {
        ...cursor,
        ...(field === "group"
          ? { taskGroupId: OTHER }
          : field === "state"
            ? { state: "queued" }
            : field === "store"
              ? { storeId: OTHER }
              : field === "view"
                ? { viewToken: "Z".repeat(43) }
                : { offset: 0 }),
      };
      // Deliberately encode raw JSON to exercise strict decoder admission, including unknown fields.
      const encoded = Buffer.from(JSON.stringify(changed)).toString("base64url");
      const prepare = vi.spyOn(f.store, "prepare");
      await expect(f.source.taskGroupRuns(f.input({ cursor: encoded }))).rejects.toMatchObject({
        code: expect.any(String),
      });
      expect(
        prepare.mock.calls.map(([sql]) => sql).filter((sql) => /\bFROM\s+command\b/i.test(sql)),
      ).toEqual([]);
      expect(first.nextCursor).toBe(encodeTaskGroupCursor(cursor));
    },
  );
});
