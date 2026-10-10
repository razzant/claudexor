import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Thread } from "@claudexor/schema";
import { expect, it, vi } from "vitest";
import { createDaemonAgentRunner } from "./daemon-agent-runner.js";

const startHarness = vi.hoisted(() => vi.fn().mockResolvedValue({ lifecycle: "succeeded" }));
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: () => ({ run: startHarness }),
}));

it.each(["agent", "ask", "plan"] as const)(
  "%s retries the recorded delegated root while preserving upstream continuation",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "cx-runner-delegated-"));
    const repoRoot = join(root, "author");
    const workspaceRoot = join(root, "caller-copy");
    const runDir = join(root, "prior");
    mkdirSync(repoRoot);
    mkdirSync(runDir);
    const thread = Thread.parse({
      schema_version: SCHEMA_VERSION,
      id: "th-del",
      created_at: "2026-10-08T00:00:00.000Z",
      updated_at: "2026-10-08T00:00:00.000Z",
      repo: { root: repoRoot, base_ref: "HEAD" },
      mode,
      workspace: { mode: "delegated", workspace_root: workspaceRoot },
      credential_profile_id: "account-a",
    });
    const runner = createDaemonAgentRunner({
      commands: {
        getByRunId: (id) =>
          id === "prior"
            ? {
                id: "job-prior",
                createdAt: "2026-10-08T00:00:00.000Z",
                runId: "prior",
                runDir,
                state: "cancelled",
                params: { prompt: "original work", scope: { kind: "project", root: repoRoot } },
              }
            : undefined,
      },
      threads: {
        assertKnownIds: () => ({ threadId: thread.id, turnId: "turn-next" }),
        getThread: () => thread,
        getTurn: () => ({ created_at: "2026-10-08T00:01:00.000Z", attachments: [] }),
        turnsFor: () => [],
        laneCheckpointsForThread: () => [],
        resumeMap: () => ({}),
      } as never,
      delegationBudgetAuthority: {} as never,
      quotaStore: () => ({}) as never,
      interactions: {} as never,
      liveInputs: {} as never,
      resources: () => ({ resolve: () => [] }) as never,
      bus: {} as never,
    });
    const request = {
      mode,
      prompt: "continue the check",
      scope: { kind: "project", root: repoRoot },
      threadId: thread.id,
      turnId: "turn-next",
      continueFrom: "prior",
      harnesses: ["fake-success"],
      execution: {
        isolation: mode === "agent" ? "live" : "envelope",
        delegated: true,
        workspaceRoot,
      },
    };
    const ctx = {
      jobId: "successor",
      signal: new AbortController().signal,
      onRunStart: () => {},
    };
    startHarness.mockClear();
    try {
      await expect(runner(request, ctx)).rejects.toMatchObject({
        code: "delegated_workspace_unavailable",
        status: 409,
        retryable: true,
      });
      expect(startHarness).not.toHaveBeenCalled();

      mkdirSync(workspaceRoot);
      await expect(runner(request, ctx)).resolves.toMatchObject({ lifecycle: "succeeded" });
      expect(startHarness).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          threadId: thread.id,
          repoRoot,
          executionRoot: workspaceRoot,
          delegated: true,
          inPlace: true,
          credentialProfileId: "account-a",
          continuation: expect.objectContaining({
            adopt: null,
            from: expect.objectContaining({ runId: "prior", runDir, workOrder: "original work" }),
          }),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
