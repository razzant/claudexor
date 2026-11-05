/**
 * A managed resource across a thread turn's life (#249), over the supported surface:
 * real SQL owners, daemon socket, HTTP control API, upload and thread-turn services.
 * Accepted turns are preserved: a recorded turn that never dispatched still dispatches
 * after a release, and only a dispatch after an accepted one is a new reference. The
 * worker and the preflight's refusal are synthetic (the preflight stand-in reads refs
 * as the real one does). No harness, credential, installed engine or live data root.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonServer } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { threadTurnServices } from "./thread-turn-services.js";
import { uploadServices } from "./upload-services.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const TOKEN = "managed-turn-fixture";
const PROMPT = "use the brief";
const REFUSED_AT_START = "refused at job start";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

async function engine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-managed-turn-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanups.push(() => sql.close());
  const daemon = new DaemonServer({
    socketPath: join(root, "d.sock"),
    token: TOKEN,
    commands: sql.graph.commands,
    onTurnEnqueueFailed: (turnId, problem) =>
      sql.graph.threads.setTurnEnqueueError(turnId, problem),
    runner: async (request, ctx) => {
      if ((request as { prompt?: unknown }).prompt === REFUSED_AT_START)
        throw Object.assign(new Error("fixture refused at job start"), {
          code: "fixture_start_refused",
          status: 403,
          retryable: true,
        });
      const runDir = join(root, ctx.jobId);
      mkdirSync(runDir);
      ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: `task-${ctx.jobId}`, runDir });
      await new Promise<void>((done) => {
        if (ctx.signal.aborted) done();
        else ctx.signal.addEventListener("abort", () => done(), { once: true });
      });
      return { lifecycle: "cancelled" };
    },
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  let preflightRefusals = 0;
  const control = new DaemonControlApiServer({
    token: TOKEN,
    daemon: new DaemonClient(join(root, "d.sock"), TOKEN),
    pollMs: 5,
    storeId: () => sql.store.storeId,
    services: {
      ...threadTurnServices(sql.graph.threads, sql.graph.resources),
      ...uploadServices(() => sql.graph.resources),
      validateResources: async (refs, heldBy) => {
        sql.graph.resources.resolve(refs, heldBy);
      },
      preflightThreadRunRequirements: async (request, heldBy) => {
        if (preflightRefusals > 0) {
          preflightRefusals -= 1;
          throw Object.assign(new Error("fixture preflight refusal"), {
            code: "fixture_preflight",
            status: 503,
          });
        }
        sql.graph.resources.resolve(request.attachments ?? [], heldBy);
      },
    },
  });
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const base = `http://${host}:${port}/v2`;
  const headers = { authorization: `Bearer ${TOKEN}`, "X-Claudexor-Protocol-Major": "3" };
  const post = async (path: string, body: unknown, key?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const importRequest = {
    expectedStoreId: sql.store.storeId,
    kind: "file",
    mime: "text/plain",
    name: "brief.txt",
    source: "/host/brief.txt",
    lifetime: "managed",
  };
  /** The host importer's exact calls: declare, send the bytes, read the receipt back. */
  const importManaged = async (key: string, text: string) => {
    const bytes = Buffer.from(text);
    const content = {
      sizeBytes: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    const begun = await post("/uploads/imports", { ...importRequest, content }, key);
    const sent = await fetch(`${base}/uploads/${begun.body.uploadId}/bytes`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(sent.status).toBe(200);
    const ready = await post("/uploads/imports", importRequest, key);
    expect(ready.body.state).toBe("ready");
    return ready.body.resource as { resourceId: string; sha256: string };
  };
  return {
    sql,
    post,
    importManaged,
    importRequest,
    refuseNextPreflight: () => void (preflightRefusals += 1),
    release: (resource: { resourceId: string; sha256: string }) =>
      post(`/resources/${resource.resourceId}/release`, {
        expectedStoreId: sql.store.storeId,
        sha256: resource.sha256,
      }),
    thread: () => sql.graph.threads.createThread({ title: "fixture", mode: "ask" }).id,
    turns: (threadId: string) => sql.graph.threads.turnsFor(threadId),
    commandsOf: (turnId: string) =>
      (
        sql.store.prepare("SELECT id FROM command WHERE turn_id=?").all(turnId) as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    holders: (resourceId: string) =>
      (
        sql.store
          .prepare("SELECT owner FROM resource_use WHERE resource_id=?")
          .all(resourceId) as Array<{
          owner: string;
        }>
      )
        .map((row) => row.owner)
        .sort(),
  };
}

describe("a keyed managed import's life over the wire", () => {
  it("keeps accepted work and its repeats, and refuses only new references after a release", async () => {
    const f = await engine();
    const resource = await f.importManaged("import", "started bytes\n");
    const start = {
      mode: "ask",
      prompt: PROMPT,
      scope: { kind: "none" },
      attachments: [{ resourceId: resource.resourceId }],
    };
    const accepted = await f.post("/runs", start, "start");
    expect(accepted.status).toBe(200);
    expect(f.holders(resource.resourceId)).toEqual(["command"]);

    const released = await f.release(resource);
    expect(released).toMatchObject({
      status: 200,
      body: { state: "released", resourceId: resource.resourceId, sha256: resource.sha256 },
    });
    // Naturally idempotent, and the import key answers as that finished state.
    expect(await f.release(resource)).toEqual(released);
    expect(await f.post("/uploads/imports", f.importRequest, "import")).toMatchObject({
      status: 200,
      body: { state: "released", resource, releasedAt: released.body.releasedAt },
    });

    // The accepted start repeats as itself; a new start is a new reference.
    const repeated = await f.post("/runs", start, "start");
    expect(repeated.status).toBe(200);
    expect(repeated.body.jobId).toBe(accepted.body.jobId);
    const fresh = await f.post("/runs", start, "new-start");
    expect(fresh).toMatchObject({ status: 410, body: { code: "resource_released" } });

    // The accepted holder still reads the exact bytes; nothing else can.
    const refs = start.attachments;
    const holder = { owner: "command", id: accepted.body.jobId as string } as const;
    const [attachment] = f.sql.graph.resources.resolve(refs, holder);
    expect(readFileSync(attachment!.path, "utf8")).toBe("started bytes\n");
    expect(() => f.sql.graph.resources.resolve(refs)).toThrow(/released/);
  });
});

describe("a recorded turn that never dispatched keeps its accepted resources", () => {
  it("dispatches on its same-key create after a pre-enqueue refusal and a release", async () => {
    const f = await engine();
    const resource = await f.importManaged("import", "refused bytes\n");
    const threadId = f.thread();
    const body = { prompt: PROMPT, attachments: [{ resourceId: resource.resourceId }] };
    f.refuseNextPreflight();
    const refused = await f.post(`/threads/${threadId}/turns`, body, "create");
    expect(refused.status).toBe(503);
    const turnId = refused.body.context.turnId as string;
    // Recorded as retryable:false by the route: no job ever existed for this turn.
    expect(f.sql.graph.threads.getTurn(turnId)?.enqueue_error).toMatchObject({
      code: "fixture_preflight",
      retryable: false,
    });
    expect(f.commandsOf(turnId)).toEqual([]);
    expect((await f.release(resource)).status).toBe(200);

    // Opposing controls: a changed request under the key, and a new turn naming the ID.
    const changed = await f.post(
      `/threads/${threadId}/turns`,
      { ...body, prompt: "changed" },
      "create",
    );
    expect(changed).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
    const fresh = await f.post(`/threads/${threadId}/turns`, body, "new-key");
    expect(fresh).toMatchObject({ status: 410, body: { code: "resource_released" } });
    expect(f.turns(threadId)).toHaveLength(1);

    // The same-key repeat is this turn's own first dispatch, under its own hold.
    const replayed = await f.post(`/threads/${threadId}/turns`, body, "create");
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ threadId, turnId });
    expect(f.turns(threadId)).toHaveLength(1);
    expect(f.commandsOf(turnId)).toHaveLength(1);
    expect(f.holders(resource.resourceId)).toEqual(["command", "turn"]);
  });

  it("dispatches on its same-key create after a daemon stop before the first enqueue", async () => {
    const f = await engine();
    const resource = await f.importManaged("import", "stopped bytes\n");
    const threadId = f.thread();
    const body = { prompt: PROMPT, attachments: [{ resourceId: resource.resourceId }] };
    // What a stop between the route's two steps leaves: the turn, and nothing else.
    const turn = f.sql.graph.threads.createTurn(threadId, PROMPT, {
      attachments: f.sql.graph.resources.resolve(body.attachments),
      idempotency: { key: "create", client: "control-api", request: { threadId, body } },
    });
    expect((await f.release(resource)).status).toBe(200);
    const replayed = await f.post(`/threads/${threadId}/turns`, body, "create");
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ threadId, turnId: turn.id });
    expect(f.commandsOf(turn.id)).toHaveLength(1);
    expect(f.holders(resource.resourceId)).toEqual(["command", "turn"]);
  });
});

describe("a dispatch after an accepted one is a new reference", () => {
  it("refuses Turn Retry and a same-key create, also once the accepted command was pruned", async () => {
    const f = await engine();
    const resource = await f.importManaged("import", "dispatched bytes\n");
    const threadId = f.thread();
    const body = { prompt: REFUSED_AT_START, attachments: [{ resourceId: resource.resourceId }] };
    const refused = await f.post(`/threads/${threadId}/turns`, body, "create");
    expect(refused.status).toBe(403);
    const turnId = refused.body.context.turnId as string;
    // The job was accepted and then refused at its start: this turn did dispatch.
    await vi.waitFor(() =>
      expect(f.sql.graph.threads.getTurn(turnId)?.enqueue_error).toMatchObject({
        code: "fixture_start_refused",
        retryable: true,
      }),
    );
    const accepted = f.commandsOf(turnId);
    expect(accepted).toHaveLength(1);
    expect((await f.release(resource)).status).toBe(200);

    const retried = await f.post(`/threads/${threadId}/turns/${turnId}/retry`, {}, "retry");
    expect(retried).toMatchObject({ status: 410, body: { code: "resource_released" } });
    expect(f.commandsOf(turnId)).toEqual(accepted);

    // Retention ends the command, its binding and its hold; the dispatch fact stays.
    f.sql.graph.pruner.prune(accepted);
    expect(f.commandsOf(turnId)).toEqual([]);
    expect(f.holders(resource.resourceId)).toEqual(["turn"]);
    const repeated = await f.post(`/threads/${threadId}/turns`, body, "create");
    expect(repeated).toMatchObject({ status: 410, body: { code: "resource_released" } });
    expect(f.commandsOf(turnId)).toEqual([]);
    expect(f.turns(threadId)).toHaveLength(1);
  });
});
