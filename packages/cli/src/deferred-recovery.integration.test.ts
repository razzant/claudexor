import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("@claudexor/control-api", () => import("../../control-api/src/index.js"));
vi.mock("@claudexor/orchestrator", () => import("../../orchestrator/src/index.js"));
vi.mock("@claudexor/config", async (original) => ({
  ...(await original<object>()),
  loadConfig: vi.fn(),
}));
vi.mock("./registry.js", () => ({ buildRegistry: () => new Map([["codex", {}]]) }));
vi.mock("./request-preflight.js", () => ({ createRunRequirementsPreflight: () => async () => {} }));
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: () => ({ preflightOneShot: async () => {} }),
}));
vi.mock("./continue-from-run.js", () => ({
  continuationForRun: () => ({ retain: true, from: { runId: "run-p" } }),
}));
vi.mock("@claudexor/workspace", async (original) => ({
  ...(await original<object>()),
  readContinuationEvidence: () => ({ hasEvidence: true }),
}));
import { loadConfig } from "@claudexor/config";
import { ControlRunStartRequest, ResolvedConfig, decodeAcceptedRunStart } from "@claudexor/schema";
import { sourceSqlFixture } from "../../daemon/src/store/test-support/source-sql-fixture.js";
import { settleDeferredPredecessor } from "../../daemon/src/store/test-support/deferred-terminal.js";
import { DeferredMessages } from "../../daemon/src/deferred-messages.js";
import { enqueueCommand } from "../../daemon/src/enqueue-command.js";
import { restoreExactRetryDefaults } from "../../daemon/src/exact-retry-defaults.js";
import { publicAcceptedCommand } from "../../daemon/src/command-rpc.js";
import {
  handleRunRetryRoute,
  type RunRetryRouteContext,
} from "../../control-api/src/run-retry-routes.js";
import { rerunWithFeedback } from "../../control-api/src/decision-rerun.js";
import { handleRunCreate } from "../../control-api/src/run-start.js";
import { createDeferredStartPreparation } from "./deferred-start-preparation.js";
import { boundedDeferredMessage } from "./mcp-deferred-message.js";
import { executionRunConfig } from "../../orchestrator/src/run-defaults.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
function config(maxTurns = 5) {
  return ResolvedConfig.parse({
    global: { harnesses: { codex: { default_model: "original-model", max_turns: maxTurns } } },
    project: {},
    trust: { access_default: "workspace_write" },
  });
}
async function fixture(ttl?: "1h") {
  vi.mocked(loadConfig).mockReturnValue(config());
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-deferred-recovery-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "final"));
  const f = await sourceSqlFixture(root);
  cleanup.push(() => f.close());
  const router = f.graph.commands,
    commands = router.current();
  const original = ControlRunStartRequest.parse({
    mode: "ask",
    prompt: "first",
    ...(ttl ? { promptCacheTtl: ttl } : {}),
  });
  commands.accept({ id: "p", params: original, clientId: "fixture", idempotencyKey: "p" });
  commands.update("p", { state: "running", runId: "run-p", taskId: "task-p", runDir: root });
  const preparation = createDeferredStartPreparation({
    resources: { resolve: () => [] },
    accounts: {},
    commands: router.queries,
    authority: {},
    quota: vi.fn(),
  } as never);
  const capture = vi.spyOn(preparation, "capture"),
    publish = vi.fn();
  let active = true;
  const coordinator = new DeferredMessages({
    commands: router,
    preparation: () => preparation,
    active: () => active,
    stopped: () => false,
    custody: () => null,
    publish,
  });
  // A run alias must resolve to the addressed full accepted body, not a summary.
  const created = await coordinator.mutate({
    request: { action: "create", predecessorId: "run-p", prompt: "next", attachments: [] },
    idempotencyKey: "create",
  });
  const owner = router.deferredFor(created.draft.draftId)!;
  const promote = async () => {
    settleDeferredPredecessor(commands, "p", root);
    active = false;
    await coordinator.settled("p");
    const successor = owner.get(created.draft.draftId)!.successorJobId!;
    expect(successor).toBeTruthy();
    expect(publish).toHaveBeenCalledTimes(1);
    commands.update(successor, {
      state: "failed",
      runId: "run-successor",
      taskId: "task-successor",
      runDir: root,
    });
    return commands.get(successor)!;
  };
  return { ...f, router, commands, original, coordinator, created, owner, capture, promote };
}

it.each(["1h", undefined] as const)(
  "inherits SQL full-body cache lifetime %s and keeps it immutable on edit",
  async (ttl) => {
    const f = await fixture(ttl);
    expect(f.router.queries.select({ ids: ["p"] })[0]?.params).not.toHaveProperty("promptCacheTtl");
    expect(f.capture.mock.calls[0]![0].params).toEqual(f.original);
    expect(f.owner.request(f.created.draft.draftId).promptCacheTtl).toBe(ttl);
    const frozen = f.owner.get(f.created.draft.draftId)!.capturedStart;
    vi.mocked(loadConfig).mockReturnValue(config(99));
    await f.coordinator.mutate({
      request: {
        action: "replace",
        draftId: f.created.draft.draftId,
        expectedRevision: 1,
        prompt: "edited",
        attachments: [],
      },
      idempotencyKey: "edit",
    });
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.owner.get(f.created.draft.draftId)!.capturedStart).toEqual(frozen);
    const successor = await f.promote();
    expect(successor.params).toMatchObject({
      prompt: "edited",
      deferredDefaults: { harnesses: { codex: { max_turns: 5 } } },
    });
    expect(decodeAcceptedRunStart(successor.params).request.promptCacheTtl).toBe(ttl);
  },
);

it("shows the production capture on the bounded read by origin, unchanged by later settings", async () => {
  const f = await fixture("1h");
  vi.mocked(loadConfig).mockReturnValue(config(99));
  const detail = f.owner.get(f.created.draft.draftId)!;
  const { controls } = boundedDeferredMessage(detail);
  expect(controls?.capturedAt).toBe(detail.capturedAt);
  expect(Date.parse(controls!.capturedAt)).not.toBeNaN();
  expect(controls?.inherited).toMatchObject({ mode: "ask", promptCacheTtl: "1h" });
  expect(controls?.inherited).not.toHaveProperty("access");
  expect(controls?.resolved).toMatchObject({
    access: detail.capturedStart!.access,
    web: detail.capturedStart!.web,
    credentialProfileId: null,
    timeLimitMode: "soft",
  });
  expect(controls?.resolved).not.toHaveProperty("mode");
  expect(controls?.settings?.harnesses.codex).toMatchObject({
    default_model: "original-model",
    max_turns: 5,
  });
  const cleared = await f.coordinator.mutate({
    request: { action: "clear", draftId: f.created.draft.draftId, expectedRevision: 1 },
    idempotencyKey: "clear",
  });
  expect(cleared.draft.state).toBe("cleared");
  expect(boundedDeferredMessage(f.owner.get(f.created.draft.draftId)!).controls).toBeNull();
});

function responseContext(
  source: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["promote"]>>,
  daemon: RunRetryRouteContext["daemon"],
) {
  let response: { status: number; body: any } | undefined;
  const ctx: RunRetryRouteContext = {
    daemon,
    findRun: async () => source,
    waitForRunStart: async (id) => ({ id, state: "queued", params: {} }),
    serializeThreadMutation: async (_id, work) => work(),
    json: (_res, status, body) => {
      response = { status, body };
    },
    requestError: (_res, error) => {
      const e = error as { status?: number; code?: string };
      response = { status: e.status ?? 400, body: { code: e.code, error: String(error) } };
    },
  };
  return { ctx, response: () => response! };
}
const res = {} as ServerResponse;
const req = new IncomingMessage(new Socket());
req.headers = { "idempotency-key": "retry" };

it("Run Again decodes a production-accepted successor and discloses omitted private preferences", async () => {
  const f = await fixture(),
    source = await f.promote();
  const r = responseContext(source, {} as never);
  await handleRunRetryRoute(r.ctx, "GET", `/runs/${source.id}/run-again`, req, res);
  expect(r.response().status).toBe(200);
  expect(r.response().body.differences).toContainEqual({
    field: "deferredDefaults",
    change: "omitted",
    reason: expect.stringContaining("current settings"),
  });
  expect(r.response().body.request).not.toHaveProperty("deferredDefaults");
  expect(ControlRunStartRequest.safeParse(r.response().body.request).success).toBe(true);
});

it("Exact Retry reconstructs frozen defaults from the accepted owner and retains fresh continuation refusal", async () => {
  const f = await fixture(),
    source = await f.promote();
  const { request: original, deferredDefaults } = decodeAcceptedRunStart(source.params);
  vi.mocked(loadConfig).mockReturnValue(config(99));
  let rebuilt: unknown;
  const enqueue = vi.fn(async (request, options) => {
    rebuilt = restoreExactRetryDefaults(f.router, request, options.operation);
    return enqueueCommand(
      { request, ...options },
      {
        commands: f.router,
        stopping: false,
        accept: () => {
          throw Error("fresh continuation admission must refuse first");
        },
        publish: vi.fn(),
      },
    );
  });
  const r = responseContext(source, { enqueue, findAccepted: async () => null } as never);
  await handleRunRetryRoute(r.ctx, "POST", `/runs/${source.id}/retry`, req, res);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(rebuilt).toMatchObject({
    deferredDefaults,
    prompt: original.prompt,
    retryOf: "run-successor",
    parentRunId: "run-successor",
  });
  expect(r.response()).toMatchObject({ status: 409, body: { code: "continuation_superseded" } });
  expect(f.router.queries.count()).toBe(2);
});

it("an admissible engine-owned Exact Retry preserves captured preferences and exact public replay", async () => {
  const f = await fixture(),
    successor = await f.promote();
  // The preferences are the actual production capture. Isolate their recovery
  // from the independent continuation claim, whose refusal is covered above.
  const { continueFrom: _chain, ...params } = successor.params as Record<string, unknown>;
  f.commands.accept({
    id: "ordinary",
    params,
    clientId: "engine-fixture",
    idempotencyKey: "ordinary",
  });
  f.commands.update("ordinary", { state: "failed", runId: "run-ordinary" });
  const { request } = decodeAcceptedRunStart(params);
  const publicRetry = { ...request, retryOf: "run-ordinary", parentRunId: "run-ordinary" };
  const envelope = {
    request: publicRetry,
    operation: "run.retry",
    clientId: "control-api",
    idempotencyKey: "new-retry",
  };
  const accept = vi.fn((body, key, client, intent, operation) =>
    f.commands.accept({
      id: "retry",
      params: body,
      idempotencyKey: key,
      clientId: client,
      idempotencyParams: intent,
      operation,
    }),
  );
  const publish = vi.fn(),
    deps = { commands: f.router, stopping: false, accept, publish };
  vi.mocked(loadConfig).mockReturnValue(config(99));
  expect(enqueueCommand(envelope, deps)).toMatchObject({ id: "retry", reused: false });
  expect(f.commands.get("retry")!.params).toMatchObject({
    deferredDefaults: decodeAcceptedRunStart(successor.params).deferredDefaults,
  });
  expect(
    executionRunConfig(
      process.cwd(),
      decodeAcceptedRunStart(f.commands.get("retry")!.params).deferredDefaults,
    ).global.harnesses.codex?.max_turns,
  ).toBe(5);
  expect(enqueueCommand(envelope, { ...deps, stopping: true })).toMatchObject({
    id: "retry",
    reused: true,
  });
  expect(publicAcceptedCommand(f.router, envelope)?.id).toBe("retry");
  expect(accept).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(() =>
    restoreExactRetryDefaults(f.router, { ...publicRetry, parentRunId: "other" }, "run.retry"),
  ).toThrow(expect.objectContaining({ code: "retry_source_mismatch" }));
  const { operation: _operation, clientId: _client, ...keyed } = envelope;
  for (const labels of [{}, { operation: "run.retry", clientId: "control-api" }])
    expect(() =>
      enqueueCommand(
        {
          ...keyed,
          ...labels,
          request: {
            ...publicRetry,
            deferredDefaults: decodeAcceptedRunStart(successor.params).deferredDefaults,
          },
        },
        deps,
      ),
    ).toThrow(expect.objectContaining({ code: "server_owned_field" }));
});

it("decision rerun omits production-captured preferences and discloses current settings", async () => {
  const f = await fixture(),
    source = await f.promote();
  const enqueue = vi.fn(async (_request: unknown, _options?: unknown) => ({
    id: "feedback",
    reused: false,
  }));
  const r = responseContext(source, { enqueue } as never),
    audit = vi.fn();
  await rerunWithFeedback(
    { ...r.ctx, appendAudit: audit },
    source,
    { action: "rerun_with_feedback", feedback: "add detail" } as never,
    "feedback",
    res,
  );
  expect(r.response()).toMatchObject({
    status: 200,
    body: { message: expect.stringContaining("current settings") },
  });
  const sent = enqueue.mock.calls[0]![0];
  expect(sent).not.toHaveProperty("deferredDefaults");
  expect(ControlRunStartRequest.safeParse(sent).success).toBe(true);
  expect(audit).toHaveBeenCalledWith(
    source,
    expect.objectContaining({ omitted_controls: ["deferredDefaults"] }),
  );
});

it("the HTTP create handler refuses private controls before replay or enqueue despite forged labels", async () => {
  const enqueue = vi.fn(),
    findAccepted = vi.fn(),
    requestError = vi.fn();
  await handleRunCreate(
    {
      daemon: { enqueue, findAccepted } as never,
      readBody: async () => ({
        prompt: "hello",
        mode: "ask",
        deferredDefaults: {},
        operation: "run.retry",
        clientId: "control-api",
      }),
      requestError,
      json: vi.fn(),
      waitForRunStart: vi.fn(),
    },
    req,
    res,
  );
  expect(requestError).toHaveBeenCalledWith(
    res,
    expect.objectContaining({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: expect.arrayContaining(["deferredDefaults"]),
        }),
      ]),
    }),
  );
  expect(enqueue).not.toHaveBeenCalled();
  expect(findAccepted).not.toHaveBeenCalled();
});
