/**
 * Read-only lookup of an accepted start: real SQL owners, daemon socket RPC, HTTP
 * control API and thread services; only the job runner is synthetic. No harness,
 * credential, installed engine or live data root is involved.
 *
 * Every lookup runs in a tripwire window: a daemon call other than the
 * accepted-command and addressed-list reads, a thread-turn writer, a full thread
 * read, preflight or resource admission throws, and the complete SQL row
 * inventory must be unchanged afterwards.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient, RunnerFn } from "@claudexor/daemon";
import type { DaemonFacadeClient } from "@claudexor/control-api";
import {
  ControlOperationCatalog,
  ControlProblem,
  ControlStartLookupResponse,
  type ControlRunStartRequest,
} from "@claudexor/schema";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import {
  startLookupEngine,
  type StartLookupEngine,
  type StartLookupEngineOptions,
} from "./test-support/start-lookup-engine.js";

const BIND = "bind a run and succeed";
const BIND_FAIL = "bind a run and fail";
const HOLD = "bind a run and hold";
const WAIT = "stay unbound";
const REFUSE = "refuse before a run";
const PREFLIGHT_REFUSE = "refused by turn preflight";
const READS = new Set(["findAccepted", "list"]);

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  const ownedRemovals = removals.splice(0).reverse();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

const validateWire = new Ajv({ strict: false, allErrors: true }).compile(
  JSON.parse(
    readFileSync(
      new URL("../../schema/generated/ControlStartLookupResponse.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** Lookup window: which daemon and service calls happened, and which were refused. */
interface Wire {
  lookup: boolean;
  calls: string[];
  tripped: string[];
  failFindAccepted?: boolean;
}

const aborted = (signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) done();
    else signal.addEventListener("abort", () => done(), { once: true });
  });

function runnerFor(root: string, engine: () => StartLookupEngine): RunnerFn {
  return async (request, ctx) => {
    const params = request as { prompt?: unknown; turnId?: unknown };
    if (params.prompt === REFUSE)
      throw Object.assign(new Error("fixture refused before its run"), {
        code: "fixture_pre_run_failure",
        status: 403,
        retryable: false,
        requiredActions: ["Change the fixture request."],
        // A producer's context is not an authority on which store answered.
        context: { storeId: "producer-context", detail: "kept" },
      });
    if (params.prompt === WAIT) {
      await aborted(ctx.signal);
      return { lifecycle: "cancelled" };
    }
    const runDir = join(root, "runs", ctx.jobId);
    mkdirSync(runDir, { recursive: true });
    const runId = `run-${ctx.jobId}`;
    ctx.onRunStart({ runId, taskId: `task-${ctx.jobId}`, runDir });
    // As the production runner does when a turn's run starts.
    if (typeof params.turnId === "string")
      engine().sql.graph.threads.bindTurnRun(params.turnId, runId);
    if (params.prompt === BIND_FAIL)
      throw Object.assign(new Error("fixture failed after its run"), {
        code: "fixture_run_failure",
        retryable: true,
      });
    if (params.prompt === HOLD) {
      await aborted(ctx.signal);
      return { lifecycle: "cancelled" };
    }
    return { lifecycle: "succeeded" };
  };
}

function tripwireFacade(wire: Wire) {
  return (client: DaemonClient): DaemonFacadeClient =>
    new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const name = String(prop);
          if (wire.lookup) {
            wire.calls.push(name);
            if (!READS.has(name)) {
              wire.tripped.push(name);
              throw new Error(`tripwire: daemon.${name} during a lookup`);
            }
            if (name === "findAccepted" && wire.failFindAccepted)
              throw Object.assign(new Error("daemon RPC unavailable (claudexor.findAccepted)"), {
                code: "daemon_unavailable",
                status: 503,
                retryable: true,
              });
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as DaemonFacadeClient;
}

function tripwireServices(wire: Wire): NonNullable<StartLookupEngineOptions["services"]> {
  return (real) => {
    const trip = (name: string) => {
      if (!wire.lookup) return;
      wire.tripped.push(name);
      throw new Error(`tripwire: ${name} during a lookup`);
    };
    return {
      ...real,
      threadDetail: async (id: string) => {
        trip("threadDetail");
        return real.threadDetail(id);
      },
      createThreadTurn: async (...args: Parameters<typeof real.createThreadTurn>) => {
        trip("createThreadTurn");
        return real.createThreadTurn(...args);
      },
      setTurnEnqueueError: (...args: Parameters<typeof real.setTurnEnqueueError>) => {
        trip("setTurnEnqueueError");
        return real.setTurnEnqueueError(...args);
      },
      findThreadTurnByIdempotency: async (
        ...args: Parameters<typeof real.findThreadTurnByIdempotency>
      ) => {
        if (wire.lookup) wire.calls.push("findThreadTurnByIdempotency");
        return real.findThreadTurnByIdempotency(...args);
      },
      validateResources: async () => trip("validateResources"),
      preflightRunRequirements: async () => trip("preflightRunRequirements"),
      preflightThreadRunRequirements: async (request: ControlRunStartRequest) => {
        trip("preflightThreadRunRequirements");
        if (request.prompt === PREFLIGHT_REFUSE)
          throw Object.assign(new Error("fixture turn preflight refused"), {
            code: "fixture_preflight_refusal",
            status: 400,
            retryable: false,
          });
      },
    };
  };
}

interface Fixture {
  root: string;
  wire: Wire;
  engine: StartLookupEngine;
  /** Close this engine and open a new one over the same root (a daemon restart). */
  restart(): Promise<void>;
}

async function fixture(
  options: Partial<Pick<StartLookupEngineOptions, "daemon" | "storeId" | "runStartTimeoutMs">> = {},
): Promise<Fixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-start-lookup-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const wire: Wire = { lookup: false, calls: [], tripped: [] };
  const f = { root, wire } as Fixture;
  const open = async () => {
    f.engine = await startLookupEngine({
      root,
      runner: runnerFor(root, () => f.engine),
      facade: tripwireFacade(wire),
      services: tripwireServices(wire),
      ...options,
    });
    cleanups.push(() => f.engine.close());
  };
  f.restart = async () => {
    await f.engine.close();
    await open();
  };
  await open();
  return f;
}

/** Every row of every table: a pure read leaves all of them byte-identical. */
function inventory(f: Fixture): string {
  const store = f.engine.sql.store;
  const tables = store
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const rows: Record<string, string[]> = {};
  for (const { name } of tables) {
    rows[name] = (store.prepare(`SELECT * FROM "${name}"`).all() as unknown[])
      .map((row) =>
        JSON.stringify(row, (_key, value: unknown) =>
          value instanceof Uint8Array
            ? Buffer.from(value).toString("hex")
            : typeof value === "bigint"
              ? value.toString()
              : value,
        ),
      )
      .sort();
  }
  return JSON.stringify(rows);
}

/** Background settlement (a terminal, a turn refusal record) finishes before a window opens. */
async function quiescent(f: Fixture): Promise<string> {
  let last = inventory(f);
  let stable = 0;
  for (let i = 0; i < 200 && stable < 3; i++) {
    await new Promise((done) => setTimeout(done, 20));
    const next = inventory(f);
    stable = next === last ? stable + 1 : 0;
    last = next;
  }
  expect(stable, "the store never became quiet before the lookup").toBe(3);
  return last;
}

/** One lookup inside the tripwire window, with the inventory compared around it. */
async function lookup(
  f: Fixture,
  send: (engine: StartLookupEngine) => Promise<{ status: number; body: Record<string, any> }>,
) {
  const before = await quiescent(f);
  f.wire.calls.length = 0;
  f.wire.lookup = true;
  let answer: { status: number; body: Record<string, any> };
  try {
    answer = await send(f.engine);
  } finally {
    f.wire.lookup = false;
  }
  expect(f.wire.tripped).toEqual([]);
  expect(inventory(f)).toBe(before);
  if (answer.status === 200) {
    expect(validateWire(answer.body), JSON.stringify(validateWire.errors)).toBe(true);
    ControlStartLookupResponse.parse(answer.body);
  } else {
    ControlProblem.parse(answer.body);
  }
  return answer;
}

const settled = (f: Fixture, jobId: string, state: string) =>
  vi.waitFor(
    async () => {
      const record = await f.engine.client.status(jobId);
      expect(record.state).toBe(state);
      return record;
    },
    { timeout: 10_000, interval: 10 },
  );

const ask = (prompt: string, extra: Record<string, unknown> = {}) => ({
  mode: "ask",
  prompt,
  scope: { kind: "none" },
  ...extra,
});

/** The handle a lookup must report: the job's own record, read straight from the daemon. */
async function expectedHandle(f: Fixture, jobId: string) {
  const record = await f.engine.client.status(jobId);
  const facts = record.error !== undefined || record.errorCode !== undefined;
  const { storeId: _store, taskGroupId: _group, ...context } = record.errorContext ?? {};
  return {
    jobId,
    runId: record.runId ?? null,
    state: record.state,
    runDir: record.runDir ?? null,
    taskId: record.taskId ?? null,
    ...(facts
      ? {
          problem: {
            message: record.error ?? null,
            code: record.errorCode ?? null,
            status: record.errorStatus ?? null,
            retryable: record.errorRetryable ?? null,
            requiredActions: record.errorRequiredActions ?? [],
            context,
          },
        }
      : {}),
  };
}

describe("POST /v2/runs/lookup", () => {
  it.each([
    ["a bound run that succeeded", BIND, "succeeded"],
    ["a job refused before any run", REFUSE, "failed"],
    ["a run that failed after binding", BIND_FAIL, "failed"],
  ] as const)("finds %s with HTTP 200 and its recorded facts", async (_name, prompt, state) => {
    const f = await fixture();
    const created = await f.engine.post("/runs", ask(prompt), "key-1");
    const jobId = (created.body["jobId"] ?? created.body["context"]?.["jobId"]) as string;
    await settled(f, jobId, state);
    const answer = await lookup(f, (e) => e.lookupRun(ask(prompt), "key-1"));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      status: "found",
      storeId: f.engine.storeId,
      handle: await expectedHandle(f, jobId),
    });
    if (prompt === REFUSE) {
      // The refusal is the job's outcome: the read succeeded and keeps every typed fact.
      expect(answer.body["handle"]).toMatchObject({
        runId: null,
        problem: {
          code: "fixture_pre_run_failure",
          status: 403,
          retryable: false,
          requiredActions: ["Change the fixture request."],
          context: { detail: "kept" },
        },
      });
      expect(answer.body["handle"]["problem"]["context"]).not.toHaveProperty("storeId");
    }
    expect(new Set(f.wire.calls)).toEqual(new Set(["findAccepted"]));
  });

  it("finds a queued job and a running job without waiting for or starting a run", async () => {
    const f = await fixture({ daemon: { maxConcurrent: 1 }, runStartTimeoutMs: 200 });
    const running = await f.engine.post("/runs", ask(HOLD), "hold");
    expect(running.status).toBe(200);
    const queued = await f.engine.post("/runs", ask(WAIT), "queued");
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ state: "queued" });
    const queuedAnswer = await lookup(f, (e) => e.lookupRun(ask(WAIT), "queued"));
    expect(queuedAnswer.body).toEqual({
      status: "found",
      storeId: f.engine.storeId,
      handle: {
        jobId: queued.body["jobId"],
        runId: null,
        state: "queued",
        runDir: null,
        taskId: null,
      },
    });
    const runningAnswer = await lookup(f, (e) => e.lookupRun(ask(HOLD), "hold"));
    expect(runningAnswer.body["handle"]).toEqual({
      jobId: running.body["jobId"],
      runId: running.body["runId"],
      state: "running",
      runDir: running.body["runDir"],
      taskId: running.body["taskId"],
    });
  });

  it("finds a continuation by the same body, resolving inheritance as create did", async () => {
    const f = await fixture();
    const source = await f.engine.post("/runs", ask(BIND), "source");
    await settled(f, source.body["jobId"], "succeeded");
    const next = { continueFrom: source.body["runId"], prompt: "continue the work" };
    const created = await f.engine.post("/runs", next, "next");
    expect(created.status).toBe(200);
    await settled(f, created.body["jobId"], "succeeded");
    const answer = await lookup(f, (e) => e.lookupRun(next, "next"));
    expect(answer.body).toMatchObject({
      status: "found",
      handle: { jobId: created.body["jobId"], runId: created.body["runId"] },
    });
    // The create route also names a predecessor by its job id; both spellings bind one key.
    const byJob = await lookup(f, (e) =>
      e.lookupRun({ ...next, continueFrom: source.body["jobId"] }, "next"),
    );
    expect(byJob.body["handle"]["jobId"]).toBe(created.body["jobId"]);
    expect(f.wire.calls).toContain("list");
  });

  it.each([
    ["a project", true],
    ["no project", false],
  ] as const)(
    "refuses typed a continuation in %s scope once retention removed its predecessor",
    async (_scope, inProject) => {
      // Cap two: the third terminal makes the ordinary prune remove the oldest command, the
      // predecessor, while its continuation keeps its command and key binding.
      const f = await fixture({ daemon: { maxHistory: 2, idempotencyRetentionMs: 0 } });
      const root = join(f.root, "project");
      if (inProject) {
        mkdirSync(root);
        f.engine.sql.graph.threads.registerProject({ root, idempotencyKey: root, clientId: "t" });
      }
      const sourceBody = ask(BIND, inProject ? { scope: { kind: "project", root } } : {});
      const source = await f.engine.post("/runs", sourceBody, "source");
      await settled(f, source.body["jobId"], "succeeded");
      // Its create inherits scope, mode and model from the predecessor; the body names none.
      const next = { continueFrom: source.body["runId"], prompt: "continue the work" };
      const created = await f.engine.post("/runs", next, "next");
      await settled(f, created.body["jobId"], "succeeded");
      const retained = await lookup(f, (e) => e.lookupRun(next, "next"));
      expect(retained.body).toMatchObject({
        status: "found",
        handle: { jobId: created.body["jobId"], runId: created.body["runId"] },
      });

      const third = await f.engine.post("/runs", ask(BIND), "third");
      await settled(f, third.body["jobId"], "succeeded");
      expect(await f.engine.client.list({ id: source.body["jobId"] })).toEqual([]);
      const bindings = f.engine.sql.store
        .prepare("SELECT count(*) AS n FROM idempotency WHERE owner = 'command' AND target_id = ?")
        .get(created.body["jobId"]) as { n: number };
      expect(bindings.n).toBe(1);
      for (const from of [source.body["runId"], source.body["jobId"]]) {
        const gone = await lookup(f, (e) => e.lookupRun({ ...next, continueFrom: from }, "next"));
        // Never not_found or a conflict computed from a request rebuilt with defaults.
        expect(gone.status).toBe(410);
        expect(gone.body).toMatchObject({
          code: "continuation_predecessor_not_retained",
          retryable: false,
          context: { continueFrom: from },
        });
        expect(f.wire.calls).toEqual(["list"]);
      }
    },
  );

  it("answers not_found, conflict and typed refusals without creating anything", async () => {
    const f = await fixture();
    const projectA = join(f.root, "project-a");
    const projectB = join(f.root, "project-b");
    const unregistered = join(f.root, "project-c");
    for (const dir of [projectA, projectB, unregistered]) mkdirSync(dir);
    for (const root of [projectA, projectB])
      f.engine.sql.graph.threads.registerProject({ root, idempotencyKey: root, clientId: "test" });
    const inA = ask(BIND, { scope: { kind: "project", root: projectA } });
    const created = await f.engine.post("/runs", inA, "project-key");
    await settled(f, created.body["jobId"], "succeeded");

    const missing = await lookup(f, (e) => e.lookupRun(inA, "never-sent"));
    expect(missing).toEqual({
      status: 200,
      body: { status: "not_found", storeId: f.engine.storeId },
    });
    const otherPartition = await lookup(f, (e) =>
      e.lookupRun({ ...inA, scope: { kind: "project", root: projectB } }, "project-key"),
    );
    expect(otherPartition.body).toEqual({ status: "not_found", storeId: f.engine.storeId });
    const changed = await lookup(f, (e) =>
      e.lookupRun({ ...inA, prompt: "a different request" }, "project-key"),
    );
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "idempotency_conflict", retryable: false });
    const notRegistered = await lookup(f, (e) =>
      e.lookupRun({ ...inA, scope: { kind: "project", root: unregistered } }, "project-key"),
    );
    expect(notRegistered.status).toBe(404);
    expect(notRegistered.body).toMatchObject({ code: "project_not_registered", retryable: false });

    const keyless = await lookup(f, (e) => e.post("/runs/lookup", inA));
    expect(keyless.status).toBe(400);
    expect(keyless.body).toMatchObject({ code: "idempotency_key_required" });
    const malformed = await lookup(f, (e) => e.lookupRun({ ...inA, prompt: 7 }, "project-key"));
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: "invalid_request" });
    // A missing route is a bare 404, never the not_found answer of a supported lookup.
    const unsupported = await lookup(f, (e) => e.post("/runs/lookup-v0", inA, "project-key"));
    expect(unsupported.status).toBe(404);
    expect(unsupported.body).toMatchObject({ code: "http_404" });
    expect(unsupported.body).not.toHaveProperty("status");
  });
});

describe("POST /v2/threads/:id/turns/lookup", () => {
  async function thread(f: Fixture) {
    return f.engine.sql.graph.threads.createThread({ title: "lookup", mode: "ask" }).id;
  }

  it("finds an accepted turn with its run, and a turn whose job ended before a run", async () => {
    const f = await fixture();
    const threadId = await thread(f);
    const bound = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "bound");
    expect(bound.status).toBe(200);
    await settled(f, bound.body["jobId"], "succeeded");
    const found = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: BIND }, "bound"));
    expect(found.body).toEqual({
      status: "found",
      storeId: f.engine.storeId,
      handle: {
        ...(await expectedHandle(f, bound.body["jobId"])),
        threadId,
        turnId: bound.body["turnId"],
      },
    });
    expect(new Set(f.wire.calls)).toEqual(new Set(["findThreadTurnByIdempotency", "findAccepted"]));

    const refused = await f.engine.post(
      `/threads/${threadId}/turns`,
      { prompt: REFUSE },
      "refused",
    );
    expect(refused.status).toBe(403);
    const jobId = refused.body["context"]["jobId"] as string;
    await settled(f, jobId, "failed");
    const failed = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: REFUSE }, "refused"));
    expect(failed.status).toBe(200);
    expect(failed.body["handle"]).toEqual({
      ...(await expectedHandle(f, jobId)),
      threadId,
      turnId: refused.body["context"]["turnId"],
    });
    expect(failed.body["handle"]).toMatchObject({ runId: null, state: "failed" });
  });

  it("reads a retained turn without a command, also after the conversation moved on", async () => {
    const f = await fixture();
    const threadId = await thread(f);
    const refused = await f.engine.post(
      `/threads/${threadId}/turns`,
      { prompt: PREFLIGHT_REFUSE },
      "orphan",
    );
    expect(refused.status).toBe(400);
    const turnId = refused.body["context"]["turnId"] as string;
    const orphan = await lookup(f, (e) =>
      e.lookupTurn(threadId, { prompt: PREFLIGHT_REFUSE }, "orphan"),
    );
    expect(orphan.body).toEqual({
      status: "turn_only",
      storeId: f.engine.storeId,
      threadId,
      turnId,
      runId: null,
      enqueueError: {
        message: "fixture turn preflight refused",
        code: "fixture_preflight_refusal",
        retryable: false,
        requiredActions: [],
        context: {},
        failedAt: expect.any(String),
      },
    });
    const later = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "later");
    expect(later.status).toBe(200);
    await settled(f, later.body["jobId"], "succeeded");
    // Create replay keeps its tail fence; the lookup is not a creation and has none.
    const replay = await f.engine.post(
      `/threads/${threadId}/turns`,
      { prompt: PREFLIGHT_REFUSE },
      "orphan",
    );
    expect(replay.body).toMatchObject({ code: "thread_turn_not_latest" });
    const old = await lookup(f, (e) =>
      e.lookupTurn(threadId, { prompt: PREFLIGHT_REFUSE }, "orphan"),
    );
    expect(old.body).toEqual(orphan.body);
  });

  it("reads a bound turn after retention removed its command, naming its exact run", async () => {
    const f = await fixture();
    const threadId = await thread(f);
    const bound = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "pruned");
    await settled(f, bound.body["jobId"], "succeeded");
    const tail = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "tail");
    await settled(f, tail.body["jobId"], "succeeded");
    const jobId = bound.body["jobId"] as string;
    f.engine.sql.graph.commands.findById(jobId)!.prune([jobId]);
    expect(await f.engine.client.list({ id: jobId })).toEqual([]);
    const answer = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: BIND }, "pruned"));
    expect(answer.body).toEqual({
      status: "turn_only",
      storeId: f.engine.storeId,
      threadId,
      turnId: bound.body["turnId"],
      runId: bound.body["runId"],
      enqueueError: null,
    });
    const replay = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "pruned");
    expect(replay.body).toMatchObject({ code: "thread_turn_already_bound" });
  });

  it("answers not_found, conflict and a typed missing thread", async () => {
    const f = await fixture();
    const threadId = await thread(f);
    const other = await thread(f);
    const bound = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "bound");
    await settled(f, bound.body["jobId"], "succeeded");
    const missing = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: BIND }, "never"));
    expect(missing.body).toEqual({ status: "not_found", storeId: f.engine.storeId });
    const changed = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: WAIT }, "bound"));
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: "idempotency_conflict", retryable: false });
    // One partition keys turn creates by key, so the same key on its other thread is another request.
    const elsewhere = await lookup(f, (e) => e.lookupTurn(other, { prompt: BIND }, "bound"));
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body).toMatchObject({ code: "idempotency_conflict" });
    const absent = await lookup(f, (e) => e.lookupTurn("th-missing", { prompt: BIND }, "bound"));
    expect(absent.status).toBe(404);
    expect(absent.body).toMatchObject({ code: "thread_not_found", retryable: false });
  });
});

describe("repeat and restart", () => {
  it("answers the same retained bindings again and after the daemon restarts", async () => {
    // A bounded start wait lets the never-bound job's create answer 202 promptly.
    const f = await fixture({ runStartTimeoutMs: 2_000 });
    const threadId = f.engine.sql.graph.threads.createThread({ title: "restart", mode: "ask" }).id;
    const run = await f.engine.post("/runs", ask(BIND), "run");
    await settled(f, run.body["jobId"], "succeeded");
    const refused = await f.engine.post("/runs", ask(REFUSE), "refused");
    await settled(f, refused.body["context"]["jobId"], "failed");
    const turn = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "turn");
    await settled(f, turn.body["jobId"], "succeeded");
    await f.engine.post(`/threads/${threadId}/turns`, { prompt: PREFLIGHT_REFUSE }, "orphan");
    const reads = [
      (e: StartLookupEngine) => e.lookupRun(ask(BIND), "run"),
      (e: StartLookupEngine) => e.lookupRun(ask(REFUSE), "refused"),
      (e: StartLookupEngine) => e.lookupRun(ask(BIND), "never"),
      (e: StartLookupEngine) => e.lookupTurn(threadId, { prompt: BIND }, "turn"),
      (e: StartLookupEngine) => e.lookupTurn(threadId, { prompt: PREFLIGHT_REFUSE }, "orphan"),
    ];
    const first = [];
    for (const read of reads) first.push(await lookup(f, read));
    for (const [index, read] of reads.entries())
      expect(await lookup(f, read)).toEqual(first[index]);
    // A job still waiting for its run when the daemon stops ends without one and stays found.
    const waiting = await f.engine.post("/runs", ask(WAIT), "waiting");
    await settled(f, waiting.body["jobId"], "running");
    const storeId = f.engine.storeId;
    await f.restart();
    expect(f.engine.storeId).toBe(storeId);
    for (const [index, read] of reads.entries())
      expect(await lookup(f, read)).toEqual(first[index]);
    const ended = await lookup(f, (e) => e.lookupRun(ask(WAIT), "waiting"));
    expect(ended.body).toEqual({
      status: "found",
      storeId,
      handle: await expectedHandle(f, waiting.body["jobId"]),
    });
    expect(ended.body["handle"]).toMatchObject({ runId: null, state: "cancelled" });
  });
});

describe("an unreadable or unnamed store", () => {
  it("refuses before reading when the store has no identity", async () => {
    const f = await fixture({ storeId: () => () => undefined });
    const answer = await lookup(f, (e) => e.lookupRun(ask(BIND), "key"));
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: "store_identity_unavailable", retryable: true });
    expect(f.wire.calls).toEqual([]);
    // Not even a continuation's predecessor is read for an answer that cannot name its store.
    const next = { continueFrom: "run-predecessor", prompt: "continue" };
    const continued = await lookup(f, (e) => e.lookupRun(next, "key"));
    expect(continued.body).toMatchObject({ code: "store_identity_unavailable" });
    expect(f.wire.calls).toEqual([]);
    const threadId = f.engine.sql.graph.threads.createThread({ title: "x", mode: "ask" }).id;
    const turn = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: BIND }, "key"));
    expect(turn.body).toMatchObject({ code: "store_identity_unavailable" });
    expect(f.wire.calls).toEqual([]);
  });

  it("refuses an answer whose store changed during the read", async () => {
    let reads = 0;
    const f = await fixture({
      storeId: (real) => () =>
        reads++ % 2 === 0 ? real() : "00000000-0000-4000-8000-000000000000",
    });
    const answer = await lookup(f, (e) => e.lookupRun(ask(BIND), "key"));
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: "store_identity_unavailable", retryable: true });
  });

  it("keeps an unreadable binding unknown instead of answering not_found", async () => {
    const f = await fixture();
    f.wire.failFindAccepted = true;
    const answer = await lookup(f, (e) => e.lookupRun(ask(BIND), "key"));
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({
      code: "idempotency_status_unavailable",
      retryable: true,
      requiredActions: ["Retry the same operation with the same Idempotency-Key."],
      context: { stage: "lookup", cause: { code: "daemon_unavailable", status: 503 } },
    });
    const threadId = f.engine.sql.graph.threads.createThread({ title: "x", mode: "ask" }).id;
    f.wire.failFindAccepted = false;
    const accepted = await f.engine.post(`/threads/${threadId}/turns`, { prompt: BIND }, "turn");
    await settled(f, accepted.body["jobId"], "succeeded");
    f.wire.failFindAccepted = true;
    const turn = await lookup(f, (e) => e.lookupTurn(threadId, { prompt: BIND }, "turn"));
    expect(turn.status).toBe(503);
    expect(turn.body).toMatchObject({ code: "idempotency_status_unavailable" });
  });
});

describe("the operation catalog", () => {
  it("advertises both lookups as keyed read-only operations beside their creates", async () => {
    const f = await fixture();
    // An external client attaches through the fixture's connection and negotiates first.
    const { baseUrl, token } = f.engine.testConnection;
    const handshake = await fetch(`${baseUrl}/v2/handshake`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolMajor: 3, client: "lookup-fixture" }),
    });
    expect(handshake.status).toBe(200);
    const catalog = ControlOperationCatalog.parse((await f.engine.get("/operations")).body);
    const op = (method: string, path: string) =>
      catalog.operations.find((entry) => entry.method === method && entry.path === path);
    for (const [path, requestSchema, applicability] of [
      ["/v2/runs/lookup", "ControlRunStartRequest", "run"],
      ["/v2/threads/:id/turns/lookup", "ControlThreadTurnRequest", "thread"],
    ] as const) {
      expect(op("POST", path)).toMatchObject({
        mutability: "read_only",
        idempotency: "key_required",
        completion: "immediate",
        requestSchema,
        responseSchema: "ControlStartLookupResponse",
        applicability,
        parameters: [],
      });
    }
    expect(op("POST", "/v2/runs")).toMatchObject({
      mutability: "mutating",
      completion: "durable_handle",
      idempotency: "key_required",
      requestSchema: "ControlRunStartRequest",
      responseSchema: "ControlRunStartResponse",
      applicability: "run",
      parameters: [expect.objectContaining({ name: "x-claudexor-store-identity" })],
    });
  });
});
