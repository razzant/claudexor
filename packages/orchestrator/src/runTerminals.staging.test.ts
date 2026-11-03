import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger } from "@claudexor/budget";
import { EventLog, appendRunEvent } from "@claudexor/event-log";
import { makeOutcomeFacts } from "@claudexor/schema";
import type { OrchestratorResult } from "./orchestrator.js";
import { guardAnnouncedRun, type AnnouncedRunContext } from "./runTerminals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture(runId: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-staged-terminal-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun(runId);
  const log = new EventLog(paths.eventsPath, runId, "task-staged");
  const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
  const context: AnnouncedRunContext = {
    log,
    store,
    paths,
    runId,
    taskId: "task-staged",
    mode: "agent",
    phase: "race",
    spend: () => root.spend(),
    valuation: () => root.valuation(),
    spendEstimated: () => root.estimated(),
  };
  const types = () =>
    readFileSync(paths.eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { type: string }).type);
  const succeeded = {
    lifecycle: "succeeded",
    facts: makeOutcomeFacts("succeeded"),
    summary: "done",
    candidates: [],
  } as unknown as OrchestratorResult;
  return { store, paths, log, context, types, succeeded };
}

describe("terminal staging inside the announced-run net", () => {
  it("commits the verdict prepared before staging although a cancel and its audit arrive during it", async () => {
    const f = fixture("run-staged");
    const controller = new AbortController();
    const staged: string[] = [];
    f.log.setTerminalStaging(async (event) => {
      staged.push(`${event.type}:${String(event.payload["lifecycle"])}`);
      controller.abort("host_cancelled");
      appendRunEvent(f.paths.eventsPath, "run-staged", "task-staged", "control.requested", {
        kind: "cancel",
      });
    });
    const result = await guardAnnouncedRun(controller.signal, async (announce) => {
      f.log.emit("run.created", { mode: "agent", prompt: "x" });
      announce(f.context);
      f.store.writeYaml(join(f.paths.arbitrationDir, "decision.yaml"), {
        winner: "a01",
        facts: makeOutcomeFacts("succeeded"),
        why_winner: "the strategy finished before the cancel",
        budget_summary: { spend_usd: 0, cash_usd: 0, valuation_usd: 0, estimated: false },
      });
      f.log.deferTerminal();
      f.store.writeText(join(f.paths.finalDir, "summary.md"), "done\n");
      f.log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
      f.log.emit("run.completed", { lifecycle: "succeeded" });
      return f.succeeded;
    });
    expect(result.lifecycle).toBe("succeeded");
    expect(staged).toEqual(["run.completed:succeeded"]);
    expect(f.types().slice(-2)).toEqual(["control.requested", "run.completed"]);
    expect(f.types().filter((type) => /^run\.(completed|failed|blocked)$/.test(type))).toEqual([
      "run.completed",
    ]);
  });

  it("stages the defensive fallback terminal of a strategy that returned without one", async () => {
    const f = fixture("run-fallback");
    const staged: string[] = [];
    f.log.setTerminalStaging(async (event) => {
      staged.push(event.type);
    });
    await guardAnnouncedRun(undefined, async (announce) => {
      f.log.emit("run.created", { mode: "agent", prompt: "x" });
      announce(f.context);
      return f.succeeded;
    });
    expect(staged).toEqual(["run.completed"]);
    expect(f.log.terminalCommitted()).toBe(true);
    expect(f.types().at(-1)).toBe("run.completed");
  });
});
