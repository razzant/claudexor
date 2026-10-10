import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InteractionRegistry,
  ProjectPartitions,
  QuotaRegistry,
  ResourceStore,
  RunEventBus,
} from "@claudexor/daemon";
import type { DelegationBudgetAuthority } from "@claudexor/orchestrator";
import { describe, expect, it, vi } from "vitest";

/**
 * Production-shaped positive capability check (INV-120) for the delegated
 * full-access exemption. The orchestrator-level test pins the GATE; this one
 * pins the PRODUCTION PATH into it, so dropping `delegated: p.execution.delegated`
 * where this runner flattens the wire block turns a test red instead of quietly
 * sending every delegated `full` run back to a 403.
 */
const captured = vi.hoisted(() => ({ input: undefined as Record<string, unknown> | undefined }));

// The runner imports buildRunOrchestrator directly. Substitute a builder whose
// run() records what the runner forwarded and then drives the REAL Orchestrator,
// so the real trust gate in task-contract-builder decides admission.
vi.mock("./run-orchestrator.js", () => ({
  credentialUnusableLedger: { note: () => {}, entries: () => [] },
  buildRunOrchestrator: () => ({
    async run(input: Record<string, unknown>) {
      captured.input = input;
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

function runnerFixture(ingest = vi.fn(), publish = vi.fn()) {
  const threads = {
    assertKnownIds: () => ({ threadId: undefined, turnId: undefined }),
    recordRunEvent: () => {},
    getThread: () => undefined,
    getTurn: () => undefined,
    createTurn: () => ({ id: "turn-1" }),
    bindTurnRun: () => {},
    recordSession: () => {},
    recordLaneCheckpoint: () => {},
    setTurnContinuity: () => {},
  } as unknown as ProjectPartitions;
  return createDaemonAgentRunner({
    delegationBudgetAuthority: {} as unknown as DelegationBudgetAuthority,
    quotaStore: () => ({ ingest }) as unknown as QuotaRegistry,
    threads,
    commands: { getByRunId: () => undefined },
    interactions: { register: () => {} } as unknown as InteractionRegistry,
    liveInputs: { register: () => ({ release: () => {} }) } as never,
    resources: () => ({ resolve: () => [] }) as unknown as ResourceStore,
    bus: { publish } as unknown as RunEventBus,
  });
}

describe("createDaemonAgentRunner", () => {
  it("forwards execution.delegated so a full run with no trust record is admitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-runner-delegated-"));
    writeFileSync(join(dir, "task.txt"), "do the thing\n");
    // A scoped config dir with NO trust file: admission must come from the
    // delegated marker travelling this path, never from an inherited allow.
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-runner-notrust-"));
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const ingest = vi.fn();
      const publish = vi.fn();
      const res = (await runnerFixture(ingest, publish)(
        {
          prompt: "x",
          mode: "agent",
          scope: { kind: "project", root: dir },
          harnesses: ["fake-success"],
          access: "full",
          execution: { isolation: "live", delegated: true, workspaceRoot: dir },
        },
        { jobId: "job-1", signal: new AbortController().signal, onRunStart: () => {} },
      )) as { lifecycle: string; runDir: string };

      // The wire marker survived the flattening into the engine input.
      expect(captured.input?.["delegated"]).toBe(true);
      expect(captured.input?.["access"]).toBe("full");
      // And the real gate admitted it, recording the profile honestly.
      expect(res.lifecycle).toBe("succeeded");
      expect(readFileSync(join(res.runDir, "context", "task.yaml"), "utf8")).toContain(
        "effective_profile: full",
      );
      // Presentation events are still published, but cannot write a second
      // quota observation after the bound native intake has already run.
      const event = {
        type: "harness.event",
        payload: {
          harness_id: "claude",
          type: "status",
          ts: new Date().toISOString(),
          session_id: "test",
          credential_route: "vendor_native",
          quota: {
            source: "claude_rate_limit_event",
            plan_label: null,
            subject_id: null,
            constraints: [
              {
                id: "five_hour",
                label: "5h",
                used_ratio: 0.2,
                window_seconds: 18000,
                resets_at: null,
                cooldown_until: null,
              },
            ],
          },
        },
      };
      (captured.input?.onEvent as (event: unknown) => void)(event);
      expect(publish).toHaveBeenLastCalledWith(event);
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      delete process.env.CLAUDEXOR_CONFIG_DIR;
    }
  });
});
