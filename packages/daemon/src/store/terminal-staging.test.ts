import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  RunEvent,
  RunTelemetry,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { processTiming } from "@claudexor/util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlCommandStore } from "./commands.js";
import { ensureDirectory } from "./external-files.js";
import { MaintenanceController } from "./maintenance.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { storedTerminal } from "./run-events.js";
import { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";

const TIME = "2026-11-02T00:00:00.000Z";
const dist = (file: string) => resolve(import.meta.dirname, "../../dist/store", file);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function facts() {
  const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: "run",
    task_id: "task",
    mode: "agent",
    outcome,
    deliverable: { present: false, kind: null, path: null, producer_attempt_id: null },
    participants: { planners: 0, attempts: [] },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: requiredActionsFor(outcome, false),
    generated_at: TIME,
  });
}
function telemetry(generatedAt = TIME) {
  return RunTelemetry.parse({
    schema_version: SCHEMA_VERSION,
    run_id: "run",
    task_id: "task",
    mode: "agent",
    requested_access: "full",
    effective_access: "full",
    external_context_policy: "off",
    effective_web_mode: "off",
    web: {},
    attempts: [],
    generated_at: generatedAt,
    run_facts: facts(),
  });
}
/** A failed terminal whose journal copy is a large body (its error text). */
function terminal() {
  const value = facts();
  return RunEvent.parse({
    seq: 2,
    ts: TIME,
    run_id: "run",
    task_id: "task",
    type: "run.failed",
    payload: {
      lifecycle: value.outcome.lifecycle,
      facts: value.outcome,
      reason: value.outcome.reason,
      run_facts: value,
      error: "e".repeat(70_000),
    },
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-terminal-staging-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, "run");
  mkdirSync(join(runDir, "final"), { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    `${JSON.stringify({ seq: 1, ts: TIME, run_id: "run", task_id: "task", type: "run.created", payload: {} })}\n`,
  );
  const daemonDir = join(root, "daemon");
  const store = await EngineStore.open({
    daemonDir,
    workerEntry: dist("flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  cleanup.push(() => store.close());
  const generation = store.transaction(() => createPartition(store, "global"));
  const blobs = new BlobFiles(store),
    obligations = new Obligations(store),
    files = new SqlTerminalFiles(store, obligations);
  const commands = new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    terminalFiles: files,
    pruner: new SqlCommandPruner(store, blobs),
  });
  // An established store's body directory (created and registered on the request thread).
  ensureDirectory(store, blobs.dir);
  commands.accept({
    id: "job",
    params: { mode: "agent", prompt: "fixture" },
    idempotencyKey: "key",
    clientId: "fixture",
  });
  commands.update("job", { state: "running", runId: "run", taskId: "task", runDir });
  // Every external write reports what it did: wrote bytes, or adopted staged ones.
  vi.spyOn(processTiming, "recordSync").mockReturnValue(true);
  const log = vi.spyOn(store, "logSlowWrite");
  const writes = () =>
    log.mock.calls.map(([line]) =>
      JSON.parse(String(line).slice("store.external_write ".length)),
    ) as Array<{ purpose: string; written: boolean; staged?: true; bytes: number }>;
  const temps = () => readdirSync(blobs.dir).filter((name) => name.endsWith(".tmp"));
  return { root, runDir, daemonDir, store, generation, blobs, files, commands, writes, temps };
}

describe("terminal receipts and bodies are written off the request thread before the commit", () => {
  it("publishes staged receipts and adopts the staged journal body inside the synchronous commit", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    expect(f.temps()).toHaveLength(2);
    expect(existsSync(join(f.runDir, "final", "run_facts.yaml"))).toBe(false);

    expect(f.commands.persistTerminal("job", terminal(), telemetry())).toEqual({
      state: "materialized",
    });
    const receipts = f.writes().filter((write) => write.purpose === "terminal_receipt");
    expect(receipts).toEqual([
      expect.objectContaining({ staged: true, written: true }),
      expect.objectContaining({ staged: true, written: true }),
    ]);
    const bodies = f.writes().filter((write) => write.purpose === "blob_body");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((write) => write.written)).toEqual([]);
    expect(f.temps()).toEqual([]);
    const receipt = parseYaml(readFileSync(join(f.runDir, "final", "run_facts.yaml"), "utf8"));
    expect(validateRunFactsInvariants(receipt)).toEqual(facts());
    expect(readFileSync(join(f.runDir, "final", "telemetry.yaml"), "utf8")).toContain(
      '"run_id": "run"',
    );
    expect(readFileSync(join(f.runDir, "events.jsonl"), "utf8")).toContain('"type":"run.failed"');
    expect(f.files.pending("run")).toBe(false);
  });

  it("writes on the request thread what changed after staging and drops the stale temp", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    const changed = telemetry("2026-11-02T00:00:01.000Z");
    expect(f.commands.persistTerminal("job", terminal(), changed)).toEqual({
      state: "materialized",
    });
    const receipts = f.writes().filter((write) => write.purpose === "terminal_receipt");
    expect(receipts).toEqual([
      expect.objectContaining({ staged: true, written: true }),
      expect.not.objectContaining({ staged: true }),
    ]);
    expect(receipts[1]).toMatchObject({ written: true });
    expect(readFileSync(join(f.runDir, "final", "telemetry.yaml"), "utf8")).toContain(
      "2026-11-02T00:00:01.000Z",
    );
    expect(f.temps()).toEqual([]);
  });

  it("leaves no terminal after a crash between staging and the commit; the orphan sweep reclaims the temps", async () => {
    const f = await fixture();
    await f.commands.stageTerminal("job", terminal(), telemetry());
    const staged = f.temps();
    expect(staged).toHaveLength(2);
    const bodies = readdirSync(f.blobs.dir).filter((name) => !name.endsWith(".tmp"));
    // The process dies before the synchronous terminal commit ran.
    await f.store.close();
    const store = await EngineStore.open({
      daemonDir: f.daemonDir,
      workerEntry: dist("flusher-worker.js"),
    });
    cleanup.push(() => store.close());
    expect(storedTerminal(store, "run", f.generation.pid)).toBeUndefined();
    expect(existsSync(join(f.runDir, "final", "run_facts.yaml"))).toBe(false);
    expect(existsSync(join(f.runDir, "final", "telemetry.yaml"))).toBe(false);
    const maintenance = new MaintenanceController(store, {
      workerEntry: dist("maintenance-worker.js"),
      processStartedAt: Date.now() + 1_000,
    });
    cleanup.push(() => maintenance.stop());
    const report = await maintenance.sweepOrphans();
    expect(report.removedTemps.map((path) => basename(path)).sort()).toEqual([...staged].sort());
    expect(f.temps()).toEqual([]);
    // The staged journal body was published but never owned: the sweep takes it too.
    expect(bodies.length).toBeGreaterThan(0);
    expect(report.removedBlobs.sort()).toEqual([...bodies].sort());
  });
});
