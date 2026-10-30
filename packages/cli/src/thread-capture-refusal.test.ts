import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectThreadPort } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { CaptureOutputExceeded } from "@claudexor/core";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { captureFailureEvidence, captureWorkingTreeTransient } from "@claudexor/workspace";
import { verifyAndDeliver } from "@claudexor/delivery";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { applyThreadDiff } from "./thread-delivery.js";

vi.mock("@claudexor/workspace", async (original) => ({
  ...(await original<typeof import("@claudexor/workspace")>()),
  captureWorkingTreeTransient: vi.fn(),
}));
vi.mock("@claudexor/delivery", async (original) => ({
  ...(await original<typeof import("@claudexor/delivery")>()),
  verifyAndDeliver: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedThreads() {
  const setThreadWorktree = vi.fn();
  const thread = {
    workspace: { mode: "isolated", worktree_path: "/fixture/kept", base_sha: "base" },
    repo: { root: "/fixture/project" },
  };
  const threads = { getThread: () => thread, setThreadWorktree } as unknown as ProjectThreadPort;
  return { thread, threads, setThreadWorktree };
}

it("refuses an incomplete thread capture before empty/apply or watermark advancement", async () => {
  const failure = new CaptureOutputExceeded("stdout");
  vi.mocked(captureWorkingTreeTransient).mockResolvedValue({
    patch: "",
    captureIncomplete: true,
    captureFailure: failure,
  });
  const { threads, setThreadWorktree } = isolatedThreads();
  await expect(applyThreadDiff(threads, "thread", { mode: "apply" })).rejects.toMatchObject({
    code: "capture_output_exceeded",
    status: 409,
  });
  expect(verifyAndDeliver).not.toHaveBeenCalled();
  expect(setThreadWorktree).not.toHaveBeenCalled();
});

it("answers the sanitized capture facts on the first refusal and on every durable replay", async () => {
  const secret = ["sk", "c".repeat(24)].join("-");
  const failure = new CaptureOutputExceeded("stdout");
  // The capture owner attaches a failed scratch cleanup as a hidden property.
  Object.defineProperty(failure, "cleanupError", {
    value: Object.assign(new Error(`scratch cleanup failed near ${secret}`), { code: "EACCES" }),
    enumerable: false,
  });
  vi.mocked(captureWorkingTreeTransient).mockResolvedValue({
    patch: "",
    captureIncomplete: true,
    captureFailure: failure,
  });
  const { thread, threads, setThreadWorktree } = isolatedThreads();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-refusal-")));
  roots.push(root);
  const token = "thread-capture-refusal-fixture";
  type Answer = { status: number; body: Record<string, unknown> };
  /** One daemon lifetime: the real SQL delivery journal behind the real route. */
  async function daemon<T>(work: (post: () => Promise<Answer>) => Promise<T>): Promise<T> {
    const sql = await sqlFixture(root);
    await sql.graph.recoverAfterStartup();
    const server = new DaemonControlApiServer({
      token,
      daemon: {
        enqueue: async () => ({ id: "unused", state: "queued" }),
        status: async (id: string) => ({ id, state: "failed" }),
        list: async () => [],
        cancel: async () => ({ cancelled: true }),
      } as never,
      services: {
        threadDetail: async () => ({ thread: { ...thread, run_ids: [] }, turns: [], sessions: [] }),
        applyThread: (id, opts) => applyThreadDiff(threads, id, opts),
        beginDelivery: async (params, input) => sql.graph.threads.beginDelivery(params, input),
        completeDelivery: async (id, result) => sql.graph.threads.completeDelivery(id, result),
        failDelivery: async (id, error) => sql.graph.threads.failDelivery(id, error),
      },
    });
    const { host, port } = await server.start();
    try {
      return await work(async () => {
        const response = await fetch(`http://${host}:${port}/v2/threads/thread/apply`, {
          method: "POST",
          body: JSON.stringify({ mode: "apply" }),
          headers: {
            authorization: ["Bearer", token].join(" "),
            "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
            "Idempotency-Key": "thread-apply-refused",
            "content-type": "application/json",
          },
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      });
    } finally {
      await server.stop();
      await sql.close();
    }
  }

  const [first, replay] = await daemon(async (post) => [await post(), await post()]);
  expect(first.status).toBe(409);
  expect(first.body).toMatchObject({ code: "capture_output_exceeded" });
  const facts = captureFailureEvidence(failure);
  expect(facts.cleanup).toMatchObject({ code: "EACCES" });
  expect(first.body["context"]).toEqual({ captureFailure: facts });
  // The idempotent replay answers from the durable journal row, in the same
  // daemon and after a restart, without re-running the capture.
  const restarted = await daemon((post) => post());
  for (const answer of [replay, restarted]) {
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual(first.body);
  }
  expect(captureWorkingTreeTransient).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(first.body)).not.toContain(secret);
  // The journal row itself holds only the sanitized facts.
  const journal = await sqlFixture(root);
  try {
    const [row] = journal.records();
    expect(row).toMatchObject({ state: "failed", errorContext: { captureFailure: facts } });
    expect(JSON.stringify(journal.records())).not.toContain(secret);
  } finally {
    await journal.close();
  }
  expect(verifyAndDeliver).not.toHaveBeenCalled();
  expect(setThreadWorktree).not.toHaveBeenCalled();
});
