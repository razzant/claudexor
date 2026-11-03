import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandListQuery } from "@claudexor/schema";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";
import { resolveContinuationBody } from "./run-continuation-start.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-continue-start-")));
  dirs.push(dir);
  return dir;
}

function fakeDaemon(records: DaemonRunRecord[]) {
  const enqueued: Record<string, unknown>[] = [];
  const daemon: DaemonFacadeClient = {
    async enqueue(params) {
      const id = `job-${enqueued.length + 1}`;
      enqueued.push(params as Record<string, unknown>);
      records.push({ id, state: "running", runId: `run-${id}`, runDir: "/tmp/r", params });
      return { id, state: "running" };
    },
    async findAccepted() {
      return null;
    },
    async status(id) {
      return records.find((record) => record.id === id)!;
    },
    async list(query?: CommandListQuery) {
      const id = query && "id" in query ? query.id : undefined;
      return id ? records.filter((r) => r.id === id || r.runId === id) : [...records];
    },
    async cancel() {
      return {};
    },
  };
  return { daemon, enqueued };
}

function predecessor(root: string, overrides: Partial<DaemonRunRecord> = {}): DaemonRunRecord {
  return {
    id: "job-p",
    runId: "run-p",
    state: "failed",
    params: {
      prompt: "build the dashboard",
      mode: "agent",
      scope: { kind: "project", root },
      execution: { isolation: "live", delegated: true, workspaceRoot: root },
      harnesses: ["claude"],
      model: "claude-fable-5-1",
    },
    ...overrides,
  };
}

async function postRun(base: string, body: unknown): Promise<Response> {
  return globalThis.fetch(`${base}/v2/runs`, {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "content-type": "application/json",
      "X-Claudexor-Protocol-Major": "3",
      "Idempotency-Key": `k-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
}

async function withServer(daemon: DaemonFacadeClient, fn: (base: string) => Promise<void>) {
  const server = new DaemonControlApiServer({ token: "tok", daemon, pollMs: 5 });
  const { host, port } = await server.start();
  try {
    await fn(`http://${host}:${port}`);
  } finally {
    await server.stop();
  }
}

describe("resolveContinuationBody", () => {
  it("fills omitted keys from the predecessor before defaults; explicit keys win", async () => {
    const root = tempDir();
    const { daemon } = fakeDaemon([predecessor(root)]);
    const resolved = (await resolveContinuationBody(daemon, {
      continueFrom: "job-p",
      prompt: "",
      model: "claude-opus-5-5",
    })) as Record<string, unknown>;
    expect(resolved).toMatchObject({
      continueFrom: "run-p",
      prompt: "",
      mode: "agent",
      scope: { kind: "project", root },
      execution: { isolation: "live", delegated: true, workspaceRoot: root },
      harnesses: ["claude"],
      model: "claude-opus-5-5",
    });
    // Not part of what a continuation needs: never inherited.
    expect(resolved).not.toHaveProperty("tests");
  });

  it("leaves ordinary requests and unknown predecessors untouched", async () => {
    const { daemon } = fakeDaemon([]);
    const ordinary = { prompt: "x" };
    expect(await resolveContinuationBody(daemon, ordinary)).toBe(ordinary);
    const unknown = { continueFrom: "run-gone", prompt: "" };
    expect(await resolveContinuationBody(daemon, unknown)).toBe(unknown);
  });
});

describe("POST /v2/runs with continueFrom", () => {
  it("enqueues the successor with the inherited workspace and an empty continuation prompt", async () => {
    const root = tempDir();
    const { daemon, enqueued } = fakeDaemon([predecessor(root)]);
    await withServer(daemon, async (base) => {
      const response = await postRun(base, { continueFrom: "run-p", prompt: "" });
      expect(response.status).toBe(200);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        continueFrom: "run-p",
        prompt: "",
        mode: "agent",
        scope: { kind: "project", root },
        execution: { isolation: "live", workspaceRoot: root },
        model: "claude-fable-5-1",
      });
    });
  });

  it("answers superseded with the chain head, and the thread/unknown refusals typed", async () => {
    const root = tempDir();
    const records = [
      predecessor(root),
      {
        id: "job-s",
        runId: "run-s",
        state: "running",
        params: { continueFrom: "run-p", prompt: "" },
      },
    ];
    const { daemon, enqueued } = fakeDaemon(records);
    await withServer(daemon, async (base) => {
      const superseded = await postRun(base, { continueFrom: "run-p", prompt: "" });
      expect(superseded.status).toBe(409);
      expect(await superseded.json()).toMatchObject({
        code: "continuation_superseded",
        retryable: false,
        context: { runId: "run-p", head: "run-s" },
      });
      const thread = await postRun(base, { continueFrom: "run-s", threadId: "th-1", prompt: "" });
      expect(thread.status).toBe(400);
      expect(await thread.json()).toMatchObject({ code: "continue_from_with_thread" });
      const unknown = await postRun(base, {
        continueFrom: "run-elsewhere",
        prompt: "",
        scope: { kind: "project", root },
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ code: "predecessor_unknown" });
      // Only a continuation may carry an empty prompt.
      const blank = await postRun(base, { prompt: " ", scope: { kind: "project", root } });
      expect(blank.status).toBe(400);
    });
    expect(enqueued).toHaveLength(0);
  });
});

describe("GET /v2/runs/:id continuation facts", () => {
  it("serves summary.resumable and summary.continuity from the run's artifacts", async () => {
    const runDir = tempDir();
    mkdirSync(join(runDir, "final"), { recursive: true });
    const resumable = {
      cause: "transport",
      resetsAt: null,
      limitWindow: null,
      limitEvidence: null,
      carriers: ["native", "packet"],
      limitCode: null,
      session: { harness: "codex", nativeSessionId: "th-1", holderProfileId: null },
      workspace: { kind: "in_place", root: runDir },
    };
    writeFileSync(join(runDir, "final", "resumable.yaml"), JSON.stringify(resumable));
    const receipt = {
      tryIndex: 1,
      attemptId: "a01",
      carrier: "native",
      cause: "transport",
      from: { runId: "run-c", attemptId: "a01", profileId: null },
      to: { profileId: null },
      workspace: "same_root",
      memory: "full",
      instructions: "as_sent",
      reingestedTokens: null,
      observedModel: "gpt-6-sol",
      modelMismatch: null,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
    };
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ seq: 1, ts: "2026-10-06T00:00:00.000Z", run_id: "run-c", task_id: "t", type: "run.continuity", payload: { receipt } })}\n`,
    );
    const { daemon } = fakeDaemon([
      { id: "job-c", runId: "run-c", state: "failed", runDir, params: { continueFrom: "run-p" } },
    ]);
    await withServer(daemon, async (base) => {
      const response = await globalThis.fetch(`${base}/v2/runs/run-c`, {
        headers: { authorization: "Bearer tok", "X-Claudexor-Protocol-Major": "3" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { summary: Record<string, unknown> };
      expect(body.summary).toMatchObject({
        continueFrom: "run-p",
        resumable,
        continuity: [receipt],
        retainedEnvelope: null,
      });
    });
  });
});
