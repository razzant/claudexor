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
import { projectTerminalRunOutput } from "./terminal-run-output.js";

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
});

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
    expect(
      projectTerminalRunOutput(
        {
          runId: "",
          runDir: "",
          status: "failed",
          jobId: "",
          error: "invalid output schema",
          errorCode: "invalid_output_schema",
          errorStatus: 400,
          errorRetryable: false,
        },
        "agent",
        null,
      ),
    ).toEqual({
      runId: "",
      runDir: "",
      status: "failed",
      jobId: "",
      mode: "agent",
      error: "invalid output schema",
      code: "invalid_output_schema",
      errorStatus: 400,
      retryable: false,
      runFacts: null,
    });
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
