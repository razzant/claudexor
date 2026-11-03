/**
 * A run receipt and a run 404 name the store that actually answered (#163).
 *
 * Real SQL stores, command and thread owners, daemon socket, HTTP control API and
 * thin clients; only the worker is synthetic. No harness, credential, installed
 * engine or live data root is involved.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonServer } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import {
  CONTROL_STORE_IDENTITY_HEADER,
  ControlOperationCatalog,
  ControlProblem,
  ControlRunRetryResponse,
  ControlThreadTurnResponse,
  McpRunToolResult,
  McpThreadTurnResult,
} from "@claudexor/schema";
import { ControlThreadTurnResponse as ShippedThreadTurnResponse } from "../../daemon/src/store/test-support/fixtures/legacy/schema/control-operation-responses.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { defaultClaudexorTools } from "../../mcp-server/src/index.js";
import { formatRunResult, structuredRunResult } from "../../mcp-server/src/run-result-format.js";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { projectTerminalRunOutput } from "./terminal-run-output.js";
import { threadTurnServices } from "./thread-turn-services.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const TOKEN = "store-identity-fixture";
const BIND = "bind a run";
const WAIT = "stay unbound";
const REFUSE = "refuse before a run";
const REFUSE_ONCE = "refuse once before a run";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

interface EngineOptions {
  /** Replaces the real provider: an embedder or a daemon with no identity stays unknown. */
  identity?: () => (() => string | undefined) | undefined;
  runStartTimeoutMs?: number;
  /** The accepted job's record cannot be read back. */
  statusFails?: boolean;
}

async function engine(options: EngineOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-store-id-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanups.push(() => sql.close());
  const refusedOnce = new Set<string>();
  const daemon = new DaemonServer({
    socketPath: join(root, "d.sock"),
    token: TOKEN,
    commands: sql.graph.commands,
    runner: async (request, ctx) => {
      const prompt = (request as { prompt?: unknown }).prompt;
      const refuse =
        prompt === REFUSE || (prompt === REFUSE_ONCE && !refusedOnce.has(String(prompt)));
      if (refuse) {
        refusedOnce.add(String(prompt));
        throw Object.assign(new Error("fixture refused before its run"), {
          code: "fixture_pre_run_failure",
          status: 403,
          retryable: false,
          // Producer context is not an authority on which store answered.
          context: { storeId: "producer-context" },
        });
      }
      if (prompt !== WAIT) {
        const runDir = join(root, ctx.jobId);
        mkdirSync(runDir);
        ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: `task-${ctx.jobId}`, runDir });
      }
      await new Promise<void>((done) => {
        if (ctx.signal.aborted) done();
        else ctx.signal.addEventListener("abort", () => done(), { once: true });
      });
      return { lifecycle: "cancelled" };
    },
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  const client = new DaemonClient(join(root, "d.sock"), TOKEN);
  const real = sql.store.storeId;
  const identity = options.identity ? options.identity() : () => sql.store.storeId;
  const control = new DaemonControlApiServer({
    token: TOKEN,
    daemon: options.statusFails
      ? {
          enqueue: (params, enqueue) => client.enqueue(params, enqueue),
          findAccepted: (params, accepted) => client.findAccepted(params, accepted),
          list: (query) => client.list(query),
          cancel: (id, reason) => client.cancel(id, reason),
          status: async () => {
            throw new Error("the record could not be read back");
          },
        }
      : client,
    pollMs: 5,
    ...(options.runStartTimeoutMs !== undefined
      ? { runStartTimeoutMs: options.runStartTimeoutMs }
      : {}),
    ...(identity ? { storeId: identity } : {}),
    services: threadTurnServices(sql.graph.threads, sql.graph.resources),
  });
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const base = `http://${host}:${port}`;
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "X-Claudexor-Protocol-Major": "3",
  };
  const post = (path: string, body: unknown, key: string, optIn: boolean) =>
    fetch(`${base}/v2${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "Idempotency-Key": key,
        ...(optIn ? { [CONTROL_STORE_IDENTITY_HEADER]: "1" } : {}),
      },
      body: JSON.stringify(body),
    });
  const run = (prompt: string) => ({ mode: "ask", prompt, scope: { kind: "none" } });
  const thread = () => sql.graph.threads.createThread({ title: "fixture", mode: "ask" }).id;
  return {
    sql,
    client,
    base,
    real,
    addr: { baseUrl: base, token: TOKEN },
    get: (path: string) => fetch(`${base}/v2${path}`, { headers }),
    post,
    run,
    thread,
  };
}

/** A receipt's store: top-level on an accepted handle, `context` on a pre-run refusal. */
function receiptStore(status: number, body: Record<string, unknown>): unknown {
  return status >= 400 ? ControlProblem.parse(body).context["storeId"] : body["storeId"];
}

const DISPOSITIONS = [
  ["bound", BIND, 200, undefined],
  ["queued", WAIT, 202, 0],
  ["refused before its run", REFUSE, 403, undefined],
] as const;

describe.each(DISPOSITIONS)("an ordinary %s admission", (_name, prompt, status, timeout) => {
  it("names the accepting store on POST /v2/runs only for a request that opted in", async () => {
    const f = await engine({ runStartTimeoutMs: timeout });
    const legacy = await f.post("/runs", f.run(prompt), "legacy", false);
    expect(legacy.status).toBe(status);
    const legacyBody = (await legacy.json()) as Record<string, unknown>;
    expect(receiptStore(status, legacyBody)).toBeUndefined();
    expect(legacyBody).not.toHaveProperty("storeId");

    const bound = await f.post("/runs", f.run(prompt), "opted-in", true);
    expect(bound.status).toBe(status);
    const body = (await bound.json()) as Record<string, unknown>;
    expect(receiptStore(status, body)).toBe(f.real);

    // A replay of the same key is the same accepted job, projected for this request.
    const replay = await f.post("/runs", f.run(prompt), "opted-in", true);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(receiptStore(status, replayBody)).toBe(f.real);
    const handle = (value: Record<string, unknown>) =>
      status >= 400 ? ControlProblem.parse(value).context["jobId"] : value["jobId"];
    expect(handle(replayBody)).toBe(handle(body));
    const unopted = await f.post("/runs", f.run(prompt), "opted-in", false);
    const unoptedBody = (await unopted.json()) as Record<string, unknown>;
    expect(handle(unoptedBody)).toBe(handle(body));
    expect(receiptStore(status, unoptedBody)).toBeUndefined();
  });

  it("names the accepting store on POST /v2/threads/:id/turns only for a request that opted in", async () => {
    const f = await engine({ runStartTimeoutMs: timeout });
    const legacy = await f.post(`/threads/${f.thread()}/turns`, { prompt }, "legacy", false);
    expect(legacy.status).toBe(status);
    const legacyBody = (await legacy.json()) as Record<string, unknown>;
    expect(legacyBody).not.toHaveProperty("storeId");
    if (status < 400) {
      // The client already in the field keeps parsing what it receives.
      expect(ShippedThreadTurnResponse.safeParse(legacyBody).success).toBe(true);
    } else {
      expect(ControlProblem.parse(legacyBody).context["storeId"]).toBeUndefined();
    }

    const threadId = f.thread();
    const optIn = await f.post(`/threads/${threadId}/turns`, { prompt }, "opted-in", true);
    expect(optIn.status).toBe(status);
    const body = (await optIn.json()) as Record<string, unknown>;
    expect(receiptStore(status, body)).toBe(f.real);
    if (status < 400) {
      expect(ControlThreadTurnResponse.parse(body)).toMatchObject({ threadId, storeId: f.real });
    } else {
      expect(ControlProblem.parse(body).context).toMatchObject({ threadId });
    }
    const replay = await f.post(`/threads/${threadId}/turns`, { prompt }, "opted-in", true);
    expect(receiptStore(status, (await replay.json()) as Record<string, unknown>)).toBe(f.real);
  });
});

describe("store identity on the strict queued thread-turn receipt", () => {
  it("is why the field is opt-in: the shipped strict branch refuses an unsolicited key", async () => {
    const f = await engine({ runStartTimeoutMs: 0 });
    const optIn = (await (
      await f.post(`/threads/${f.thread()}/turns`, { prompt: WAIT }, "opted-in", true)
    ).json()) as Record<string, unknown>;
    expect(optIn["storeId"]).toBe(f.real);
    expect(ShippedThreadTurnResponse.safeParse(optIn).success).toBe(false);
    const { storeId: _store, ...shape } = optIn;
    expect(ShippedThreadTurnResponse.safeParse(shape).success).toBe(true);
  });
});

describe("an accepted job whose start could not be read back", () => {
  it("keeps its handle and claims no store, because no store answered for that job", async () => {
    const f = await engine({ statusFails: true });
    const run = await f.post("/runs", f.run(WAIT), "run", true);
    expect(run.status).toBe(500);
    const runContext = ControlProblem.parse(await run.json()).context;
    expect(runContext["jobId"]).toEqual(expect.any(String));
    expect(runContext).not.toHaveProperty("storeId");
    const threadId = f.thread();
    const turn = await f.post(`/threads/${threadId}/turns`, { prompt: WAIT }, "turn", true);
    expect(turn.status).toBe(500);
    const turnContext = ControlProblem.parse(await turn.json()).context;
    expect(turnContext).toMatchObject({ threadId, jobId: expect.any(String) });
    expect(turnContext).not.toHaveProperty("storeId");
  });
});

describe("recovery admissions", () => {
  it("Exact Retry names the accepting store only for a request that opted in", async () => {
    const f = await engine();
    const source = (await (await f.post("/runs", f.run(BIND), "source", false)).json()) as {
      jobId: string;
      runId: string;
    };
    f.sql.graph.commands.findById(source.jobId)!.update(source.jobId, { state: "succeeded" });
    const legacy = await f.post(`/runs/${source.runId}/retry`, {}, "retry-legacy", false);
    expect(legacy.status).toBe(200);
    const legacyBody = await legacy.json();
    expect(legacyBody).not.toHaveProperty("storeId");
    expect(ControlRunRetryResponse.parse(legacyBody).storeId).toBeUndefined();

    const next = (await (await f.post("/runs", f.run(BIND), "source-2", false)).json()) as {
      jobId: string;
      runId: string;
    };
    f.sql.graph.commands.findById(next.jobId)!.update(next.jobId, { state: "succeeded" });
    const optIn = await f.post(`/runs/${next.runId}/retry`, {}, "retry-opted-in", true);
    expect(optIn.status).toBe(200);
    expect(ControlRunRetryResponse.parse(await optIn.json()).storeId).toBe(f.real);
  });

  it("the refused-turn retry names the accepting store only for a request that opted in", async () => {
    const f = await engine();
    const threadId = f.thread();
    const refused = await f.post(`/threads/${threadId}/turns`, { prompt: REFUSE_ONCE }, "t", false);
    expect(refused.status).toBe(403);
    const turnId = ControlProblem.parse(await refused.json()).context["turnId"] as string;
    f.sql.graph.threads.setTurnEnqueueError(turnId, {
      message: "fixture refused before its run",
      code: "fixture_pre_run_failure",
      retryable: true,
      required_actions: [],
      context: {},
    });
    const retried = await f.post(`/threads/${threadId}/turns/${turnId}/retry`, {}, "r", true);
    expect(retried.status).toBe(200);
    expect(ControlThreadTurnResponse.parse(await retried.json())).toMatchObject({
      turnId,
      storeId: f.real,
    });
    const replay = await f.post(`/threads/${threadId}/turns/${turnId}/retry`, {}, "r", false);
    expect(replay.status).toBe(200);
    expect(await replay.json()).not.toHaveProperty("storeId");
  });
});

describe("an engine without a store identity", () => {
  const noProvider: EngineOptions["identity"] = () => undefined;
  const closedStore: EngineOptions["identity"] = () => () => undefined;
  const emptyIdentity: EngineOptions["identity"] = () => () => "";
  it.each([
    ["no provider", noProvider],
    ["a closed store", closedStore],
    ["an empty identity", emptyIdentity],
  ] as const)("still admits and claims nothing with %s", async (_name, identity) => {
    const f = await engine({ identity });
    const run = await f.post("/runs", f.run(BIND), "run", true);
    expect(run.status).toBe(200);
    expect(await run.json()).not.toHaveProperty("storeId");
    const turn = await f.post(`/threads/${f.thread()}/turns`, { prompt: BIND }, "turn", true);
    expect(turn.status).toBe(200);
    expect(await turn.json()).not.toHaveProperty("storeId");
    const absent = await f.get("/runs/run-missing");
    expect(absent.status).toBe(404);
    expect(ControlProblem.parse(await absent.json())).toMatchObject({
      code: "http_404",
      message: "no such run",
      context: {},
    });
  });
});

describe("GET /v2/runs/:id absence", () => {
  it("names the store that answered, keeping the typed problem", async () => {
    const f = await engine();
    const absent = await f.get("/runs/run-missing");
    expect(absent.status).toBe(404);
    expect(absent.headers.get("content-type")).toContain("application/problem+json");
    expect(await absent.json()).toEqual({
      code: "http_404",
      message: "no such run",
      retryable: false,
      fieldErrors: {},
      requiredActions: [],
      evidenceRefs: [],
      context: { storeId: f.real },
    });
    // The named store is the durable row itself, not a value derived from the request or process.
    const row = f.sql.store.prepare("SELECT value FROM meta WHERE key='store_id'").get() as {
      value: string;
    };
    expect(row.value).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(f.real).toBe(row.value);
  });

  it("from another store never matches the receipt of the store that accepted the run", async () => {
    const accepting = await engine();
    const foreign = await engine();
    expect(foreign.real).not.toBe(accepting.real);
    const receipt = (await (
      await accepting.post("/runs", accepting.run(BIND), "accepted", true)
    ).json()) as { jobId: string; runId: string; storeId: string };
    expect(receipt.storeId).toBe(accepting.real);

    const answer = await foreign.get(`/runs/${receipt.runId}`);
    expect(answer.status).toBe(404);
    const problem = ControlProblem.parse(await answer.json());
    expect(problem).toMatchObject({ code: "http_404", context: { storeId: foreign.real } });
    expect(problem.context["storeId"]).not.toBe(receipt.storeId);

    // The run the foreign store cannot see is still there in the store that accepted it.
    const owner = await accepting.client.list({ id: receipt.runId });
    expect(owner.map((record) => record.id)).toEqual([receipt.jobId]);
    const missing = await accepting.get("/runs/other-run");
    expect(ControlProblem.parse(await missing.json()).context["storeId"]).toBe(receipt.storeId);
  });
});

describe("the MCP status read", () => {
  it("keeps the answering store on its typed absence", async () => {
    const f = await engine();
    vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: f.client,
      addr: f.addr,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    await expect(
      mcpSurfaceRunner({ requireExistingDaemon: true })({
        mode: "__run_status",
        runId: "run-missing",
      }),
    ).rejects.toMatchObject({
      code: "http_404",
      message: "no such run",
      context: { storeId: f.real },
    });
  });
});

describe("the MCP thread-turn tool", () => {
  async function tool(f: Awaited<ReturnType<typeof engine>>) {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: f.client,
      addr: f.addr,
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    } as never);
    const turn = defaultClaudexorTools(mcpSurfaceRunner()).find(
      (candidate) => candidate.name === "claudexor_thread_turn",
    )!;
    // A strict MCP host validates structured content against what the tool advertised.
    const validate = new Ajv({ strict: false, allErrors: true }).compile(turn.outputSchema!);
    return { turn, validate };
  }

  it.each([
    ["bound", BIND, undefined],
    ["queued", WAIT, 0],
  ] as const)("keeps the accepting store on a %s turn handle", async (_name, prompt, timeout) => {
    const f = await engine({ runStartTimeoutMs: timeout });
    const { turn, validate } = await tool(f);
    const answer = await turn.handler({ threadId: f.thread(), prompt, idempotencyKey: "turn" }, {});
    if (typeof answer === "string") throw new Error(answer);
    expect(answer.isError, JSON.stringify(answer)).toBeFalsy();
    expect(McpThreadTurnResult.parse(answer.structured)).toMatchObject({ storeId: f.real });
    expect(validate(answer.structured), JSON.stringify(validate.errors)).toBe(true);
    expect(answer.text).toContain(`storeId: ${f.real}`);
  });

  it("keeps a valid handle when the engine has no store to name", async () => {
    const f = await engine({ identity: () => undefined, runStartTimeoutMs: 0 });
    const { turn, validate } = await tool(f);
    const answer = await turn.handler(
      { threadId: f.thread(), prompt: WAIT, idempotencyKey: "turn" },
      {},
    );
    if (typeof answer === "string") throw new Error(answer);
    expect(McpThreadTurnResult.parse(answer.structured)).not.toHaveProperty("storeId");
    expect(validate(answer.structured), JSON.stringify(validate.errors)).toBe(true);
    expect(answer.text).not.toContain("storeId");
  });

  it("does not ask for the store identity when it creates a thread", async () => {
    const f = await engine();
    await tool(f);
    const fetch = vi.spyOn(globalThis, "fetch");
    await mcpSurfaceRunner()({ mode: "__thread_create", repoPath: "/fixture-project" }).catch(
      () => undefined,
    );
    const init = fetch.mock.calls.at(-1)?.[1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).has(CONTROL_STORE_IDENTITY_HEADER)).toBe(false);
  });
});

describe("the CLI and MCP launch path", () => {
  const launch = (f: Awaited<ReturnType<typeof engine>>, prompt: string, unbound = true) =>
    daemonRun.enqueueAndAwait(f.client, f.addr, f.run(prompt), {
      waitForTerminal: false,
      acceptUnbound: unbound,
    });

  it.each([
    ["bound", BIND, undefined, "running"],
    ["queued", WAIT, 0, undefined],
    ["refused before its run", REFUSE, undefined, "failed"],
  ] as const)("keeps the accepting store on a %s handle", async (_name, prompt, timeout, state) => {
    const f = await engine({ runStartTimeoutMs: timeout });
    const out = await launch(f, prompt);
    expect(out.storeId).toBe(f.real);
    if (state) expect(out.status).toBe(state);
    const terminal = projectTerminalRunOutput(out, "ask", null);
    expect(terminal["storeId"]).toBe(f.real);
    const structured = structuredRunResult({ ...out, summary: "accepted" });
    expect(McpRunToolResult.parse(structured).storeId).toBe(f.real);
    expect(formatRunResult({ ...out, summary: "accepted" })).toContain(`storeId: ${f.real}`);
  });

  it("keeps the accepting store on a thread turn launched through the same path", async () => {
    const f = await engine();
    const out = await daemonRun.enqueueAndAwait(
      f.client,
      f.addr,
      { ...f.run(BIND), threadId: f.thread() },
      { waitForTerminal: false, acceptUnbound: true },
    );
    expect(out.storeId).toBe(f.real);
  });

  it("keeps a usable handle when the engine has no store to name", async () => {
    const f = await engine({ identity: () => undefined, runStartTimeoutMs: 0 });
    const out = await launch(f, WAIT);
    expect(out.jobId).toEqual(expect.any(String));
    expect(out).not.toHaveProperty("storeId");
    expect(projectTerminalRunOutput(out, "ask", null)).not.toHaveProperty("storeId");
  });

  it("carries the store on a refusal surfaced as an error", async () => {
    const f = await engine();
    await expect(launch(f, REFUSE, false)).rejects.toMatchObject({
      code: "fixture_pre_run_failure",
      context: { storeId: f.real },
    });
  });
});

describe("the operation catalog", () => {
  it("advertises the opt-in on every operation whose receipt can carry it", async () => {
    const f = await engine();
    const catalog = ControlOperationCatalog.parse(await (await f.get("/operations")).json());
    const optedIn = catalog.operations
      .filter((operation) =>
        operation.parameters?.some(
          (parameter) => parameter.name.toLowerCase() === CONTROL_STORE_IDENTITY_HEADER,
        ),
      )
      .map((operation) => `${operation.method} ${operation.path}`)
      .sort();
    expect(optedIn).toEqual(
      [
        "POST /v2/handshake",
        "POST /v2/runs",
        "POST /v2/runs/:id/decision",
        "POST /v2/runs/:id/retry",
        "POST /v2/threads/:id/turns",
        "POST /v2/threads/:id/turns/:id/retry",
      ].sort(),
    );
  });
});
