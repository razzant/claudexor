/**
 * A thread turn's preparation scope through the production runner path
 * (run-deadline/1, #694 r10): a job with a deadline opens it first, hands its
 * marker to the warden before anything launches and settles it on success; an
 * ordinary turn opens none unless a tree is made. No successful turn leaves an
 * open `thread-preparation:<job>` row in the daemon's run-scope index.
 */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAccountEvidence,
  type InteractionRegistry,
  type ProjectThreadPort,
  type QuotaRegistry,
  type ResourceStorePort,
  type RunEventBus,
} from "@claudexor/daemon";
import type { DelegationBudgetAuthority } from "@claudexor/orchestrator";
import { describe, expect, it, vi } from "vitest";

// The daemon's run-scope index binds to this config dir on first use.
process.env.CLAUDEXOR_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claudexor-runner-prep-"));

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

const { createDaemonAgentRunner } = await import("./daemon-agent-runner.js");
const { daemonRunScopeIndex } = await import("./run-scope-index.js");

function runner() {
  const threads = {
    // A turn of the request (no thread binding): its Git preflight runs.
    assertKnownIds: () => ({ threadId: undefined, turnId: "turn-1" }),
    recordRunEvent: () => {},
    getThread: () => undefined,
    getTurn: () => undefined,
    createTurn: () => ({ id: "turn-1" }),
    bindTurnRun: () => {},
    recordSession: () => {},
    recordLaneCheckpoint: () => {},
    setTurnContinuity: () => {},
  } as unknown as ProjectThreadPort;
  return createDaemonAgentRunner({
    delegationBudgetAuthority: {} as unknown as DelegationBudgetAuthority,
    quotaStore: () => ({ ingest: () => {} }) as unknown as QuotaRegistry,
    accounts: createAccountEvidence(),
    threads,
    commands: { getByRunId: () => undefined },
    interactions: { register: () => {} } as unknown as InteractionRegistry,
    liveInputs: { register: () => ({ release: () => {} }) } as never,
    resources: () => ({ resolve: () => [] }) as unknown as ResourceStorePort,
    bus: { publish: () => {} } as unknown as RunEventBus,
  });
}

async function inPlaceTurn(jobId: string, holds: boolean) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-runner-prep-project-")));
  writeFileSync(join(dir, "task.txt"), "do the thing\n");
  const attached: string[] = [];
  const result = (await runner()(
    {
      prompt: "x",
      mode: "agent",
      scope: { kind: "project", root: dir },
      harnesses: ["fake-success"],
      access: "full",
      turnId: "turn-1",
      execution: { isolation: "live", delegated: true, workspaceRoot: dir },
    },
    {
      jobId,
      signal: new AbortController().signal,
      onRunStart: () => {},
      deadlineScope: {
        attach: async (marker: string) => {
          attached.push(marker);
        },
        holds: () => holds,
      },
    },
  )) as { lifecycle: string };
  const rows = daemonRunScopeIndex()
    .list()
    .filter((entry) => entry.run_id === `thread-preparation:${jobId}`);
  return { result, attached, rows };
}

describe("a thread turn's preparation scope in the runner", () => {
  it("a job with a deadline opens it first, hands it over, and a successful in-place turn settles it", async () => {
    const { result, attached, rows } = await inPlaceTurn("job-deadline", true);
    expect(result.lifecycle).toBe("succeeded");
    // The preparation's marker first, then the run's own.
    expect(attached).toHaveLength(2);
    expect(attached[0]).not.toBe(attached[1]);
    expect(rows.filter((row) => row.state === "open")).toEqual([]);
  });

  it("an ordinary in-place turn opens no preparation scope", async () => {
    const { result, attached, rows } = await inPlaceTurn("job-plain", false);
    expect(result.lifecycle).toBe("succeeded");
    expect(attached).toHaveLength(1); // the run's own scope only
    expect(rows).toEqual([]);
  });
});
