import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionRecord, makeOutcomeFacts } from "@claudexor/schema";
import { candidatesFor } from "./candidates.js";
import { inRunProjection } from "./projection-context.js";
import { readRawTextArtifact } from "./run-artifact-read.js";

describe("candidatesFor ranking scorecard projection (QA-028)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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
    expect(cards[0]?.diffstat).toBeNull();
  });

  it.skipIf(process.platform === "win32").each([true, false])(
    "keeps candidate symlink semantics independent of the raw reader (raw first=%s)",
    (rawFirst) => {
      const runDir = runDirWith({ a01: "attempt_id: a01\nharness_id: codex\n" });
      mkdirSync(join(runDir, "reviews"));
      writeFileSync(join(runDir, "reviews/target.yaml"), "review_verified: true\nfindings: []\n");
      const relative = "reviews/a01.yaml";
      symlinkSync("target.yaml", join(runDir, relative));
      const record = { id: "r", state: "succeeded", runDir };
      inRunProjection(() => {
        if (rawFirst) expect(readRawTextArtifact(record, relative)).toBeNull();
        else expect(candidatesFor(runDir, null)[0]?.reviewVerified).toBe(true);
        expect(readRawTextArtifact(record, relative)).toBeNull();
        expect(candidatesFor(runDir, null)[0]?.reviewVerified).toBe(true);
      });
    },
  );

  it.each([true, false])(
    "memoizes each reader independently for one request only (raw first=%s)",
    (rawFirst) => {
      const runDir = runDirWith({ a01: "attempt_id: a01\nharness_id: codex\n" });
      mkdirSync(join(runDir, "reviews"));
      const original = "review_verified: true\nfindings: []\n";
      const relative = "reviews/a01.yaml";
      writeFileSync(join(runDir, relative), original);
      const record = { id: "r", state: "succeeded", runDir };
      inRunProjection(() => {
        if (rawFirst) expect(readRawTextArtifact(record, relative)).toBe(original);
        else expect(candidatesFor(runDir, null)[0]?.reviewVerified).toBe(true);
        expect(readRawTextArtifact(record, relative)).toBe(original);
        expect(candidatesFor(runDir, null)[0]?.reviewVerified).toBe(true);
        writeFileSync(join(runDir, relative), "review_verified: false\nfindings: []\n");
        expect(candidatesFor(runDir, null)[0]?.reviewVerified).toBe(true);
        expect(readRawTextArtifact(record, relative)).toBe(original);
      });
      expect(candidatesFor(runDir, null)[0]?.reviewVerified).toBe(false);
    },
  );

  describe("applied confinement, as the CALLER of a delegated run sees it", () => {
    it("reports a proven boundary, and the stated absence of one, without reading the OS", () => {
      const runDir = runDirWith({
        a01: [
          "attempt_id: a01",
          "harness_id: codex",
          "confinement_mechanism: seatbelt",
          "confinement_profile_digest: sha256:abc",
          "confinement_verified_denied_path: /Users/x/.claudexor/v3/daemon",
          "",
        ].join("\n"),
        a02: [
          "attempt_id: a02",
          "harness_id: claude",
          "confinement_unavailable_reason: no OS-enforced filesystem boundary is implemented for win32",
          "",
        ].join("\n"),
      });
      const cards = candidatesFor(runDir, null);
      const proven = cards.find((c) => c.attemptId === "a01")?.confinement;
      expect(proven).toEqual({
        proven: true,
        mechanism: "seatbelt",
        verifiedDeniedPath: "/Users/x/.claudexor/v3/daemon",
        unavailableReason: null,
      });
      const absent = cards.find((c) => c.attemptId === "a02")?.confinement;
      expect(absent?.proven).toBe(false);
      expect(absent?.mechanism).toBeNull();
      expect(absent?.unavailableReason).toMatch(/win32/);
    });

    it("calls a mechanism NAME with no proof exactly what it is: no boundary", () => {
      // The whole reason the applied-fact block exists. A record that names a
      // mechanism and cannot say what it denied is a promise, and this
      // projection must never launder it into `proven: true`.
      const runDir = runDirWith({
        a01: "attempt_id: a01\nharness_id: codex\nconfinement_mechanism: seatbelt\n",
      });
      const card = candidatesFor(runDir, null)[0]?.confinement;
      expect(card?.mechanism).toBe("seatbelt");
      expect(card?.proven).toBe(false);
    });

    it("stays null for a run that never asked for a boundary", () => {
      const runDir = runDirWith({ a01: "attempt_id: a01\nharness_id: codex\n" });
      expect(candidatesFor(runDir, null)[0]?.confinement).toBeNull();
    });
  });
});
