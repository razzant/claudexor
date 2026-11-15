// #694 V17: Apply of a thread whose worktree preparation is held is one
// retryable 409 conflict, on the first call, on its same-key replay and after a
// restart: `termination_unconfirmed` (its end not proven) and
// `preparation_cleanup_failed` (its end proven, its record not removed) answer
// the same status, code, retryability, required actions and context each time.
// Apply releases nothing: the record stays byte-identical, no capture or
// delivery runs, the thread's watermark is not touched.
//
// The real route, the real `applyThreadDiff` readiness check over a real record
// in this test's folder, and the real SQL delivery journal; the HTTP server is
// in process on loopback. No process is started.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectThreadPort } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import {
  captureWorkingTreeTransient,
  threadPreparationRecordPath,
  writeThreadPreparation,
  type ThreadPreparationRecord,
} from "@claudexor/workspace";
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
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

type Answer = { status: number; body: Record<string, unknown> };

const CASES = [
  { code: "termination_unconfirmed", cleanupError: undefined },
  { code: "preparation_cleanup_failed", cleanupError: "EACCES: the record could not be removed" },
] as const;

describe("Apply of a held thread worktree (#694 V17)", () => {
  it.each(CASES)(
    "$code: the first refusal, its same-key replay and a restart's replay are the same retryable 409",
    async ({ code, cleanupError }) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-apply-held-")));
      roots.push(root);
      const tree = join(root, "threads", "th-held", "tree");
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, ".git"), "gitdir: elsewhere\n");
      const record: ThreadPreparationRecord = {
        schema: 1,
        thread_id: "th-held",
        tree,
        scope: null,
        opened_at: "2026-11-15T10:00:00.000Z",
        own_registration: true,
        own_branch: { name: "claudexor/thread-th-held", tip: "a".repeat(40) },
        held: { reason: "output_held", groups: [], at: "2026-11-15T10:00:01.000Z" },
        ...(cleanupError ? { cleanup_error: cleanupError } : {}),
      };
      writeThreadPreparation(record);
      const recordPath = threadPreparationRecordPath(tree);
      const recordBytes = readFileSync(recordPath);

      const setThreadWorktree = vi.fn();
      const thread = {
        workspace: { mode: "isolated", worktree_path: tree, base_sha: "base" },
        repo: { root: join(root, "project") },
      };
      const threads = {
        getThread: () => thread,
        setThreadWorktree,
      } as unknown as ProjectThreadPort;
      const token = "thread-apply-held-fixture";
      const sqlDir = join(root, "sql");
      /** One daemon lifetime: the real SQL delivery journal behind the real route. */
      async function daemon<T>(work: (post: () => Promise<Answer>) => Promise<T>): Promise<T> {
        const sql = await sqlFixture(sqlDir);
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
            threadDetail: async () => ({
              thread: { ...thread, run_ids: [] },
              turns: [],
              sessions: [],
            }),
            applyThread: (id, opts) => applyThreadDiff(threads, id, opts),
            beginDelivery: async (params, input) => sql.graph.threads.beginDelivery(params, input),
            completeDelivery: async (id, result) => sql.graph.threads.completeDelivery(id, result),
            failDelivery: async (id, error) => sql.graph.threads.failDelivery(id, error),
          },
        });
        const { host, port } = await server.start();
        try {
          return await work(async () => {
            const response = await fetch(`http://${host}:${port}/v2/threads/th-held/apply`, {
              method: "POST",
              body: JSON.stringify({ mode: "apply" }),
              headers: {
                authorization: ["Bearer", token].join(" "),
                "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
                "Idempotency-Key": "thread-apply-held",
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
      expect(first.body).toMatchObject({ code, retryable: true });
      expect(first.body["requiredActions"]).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(first.body["context"]).toMatchObject({
        held: [tree],
        preparation: { tree, record: recordPath },
      });
      const restarted = await daemon((post) => post());
      for (const answer of [replay, restarted]) {
        expect(answer.status).toBe(409);
        expect(answer.body).toEqual(first.body);
      }
      // The journal row keeps the retryability the replay answers.
      const journal = await sqlFixture(sqlDir);
      try {
        expect(journal.records()).toEqual([
          expect.objectContaining({
            state: "failed",
            errorCode: code,
            errorRetryable: true,
            result: { status: 409, code },
          }),
        ]);
      } finally {
        await journal.close();
      }
      // Apply released nothing and delivered nothing.
      expect(readFileSync(recordPath)).toEqual(recordBytes);
      expect(captureWorkingTreeTransient).not.toHaveBeenCalled();
      expect(verifyAndDeliver).not.toHaveBeenCalled();
      expect(setThreadWorktree).not.toHaveBeenCalled();
    },
  );
});
