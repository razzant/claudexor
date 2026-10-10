import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDaemonAgentRunner } from "./daemon-agent-runner.js";

const startHarness = vi.hoisted(() => vi.fn().mockResolvedValue({ lifecycle: "succeeded" }));
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: () => ({ run: startHarness }),
}));

it.each(["record", "metadata", "directory"])(
  "refuses a vanished predecessor %s before any harness work, while a surviving source continues",
  async (missing) => {
    const root = mkdtempSync(join(tmpdir(), "cx-source-"));
    const runDir = join(root, "prior");
    const prior = {
      id: "job-prior",
      createdAt: "2026-10-08T00:00:00.000Z",
      runId: "prior",
      runDir,
      state: "cancelled" as const,
      params: { prompt: "original work" },
    };
    let records: Array<Omit<typeof prior, "runDir"> & { runDir?: string }> =
      missing === "record"
        ? []
        : [{ ...prior, runDir: missing === "metadata" ? undefined : runDir }];
    const runner = createDaemonAgentRunner({
      threads: { assertKnownIds: () => ({}) } as never,
      commands: { getByRunId: (id) => records.find((record) => record.runId === id) },
      delegationBudgetAuthority: {} as never,
      quotaStore: () => ({}) as never,
      interactions: {} as never,
      liveInputs: {} as never,
      resources: () => ({ resolve: () => [] }) as never,
      bus: {} as never,
    });
    const request = { mode: "ask", prompt: "", continueFrom: "prior", harnesses: ["fake-success"] };
    const ctx = { jobId: "successor", onRunStart: () => {}, signal: new AbortController().signal };
    startHarness.mockClear();
    try {
      await expect(runner(request, ctx)).rejects.toMatchObject({
        code: "continuation_predecessor_unavailable",
        status: 404,
        retryable: false,
        context: { predecessor: "prior" },
      });
      expect(startHarness).not.toHaveBeenCalled();
      records = [prior];
      mkdirSync(runDir);
      await expect(runner(request, ctx)).resolves.toMatchObject({ lifecycle: "succeeded" });
      expect(startHarness).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          continuation: expect.objectContaining({
            from: expect.objectContaining({ runId: "prior", runDir, workOrder: "original work" }),
          }),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
