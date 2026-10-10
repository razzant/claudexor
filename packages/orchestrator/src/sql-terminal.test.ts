import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import { appendLine } from "@claudexor/util";
import {
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
  makeOutcomeFacts,
  type RunEvent,
} from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunEventLog } from "./runEventLog.js";
import { guardAnnouncedRun } from "./runTerminals.js";

// The replacement sink, rather than the legacy prepared.commit, owns storage.
// An accidental return to the old fsync writer fails this real guard flow.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: () => {
      throw new Error("legacy terminal fsync entered SQL hook path");
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrator terminal persistence port", () => {
  it("passes canonical facts and prepared telemetry through RunInput without a daemon/SQLite dependency", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-orchestrator-sql-terminal-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") }),
      paths = store.createRun("run");
    const time = "2026-10-10T00:00:00.000Z";
    store.writeYaml(
      join(paths.contextDir, "task.yaml"),
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task",
        created_at: time,
        repo: { root, base_ref: "main" },
        mode: { kind: "agent" },
        user_intent: { raw: "terminal fixture" },
        tests: { commands: [] },
      }),
    );
    store.writeYaml(
      join(paths.finalDir, "telemetry.yaml"),
      RunTelemetry.parse({
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
        generated_at: time,
      }),
    );
    const seen: Array<{ event: RunEvent; telemetry: RunTelemetry | null }> = [];
    const log = createRunEventLog(paths.eventsPath, "run", "task", {
      onTerminalPersist(event, telemetry) {
        seen.push({ event, telemetry });
        store.writeYaml(join(paths.finalDir, "run_facts.yaml"), event.payload.run_facts);
        if (telemetry) store.writeYaml(join(paths.finalDir, "telemetry.yaml"), telemetry);
        appendLine(paths.eventsPath, JSON.stringify(event));
        return { state: "materialized" };
      },
    });
    const outcome = makeOutcomeFacts("failed", { reason: "harness_failed" });
    try {
      const result = await guardAnnouncedRun(undefined, async (announce) => {
        announce({
          log,
          store,
          paths,
          runId: "run",
          taskId: "task",
          mode: "agent",
          phase: "fixture",
        });
        log.emit("run.created", { mode: "agent", prompt: "fixture" });
        log.emit("run.failed", { lifecycle: "failed", facts: outcome, reason: outcome.reason });
        return {
          runId: "run",
          taskId: "task",
          mode: "agent",
          lifecycle: "failed",
          facts: outcome,
          winner: null,
          runDir: paths.root,
          summary: "fixture failure",
          candidates: [],
          spendUsd: null,
        };
      });
      expect(result.lifecycle).toBe("failed");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.telemetry?.run_facts).toEqual(seen[0]!.event.payload.run_facts);
      const events = readFileSync(paths.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RunEvent);
      expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
      expect(log.terminalCommitted()).toBe(true);
    } finally {
      log.dispose();
    }
  });
});
