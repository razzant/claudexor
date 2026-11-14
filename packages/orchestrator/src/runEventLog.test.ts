import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog, lastSeqInFile } from "@claudexor/event-log";
import { SCHEMA_VERSION, TaskContract, type RunEvent } from "@claudexor/schema";
import type { RunInput } from "./orchestrator.js";
import { beginAnnouncedRun, createRunEventLog, prepareRunAnnouncement } from "./runEventLog.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";

describe("run event-log startup ownership", () => {
  it("releases the pre-announce writer when the durable run.created sink refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-run-event-log-"));
    const path = join(root, "events.jsonl");
    try {
      const log = createRunEventLog(path, "run-startup", "task-startup", {
        onEventPersist: () => {
          throw new Error("durable startup refused");
        },
      });

      // The run's log is queued: the sink refuses when the line lands.
      await expect(
        prepareRunAnnouncement(log, () =>
          log.emitLanded("run.created", { mode: "agent", prompt: "exercise startup refusal" }),
        ),
      ).rejects.toThrow(/durable startup refused/);
      expect(lastSeqInFile(path)).toBe(1);

      const retry = new EventLog(path, "run-startup", "task-startup");
      retry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the writer when ledger preparation refuses before run.created", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-run-event-log-"));
    const path = join(root, "events.jsonl");
    try {
      const log = createRunEventLog(path, "run-ledger-refusal", "task-ledger-refusal", {});

      await expect(
        prepareRunAnnouncement(log, () => {
          throw new Error("ledger preparation refused");
        }),
      ).rejects.toThrow(/ledger preparation refused/);
      expect(lastSeqInFile(path)).toBe(0);

      const retry = new EventLog(path, "run-ledger-refusal", "task-ledger-refusal");
      retry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("run announcement and its journal landings", () => {
  const roots: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  /** One startup of run `runId`; `order` records what its callbacks saw. */
  function start(runId: string, order: string[], input: Partial<RunInput>) {
    const root = mkdtempSync(join(tmpdir(), "claudexor-run-announcement-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const eventsPath = store.runPaths(runId).eventsPath;
    let announced: AnnouncedRunContext | null = null;
    const contract = TaskContract.parse({
      schema_version: SCHEMA_VERSION,
      task_id: "task",
      created_at: "2026-11-13T00:00:00.000Z",
      repo: { root, base_ref: "main" },
      mode: { kind: "agent" },
      user_intent: { raw: "startup fixture" },
      tests: { commands: [] },
    });
    const started = beginAnnouncedRun(
      {
        input: {
          repoRoot: root,
          prompt: "startup fixture",
          onRunStart: () => order.push("onRunStart"),
          onEvent: (event: RunEvent) => order.push(`publish:${event.type}`),
          ...input,
        },
        contract,
        quotaSnapshots: [],
        store,
        runId,
        taskId: "task",
        mode: "agent",
        phase: "race",
        prompt: "startup fixture",
      },
      (context) => {
        // What a reader of the run's file finds when the run is announced.
        const onDisk =
          existsSync(eventsPath) &&
          readFileSync(eventsPath, "utf8").includes('"type":"run.created"');
        order.push(`announce:${onDisk ? "landed" : "not landed"}`);
        announced = context;
      },
    );
    return { started, eventsPath, announced: () => announced };
  }

  it("announces a run once run.created has landed and its sink took it, and fails startup alone when the sink refuses it", async () => {
    const accepted: string[] = [];
    await start("run-accepted", accepted, {
      onEventPersist: (event) => accepted.push(`persist:${event.type}`),
    }).started;
    expect(accepted).toEqual([
      "persist:run.created",
      "publish:run.created",
      "announce:landed",
      "onRunStart",
    ]);

    const order: string[] = [];
    const refused = start("run-refused", order, {
      onEventPersist: (event) => {
        order.push(`persist:${event.type}`);
        if (event.type === "run.created") throw new Error("journal refused run.created");
      },
    });
    await expect(refused.started).rejects.toThrow("journal refused run.created");
    // Never announced, started or published; the line is on disk, the writer released.
    expect(order).toEqual(["persist:run.created"]);
    expect(lastSeqInFile(refused.eventsPath)).toBe(1);
    expect(() => new EventLog(refused.eventsPath, "run-refused", "task").dispose()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("rejects out of an announced startup whose project.git.initialized is refused, and its log still commits a terminal", async () => {
    const order: string[] = [];
    const run = start("run-git-refused", order, {
      projectGitInitialization: {
        initialized: true,
        baselineCommitted: true,
        gitignoreSeeded: false,
        headSha: "a".repeat(40),
      },
      onEventPersist: (event) => {
        order.push(`persist:${event.type}`);
        if (event.type === "project.git.initialized") throw new Error("journal refused git init");
      },
    });
    await expect(run.started).rejects.toThrow("journal refused git init");
    expect(order).toEqual([
      "persist:run.created",
      "publish:run.created",
      "announce:landed",
      "onRunStart",
      "persist:project.git.initialized",
    ]);
    // The refusal was this await's alone: the run's log still terminalizes.
    const log = run.announced()!.log;
    await expect(log.emitTerminal("run.failed", {})).resolves.toMatchObject({
      seq: 3,
      type: "run.failed",
    });
    expect(
      readFileSync(run.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as RunEvent).type),
    ).toEqual(["run.created", "project.git.initialized", "run.failed"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});
