import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { BudgetLedger } from "@claudexor/budget";
import { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts } from "@claudexor/schema";
import { guardAnnouncedRun } from "./runTerminals.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture(runId: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-held-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun(runId);
  const log = new EventLog(paths.eventsPath, runId, "task-held");
  return { store, paths, log };
}

function terminals(eventsPath: string): Array<{ type: string; lifecycle: string | undefined }> {
  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload?: { lifecycle?: string } })
    .filter((event) => /^run\.(completed|failed|cancelled)$/.test(event.type))
    .map((event) => ({ type: event.type, lifecycle: event.payload?.lifecycle }));
}

describe("held terminal, late throw (fix round 4 item 3 / Astra R1)", () => {
  it.each([
    { kind: "an ordinary run keeps its held success", delegate: false, lifecycle: "succeeded" },
    { kind: "a Delegate parent is still cancelled", delegate: true, lifecycle: "cancelled" },
  ])(
    "abort DURING the barrier of a strategy that held its success and then threw: $kind",
    async ({ delegate, lifecycle }) => {
      const runId = delegate ? "run-held-delegate" : "run-held-ordinary";
      const { store, paths, log } = fixture(runId);
      const controller = new AbortController();
      const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
      const result = await guardAnnouncedRun(
        controller.signal,
        async (announce) => {
          log.emit("run.created", { mode: "agent", prompt: "x" });
          announce({
            log,
            store,
            paths,
            runId,
            taskId: "task-held",
            mode: "agent",
            phase: "race",
            spend: () => root.spend(),
            valuation: () => root.valuation(),
            spendEstimated: () => root.estimated(),
            // Only a Delegate parent owns a child drain; its cancel stays live.
            ...(delegate
              ? { budgetTerminal: () => root.terminal(), recheckBudgetAfterBarrier: () => true }
              : {}),
          });
          store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), {
            winner: "a01",
            facts: makeOutcomeFacts("succeeded"),
            why_winner: "strategy completed before the late throw",
            budget_summary: { spend_usd: 0, cash_usd: 0, valuation_usd: 0, estimated: false },
          });
          log.deferTerminal();
          store.writeText(join(paths.finalDir, "summary.md"), "done\n");
          log.emit("output.ready", { path: "final/summary.md", kind: "summary" });
          log.emit("run.completed", { lifecycle: "succeeded" });
          throw new Error("late explosion after the held terminal");
        },
        async () => {
          // The host cancels while the settlement barrier runs.
          controller.abort("host_cancelled");
        },
      );
      expect(result.lifecycle).toBe(lifecycle);
      const published = terminals(paths.eventsPath);
      expect(published).toHaveLength(1);
      expect(published[0]?.lifecycle).toBe(lifecycle);
      if (!delegate) expect(published[0]?.type).toBe("run.completed");
    },
  );
});
