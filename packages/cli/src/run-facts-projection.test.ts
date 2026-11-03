import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, makeOutcomeFacts, validateRunFactsInvariants } from "@claudexor/schema";
import {
  projectRunFacts,
  projectTerminalDetailFields,
  readRunFactsArtifact,
} from "./run-facts-projection.js";
import { projectTerminalRunOutput, terminalRunRequiredActionLines } from "./terminal-run-output.js";

const terminalReceipt = validateRunFactsInvariants({
  schema_version: SCHEMA_VERSION,
  run_id: "run-facts",
  task_id: "task-facts",
  mode: "plan",
  outcome: makeOutcomeFacts("succeeded"),
  deliverable: {
    present: true,
    kind: "plan",
    path: "final/plan.md",
    producer_attempt_id: "p01",
  },
  participants: {
    planners: 1,
    attempts: [
      {
        attempt_id: "p01",
        harness_id: "codex",
        role: "planner",
        deliverable_present: true,
        status: "success",
      },
    ],
  },
  gates: {
    configured: false,
    required: 0,
    total: 0,
    executed: false,
    state: "not_configured",
    receipt_attempt_id: null,
  },
  review: { state: "not_run", blocker_ids: [], blockers: 0 },
  apply: { eligibility: null, operator_decision_present: false },
  required_actions: [],
  generated_at: "2026-07-26T12:00:00.000Z",
});

const tempRoots: string[] = [];
const jsonReader = {
  readYaml: (path: string): unknown => JSON.parse(readFileSync(path, "utf8")),
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function emptyFinalDir(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-cli-run-facts-"));
  tempRoots.push(root);
  const finalDir = join(root, "final");
  mkdirSync(finalDir);
  return finalDir;
}

function finalDirWithReceipt(value: unknown = terminalReceipt): string {
  const finalDir = emptyFinalDir();
  writeFileSync(join(finalDir, "run_facts.yaml"), JSON.stringify(value), "utf8");
  return finalDir;
}

describe("RunFacts CLI projections (GH #29)", () => {
  it("keeps accepted group/store metadata in JSON and NDJSON terminal receipts without inheriting detail fields", () => {
    const metadata = {
      taskGroupId: "11111111-1111-4111-8111-111111111111",
      storeId: "22222222-2222-4222-8222-222222222222",
    };
    const out = {
      runId: "run-g",
      runDir: "/fixture/run",
      jobId: "job-g",
      status: "succeeded",
      ...metadata,
    };
    for (const options of [{}, { frame: "run.terminal" as const }]) {
      expect(projectTerminalRunOutput(out, "ask", null, options)).toMatchObject(metadata);
      const { taskGroupId: _group, storeId: _store, ...legacy } = out;
      const untagged = projectTerminalRunOutput(legacy, "ask", { summary: metadata }, options);
      expect(untagged).not.toHaveProperty("taskGroupId");
      expect(untagged).not.toHaveProperty("storeId");
      const producerContext = projectTerminalRunOutput(
        { ...legacy, errorContext: metadata },
        "ask",
        null,
        options,
      );
      expect(producerContext).not.toHaveProperty("taskGroupId");
      expect(producerContext).not.toHaveProperty("storeId");
      const incomplete = projectTerminalRunOutput(
        { ...legacy, taskGroupId: metadata.taskGroupId },
        "ask",
        null,
        options,
      );
      expect(incomplete).not.toHaveProperty("taskGroupId");
      expect(incomplete).not.toHaveProperty("storeId");
    }
  });

  it("keeps an ordinary handle's accepting store, never a producer's lone context key", () => {
    const storeId = "22222222-2222-4222-8222-222222222222";
    const out = { runId: "", runDir: "", jobId: "job", status: "failed" };
    expect(projectTerminalRunOutput({ ...out, storeId }, "ask", null)).toMatchObject({ storeId });
    expect(
      projectTerminalRunOutput({ ...out, errorContext: { storeId } }, "ask", null),
    ).not.toHaveProperty("storeId");
  });

  it("retains a pre-run failure's accepted metadata from server error context", () => {
    const metadata = {
      taskGroupId: "11111111-1111-4111-8111-111111111111",
      storeId: "22222222-2222-4222-8222-222222222222",
    };
    const out = {
      runId: "",
      runDir: "",
      jobId: "job-g",
      status: "failed",
      errorCode: "fixture_pre_run_failure",
      errorContext: { jobId: "job-g", state: "failed", ...metadata },
    };
    expect(projectTerminalRunOutput(out, "ask", null)).toMatchObject({
      jobId: "job-g",
      runId: "",
      ...metadata,
    });
    expect(projectTerminalRunOutput(out, "ask", null, { frame: "run.terminal" })).toMatchObject({
      frame: "run.terminal",
      ...metadata,
    });
  });

  it("returns the exact validated receipt already carried by run detail", () => {
    const projected = projectRunFacts(
      {
        summary: { runId: "run-facts", taskId: "task-facts" },
        runFacts: terminalReceipt,
      },
      { runId: "run-facts" },
    );
    expect(JSON.stringify(projected)).toBe(JSON.stringify(terminalReceipt));
  });

  it("keeps terminal runFacts three-state: missing/unavailable are null, invalid throws", () => {
    // Unavailable detail (transport hiccup or 404/legacy run): null.
    expect(projectTerminalDetailFields(null)).toEqual({ runFacts: null });
    // Detail present but the receipt is genuinely missing (legacy run): null,
    // the key itself always present on terminal JSON.
    expect(projectTerminalDetailFields({ runFacts: null })).toEqual({ runFacts: null });
    expect(projectTerminalDetailFields({ runFacts: terminalReceipt })).toEqual({
      runFacts: terminalReceipt,
    });
    // Present-but-invalid never collapses into the legacy null.
    expect(() => projectTerminalDetailFields({ runFacts: { run_id: "partial" } })).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
  });

  it("keeps the JSON and NDJSON terminal envelope additive and canonical", () => {
    const applyEligibility = {
      eligible: false,
      state: "needs_review",
      reason: "review_blocked",
      requiredAction: "accept_risk",
    };
    const delegation = { requested: true, effective: true, used: true, reason: null };
    expect(
      projectTerminalRunOutput(
        {
          runId: "run-facts",
          runDir: "/runs/run-facts",
          status: "succeeded",
          jobId: "job-facts",
        },
        "plan",
        {
          summary: { runId: "run-facts", taskId: "task-facts", delegation },
          outcomeBanner: "Done · needs review",
          applyEligibility,
          runFacts: terminalReceipt,
        },
        { frame: "run.terminal", summary: "human decision required" },
      ),
    ).toEqual({
      frame: "run.terminal",
      runId: "run-facts",
      runDir: "/runs/run-facts",
      status: "succeeded",
      jobId: "job-facts",
      mode: "plan",
      summary: "human decision required",
      outcomeBanner: "Done · needs review",
      delegation,
      applyEligibility,
      runFacts: terminalReceipt,
    });
  });

  it("preserves typed RunFailure in the shared JSON and NDJSON terminal envelope", () => {
    const failure = {
      phase: "execute",
      category: "auth",
      code: null,
      harnessId: "claude",
      attemptId: "a01",
      safeMessage: "Authentication expired",
      rawDetailRef: null,
      logRefs: [],
      eventRefs: [],
      runDir: "/runs/run-failed",
      nextActions: ["Log in again"],
    };

    expect(
      projectTerminalRunOutput(
        {
          runId: "run-failed",
          runDir: "/runs/run-failed",
          status: "failed",
          jobId: "job-failed",
        },
        "agent",
        { failure },
        { frame: "run.terminal" },
      ),
    ).toMatchObject({
      frame: "run.terminal",
      status: "failed",
      failure,
      runFacts: null,
    });
  });

  it("binds the receipt lifecycle to the settled daemon job state (unified with control-api)", () => {
    const out = { runId: "run-facts", runDir: "/runs/run-facts", status: "failed", jobId: "j" };
    const detail = {
      summary: { runId: "run-facts", taskId: "task-facts" },
      runFacts: terminalReceipt,
    };
    // A succeeded receipt served for a failed daemon terminal is a lie.
    expect(() => projectTerminalRunOutput(out, "plan", detail)).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
    // The matching lifecycle serves the exact receipt.
    expect(projectTerminalRunOutput({ ...out, status: "succeeded" }, "plan", detail)).toMatchObject(
      { runFacts: terminalReceipt },
    );
  });

  it("keeps an early JSON failure typed while reporting a missing legacy receipt", () => {
    const refused = {
      runId: "",
      runDir: "",
      status: "failed",
      jobId: "",
      error: "Git is unavailable",
      errorCode: "git_developer_tools_stub",
      errorStatus: 503,
      errorRetryable: false,
      errorRequiredActions: ["Install Apple Command Line Tools with xcode-select --install."],
      errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
    } as Parameters<typeof projectTerminalRunOutput>[0];
    expect(projectTerminalRunOutput(refused, "agent", null)).toEqual({
      runId: "",
      runDir: "",
      status: "failed",
      jobId: "",
      mode: "agent",
      error: "Git is unavailable",
      code: "git_developer_tools_stub",
      errorStatus: 503,
      retryable: false,
      requiredActions: ["Install Apple Command Line Tools with xcode-select --install."],
      context: { capability: "git", capabilityStatus: "developer_tools_stub" },
      runFacts: null,
    });
    expect(terminalRunRequiredActionLines(refused)).toEqual([
      "  next: Install Apple Command Line Tools with xcode-select --install.",
    ]);
  });

  it("reads the exact canonical artifact for inspect", () => {
    const finalDir = finalDirWithReceipt();
    expect(
      JSON.stringify(
        readRunFactsArtifact(jsonReader, finalDir, {
          runId: "run-facts",
          taskId: "task-facts",
        }),
      ),
    ).toBe(JSON.stringify(terminalReceipt));
  });

  it("retains legacy null only for a missing receipt and fails loudly for malformed data", () => {
    expect(projectRunFacts(null)).toBeNull();
    expect(readRunFactsArtifact(jsonReader, emptyFinalDir())).toBeNull();
    expect(() => projectRunFacts({ runFacts: { run_id: "partial" } })).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
    const malformedFinalDir = emptyFinalDir();
    writeFileSync(join(malformedFinalDir, "run_facts.yaml"), "{not-json", "utf8");
    expect(() => readRunFactsArtifact(jsonReader, malformedFinalDir)).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
  });

  it("fails closed for a shape-valid receipt that violates cross-axis invariants", () => {
    const contradictory = {
      ...terminalReceipt,
      participants: { ...terminalReceipt.participants, planners: 2 },
    };
    expect(() => projectRunFacts({ runFacts: contradictory })).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
    expect(() => readRunFactsArtifact(jsonReader, finalDirWithReceipt(contradictory))).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
  });

  it("fails closed when a receipt identity differs from the requested run or task", () => {
    expect(() =>
      projectRunFacts(
        {
          summary: { runId: "run-other", taskId: "task-facts" },
          runFacts: terminalReceipt,
        },
        { runId: "run-facts" },
      ),
    ).toThrow(/canonical RunFacts receipt is invalid/);
    expect(() =>
      projectRunFacts({
        summary: { runId: "run-facts", taskId: "task-other" },
        runFacts: terminalReceipt,
      }),
    ).toThrow(/canonical RunFacts receipt is invalid/);
    expect(() =>
      readRunFactsArtifact(jsonReader, finalDirWithReceipt(), {
        runId: "run-facts",
        taskId: "task-other",
      }),
    ).toThrow(/canonical RunFacts receipt is invalid/);
  });

  it("rejects valid receipts reached through symlinks, including dangling links", () => {
    const linkedFinalDir = emptyFinalDir();
    const externalReceipt = join(dirname(linkedFinalDir), "external-run-facts.yaml");
    writeFileSync(externalReceipt, JSON.stringify(terminalReceipt), "utf8");
    symlinkSync(externalReceipt, join(linkedFinalDir, "run_facts.yaml"));
    expect(() => readRunFactsArtifact(jsonReader, linkedFinalDir)).toThrow(
      /canonical RunFacts receipt is invalid/,
    );

    const danglingFinalDir = emptyFinalDir();
    symlinkSync(
      join(dirname(danglingFinalDir), "missing-run-facts.yaml"),
      join(danglingFinalDir, "run_facts.yaml"),
    );
    expect(() => readRunFactsArtifact(jsonReader, danglingFinalDir)).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
  });

  it("rejects non-regular receipt paths and a symlinked final directory", () => {
    const directoryFinalDir = emptyFinalDir();
    mkdirSync(join(directoryFinalDir, "run_facts.yaml"));
    expect(() => readRunFactsArtifact(jsonReader, directoryFinalDir)).toThrow(
      /canonical RunFacts receipt is invalid/,
    );

    const targetFinalDir = finalDirWithReceipt();
    const linkedRoot = mkdtempSync(join(tmpdir(), "claudexor-cli-run-facts-link-"));
    tempRoots.push(linkedRoot);
    const linkedFinalDir = join(linkedRoot, "final");
    symlinkSync(targetFinalDir, linkedFinalDir, "dir");
    expect(() => readRunFactsArtifact(jsonReader, linkedFinalDir)).toThrow(
      /canonical RunFacts receipt is invalid/,
    );
  });
});
