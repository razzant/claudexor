import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlRouteHealth,
  DaemonTimingFacts,
  RunFailure,
  RunTelemetry,
  SCHEMA_VERSION,
  selectRunListPage,
} from "@claudexor/schema";
import { processTiming } from "@claudexor/util";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

const token = "route-health-fixture";
const headers = { authorization: `Bearer ${token}`, "X-Claudexor-Protocol-Major": "3" };
const roots: string[] = [];
const servers: DaemonControlApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const web = {
  required: false,
  policy: "auto",
  effective_mode: "auto",
  attempted: false,
  satisfied: false,
  status: "none",
  tool: null,
  target: null,
  error_summary: null,
};

function telemetry(id: string, harnessId: string, effectiveAccess: string) {
  return RunTelemetry.parse({
    schema_version: SCHEMA_VERSION,
    run_id: id,
    task_id: `task-${id}`,
    mode: "ask",
    requested_access: effectiveAccess,
    effective_access: effectiveAccess,
    external_context_policy: "auto",
    effective_web_mode: "auto",
    web,
    final_attempt_id: "a01",
    attempts: [{ attempt_id: "a01", harness_id: harnessId, web }],
    generated_at: "2026-10-28T10:00:00.000Z",
  });
}

interface Fixture {
  id: string;
  state: string;
  createdAt: string;
  primaryHarness: string;
  /** Telemetry-settled route; absent = no telemetry artifact (access unknown). */
  settled?: { harnessId: string; access: string };
  failure?: { category: string; message: string };
  error?: string;
}

function makeRun(root: string, fixture: Fixture): DaemonRunRecord {
  const runDir = join(root, fixture.id);
  mkdirSync(join(runDir, "final"), { recursive: true });
  if (fixture.settled) {
    writeFileSync(
      join(runDir, "final", "telemetry.yaml"),
      JSON.stringify(telemetry(fixture.id, fixture.settled.harnessId, fixture.settled.access)),
    );
  }
  if (fixture.failure) {
    writeFileSync(
      join(runDir, "final", "failure.yaml"),
      JSON.stringify(
        RunFailure.parse({
          category: fixture.failure.category,
          harnessId: fixture.settled?.harnessId ?? null,
          safeMessage: fixture.failure.message,
          runDir,
        }),
      ),
    );
  }
  return {
    id: `job-${fixture.id}`,
    runId: fixture.id,
    taskId: `task-${fixture.id}`,
    state: fixture.state,
    runDir,
    createdAt: fixture.createdAt,
    ...(fixture.state === "running" ? {} : { finishedAt: fixture.createdAt }),
    ...(fixture.error ? { error: fixture.error } : {}),
    params: {
      mode: "ask",
      primaryHarness: fixture.primaryHarness,
      harnesses: [fixture.primaryHarness],
      scope: { kind: "none" },
    },
  };
}

async function fixture(fixtures: Fixture[]) {
  const root = mkdtempSync(join(tmpdir(), "claudexor-route-health-"));
  roots.push(root);
  const records = fixtures.map((f) => makeRun(root, f));
  const daemon: DaemonFacadeClient = {
    enqueue: async () => ({ id: "none", state: "queued" }),
    status: async (id) => {
      const found = records.find((r) => r.id === id || r.runId === id);
      if (!found) throw new Error(`no such job: ${id}`);
      return structuredClone(found);
    },
    list: async (query) =>
      "page" in query
        ? selectRunListPage(records, { ...query.page, limit: query.page.limit + 1 }).page.map((r) =>
            structuredClone(r),
          )
        : [],
    cancel: async () => ({ ok: true }),
  };
  const server = new DaemonControlApiServer({ token, daemon, host: "127.0.0.1", port: 0 });
  servers.push(server);
  const { host, port } = await server.start();
  return (path: string) => fetch(`http://${host}:${port}${path}`, { headers });
}

// The route reads the real clock (`scanRouteHealth`'s default `now`), so run
// times are relative to the request: the seven-day window holds the same rows
// whatever day the suite runs.
const HOUR_MS = 60 * 60 * 1_000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const recent = hoursAgo(1);
const refused = {
  category: "harness_error",
  message: "agy headless tool permission refused: read_file",
};

describe("GET /v2/daemon/route-health over the control API", () => {
  it("reads the window's bounded route facts and groups runs per route", async () => {
    const get = await fixture([
      {
        id: "a1",
        state: "failed",
        createdAt: recent,
        primaryHarness: "agy",
        settled: { harnessId: "agy", access: "readonly" },
        failure: refused,
      },
      {
        id: "live",
        state: "running",
        createdAt: hoursAgo(2),
        primaryHarness: "claude",
      },
      {
        id: "a2",
        state: "failed",
        createdAt: hoursAgo(1 * 24 + 1),
        primaryHarness: "agy",
        settled: { harnessId: "agy", access: "readonly" },
        failure: refused,
      },
      // No failure.yaml: readFailure falls back to the job error as an unknown category.
      {
        id: "a3",
        state: "failed",
        createdAt: hoursAgo(2 * 24 + 1),
        primaryHarness: "agy",
        settled: { harnessId: "agy", access: "readonly" },
        error: "spawn ENOENT",
      },
      {
        id: "c1",
        state: "succeeded",
        createdAt: hoursAgo(3 * 24 + 1),
        primaryHarness: "claude",
        settled: { harnessId: "claude", access: "workspace_write" },
      },
      // No telemetry at all: harness from the primary harness, access unknown.
      {
        id: "d1",
        state: "cancelled",
        createdAt: hoursAgo(4 * 24 + 1),
        primaryHarness: "codex",
      },
      {
        id: "d2",
        state: "interrupted",
        createdAt: hoursAgo(5 * 24 + 1),
        primaryHarness: "codex",
      },
      // Created more than seven days before the request: the walk ends here.
      {
        id: "old",
        state: "failed",
        createdAt: hoursAgo(27 * 24),
        primaryHarness: "agy",
        settled: { harnessId: "agy", access: "readonly" },
        failure: refused,
      },
    ]);
    const response = await get("/v2/daemon/route-health");
    expect(response.status).toBe(200);
    const health = ControlRouteHealth.parse(await response.json());
    expect(health).toMatchObject({
      windowDays: 7,
      scannedRuns: 6,
      complete: true,
      incompleteReason: null,
    });
    expect(Date.parse(health.generatedAt) - Date.parse(health.from)).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(health.routes).toEqual([
      {
        harnessId: "agy",
        access: "readonly",
        runs: 3,
        succeeded: 0,
        failed: 3,
        cancelled: 0,
        other: 0,
        topFailures: [
          { category: "harness_error", code: null, message: refused.message, count: 2 },
          { category: "unknown", code: null, message: "spawn ENOENT", count: 1 },
        ],
      },
      {
        harnessId: "claude",
        access: "workspace_write",
        runs: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        other: 0,
        topFailures: [],
      },
      {
        harnessId: "codex",
        access: "unknown",
        runs: 2,
        succeeded: 0,
        failed: 0,
        cancelled: 2,
        other: 0,
        topFailures: [],
      },
    ]);
  });

  it("keeps route-facts jobs out of the daemon status timing facts", async () => {
    const get = await fixture([
      {
        id: "t1",
        state: "failed",
        createdAt: recent,
        primaryHarness: "agy",
        settled: { harnessId: "agy", access: "readonly" },
        failure: refused,
      },
    ]);
    expect((await get("/v2/daemon/route-health")).status).toBe(200);
    expect((await get("/v2/runs")).status).toBe(200);
    const facts = processTiming.facts();
    const kinds = facts.bulk.map((entry) => entry.kind);
    // The run list's summary jobs are still timed; route-facts jobs are not, so
    // the closed kind set an older strict client validates never meets a new value.
    expect(kinds).toContain("summary");
    expect(kinds).not.toContain("route-facts");
    expect(DaemonTimingFacts.parse(facts)).toEqual(facts);
  });

  it("answers an empty window honestly and refuses query parameters", async () => {
    const get = await fixture([]);
    const empty = await get("/v2/daemon/route-health");
    expect(empty.status).toBe(200);
    expect(ControlRouteHealth.parse(await empty.json())).toMatchObject({
      scannedRuns: 0,
      complete: true,
      routes: [],
    });
    const refusedQuery = await get("/v2/daemon/route-health?days=3");
    expect(refusedQuery.status).toBe(400);
    expect(await refusedQuery.json()).toMatchObject({ code: "invalid_request" });
  });
});
