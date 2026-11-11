import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountEvidence } from "@claudexor/daemon";
import type { ProcessingReceipt } from "@claudexor/schema";
import { createDaemonAgentRunner } from "./daemon-agent-runner.js";

const startHarness = vi.hoisted(() => vi.fn().mockResolvedValue({ lifecycle: "succeeded" }));
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: () => ({ run: startHarness }),
}));

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const inherited = (native: string | null): ProcessingReceipt => ({
  requested: null,
  submitted: native === "fast" ? "fast" : native ? "standard" : null,
  submittedNative: native,
  observed: "unknown",
  observedNative: [],
  reason: native ? "native_explicit" : "native_default_unconfirmed",
  source: "codex.managed_config",
});

/** The daemon runner hands Exact Retry the source run's frozen inherited speed;
 * a preference, or any command that is not an Exact Retry, chooses its own. */
it.each([
  { name: "Exact Retry", request: { retryOf: "prior" }, expected: { codex: inherited("fast") } },
  {
    name: "Exact Retry with a frozen advisory preference",
    request: { retryOf: "prior", processingPreference: "standard" },
    expected: undefined,
  },
  { name: "a new command", request: {}, expected: undefined },
])("$name", async ({ request, expected }) => {
  const root = mkdtempSync(join(tmpdir(), "cx-retry-processing-"));
  roots.push(root);
  const runDir = join(root, "prior");
  mkdirSync(join(runDir, "context"), { recursive: true });
  // The source's frozen routing-time intent, as the orchestrator writes it.
  writeFileSync(
    join(runDir, "context", "processing_intent.yaml"),
    JSON.stringify({ schema_version: 1, harnesses: { codex: inherited("fast") } }),
  );
  const records = [
    {
      id: "job-prior",
      createdAt: "2026-10-08T00:00:00.000Z",
      runId: "prior",
      runDir,
      state: "failed" as const,
      params: { prompt: "original work" },
    },
  ];
  const runner = createDaemonAgentRunner({
    threads: { assertKnownIds: () => ({}) } as never,
    commands: { getByRunId: (id) => records.find((record) => record.runId === id) },
    delegationBudgetAuthority: {} as never,
    quotaStore: () => ({}) as never,
    accounts: createAccountEvidence(),
    interactions: {} as never,
    liveInputs: {} as never,
    resources: () => ({ resolve: () => [] }) as never,
    bus: {} as never,
  });
  startHarness.mockClear();
  await runner(
    { mode: "ask", prompt: "original work", harnesses: ["codex"], ...request },
    { jobId: "retry", onRunStart: () => {}, signal: new AbortController().signal },
  );
  expect(startHarness).toHaveBeenCalledOnce();
  expect(startHarness.mock.calls[0]![0].processingIntent).toEqual(expected);
});
