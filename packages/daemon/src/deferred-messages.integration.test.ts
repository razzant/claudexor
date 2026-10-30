import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("@claudexor/daemon", () => import("./index.js"));
import {
  CapturedRunStart,
  ControlRunStartRequest,
  RunFacts,
  RunProcessScopeOutcome,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  needsOperatorAttention,
  type DeferredMessageReceipt,
} from "@claudexor/schema";
import { reapScopeMembers } from "@claudexor/core";
import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { DaemonServer, type RunContext } from "./server.js";
import { DeferredMessages } from "./deferred-messages.js";
import { SqlCommandStore } from "./store/commands.js";
import { SqlDeferredMessages } from "./store/deferred-messages.js";
import { StoreCorruptError, StoreFullError } from "./store/errors.js";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";

const SCOPE_MARKER = "CLAUDEXOR_SCOPE_0123456789abcdef0123456789abcdef";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(
  mode: "ask" | "agent" = "ask",
  options: {
    custody?: boolean;
    failure?: boolean;
    outcome?: Record<string, unknown>;
    scope?: RunProcessScopeOutcome;
    maxConcurrent?: number;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-deferred-integration-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanups.push(() => sql.close());
  const done = barrier(),
    started: Array<{ params: any; ctx: RunContext }> = [];
  let predecessor = "";
  const capture = vi.fn(async (record, input) =>
    CapturedRunStart.parse({
      ...(record.params as object),
      ...input.controls,
      continueFrom: record.runId ?? record.id,
      prompt: input.prompt,
      attachments: input.attachments,
    }),
  );
  const validate = vi.fn(async () => {});
  const daemon = new DaemonServer({
    socketPath: join(root, "unused.sock"),
    token: "test",
    commands: sql.graph.commands,
    maxConcurrent: options.maxConcurrent ?? 2,
    deferredStart: () => ({ capture, validate }),
    runner: async (params, ctx) => {
      started.push({ params, ctx });
      const runDir = join(root, ctx.jobId);
      mkdirSync(join(runDir, "final"), { recursive: true });
      const runId = `run-${ctx.jobId}`,
        taskId = `task-${ctx.jobId}`;
      ctx.onRunStart({ runId, taskId, runDir });
      if (!predecessor) {
        predecessor = ctx.jobId;
        await Promise.race([
          done.promise,
          new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true })),
        ]);
      } else {
        await new Promise<void>((r) =>
          ctx.signal.addEventListener("abort", () => r(), { once: true }),
        );
        return { lifecycle: "cancelled" };
      }
      const lifecycle = options.failure ? "failed" : "succeeded";
      const facts = RunFacts.parse({
        schema_version: SCHEMA_VERSION,
        run_id: runId,
        task_id: taskId,
        mode,
        outcome: {
          ...makeOutcomeFacts(lifecycle),
          review_requested: false,
          work_state: { state: "completed", source: "constrained" },
          ...options.outcome,
        },
        deliverable: { present: true, kind: "answer", path: "final/answer.md" },
        presentation: { state: "ready", primary: { kind: "answer", path: "final/answer.md" } },
        participants: { planners: 0, attempts: [] },
        gates: {
          configured: false,
          required: 0,
          total: 0,
          executed: false,
          state: "not_configured",
        },
        review: { state: "not_run", blockers: 0, blocker_ids: [] },
        apply: { eligibility: null },
        required_actions: [],
        generated_at: new Date().toISOString(),
      });
      facts.required_actions = requiredActionsFor(
        facts.outcome,
        facts.apply.operator_decision_present,
      );
      if (options.custody !== false)
        writeFileSync(
          join(runDir, "final/process_scope.yaml"),
          JSON.stringify(
            options.scope ??
              RunProcessScopeOutcome.parse({
                marker: SCOPE_MARKER,
                coverage: "marker+capture",
                census: "ok",
                settled: true,
                incomplete: false,
                survivors: [],
                unreadable: [],
                completeness: "not_provable",
              }),
          ),
        );
      const type =
        lifecycle !== "succeeded"
          ? "run.failed"
          : needsOperatorAttention(facts.outcome, false)
            ? "run.blocked"
            : "run.completed";
      sql.graph.commands.persistTerminal(
        ctx.jobId,
        {
          run_id: runId,
          task_id: taskId,
          seq: 1,
          ts: new Date().toISOString(),
          type,
          payload: {
            run_facts: facts,
            facts: facts.outcome,
            lifecycle,
            reason: facts.outcome.reason,
          },
        },
        null,
      );
      return sql.graph.commands.findById(ctx.jobId)!.get(ctx.jobId)!.result;
    },
  });
  cleanups.push(() => daemon.stop());
  const request = ControlRunStartRequest.parse({
    mode,
    prompt: "first",
    execution:
      mode === "agent"
        ? { isolation: "live", delegated: true, workspaceRoot: root }
        : { isolation: "envelope" },
  });
  const initial = (await daemon.dispatch("claudexor.enqueue", {
    request,
    clientId: "test",
    idempotencyKey: "predecessor",
  })) as { id: string };
  const input = {
    request: { action: "create", predecessorId: initial.id, prompt: "verify", attachments: [] },
    idempotencyKey: "draft",
  };
  const mutate = (raw: unknown) =>
    daemon.dispatch("claudexor.deferredMessage", raw) as Promise<DeferredMessageReceipt>;
  const create = () => mutate(input);
  const read = (id: string) => sql.graph.commands.deferredFor(id)!.get(id)!;
  return {
    root,
    sql,
    daemon,
    done,
    started,
    capture,
    validate,
    initial,
    input,
    mutate,
    create,
    read,
  };
}

describe("deferred promotion in the existing daemon queue", () => {
  it.each(["agent", "ask"] as const)(
    "releases %s custody before accepting and launching exactly one ordinary successor",
    async (mode) => {
      const f = await fixture(mode);
      const first = await f.create();
      expect(first.draft.state).toBe("waiting");
      expect(f.started).toHaveLength(1);
      expect(f.validate).not.toHaveBeenCalled();
      await expect(
        f.daemon.dispatch("claudexor.enqueue", {
          request: { ...f.started[0]!.params, continueFrom: f.initial.id },
          idempotencyKey: "overtake",
        }),
      ).rejects.toMatchObject({ code: "continuation_reserved" });
      f.done.release();
      await vi.waitFor(() => expect(f.read(first.draft.draftId).state).toBe("dispatched"));
      expect(f.started).toHaveLength(2);
      const successor = f.read(first.draft.draftId).successorJobId;
      expect(f.started[1]).toMatchObject({
        ctx: { jobId: successor },
        params: { prompt: "verify", continueFrom: `run-${f.initial.id}`, mode },
      });
      f.validate.mockRejectedValue(new Error("revoked"));
      expect(await f.create()).toMatchObject({
        appliedRevision: 1,
        draft: { state: "dispatched", successorJobId: successor },
      });
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(f.started).toHaveLength(2);
    },
  );
  it("stays waiting for native retry-shaped progress, then holds an actual failure", async () => {
    const f = await fixture("ask", { failure: true });
    const draft = (await f.create()).draft;
    sqlRetryEvent(f);
    expect(f.read(draft.draftId).state).toBe("waiting");
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).hold?.code).toBe("predecessor_failed"));
    expect(f.started).toHaveLength(1);
  });
  it.each([
    [{ custody: false }, "settlement_unknown"],
    [
      {
        outcome: {
          reason: "input_required",
          work_state: {
            state: "needs_input",
            source: "constrained",
            required_inputs: [{ kind: "decision", locator: null, description: "choose target" }],
          },
        },
      },
      "predecessor_needs_input",
    ],
    [{ outcome: { checks: "failed", reason: "checks_failed" } }, "predecessor_checks_failed"],
  ] as const)("holds incompatible evidence %j", async (options, code) => {
    const f = await fixture("ask", options);
    const draft = (await f.create()).draft;
    f.done.release();
    await vi.waitFor(() => {
      const record = f.sql.graph.commands.findById(f.initial.id)!.get(f.initial.id)!;
      expect(f.read(draft.draftId).hold?.code, JSON.stringify(record)).toBe(code);
    });
    expect(f.started).toHaveLength(1);
  });
  it("holds every draft where the platform has no process census (the win32 reap)", async () => {
    const reap = await reapScopeMembers({ marker: SCOPE_MARKER, platform: "win32" });
    expect(reap).toMatchObject({ census: "unsupported", coverage: "tree_only", settled: false });
    const f = await fixture("ask", {
      scope: RunProcessScopeOutcome.parse({
        marker: SCOPE_MARKER,
        coverage: reap.coverage,
        census: reap.census,
        settled: reap.settled,
        incomplete: reap.incomplete,
        completeness: reap.completeness,
        completeness_reason: reap.completenessReason,
      }),
    });
    const draft = (await f.create()).draft;
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).hold?.code).toBe("settlement_unknown"));
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.started).toHaveLength(1);
  });
  it("reuses the freed slot while the next message's dispatch validation is pending", async () => {
    const f = await fixture("ask", { maxConcurrent: 1 });
    const other = (await f.daemon.dispatch("claudexor.enqueue", {
      request: ControlRunStartRequest.parse({ mode: "ask", prompt: "unrelated" }),
      clientId: "test",
      idempotencyKey: "unrelated",
    })) as { id: string };
    const draft = (await f.create()).draft;
    const preflight = barrier();
    cleanups.push(preflight.release);
    f.validate.mockImplementation(async () => preflight.promise);
    f.done.release();
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(f.started.map((s) => s.ctx.jobId)).toEqual([f.initial.id, other.id]),
    );
    expect(f.read(draft.draftId).state).toBe("waiting");
    preflight.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).state).toBe("dispatched"));
    const successor = f.read(draft.draftId).successorJobId!;
    expect(f.sql.graph.commands.queries.select({ ids: [successor] })[0]?.state).toBe("queued");
    await f.daemon.dispatch("claudexor.cancel", { id: other.id });
    await vi.waitFor(() =>
      expect(f.started.map((s) => s.ctx.jobId)).toEqual([f.initial.id, other.id, successor]),
    );
    expect(f.started[2]!.params.prompt).toBe("verify");
  });
  it("holds current admission refusal and never rearms on edit or readiness return", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    f.validate.mockRejectedValue(
      Object.assign(new Error("profile revoked"), { code: "profile_unavailable", status: 403 }),
    );
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).hold?.code).toBe("admission_refused"));
    f.validate.mockResolvedValue();
    expect(
      await f.mutate({
        request: {
          action: "replace",
          draftId: draft.draftId,
          expectedRevision: 1,
          prompt: "edited",
          attachments: [],
        },
        idempotencyKey: "edit",
      }),
    ).toMatchObject({ draft: { state: "held", revision: 2 } });
    expect(f.started).toHaveLength(1);
    expect(f.capture).toHaveBeenCalledTimes(1);
  });
  it.each(["replace", "clear", "stop", "shutdown"] as const)(
    "fences %s racing asynchronous dispatch preflight",
    async (action) => {
      const f = await fixture();
      const draft = (await f.create()).draft;
      const preflight = barrier();
      f.validate.mockImplementation(async () => preflight.promise);
      f.done.release();
      await vi.waitFor(() => expect(f.validate).toHaveBeenCalled());
      let edit: Promise<unknown> | undefined;
      if (action === "replace")
        edit = f.mutate({
          request: {
            action,
            draftId: draft.draftId,
            expectedRevision: 1,
            prompt: "latest",
            attachments: [],
          },
          idempotencyKey: action,
        });
      if (action === "clear")
        await f.mutate({
          request: { action, draftId: draft.draftId, expectedRevision: 1 },
          idempotencyKey: action,
        });
      if (action === "stop") await f.daemon.dispatch("claudexor.cancel", { id: f.initial.id });
      const stopping = action === "shutdown" ? f.daemon.stop() : undefined;
      preflight.release();
      await edit;
      await stopping;
      await vi.waitFor(() =>
        expect(f.read(draft.draftId).state).toBe(
          action === "replace" ? "dispatched" : action === "clear" ? "cleared" : "held",
        ),
      );
      expect(f.started).toHaveLength(action === "replace" ? 2 : 1);
      if (action === "replace") expect(f.started[1]!.params.prompt).toBe("latest");
    },
  );
  it("publishes the same committed receipt after an acceptance notification throws", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    const original = SqlCommandStore.prototype.acceptInTx;
    vi.spyOn(SqlCommandStore.prototype, "acceptInTx").mockImplementation(function (
      this: SqlCommandStore,
      tx,
      prepared,
    ) {
      const accepted = original.call(this, tx, prepared);
      tx.changes.afterCommit(() => {
        throw new Error("lost notification");
      });
      return accepted;
    });
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).state).toBe("dispatched"));
    expect(f.started).toHaveLength(2);
    expect((await f.create()).draft.successorJobId).toBe(f.started[1]!.ctx.jobId);
  });
  it("refuses raw Delegate/belt/child mutations and caller-owned snapshot injection before capture", async () => {
    const f = await fixture();
    for (const extra of [
      { beltContext: true },
      { delegatedFromRunId: "parent" },
      { operation: "delegated-run" },
    ])
      await expect(f.mutate({ ...f.input, ...extra })).rejects.toMatchObject({
        code: "delegation_forbidden",
        status: 403,
      });
    for (const method of ["claudexor.deferredMessageRead", "claudexor.deferredMessageProjection"])
      await expect(
        f.daemon.dispatch(method, {
          draftId: "unknown",
          predecessorId: f.initial.id,
          beltContext: true,
        }),
      ).rejects.toMatchObject({ code: "delegation_forbidden", status: 403 });
    const child = { ...f.started[0]!.params, delegatedFromRunId: "parent" };
    f.sql.graph.commands
      .forRequest(child)
      .accept({ id: "child", params: child, clientId: "fixture", idempotencyKey: "child" });
    await expect(
      f.mutate({ ...f.input, request: { ...f.input.request, predecessorId: "child" } }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    await expect(
      f.daemon.dispatch("claudexor.enqueue", {
        request: { ...f.started[0]!.params, deferredDefaults: {} },
        idempotencyKey: "injection",
      }),
    ).rejects.toMatchObject({ code: "server_owned_field" });
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.sql.store.prepare("SELECT count(*) n FROM deferred_message").get()).toEqual({ n: 0 });
  });
  it("keeps credential-shaped draft text exactly through create and replace (INV-146)", async () => {
    const f = await fixture();
    const prompt = "api_key=sk-" + "abcdefghijklmnopqrstuvwxyz0123456789";
    const created = await f.mutate({ ...f.input, request: { ...f.input.request, prompt } });
    expect(f.read(created.draft.draftId).prompt).toBe(prompt);
    const replaced = `${prompt} (revised)`;
    await f.mutate({
      request: {
        action: "replace",
        draftId: created.draft.draftId,
        expectedRevision: created.draft.revision,
        prompt: replaced,
        attachments: [],
      },
      idempotencyKey: "secret",
    });
    expect(f.read(created.draft.draftId).prompt).toBe(replaced);
  });
  it("enforces the same operator boundary over real HTTP and projects addressed detail without bodies in collections", async () => {
    const f = await fixture();
    const control = new DaemonControlApiServer({
      token: "fixture",
      daemon: new DaemonLocalClient(() => f.daemon),
    });
    const { host, port } = await control.start();
    cleanups.push(() => control.stop());
    const http = async (path: string, body?: unknown, key = "http") => {
      const response = await fetch(`http://${host}:${port}/v2${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer fixture",
          "x-claudexor-protocol-major": "3",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    for (const extra of [{ beltContext: true }, { delegatedFromRunId: "parent" }]) {
      const refused = await http("/runs/next-message", { ...f.input.request, ...extra });
      expect(refused).toMatchObject({ status: 403, body: { code: "delegation_forbidden" } });
    }
    const child = { ...f.started[0]!.params, delegatedFromRunId: "parent" };
    f.sql.graph.commands
      .forRequest(child)
      .accept({ id: "child", params: child, clientId: "fixture", idempotencyKey: "child" });
    expect(
      await http(
        "/runs/next-message",
        { ...f.input.request, predecessorId: "child" },
        "child-draft",
      ),
    ).toMatchObject({ status: 403, body: { code: "delegation_forbidden" } });
    expect(f.capture).not.toHaveBeenCalled();
    const accepted = await http("/runs/next-message", f.input.request);
    expect(accepted).toMatchObject({
      status: 200,
      body: { appliedRevision: 1, draft: { state: "waiting" } },
    });
    const id = accepted.body.draft.draftId;
    expect(
      await http("/runs", { continueFrom: f.initial.id, prompt: "overtake" }, "http-overtake"),
    ).toMatchObject({
      status: 409,
      body: { code: "continuation_reserved", context: { draftId: id } },
    });
    expect(await http(`/runs/next-message/${id}`)).toMatchObject({
      status: 200,
      body: { prompt: "verify", capturedStart: { continueFrom: `run-${f.initial.id}` } },
    });
    expect(await http(`/runs/${f.initial.id}`)).toMatchObject({
      status: 200,
      body: { deferredMessage: { draftId: id, state: "waiting" } },
    });
    const collection = await http("/runs");
    expect(collection.status).toBe(200);
    expect(JSON.stringify(collection.body)).not.toContain('"verify"');
    expect(JSON.stringify(collection.body)).not.toContain('"capturedStart"');
    f.capture.mockRejectedValue(new Error("capture revoked"));
    expect(await http("/runs/next-message", f.input.request)).toEqual(accepted);
    expect(f.capture).toHaveBeenCalledTimes(1);
  });
  it("recovers held startup state without read-triggered launch", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    f.sql.graph.commands.deferredFor(draft.draftId)!.recoverAfterStartup();
    f.done.release();
    await vi.waitFor(() =>
      expect(f.sql.graph.commands.queries.select({ ids: [f.initial.id] })[0]?.state).toBe(
        "succeeded",
      ),
    );
    const afterRestart = new DeferredMessages({
      commands: f.sql.graph.commands,
      preparation: () => ({ capture: f.capture, validate: f.validate }),
      active: () => false,
      stopped: () => false,
      publish: vi.fn(),
    });
    expect(afterRestart.read(draft.draftId)).toMatchObject({
      state: "held",
      hold: { code: "restart_requires_controller" },
    });
    await afterRestart.settled(f.initial.id);
    expect(f.started).toHaveLength(1);
  });
});

describe("public Stop of a predecessor with a next message", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  // The real HTTP control route, not the raw daemon cancel RPC.
  async function publicStop(f: Fixture) {
    const control = new DaemonControlApiServer({
      token: "fixture",
      daemon: new DaemonLocalClient(() => f.daemon),
    });
    const { host, port } = await control.start();
    cleanups.push(() => control.stop());
    return async (id: string) => {
      const response = await fetch(`http://${host}:${port}/v2/runs/${id}/control`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "x-claudexor-protocol-major": "3",
          "content-type": "application/json",
        },
        body: JSON.stringify({ control: { kind: "cancel" } }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
  }
  const state = (f: Fixture, id: string) =>
    f.sql.graph.commands.queries.select({ ids: [id] })[0]?.state;
  const commands = (f: Fixture) =>
    (f.sql.store.prepare("SELECT count(*) n FROM command").get() as { n: number }).n;

  it("holds a live predecessor's waiting draft before any dispatch validation", async () => {
    const f = await fixture();
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    expect(state(f, f.initial.id)).toBe("running");
    expect(await stop(f.initial.id)).toMatchObject({
      status: 200,
      body: {
        accepted: true,
        status: "applied",
        deferredMessage: {
          draftId: draft.draftId,
          state: "held",
          hold: { code: "stop_requested" },
          successorJobId: null,
        },
      },
    });
    await vi.waitFor(() => expect(state(f, f.initial.id)).not.toBe("running"));
    await f.daemon.stop();
    expect(f.read(draft.draftId)).toMatchObject({
      state: "held",
      hold: { code: "stop_requested" },
    });
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
  });

  it("holds a terminal predecessor's draft while dispatch validation is still running", async () => {
    const f = await fixture();
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    const preflight = barrier();
    f.validate.mockImplementation(async () => preflight.promise);
    f.done.release();
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalled());
    expect(state(f, f.initial.id)).toBe("succeeded");
    const stopped = await stop(f.initial.id);
    preflight.release();
    await vi.waitFor(() => expect(f.validate).toHaveResolved());
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.read(draft.draftId)).toMatchObject({ state: "held", successorJobId: null });
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(stopped).toMatchObject({
      status: 200,
      body: {
        accepted: true,
        status: "applied",
        cascadeRunIds: [],
        deferredMessage: {
          draftId: draft.draftId,
          state: "held",
          hold: { code: "stop_requested" },
        },
      },
    });
  });

  it("returns the already accepted successor without cancelling it", async () => {
    const f = await fixture();
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    f.done.release();
    await vi.waitFor(() => expect(f.started).toHaveLength(2));
    const successor = f.read(draft.draftId).successorJobId!;
    expect(f.started[1]!.ctx.jobId).toBe(successor);
    const stopped = await stop(f.initial.id);
    expect(stopped).toMatchObject({
      status: 409,
      body: {
        code: "next_message_dispatched",
        retryable: false,
        context: {
          deferredMessage: {
            draftId: draft.draftId,
            state: "dispatched",
            successorJobId: successor,
            successorRunId: `run-${successor}`,
          },
        },
      },
    });
    expect(stopped.body.message).toContain(successor);
    expect(f.started[1]!.ctx.signal.aborted).toBe(false);
    expect(state(f, successor)).toBe("running");
  });

  it.each(["absent", "cleared"] as const)(
    "keeps the terminal refusal when the predecessor's draft is %s",
    async (slot) => {
      const f = await fixture();
      const stop = await publicStop(f);
      if (slot === "cleared") {
        const draft = (await f.create()).draft;
        await f.mutate({
          request: { action: "clear", draftId: draft.draftId, expectedRevision: 1 },
          idempotencyKey: "clear",
        });
      }
      f.done.release();
      await vi.waitFor(() => expect(state(f, f.initial.id)).toBe("succeeded"));
      expect(await stop(f.initial.id)).toEqual({
        status: 409,
        body: expect.objectContaining({
          code: "http_409",
          message: "run is succeeded; cancel has nothing to stop",
          context: {},
        }),
      });
      expect(f.started).toHaveLength(1);
    },
  );

  it("discloses an already held draft without claiming a new stop", async () => {
    const f = await fixture("ask", { failure: true });
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    f.done.release();
    await vi.waitFor(() => expect(f.read(draft.draftId).hold?.code).toBe("predecessor_failed"));
    expect(await stop(f.initial.id)).toMatchObject({
      status: 409,
      body: {
        code: "http_409",
        message: "run is failed; cancel has nothing to stop",
        context: { deferredMessage: { state: "held", hold: { code: "predecessor_failed" } } },
      },
    });
    expect(f.read(draft.draftId).hold?.code).toBe("predecessor_failed");
  });

  // Only the Stop's own hold write fails; later writes succeed again.
  const failHoldOnce = () =>
    vi.spyOn(SqlDeferredMessages.prototype, "hold").mockImplementationOnce(() => {
      throw new StoreFullError("fixture: no space for the hold");
    });
  async function validating(f: Fixture) {
    const preflight = barrier();
    cleanups.push(preflight.release);
    f.validate.mockImplementation(async () => preflight.promise);
    f.done.release();
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalled());
    expect(state(f, f.initial.id)).toBe("succeeded");
    return preflight;
  }
  async function afterValidation(preflight: ReturnType<typeof barrier>, f: Fixture) {
    preflight.release();
    await vi.waitFor(() => expect(f.validate).toHaveResolved());
    await new Promise((resolve) => setImmediate(resolve));
  }
  const unsaved = (draftId: string) => ({
    code: "next_message_hold_failed",
    retryable: true,
    context: { deferredMessage: { draftId, state: "waiting" } },
  });

  it("still stops a live predecessor when its Stop hold cannot be saved", async () => {
    const f = await fixture();
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    failHoldOnce();
    const stopped = await stop(f.initial.id);
    expect(f.started[0]!.ctx.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(f.read(draft.draftId).state).toBe("held"));
    expect(f.read(draft.draftId).hold?.code).toBe("stop_requested");
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(stopped).toMatchObject({ status: 503, body: unsaved(draft.draftId) });
    expect(stopped.body.message).toMatch(/^cancel requested; .*out of space/);
  });

  it("neither claims nor sends a terminal predecessor's draft whose Stop hold failed during validation", async () => {
    const f = await fixture();
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    const preflight = await validating(f);
    failHoldOnce();
    const stopped = await stop(f.initial.id);
    await afterValidation(preflight, f);
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(f.read(draft.draftId)).toMatchObject({
      state: "held",
      hold: { code: "stop_requested" },
      successorJobId: null,
    });
    expect(stopped).toMatchObject({ status: 503, body: unsaved(draft.draftId) });
    expect(stopped.body.message).toContain("out of space");
  });

  it("raw daemon cancel stops a live predecessor before reporting the unsaved hold", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    failHoldOnce();
    const outcome = await f.daemon
      .dispatch("claudexor.cancel", { id: f.initial.id })
      .catch((error: unknown) => error);
    expect(f.started[0]!.ctx.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(f.read(draft.draftId).state).toBe("held"));
    expect(f.read(draft.draftId).hold?.code).toBe("stop_requested");
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(outcome).toMatchObject({ ...unsaved(draft.draftId), status: 503 });
  });

  it("raw daemon cancel during validation reports the unsaved hold and never sends the draft", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    const preflight = await validating(f);
    failHoldOnce();
    const outcome = await f.daemon
      .dispatch("claudexor.cancel", { id: f.initial.id })
      .catch((error: unknown) => error);
    await afterValidation(preflight, f);
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(f.read(draft.draftId)).toMatchObject({
      state: "held",
      hold: { code: "stop_requested" },
      successorJobId: null,
    });
    expect(outcome).toMatchObject({ ...unsaved(draft.draftId), status: 503 });
  });

  // No hold can ever be saved, while acceptance and every other write still
  // work: a missing fence would show up as an accepted successor.
  const failEveryHold = () => {
    const owner = SqlDeferredMessages.prototype as unknown as { write(...args: unknown[]): void };
    const write = owner.write;
    return vi.spyOn(owner, "write").mockImplementation(function (this: unknown, ...args) {
      if ((args[1] as { state?: string } | undefined)?.state === "held")
        throw new StoreFullError("fixture: no hold can be saved");
      return write.apply(this, args);
    });
  };
  // The unconfirmed shutdown is the asserted outcome; cleanup must not repeat it.
  async function unconfirmedStop(f: Fixture) {
    const stopping = f.daemon.stop();
    f.daemon.stop = () => Promise.resolve();
    return stopping.then(
      () => null,
      (error: unknown) => error,
    );
  }

  it.each(["held", "clear", "settle"] as const)(
    "retires the temporary Stop fence after authoritative %s without sending the draft",
    async (retirement) => {
      const f = await fixture();
      const stop = await publicStop(f);
      const draft = (await f.create()).draft;
      const preflight = await validating(f);
      const stopped = (f.daemon as unknown as { deferred: { stopped: Set<string> } }).deferred
        .stopped;
      if (retirement !== "held") failHoldOnce();
      const outcome = await stop(f.initial.id);
      expect(outcome.status).toBe(retirement === "held" ? 200 : 503);
      if (retirement !== "held") {
        expect(stopped.has(draft.draftId)).toBe(true);
        expect(f.read(draft.draftId).state).toBe("waiting");
      }
      if (retirement === "clear")
        await f.mutate({
          request: { action: "clear", draftId: draft.draftId, expectedRevision: 1 },
          idempotencyKey: "clear-fenced",
        });
      if (retirement !== "settle") expect(stopped.has(draft.draftId)).toBe(false);
      await afterValidation(preflight, f);
      expect(stopped.size).toBe(0);
      expect(f.read(draft.draftId).state).toBe(retirement === "clear" ? "cleared" : "held");
      expect(f.started).toHaveLength(1);
      expect(commands(f)).toBe(1);
    },
  );

  it("repeated raw cancels retry a hold that can never be saved and never send or claim the draft", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    const preflight = await validating(f);
    const writes = failEveryHold();
    for (const attempt of [1, 2]) {
      const before = writes.mock.calls.length;
      const outcome = await f.daemon
        .dispatch("claudexor.cancel", { id: f.initial.id })
        .catch((error: unknown) => error);
      expect(outcome, `raw cancel ${attempt}`).toMatchObject({
        ...unsaved(draft.draftId),
        status: 503,
      });
      expect(writes.mock.calls.length, `raw cancel ${attempt}`).toBeGreaterThan(before);
    }
    await afterValidation(preflight, f);
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(f.read(draft.draftId)).toMatchObject({
      state: "waiting",
      hold: null,
      successorJobId: null,
    });
    expect(await unconfirmedStop(f)).toMatchObject({ code: "daemon_shutdown_unconfirmed" });
    expect(f.read(draft.draftId).state).toBe("waiting");
  });

  it("repeated public Stops keep answering 503 for a hold that can never be saved and never send the draft", async () => {
    const f = await fixture();
    const stop = await publicStop(f);
    const draft = (await f.create()).draft;
    failEveryHold();
    const live = await stop(f.initial.id);
    expect(f.started[0]!.ctx.signal.aborted).toBe(true);
    expect(live).toMatchObject({ status: 503, body: unsaved(draft.draftId) });
    expect(live.body.message).toMatch(/^cancel requested; /);
    await vi.waitFor(() => expect(state(f, f.initial.id)).not.toBe("running"));
    const ended = await stop(f.initial.id);
    expect(ended).toMatchObject({ status: 503, body: unsaved(draft.draftId) });
    expect(ended.body.message).toMatch(/^run is succeeded; /);
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
    expect(f.read(draft.draftId)).toMatchObject({
      state: "waiting",
      hold: null,
      successorJobId: null,
    });
    expect(await unconfirmedStop(f)).toMatchObject({ code: "daemon_shutdown_unconfirmed" });
  });

  it("shutdown still aborts and drains runners when a next-message hold cannot be saved", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    failHoldOnce();
    const outcome = await unconfirmedStop(f);
    expect(f.started[0]!.ctx.signal.aborted).toBe(true);
    expect(state(f, f.initial.id)).not.toBe("running");
    expect(outcome).toMatchObject({ code: "daemon_shutdown_unconfirmed" });
    expect((outcome as Error).message).toContain(`next message ${draft.draftId}`);
    expect((outcome as Error).cause).toMatchObject({ errors: [{ code: "store_full" }] });
    expect(f.read(draft.draftId).hold?.code).toBe("shutdown");
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.started).toHaveLength(1);
    expect(commands(f)).toBe(1);
  });

  it("a store-recovery shutdown still tolerates a hold the corrupt store cannot save", async () => {
    const f = await fixture();
    const draft = (await f.create()).draft;
    vi.spyOn(SqlDeferredMessages.prototype, "hold").mockImplementationOnce(() => {
      throw new StoreCorruptError("fixture: corrupt page");
    });
    await f.daemon.stopForStoreRecovery();
    expect(f.started[0]!.ctx.signal.aborted).toBe(true);
    expect(state(f, f.initial.id)).not.toBe("running");
    expect(f.read(draft.draftId).hold?.code).toBe("shutdown");
    expect(commands(f)).toBe(1);
  });
});

function sqlRetryEvent(f: Awaited<ReturnType<typeof fixture>>) {
  f.sql.graph.commands.recordRunEvent(f.started[0]!.params, {
    run_id: `run-${f.initial.id}`,
    task_id: `task-${f.initial.id}`,
    seq: 1,
    ts: new Date().toISOString(),
    type: "harness.event",
    payload: { type: "api_retry", status: 429, willRetry: true },
  });
}
