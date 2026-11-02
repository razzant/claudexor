import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { processTiming } from "@claudexor/util";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";

/**
 * Production composition of terminal staging (`createSqlDaemonRuntime` wires
 * `terminalStaging`; `createDaemonAgentRunner` hands it to the run as
 * `onTerminalStage`). Only the orchestrator builder is replaced, by the real
 * Orchestrator over the offline fake harness, as `daemon-agent-runner.test.ts`
 * does; the runtime, runner, EventLog, SQL store and file owner are real.
 */
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: () => ({
    async run(input: Record<string, unknown>) {
      const { Orchestrator } = await import("@claudexor/orchestrator");
      const { createFakeHarness } = await import("@claudexor/harness-fake");
      return await new Orchestrator({
        registry: new Map([["fake-success", createFakeHarness("fake-success")]]),
        reviewers: [],
      }).run(input as never);
    },
  }),
}));

const cleanups: Array<() => void | Promise<void>> = [];
const configDir = process.env.CLAUDEXOR_CONFIG_DIR;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
  if (configDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = configDir;
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

describe("terminal staging through the production daemon wiring", () => {
  it("adopts both receipts of two successive small runs on a fresh store", async () => {
    const root = temp("cx-staging-wiring-");
    process.env.CLAUDEXOR_CONFIG_DIR = temp("cx-staging-wiring-config-");
    // A fresh store: nothing creates its body directory before the runs.
    const store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
    });
    cleanups.push(() => store.close());
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
    const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
    cleanups.push(() => graph.close());
    const runtime = createSqlDaemonRuntime(graph, {
      server: { socketPath: join(root, "unused.sock"), token: "fixture" },
      authReadiness: () => ({ invalidate: () => {} }),
    });
    cleanups.push(() => runtime.stop());
    // Every external write reports what it did: wrote bytes, or adopted staged ones.
    vi.spyOn(processTiming, "recordSync").mockReturnValue(true);
    const log = vi.spyOn(store, "logSlowWrite");
    const receipts = () =>
      log.mock.calls
        .map(([line]) => JSON.parse(String(line).slice("store.external_write ".length)))
        .filter((write: { purpose: string }) => write.purpose === "terminal_receipt");

    for (const run of [1, 2]) {
      const workspace = temp(`cx-staging-wiring-ws${run}-`);
      writeFileSync(join(workspace, "task.txt"), "small\n");
      graph.projects.register({ root: workspace, idempotencyKey: workspace, clientId: "fixture" });
      const { id } = await runtime.client.enqueue({
        prompt: `small run ${run}`,
        mode: "agent",
        scope: { kind: "project", root: workspace },
        harnesses: ["fake-success"],
        access: "full",
        execution: { isolation: "live", delegated: true, workspaceRoot: workspace },
      });
      await vi.waitFor(
        async () => expect(TERMINAL.has((await runtime.client.status(id)).state)).toBe(true),
        { timeout: 60_000, interval: 50 },
      );
      expect(receipts()).toHaveLength(2 * run);
    }
    expect(receipts()).toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ staged: true, written: true })),
    );
    expect(readdirSync(store.paths.blobs).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
