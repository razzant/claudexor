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
});

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
});
