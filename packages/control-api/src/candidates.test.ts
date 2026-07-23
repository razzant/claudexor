import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionRecord, makeOutcomeFacts } from "@claudexor/schema";
import { candidatesFor } from "./candidates.js";

describe("candidatesFor ranking scorecard projection (QA-028)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function runDirWith(attempts: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "cand-"));
    dirs.push(root);
    for (const [id, yaml] of Object.entries(attempts)) {
      const d = join(root, "attempts", id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "attempt.yaml"), yaml);
    }
    return root;
  }

  it("attaches each candidate's ranking_scorecard row as rankingAxes and marks the winner", () => {
    const runDir = runDirWith({
      a01: "attempt_id: a01\nharness_id: codex\n",
      a02: "attempt_id: a02\nharness_id: cursor\n",
    });
    const decision = DecisionRecord.parse({
      run_id: "run-x",
      mode: "agent",
      facts: makeOutcomeFacts("succeeded"),
      winner: "a02",
      ranking_scorecard: [
        { attempt_id: "a02", label: "Candidate B", axes: { tool_warnings: "0", diff_lines: "10" } },
        { attempt_id: "a01", label: "Candidate A", axes: { tool_warnings: "1", diff_lines: "10" } },
      ],
      decisive_axis: { key: "tool_warnings", winner_value: "0", runner_up_value: "1" },
    });

    const cards = candidatesFor(runDir, decision);
    const a01 = cards.find((c) => c.attemptId === "a01");
    const a02 = cards.find((c) => c.attemptId === "a02");
    expect(a02?.winner).toBe(true);
    expect(a02?.rankingAxes).toEqual({ tool_warnings: "0", diff_lines: "10" });
    expect(a01?.rankingAxes).toEqual({ tool_warnings: "1", diff_lines: "10" });
    // The decisive axis stays on the decision record itself (winner-vs-runnerup
    // relation), which ControlRunDetail already carries verbatim.
    expect(decision.decisive_axis?.key).toBe("tool_warnings");
  });

  it("leaves rankingAxes null when there is no decision / scorecard", () => {
    const runDir = runDirWith({ a01: "attempt_id: a01\nharness_id: codex\n" });
    const cards = candidatesFor(runDir, null);
    expect(cards[0]?.rankingAxes).toBeNull();
  });
});
