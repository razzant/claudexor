import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { primaryOutputCandidatesForCli, primaryOutputForCli } from "./primary-output.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("primaryOutputForCli", () => {
  it("prefers an agent answer artifact before summary or patch output", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cli-primary-output-"));
    tempRoots.push(root);
    const finalDir = join(root, "final");
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(join(finalDir, "answer.md"), "agent answer\n");
    writeFileSync(join(finalDir, "summary.md"), "summary text\n");
    writeFileSync(join(finalDir, "patch.diff"), "diff --git a/a b/a\n");

    expect(primaryOutputForCli(root, "agent")).toMatchObject({
      kind: "answer",
      path: "final/answer.md",
      text: "agent answer\n",
    });
  });

  it("keeps answer first in the default write-mode candidate order (summary.md retired, V8)", () => {
    expect(primaryOutputCandidatesForCli("agent").map((candidate) => candidate.path)).toEqual([
      "final/answer.md",
      "final/patch.diff",
    ]);
  });

  it("promotes a cancelled Ask summary as a diagnostic without promoting successful summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cli-primary-output-"));
    tempRoots.push(root);
    const finalDir = join(root, "final");
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(join(finalDir, "summary.md"), "Ask was cancelled while waiting for input.\n");

    expect(primaryOutputForCli(root, "ask", { lifecycle: "cancelled" })).toMatchObject({
      kind: "diagnostic",
      path: "final/summary.md",
    });
    expect(primaryOutputForCli(root, "ask", { lifecycle: "succeeded" })).toBeNull();
  });

  it("uses immutable presentation facts instead of re-selecting an earlier output", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cli-primary-output-"));
    tempRoots.push(root);
    const finalDir = join(root, "final");
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(join(finalDir, "answer.md"), "Earlier answer\n");
    writeFileSync(join(finalDir, "summary.md"), "Late diagnostic\n");

    expect(
      primaryOutputForCli(root, "ask", {
        lifecycle: "cancelled",
        presentation: {
          state: "diagnostic",
          primary: { kind: "diagnostic", path: "final/summary.md" },
        },
      }),
    ).toEqual({
      kind: "diagnostic",
      path: "final/summary.md",
      text: "Late diagnostic\n",
    });
  });

  it("renders a typed RunFailure using its safe message", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-cli-primary-output-"));
    tempRoots.push(root);
    mkdirSync(join(root, "final"), { recursive: true });

    expect(
      primaryOutputForCli(root, "agent", {
        failure: {
          phase: "execute",
          category: "auth",
          code: null,
          harnessId: "claude",
          attemptId: "a01",
          safeMessage: "Authentication expired",
          rawDetailRef: null,
          resetsAt: null,
          vendorFailure: null,
          poolAttempts: [],
          logRefs: [],
          eventRefs: [],
          runDir: root,
          nextActions: ["Run claudexor auth login claude"],
        },
      }),
    ).toMatchObject({ kind: "diagnostic", text: "Authentication expired" });
  });
});
