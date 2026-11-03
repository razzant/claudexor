import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FindingCategory, Severity } from "@claudexor/schema";
import { parseFindingsDetailed } from "../../review/src/findings.js";
import {
  RELEASE_NATIVE_CHECKLIST_ITEMS,
  SEALED_REVIEW_CATEGORY_VALUES,
  SEALED_REVIEW_SEVERITY_VALUES,
} from "../../review/src/sealedReviewEnvelope.js";
import {
  assertExactCandidateInputs,
  bundleReleaseReviewVerifier,
} from "../../../scripts/lib/release-review-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("release review verifier runtime", () => {
  it("bundles the production entry from repo-owned sources only", async () => {
    const verifier = await bundleReleaseReviewVerifier(repoRoot);
    expect(verifier.contents.length).toBeGreaterThan(0);
    expect(verifier.inputs).toContain("packages/review/src/sealedReviewEnvelope.ts");
    expect(verifier.inputs.some((path) => path.split("/").includes("node_modules"))).toBe(false);

    const runtime = (await import(
      `data:text/javascript;base64,${Buffer.from(verifier.contents).toString("base64")}`
    )) as {
      parseSealedReviewEnvelopeDetailed: (
        text: string,
        reviewer: { harness_id: string },
      ) => { error: string | null; malformed: number; findings: { severity: string }[] };
    };
    expect(SEALED_REVIEW_SEVERITY_VALUES).toEqual(Severity.options);
    expect(SEALED_REVIEW_CATEGORY_VALUES).toEqual(FindingCategory.options);
    const findings = [
      [],
      [{ severity: "WARN", category: "test_gap", claim: "valid warning" }],
      [
        {
          id: "finding-1",
          severity: "BLOCK",
          category: "correctness",
          claim: "complete blocker",
          linked_acceptance_criteria: ["INV-125"],
          evidence: {
            files: [{ path: "file.ts", lines: "1-2" }],
            diff_hunks: ["@@ -1 +1 @@"],
            commands: [{ command: "pnpm test" }],
            logs: [{ path: "test.log" }],
          },
          proposed_fix: "repair it",
        },
      ],
      [{ severity: "NIT", category: null, linked_acceptance_criteria: null, evidence: null }],
      [{ severity: "CRITICAL", claim: "invalid severity" }],
      [{ severity: "WARN", category: "style", claim: "invalid category" }],
      [{ id: "", severity: "WARN", claim: "invalid id" }],
      [{ severity: "WARN", claim: "invalid criterion", linked_acceptance_criteria: [""] }],
      [{ severity: "WARN", claim: "invalid evidence", evidence: { files: [{ path: 42 }] } }],
      [
        {
          severity: "WARN",
          claim: "invalid lines",
          evidence: { files: [{ path: "x", lines: 1 }] },
        },
      ],
      [{ severity: "WARN", claim: "invalid hunk", evidence: { diff_hunks: [42] } }],
      [{ severity: "WARN", claim: "invalid command", evidence: { commands: [{ command: 42 }] } }],
      [{ severity: "WARN", claim: "invalid log", evidence: { logs: [{ path: 42 }] } }],
      [{ severity: "WARN", claim: "invalid fix", proposed_fix: 42 }],
      [
        { severity: "WARN", claim: "retained warning" },
        { category: "correctness", claim: "missing severity" },
      ],
    ];
    for (const candidate of findings) {
      const reviewer = { harness_id: "release-reviewer" };
      const canonical = parseFindingsDetailed(JSON.stringify({ findings: candidate }), reviewer);
      const blocking = canonical.findings.some((finding) =>
        ["BLOCK", "FIX_FIRST", "NEEDS_HUMAN", "INSUFFICIENT_EVIDENCE"].includes(finding.severity),
      );
      const text = JSON.stringify({
        completion: {
          verdict: blocking ? "FAIL" : "PASS",
          checklist: RELEASE_NATIVE_CHECKLIST_ITEMS.map((item) => ({ item, completed: true })),
          findingCount: candidate.length,
        },
        findings: candidate,
      });
      const bundled = runtime.parseSealedReviewEnvelopeDetailed(text, reviewer);
      expect(bundled.error === null, text).toBe(canonical.malformed === 0);
      expect(bundled.malformed, text).toBe(canonical.malformed);
      expect(
        bundled.findings.map((finding) => finding.severity),
        text,
      ).toEqual(canonical.findings.map((finding) => finding.severity));
    }
  });

  it("refuses untracked or drifted repo-owned inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-review-runtime-"));
    scratch.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/tracked.ts"), "export const tracked = true;\n");
    git("add", "src/tracked.ts");
    git("commit", "-qm", "fixture");

    expect(() => assertExactCandidateInputs(root, ["src/tracked.ts"])).not.toThrow();
    writeFileSync(join(root, "src/untracked.ts"), "export const untracked = true;\n");
    expect(() => assertExactCandidateInputs(root, ["src/untracked.ts"])).toThrow(/not tracked/);
    writeFileSync(join(root, "src/tracked.ts"), "export const tracked = false;\n");
    expect(() => assertExactCandidateInputs(root, ["src/tracked.ts"])).toThrow(/differs from HEAD/);
  });
});
