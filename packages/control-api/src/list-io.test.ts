import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { ControlRunListResponse, ControlThreadListResponse, TaskContract } from "@claudexor/schema";
import {
  WorkspaceManager,
  envelopeBaseOf,
  retainForContinuation,
  writeContinuationSources,
  writeEnvelopeCustody,
  retainedEnvelopeBase,
} from "@claudexor/workspace";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import { EventLog } from "@claudexor/event-log";
import { runRetentionPass } from "./retention.js";
import { finalizeStructuredOutput } from "../../orchestrator/src/structuredOutput.js";
import type { DaemonRunRecord } from "./run-record.js";
import { BulkExecutor } from "./bulk-executor.js";
import { BULK_WORKER_ROLE } from "./bulk-protocol.js";

const io = vi.hoisted(() => ({
  reads: [] as string[],
  onRead: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      io.reads.push(String(args[0]));
      io.onRead?.();
      return fs.readFileSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  io.onRead = undefined;
  io.reads = [];
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-list-io-")));
  roots.push(root);
  return root;
}
function record(id: string, state = "succeeded", runDir = temp()): DaemonRunRecord {
  mkdirSync(join(runDir, "final"), { recursive: true });
  mkdirSync(join(runDir, "arbitration"));
  writeFileSync(join(runDir, "final/telemetry.yaml"), "attempts: []\n");
  writeFileSync(
    join(runDir, "arbitration/decision.yaml"),
    JSON.stringify({
      winner: "a01",
      facts: {
        lifecycle: "succeeded",
        review: "blocked",
        checks: "not_configured",
        noChanges: false,
      },
    }),
  );
  return { id, runId: id, runDir, state, params: { mode: "agent", scope: { kind: "none" } } };
}
async function withServer(
  records: DaemonRunRecord[],
  services: DaemonControlApiOptions["services"],
  test: (get: (path: string) => Promise<Response>, queries: unknown[]) => Promise<void>,
) {
  const queries: unknown[] = [];
  const server = new DaemonControlApiServer({
    token: "list-fixture",
    services,
    daemon: {
      list: async (query) => {
        queries.push(query);
        if ("ids" in query) return records.filter((r) => query.ids.includes(r.runId ?? r.id));
        return records;
      },
      status: async () => records[0]!,
      enqueue: async () => ({ id: "unused", state: "queued" }),
      cancel: async () => ({}),
    },
  });
  // Keep cost assertions on real worker reads, not main-thread-only spies.
  (server as unknown as { bulk: BulkExecutor }).bulk = new BulkExecutor(() => {
    const worker = new Worker(new URL("./test-support/bulk-read-counter.mjs", import.meta.url), {
      workerData: { role: BULK_WORKER_ROLE },
    });
    worker.on("message", (message: { type?: string; path: string }) => {
      if (message.type !== "test:artifact-read") return;
      io.reads.push(message.path);
      io.onRead?.();
    });
    return worker;
  });
  const { host, port } = await server.start();
  try {
    await test(
      (path) =>
        fetch(`http://${host}:${port}${path}`, {
          headers: { authorization: "Bearer list-fixture", "X-Claudexor-Protocol-Major": "3" },
        }),
      queries,
    );
  } finally {
    await server.stop();
  }
}

it("lists all threads in order but reads attention artifacts only for succeeded heads", async () => {
  const blocked = record("blocked");
  const old = record("historical");
  const clean = record("clean");
  writeFileSync(
    join(clean.runDir!, "arbitration/decision.yaml"),
    JSON.stringify({
      winner: "a01",
      facts: { lifecycle: "succeeded", review: "approved", checks: "passed", noChanges: false },
    }),
  );
  const running = record("running", "running");
  const threads = [blocked, clean, running].map((r, i) => ({
    id: `thread-${i}`,
    mode: "agent",
    run_ids: [old.id, r.id],
    head_run_id: r.id,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: `2026-10-0${3 - i}T00:00:00Z`,
  }));
  const problems = [
    {
      projectId: "missing",
      root: "/missing",
      code: "project_root_missing" as const,
      message: "fixture",
    },
  ];
  await withServer(
    [old, blocked, clean, running],
    { listThreads: async () => ({ threads, problems }) },
    async (get, queries) => {
      io.reads = [];
      const response = await get("/v2/threads");
      expect(response.status).toBe(200);
      const body = ControlThreadListResponse.parse(await response.json());
      expect(body.threads.map((t) => [t.id, t.needsHuman])).toEqual([
        ["thread-0", true],
        ["thread-1", false],
        ["thread-2", false],
      ]);
      expect(body.problems).toEqual(problems);
      expect(queries).toEqual([{ ids: [blocked.id, clean.id, running.id] }]);
      expect(io.reads.some((p) => p.startsWith(blocked.runDir!))).toBe(true);
      expect(
        io.reads.filter((p) => p.startsWith(old.runDir!) || p.startsWith(running.runDir!)),
      ).toEqual([]);
    },
  );
});

it("keeps hot pages free of artifact/continuation reads and invalidates custody-only changes", async () => {
  const repo = temp();
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "init",
  ]);
  const ancestor = record("ancestor", "interrupted");
  const head = record("head", "failed");
  writeFileSync(join(ancestor.runDir!, "final/retained-output.md"), "Work to continue\n");
  writeContinuationSources(head.runDir!, [
    { runId: ancestor.id, runDir: ancestor.runDir!, state: "interrupted" },
  ]);
  const manager = new WorkspaceManager(repo);
  const env = await manager.create({ taskId: "task-list", attemptId: "a01", baseRef: "HEAD" });
  const custody = retainForContinuation(
    env,
    { runId: ancestor.id, runDir: ancestor.runDir! },
    "host_restart",
  );
  await withServer([head], {}, async (get) => {
    const page = async () => ControlRunListResponse.parse(await (await get("/v2/runs")).json());
    const first = await page();
    expect(first.runs[0]?.resumable?.workspace.kind).toBe("retained_envelope");
    io.reads = [];
    expect(await page()).toEqual(first);
    expect(io.reads).toEqual([]);
    // Adoption writes custody before removing the pointer: test that interval.
    writeEnvelopeCustody(envelopeBaseOf(env), {
      ...custody,
      state: "live",
      holder_run_id: "successor",
    });
    const changed = await page();
    expect(changed.runs[0]?.resumable?.workspace.kind).toBe("none");
    expect(io.reads).toContain(join(head.runDir!, "context/continuation.json"));
    expect(io.reads.some((p) => p === join(head.runDir!, "final/telemetry.yaml"))).toBe(true);
    expect(await page()).toEqual(changed);
  });
  await manager.dispose(env);
});

it("serves health during a cold page before the remaining summaries read their artifacts", async () => {
  const pageRoot = temp();
  const records = Array.from({ length: 120 }, (_, i) =>
    record(`run-${i}`, "succeeded", join(pageRoot, `run-${i}`)),
  );
  await withServer(records, {}, async (get) => {
    const telemetry = new Set<string>();
    let health: Promise<void> | undefined;
    let readCountAtHealth = 0;
    io.onRead = () => {
      for (const p of io.reads) if (p.endsWith("/final/telemetry.yaml")) telemetry.add(p);
      if (telemetry.size && !health)
        health = get("/healthz").then(async (response) => {
          expect(response.status).toBe(200);
          await response.arrayBuffer();
          readCountAtHealth = telemetry.size;
        });
    };
    const response = await get("/v2/runs?limit=120");
    expect(response.status).toBe(200);
    const page = ControlRunListResponse.parse(await response.json());
    await health;
    expect(page.runs).toHaveLength(120);
    expect(telemetry.size).toBe(120);
    expect(readCountAtHealth).toBeGreaterThan(0);
    expect(readCountAtHealth).toBeLessThan(120);
    console.info("cold-page HTTP health witness", {
      summariesAtHealth: readCountAtHealth,
      total: 120,
    });
    expect((await get("/v2/runs?unknown=1")).status).toBe(400);
  });
});

it("invalidates inherited continuation when real GC reclaims an eligible ancestor without a pointer", async () => {
  const runsDir = temp();
  const ancestor = record("old", "interrupted", join(runsDir, "old"));
  // No thread reference, retained envelope or actionable patch protects this source.
  rmSync(join(ancestor.runDir!, "arbitration/decision.yaml"));
  writeFileSync(join(ancestor.runDir!, "final/answer.md"), "prior work\n");
  const head = record("head", "failed");
  writeContinuationSources(head.runDir!, [
    { runId: ancestor.id, runDir: ancestor.runDir!, state: ancestor.state },
  ]);
  await withServer([head], {}, async (get) => {
    const page = async () => ControlRunListResponse.parse(await (await get("/v2/runs")).json());
    expect((await page()).runs[0]?.resumable?.cause).toBe("host_restart");
    expect(retainedEnvelopeBase(ancestor.runDir!)).toBeNull();
    const receipt = await runRetentionPass(
      { runsMaxAgeDays: 1, reviewsMaxAgeDays: 1, keepLastRunsPerProject: 0 },
      { dry_run: false },
      {
        projects: () => [{ root: runsDir, runsDir, reviewsDir: null }],
        records: () => [
          { runId: ancestor.id, state: ancestor.state, finishedAt: "2020-01-01T00:00:00Z" },
        ],
        referencedRunIds: () => new Set(),
      },
    );
    expect(receipt.deleted_runs.map((run) => run.run_id)).toEqual([ancestor.id]);
    expect(retainedEnvelopeBase(ancestor.runDir!)).toBeNull();
    expect((await page()).runs[0]?.resumable).toBeNull();
  });
});

it("observes active task and unparseable structured-output publication without an event or record change", async () => {
  const rec = record("active", "running");
  const store = new ArtifactStore(temp());
  const eventsPath = join(rec.runDir!, "events.jsonl");
  writeFileSync(eventsPath, "");
  const log = new EventLog(eventsPath, rec.id, "task-active");
  try {
    await withServer([rec], {}, async (get) => {
      const page = async () =>
        ControlRunListResponse.parse(await (await get("/v2/runs")).json()).runs[0]!;
      const before = await page();
      // Convergence publishes this contract via the same store owner without
      // task.contract.created; subsequent workspace preparation awaits I/O.
      const task = TaskContract.parse({
        schema_version: 2,
        task_id: "task-active",
        created_at: new Date().toISOString(),
        repo: { root: dirname(rec.runDir!), base_ref: "HEAD" },
        mode: { kind: "agent" },
        user_intent: { raw: "test" },
        access: { requested_profile: "readonly", effective_profile: "readonly" },
      });
      store.writeYaml(join(rec.runDir!, "context/task.yaml"), task);
      const published = await page();
      expect(before.effectiveAccess).toBeUndefined();
      expect(published.effectiveAccess).toBe("readonly");
      expect(published.outputConformance).toBeNull();
      const emitted = vi.spyOn(log, "emit");
      finalizeStructuredOutput({
        store,
        log,
        finalDir: join(rec.runDir!, "final"),
        schema: { type: "object" },
        answerText: "unparseable output",
      });
      expect(emitted).not.toHaveBeenCalled();
      expect((await page()).outputConformance).toBe("failed");
    });
  } finally {
    log.dispose();
  }
});

it("deduplicates addressed heads while preserving null, missing and duplicate thread rows", async () => {
  const head = record("shared");
  const threads = [null, "missing", head.id, head.id].map((id, i) => ({
    id: `t-${i}`,
    mode: "agent",
    head_run_id: id,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  }));
  await withServer([head], { listThreads: async () => ({ threads }) }, async (get, queries) => {
    const response = await get("/v2/threads");
    expect(response.status).toBe(200);
    const body = ControlThreadListResponse.parse(await response.json());
    expect(body.threads.map((t) => [t.id, t.needsHuman])).toEqual([
      ["t-0", false],
      ["t-1", false],
      ["t-2", true],
      ["t-3", true],
    ]);
    expect(queries).toEqual([{ ids: ["missing", "shared"] }]);
  });
});
