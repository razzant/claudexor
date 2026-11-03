import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunFailure, RunTelemetry, SCHEMA_VERSION, TaskContract } from "@claudexor/schema";
import { projectBulkJob } from "./bulk-worker.js";
import { ROUTE_HEALTH_ARTIFACT_MAX_BYTES, type RouteHealthFacts } from "./route-health-facts.js";
import type { DaemonRunRecord } from "./run-record.js";
import { eventsParseCountForTests, resetEventsParseCountForTests } from "./run-timeline.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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

function telemetryText(harnessId: string, effectiveAccess: string): string {
  return JSON.stringify(
    RunTelemetry.parse({
      schema_version: SCHEMA_VERSION,
      run_id: "run-1",
      task_id: "task-1",
      mode: "ask",
      requested_access: effectiveAccess,
      effective_access: effectiveAccess,
      external_context_policy: "auto",
      effective_web_mode: "auto",
      web,
      final_attempt_id: "a01",
      attempts: [{ attempt_id: "a01", harness_id: harnessId, web }],
      generated_at: "2026-10-28T10:00:00.000Z",
    }),
  );
}

function taskText(runDir: string, effectiveProfile: string): string {
  return JSON.stringify(
    TaskContract.parse({
      schema_version: 2,
      task_id: "task-1",
      created_at: "2026-10-28T09:00:00.000Z",
      repo: { root: runDir, base_ref: "HEAD" },
      mode: { kind: "ask" },
      user_intent: { raw: "route health fixture" },
      access: { requested_profile: effectiveProfile, effective_profile: effectiveProfile },
    }),
  );
}

function failureText(runDir: string): string {
  return JSON.stringify(
    RunFailure.parse({
      category: "harness_error",
      harnessId: "agy",
      safeMessage: "agy headless tool permission refused: read_file",
      runDir,
    }),
  );
}

/** A finished failed run directory holding only the files a test writes. */
function runWith(files: Record<string, string>, error?: string): DaemonRunRecord {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-route-facts-"));
  roots.push(runDir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(runDir, rel, ".."), { recursive: true });
    writeFileSync(join(runDir, rel), text);
  }
  return {
    id: "job-1",
    runId: "run-1",
    taskId: "task-1",
    state: "failed",
    runDir,
    createdAt: "2026-10-28T09:00:00.000Z",
    finishedAt: "2026-10-28T09:05:00.000Z",
    ...(error === undefined ? {} : { error }),
    params: { mode: "ask", primaryHarness: "agy", harnesses: ["agy"], scope: { kind: "none" } },
  };
}

/** The worker job exactly as the bulk executor runs it. */
const routeFacts = (record: DaemonRunRecord) =>
  projectBulkJob(
    { kind: "route-facts", input: { record } },
    async () => null,
  ) as Promise<RouteHealthFacts>;

/** Two thousand journal lines: the summarizer parses them all, route facts none. */
const journal = Array.from({ length: 2_000 }, (_, i) =>
  JSON.stringify({ seq: i + 1, type: "harness.output", payload: { text: "x".repeat(200) } }),
).join("\n");

describe("route health facts", () => {
  it("reads the route from telemetry and the failure record, never the event journal", async () => {
    const record = runWith({
      "final/telemetry.yaml": telemetryText("agy", "readonly"),
      "final/failure.yaml": failureText("unused"),
      // Telemetry names the enforced access, so the task contract is not consulted.
      "context/task.yaml": taskText("/tmp", "workspace_write"),
      "events.jsonl": journal,
    });
    resetEventsParseCountForTests();
    const facts = await routeFacts(record);
    expect(facts).toMatchObject({
      route: { harnessId: "agy" },
      failure: {
        category: "harness_error",
        harnessId: "agy",
        safeMessage: "agy headless tool permission refused: read_file",
      },
      primaryHarness: "agy",
      effectiveAccess: "readonly",
    });
    expect(eventsParseCountForTests()).toBe(0);
    // The counter does see the shared summarizer parse the same journal, so
    // the zero above is a real absence of the read.
    await projectBulkJob({ kind: "summary", input: { record } }, async () => null);
    expect(eventsParseCountForTests()).toBeGreaterThan(0);
  });

  it("falls back to the task contract, then to unknown, and keeps a bare job error", async () => {
    const contractOnly = runWith(
      { "context/task.yaml": taskText("/tmp", "readonly") },
      "spawn ENOENT",
    );
    expect(await routeFacts(contractOnly)).toMatchObject({
      route: null,
      effectiveAccess: "readonly",
      failure: { category: "unknown", safeMessage: "spawn ENOENT" },
      error: "spawn ENOENT",
    });
    const bare = await routeFacts(runWith({}));
    expect(bare).toMatchObject({ route: null, failure: null, primaryHarness: "agy" });
    expect(bare.effectiveAccess).toBeUndefined();
  });

  it("counts an artifact over the read allowance as absent, and one under it as read", async () => {
    const pad = " ".repeat(ROUTE_HEALTH_ARTIFACT_MAX_BYTES);
    const over = runWith(
      {
        "final/telemetry.yaml": telemetryText("agy", "readonly") + pad,
        "final/failure.yaml": failureText("unused") + pad,
      },
      "spawn ENOENT",
    );
    const degraded = await routeFacts(over);
    expect(degraded).toMatchObject({
      route: null,
      failure: { category: "unknown", safeMessage: "spawn ENOENT" },
    });
    expect(degraded.effectiveAccess).toBeUndefined();
    const within = runWith({
      "final/telemetry.yaml": telemetryText("agy", "readonly") + " ".repeat(1_024),
      "final/failure.yaml": failureText("unused"),
    });
    expect(await routeFacts(within)).toMatchObject({
      route: { harnessId: "agy" },
      effectiveAccess: "readonly",
      failure: { category: "harness_error" },
    });
  });
});
