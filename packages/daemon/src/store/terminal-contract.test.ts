import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EventLog, appendRunEvent } from "../../../event-log/src/index.js";
import {
  RunEvent,
  RunTelemetry,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  requiredActionsFor,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import { appendLine } from "@claudexor/util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamRunEvents,
  type StreamEventsCtx,
} from "../../../control-api/src/run-events-stream.js";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandStore } from "./commands.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlEventLedger } from "./event-store.js";
import { writeExternalFile } from "./external-files.js";
import { Obligations } from "./obligations.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { SqlRunEventStore, storedTerminal } from "./run-events.js";
import { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";

const TIME = "2026-10-10T00:00:00.000Z";
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
function telemetry() {
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
    generated_at: TIME,
    run_facts: facts(),
  });
}
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
    },
  });
}
async function runtime(root: string, io: ConstructorParameters<typeof SqlTerminalFiles>[2] = {}) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  cleanup.push(() => store.close());
  const generation =
    currentGeneration(store, "global") ?? store.transaction(() => createPartition(store, "global"));
  const blobs = new BlobFiles(store),
    obligations = new Obligations(store),
    files = new SqlTerminalFiles(store, obligations, io);
  const commands = new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    terminalFiles: files,
    pruner: new SqlCommandPruner(store, blobs),
  });
  return { store, generation, blobs, obligations, files, commands };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-sql-terminal-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, "run");
  mkdirSync(join(runDir, "final"), { recursive: true });
  let fault: string | null = null;
  const writes: string[] = [];
  const f = await runtime(root, {
    write: (store, input) => {
      writes.push(input.name);
      if (input.name === fault) throw new Error(`EIO ${fault}`);
      return writeExternalFile(store, input);
    },
    append: (path, line) => {
      writes.push("events.jsonl");
      if (fault === "events.jsonl") throw new Error("EIO events.jsonl");
      appendLine(path, line);
    },
  });
  f.commands.accept({
    id: "job",
    params: { mode: "agent", prompt: "fixture" },
    idempotencyKey: "key",
    clientId: "fixture",
  });
  f.commands.update("job", { state: "running", runId: "run", taskId: "task", runDir });
  const events = new SqlRunEventStore(new SqlEventLedger(f.store, f.blobs, f.generation));
  const persisted = vi.fn((event: RunEvent) => events.record(event));
  const log = new EventLog(join(runDir, "events.jsonl"), "run", "task", persisted);
  cleanup.push(() => log.dispose());
  const legacyCommit = vi.fn(() => {
      throw new Error("legacy fsync writer must not run");
    }),
    rollback = vi.fn();
  log.setBeforeTerminal((type) => ({
    type,
    payload: terminal().payload,
    telemetry: telemetry(),
    commit: legacyCommit,
    rollback,
  }));
  log.setTerminalPersistence((event, t) => f.commands.persistTerminal("job", event, t));
  log.emit("run.created", { mode: "agent", prompt: "fixture" });
  return {
    ...f,
    root,
    runDir,
    log,
    persisted,
    legacyCommit,
    rollback,
    writes,
    setFault: (value: string | null) => {
      fault = value;
    },
  };
}
function pass(store: EngineStore): Promise<void> {
  return new Promise((resolve) => {
    const off = store.onSynced(() => {
      off();
      resolve();
    });
    store.flusherControl.tick();
  });
}
const readEvents = (runDir: string) =>
  readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => RunEvent.parse(JSON.parse(line)));

describe("SQL terminal transaction and real EventLog", () => {
  it("commits once, materializes every prepared file, and cannot be overwritten by a late result", async () => {
    const f = await fixture();
    const event = f.log.emit("run.failed", terminal().payload);
    expect(f.legacyCommit).not.toHaveBeenCalled();
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.persisted).toHaveBeenCalledTimes(1);
    expect(f.commands.get("job")).toMatchObject({
      state: "failed",
      finishedAt: event.ts,
      result: { lifecycle: "failed", facts: facts().outcome },
    });
    expect(storedTerminal(f.store, "run")).toEqual(event);
    expect(f.obligations.get("terminal_files", "run")?.state).toBe("materialized");
    expect(JSON.parse(readFileSync(join(f.runDir, "final/run_facts.yaml"), "utf8"))).toEqual(
      facts(),
    );
    expect(JSON.parse(readFileSync(join(f.runDir, "final/telemetry.yaml"), "utf8"))).toEqual(
      telemetry(),
    );
    expect(readEvents(f.runDir).map((row) => row.type)).toEqual(["run.created", "run.failed"]);
    expect(() => f.commands.persistTerminal("job", event, telemetry())).toThrow(
      /UNIQUE|constraint/i,
    );
    f.commands.update("job", {
      state: "cancelled",
      finishedAt: "2099-01-01T00:00:00.000Z",
      result: { summary: "late detail", facts: { lifecycle: "succeeded" } },
    });
    expect(f.commands.get("job")).toMatchObject({
      state: "failed",
      finishedAt: event.ts,
      result: { summary: "late detail", lifecycle: "failed", facts: facts().outcome },
    });
    await pass(f.store);
    expect(f.obligations.get("terminal_files", "run")).toBeUndefined();
    expect(readEvents(f.runDir).filter((row) => row.type === "run.failed")).toHaveLength(1);
  });

  it.each(["run_facts.yaml", "telemetry.yaml", "events.jsonl"])(
    "T-TRM-1/4: repeated EIO in %s keeps SQL terminal and immediate repair later completes without another terminal INSERT",
    async (name) => {
      const f = await fixture();
      f.setFault(name);
      expect(() => f.log.emit("run.failed", terminal().payload)).toThrow(
        expect.objectContaining({ code: "terminal_recovery_required" }),
      );
      expect(f.writes.filter((value) => value === name)).toHaveLength(2);
      expect(f.commands.get("job")?.state).toBe("failed");
      expect(f.obligations.get("terminal_files", "run")?.state).toBe("pending");
      expect(f.rollback).not.toHaveBeenCalled();
      expect(f.legacyCommit).not.toHaveBeenCalled();
      f.commands.update("job", { state: "cancelled", finishedAt: "2099-01-01" });
      expect(f.commands.get("job")?.state).toBe("failed");
      f.setFault(null);
      expect(f.commands.recoverDurableTerminal("job")?.state).toBe("failed");
      f.log.releaseRecoveredTerminalFence();
      appendRunEvent(join(f.runDir, "events.jsonl"), "run", "task", "control.requested", {
        action: "cancel",
      });
      expect(readEvents(f.runDir).map((row) => row.type)).toEqual([
        "run.created",
        "run.failed",
        "control.requested",
      ]);
      expect(f.store.prepare("SELECT count(*) AS n FROM run_terminal").get()).toEqual({ n: 1 });
      expect(f.obligations.get("terminal_files", "run")?.state).toBe("materialized");
    },
  );

  it("a terminal event INSERT fault rolls command/result/obligation/sequence back before files", async () => {
    const f = await fixture();
    const before = f.store.prepare("SELECT next_seq FROM partition").get();
    f.store.transaction(() =>
      f.store.exec(
        "CREATE TRIGGER fail_terminal_event BEFORE INSERT ON event WHEN NEW.type='run.event' BEGIN SELECT RAISE(ABORT,'terminal event fault'); END",
      ),
    );
    expect(() => f.log.emit("run.failed", terminal().payload)).toThrow(/terminal event fault/);
    expect(f.commands.get("job")?.state).toBe("running");
    expect(storedTerminal(f.store, "run")).toBeUndefined();
    expect(f.obligations.open()).toEqual([]);
    expect(f.store.prepare("SELECT next_seq FROM partition").get()).toEqual(before);
    expect(f.writes).toEqual([]);
    f.store.transaction(() => f.store.exec("DROP TRIGGER fail_terminal_event"));
    expect(f.log.emit("run.failed", terminal().payload).seq).toBe(2);
  });

  it("T-TRM-3: SIGKILL after SQL commit leaves an obligation that a fresh process state repairs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-sql-kill-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const runDir = join(root, "run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const modules = Object.fromEntries(
      [
        "store",
        "blob-files",
        "obligations",
        "terminal-files",
        "commands",
        "command-prune",
        "partitions",
      ].map((name) => [
        name,
        pathToFileURL(resolve(import.meta.dirname, "../../dist/store", `${name}.js`)).href,
      ]),
    );
    const source = `
      const {EngineStore}=await import(${JSON.stringify(modules.store)});
      const {BlobFiles}=await import(${JSON.stringify(modules["blob-files"])});
      const {Obligations}=await import(${JSON.stringify(modules.obligations)});
      const {SqlTerminalFiles}=await import(${JSON.stringify(modules["terminal-files"])});
      const {SqlCommandStore}=await import(${JSON.stringify(modules.commands)});
      const {SqlCommandPruner}=await import(${JSON.stringify(modules["command-prune"])});
      const {createPartition}=await import(${JSON.stringify(modules.partitions)});
      const store=await EngineStore.open({daemonDir:${JSON.stringify(join(root, "daemon"))},workerEntry:${JSON.stringify(resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"))},flusherHooks:{manualTick:true}});
      const generation=store.transaction(()=>createPartition(store,'global'));
      const blobs=new BlobFiles(store),obligations=new Obligations(store);
      const files=new SqlTerminalFiles(store,obligations,{write(){process.kill(process.pid,'SIGKILL');throw new Error('kill did not occur');}});
      const commands=new SqlCommandStore(store,blobs,generation,{isLive:()=>true,obligations,terminalFiles:files,pruner:new SqlCommandPruner(store,blobs)});
      commands.accept({id:'job',params:{mode:'agent'},idempotencyKey:'kill-key',clientId:'fixture'});
      commands.update('job',{state:'running',runId:'run',taskId:'task',runDir:${JSON.stringify(runDir)}});
      commands.persistTerminal('job',${JSON.stringify(terminal())},${JSON.stringify(telemetry())});
      process.exit(19);
    `;
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      timeout: 15000,
    });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    const f = await runtime(root);
    expect(f.commands.get("job")?.state).toBe("failed");
    expect(f.obligations.get("terminal_files", "run")?.state).toBe("pending");
    expect((await f.obligations.completeOpen()).failed).toEqual([]);
    expect(readEvents(runDir).map((event) => event.type)).toEqual(["run.failed"]);
    expect(f.commands.recoverDurableTerminal("job")?.state).toBe("failed");
  });
});

describe("T-TRM-2 real SSE pending obligation", () => {
  it.each([0, 2])(
    "does not end with a terminal line while pending, including reconnect at %s",
    async (lastEventId) => {
      const f = await fixture();
      f.log.emit("run.failed", terminal().payload);
      f.store.transaction(() =>
        f.store
          .prepare(
            "UPDATE effect_obligation SET state='pending',materialized_g=NULL WHERE key='run'",
          )
          .run(),
      );
      const req = new EventEmitter(),
        res = Object.assign(new EventEmitter(), {
          chunks: [] as string[],
          ended: false,
          writeHead() {},
          write(value: string) {
            this.chunks.push(value);
            return true;
          },
          end() {
            this.ended = true;
            this.emit("close");
          },
        });
      let wake: ((event: { run_id?: string }) => void) | undefined;
      const record = { id: "job", runId: "run", runDir: f.runDir, state: "failed" } as const;
      const ctx: StreamEventsCtx = {
        findRun: async () => record as never,
        json() {},
        opts: {
          daemon: { status: async () => record as never },
          terminalFilesPending: (id) => f.files.pending(id),
          bus: {
            subscribe(fn) {
              wake = fn;
              return () => {
                wake = undefined;
              };
            },
          },
          pollMs: 100000,
          heartbeatMs: 100000,
        },
        sseClients: new Set(),
      };
      cleanup.push(() => {
        req.emit("close");
      });
      await streamRunEvents(ctx, "job", lastEventId, req as never, res as never);
      expect(res.ended).toBe(false);
      expect(res.chunks.join("")).not.toContain("event: end");
      expect(res.chunks.join("").includes("event: run.failed")).toBe(lastEventId === 0);
      f.files.materialize("run");
      wake?.({ run_id: "run" });
      await vi.waitFor(() => expect(res.ended).toBe(true));
      expect(res.chunks.join("").match(/event: end/g)).toHaveLength(1);
      expect(res.chunks.join("").match(/event: run.failed/g)?.length ?? 0).toBe(
        lastEventId === 0 ? 1 : 0,
      );
    },
  );
});
