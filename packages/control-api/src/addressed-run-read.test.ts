/**
 * Addressed run reads in the control plane.
 *
 * `findRun` and parent-detail child projection used to ask the daemon for EVERY
 * retained record and match locally, so one `GET /v2/runs/:id` serialized every
 * retained prompt in the partition. Both now address the daemon. These tests
 * pin that the addressed query is actually sent, that the local exact match and
 * bounded child rule survive an engine that ignores it, that the honest
 * present/absent/terminal/unreachable distinctions are unchanged, and that the
 * cancellation cascade stays UNCAPPED.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DELEGATED_CHILDREN, type CommandListQuery } from "@claudexor/schema";
import { afterAll, describe, expect, it } from "vitest";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "./daemon-server.js";

const TOKEN = "addressed-run-read-token";

const reaped: string[] = [];
afterAll(() => {
  for (const dir of reaped.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-addressed-run-"));
  mkdirSync(join(dir, "final"), { recursive: true });
  reaped.push(dir);
  return dir;
}

function runRecord(seed: Partial<DaemonRunRecord> & { id: string }): DaemonRunRecord {
  return { state: "running", runDir: runDir(), params: {}, ...seed };
}

function delegatedChild(id: string, parentRunId: string, index: number): DaemonRunRecord {
  return runRecord({
    id: `job-${id}`,
    runId: id,
    createdAt: new Date(Date.UTC(2026, 8, 15) + index * 1_000).toISOString(),
    params: { parentRunId, delegatedFromRunId: parentRunId },
  });
}

/** A facade over a fixed roster. `onList` observes every query the control
 * plane sends; `honorQuery` decides whether this engine understands it. */
function facade(
  records: DaemonRunRecord[],
  options: {
    onList?: (query?: CommandListQuery) => void;
    honorQuery?: boolean;
    onCancel?: (id: string) => void;
  } = {},
): DaemonFacadeClient {
  return {
    async enqueue() {
      return { id: "job-unused", state: "queued" };
    },
    async status(id) {
      return records.find((record) => record.id === id) as DaemonRunRecord;
    },
    async list(query) {
      options.onList?.(query);
      if (!options.honorQuery) return records;
      if (query && "id" in query) {
        const hit = records.find((record) => record.id === query.id || record.runId === query.id);
        return hit ? [hit] : [];
      }
      if (query && "delegatedFromRunId" in query) {
        return records.filter(
          (record) =>
            (record.params as { delegatedFromRunId?: string })?.delegatedFromRunId ===
            query.delegatedFromRunId,
        );
      }
      return records;
    },
    async fenceDelegationParent(runId) {
      return { runId, fenced: true };
    },
    async cancel(id) {
      options.onCancel?.(id);
      const record = records.find((candidate) => candidate.id === id);
      if (record) record.state = "cancelled";
      return { id, cancelled: true };
    },
  };
}

async function withApi(
  daemon: DaemonFacadeClient,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = new DaemonControlApiServer({ token: TOKEN, daemon, pollMs: 1 });
  const { host, port } = await server.start();
  try {
    await fn(`http://${host}:${port}`);
  } finally {
    await server.stop();
  }
}

function get(base: string, path: string): Promise<Response> {
  return fetch(`${base}/v2${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, "X-Claudexor-Protocol-Major": "3" },
  });
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v2${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "X-Claudexor-Protocol-Major": "3" },
    body: JSON.stringify(body),
  });
}

describe("addressed run detail", () => {
  it("never asks an engine that refuses unqualified reads for the whole list", async () => {
    const parent = runRecord({ id: "job-parent", runId: "run-parent" });
    const child = delegatedChild("run-child", "run-parent", 0);
    const noise = Array.from({ length: 50 }, (_, index) =>
      runRecord({
        id: `job-noise-${index}`,
        runId: `run-noise-${index}`,
        params: { prompt: "unrelated" },
      }),
    );
    const queries: Array<CommandListQuery | undefined> = [];
    const strict: DaemonFacadeClient = {
      ...facade([parent, child, ...noise], { honorQuery: true }),
      async list(query) {
        queries.push(query);
        if (!query || (!("id" in query) && !("delegatedFromRunId" in query))) {
          throw new Error("unqualified daemon list on an addressed route");
        }
        if ("id" in query) {
          const hit = [parent, child, ...noise].find(
            (record) => record.id === query.id || record.runId === query.id,
          );
          return hit ? [hit] : [];
        }
        return [child].filter(
          (record) =>
            (record.params as { delegatedFromRunId?: string }).delegatedFromRunId ===
            query.delegatedFromRunId,
        );
      },
    };

    await withApi(strict, async (base) => {
      const response = await get(base, "/runs/run-parent");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { children: Array<{ runId: string }> };
      expect(body.children.map((row) => row.runId)).toEqual(["run-child"]);
    });
    expect(queries).toEqual([{ id: "run-parent" }, { delegatedFromRunId: "run-parent" }]);
  });

  it("keeps the exact match and the bounded child rule on an engine that ignores the query", async () => {
    // Forward compatibility: an older daemon answers every query with the full
    // list, so the control plane must still select rather than take element 0.
    const target = runRecord({ id: "job-target", runId: "run-target" });
    const children = Array.from({ length: 12 }, (_, index) =>
      delegatedChild(`run-kid-${index}`, "run-target", index),
    );
    const decoysFirst = [runRecord({ id: "job-decoy", runId: "run-decoy" }), ...children, target];

    await withApi(facade(decoysFirst, { honorQuery: false }), async (base) => {
      const response = await get(base, "/runs/run-target");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        summary: { runId: string };
        children: Array<{ runId: string }>;
      };
      expect(body.summary.runId).toBe("run-target");
      expect(body.children).toHaveLength(MAX_DELEGATED_CHILDREN);
      expect(body.children[0]!.runId).toBe("run-kid-0");
    });
  });
});

describe("addressed reads keep the honest present/absent distinctions", () => {
  it("serves a retained cancelled run, 404s a genuinely absent one, and 409s terminal control", async () => {
    const cancelled = runRecord({
      id: "job-cancelled",
      runId: "run-cancelled",
      state: "cancelled",
    });
    await withApi(facade([cancelled], { honorQuery: true }), async (base) => {
      const detail = await get(base, "/runs/run-cancelled");
      expect(detail.status).toBe(200);
      expect((await detail.json()) as { summary: { state: string } }).toMatchObject({
        summary: { state: "cancelled" },
      });

      const absent = await get(base, "/runs/run-never-existed");
      expect(absent.status).toBe(404);
      expect(await absent.json()).toMatchObject({ code: "http_404", message: "no such run" });

      // Present but terminal: the control has nothing to stop, and saying so is
      // a different fact from "this run does not exist".
      const control = await post(base, "/runs/run-cancelled/control", {
        control: { kind: "cancel" },
      });
      expect(control.status).toBe(409);
    });
  });

  it("never reports an unreachable daemon as an absent run", async () => {
    const unreachable: DaemonFacadeClient = {
      ...facade([], {}),
      async list() {
        throw Object.assign(new Error("daemon connection closed"), { code: "daemon_unreachable" });
      },
    };
    await withApi(unreachable, async (base) => {
      const response = await get(base, "/runs/run-target");
      expect(response.status).toBe(500);
      // A transport failure is never the 404 an absent run would produce.
      expect(await response.json()).not.toMatchObject({ code: "http_404" });
    });
  });
});

describe("Delegate cancellation cascade", () => {
  it("cancels every transitive descendant, past the direct-child display cap", async () => {
    const parent = runRecord({ id: "job-parent", runId: "run-parent", params: { delegate: true } });
    // A deep chain: more descendants than the bounded direct-child projection
    // shows, and deeper than one generation. Cancellation must reach all of them.
    const chain = Array.from({ length: MAX_DELEGATED_CHILDREN + 4 }, (_, index) =>
      delegatedChild(
        `run-desc-${index}`,
        index === 0 ? "run-parent" : `run-desc-${index - 1}`,
        index,
      ),
    );
    const cancelledIds: string[] = [];
    const daemon = facade([parent, ...chain], { onCancel: (id) => cancelledIds.push(id) });

    await withApi(daemon, async (base) => {
      const response = await post(base, "/runs/run-parent/control", {
        control: { kind: "cancel" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { cascadeRunIds: string[] };
      expect(body.cascadeRunIds).toEqual(chain.map((record) => record.runId));
      expect(body.cascadeRunIds.length).toBeGreaterThan(MAX_DELEGATED_CHILDREN);
    });
    expect(cancelledIds).toEqual(
      [...chain]
        .reverse()
        .map((record) => record.id)
        .concat("job-parent"),
    );
  });
});
