import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SCOPE_MODEL,
  REQUIRED_TRIAD_MODELS,
  TRIAD_ITEMS,
  buildTouchedFilePack,
  completionTermination,
  exactPanelMatch,
  parseChecklistJson,
  pathIsWithin,
  releaseReviewDecision,
  validateFrozenReviewBinding,
  validateNewReviewOutput,
  validateChecklistResponse,
} from "../../../scripts/lib/release-review-contract.mjs";

function cleanRows() {
  return TRIAD_ITEMS.map((item) => ({
    item,
    verdict: "PASS",
    severity: "advisory",
    reason: `${item} checked`,
  }));
}

describe("release review fail-closed contract", () => {
  it("accepts only the exact ordered model panel", () => {
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS, REQUIRED_SCOPE_MODEL)).toBe(true);
    expect(exactPanelMatch([...REQUIRED_TRIAD_MODELS].reverse(), REQUIRED_SCOPE_MODEL)).toBe(false);
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS, "anthropic/nearest-model")).toBe(false);
    expect(exactPanelMatch(REQUIRED_TRIAD_MODELS.slice(0, 2), REQUIRED_SCOPE_MODEL)).toBe(false);
  });

  it("distinguishes candidate/packet descendants from external review artifacts", () => {
    expect(pathIsWithin("/candidate", "/candidate")).toBe(true);
    expect(pathIsWithin("/candidate", "/candidate/reviews/round-1")).toBe(true);
    expect(pathIsWithin("/candidate", "/candidate-sibling/reviews")).toBe(false);
    expect(pathIsWithin("/packet", "/external/reviews/round-1")).toBe(false);
    expect(
      validateNewReviewOutput("/candidate", "/packet", "/external/reviews/round-1", true),
    ).toMatchObject({ ok: false, reasons: ["review output already exists"] });
  });

  it("binds a clean worktree and sealed packet to the exact candidate SHA and tree", () => {
    const candidateSha = "a".repeat(40);
    const candidateTree = "b".repeat(40);
    const clean = {
      candidateSha,
      candidateTree,
      actualSha: candidateSha,
      actualTree: candidateTree,
      dirty: false,
    };
    expect(validateFrozenReviewBinding(clean)).toEqual({ ok: true, reasons: [] });
    expect(validateFrozenReviewBinding({ ...clean, dirty: true }).ok).toBe(false);
    expect(validateFrozenReviewBinding({ ...clean, actualTree: "c".repeat(40) }).ok).toBe(false);
  });

  it("builds touched-file context from Git blobs without following tracked symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-review-pack-"));
    const repo = join(root, "repo");
    const outside = join(root, "outside.txt");
    const sentinel = "OUTSIDE_SENTINEL_NOT_IN_GIT";
    mkdirSync(repo);
    writeFileSync(outside, sentinel);
    writeFileSync(join(repo, "regular.txt"), "committed regular content\n");
    symlinkSync(outside, join(repo, "leak.txt"));
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git(["init", "-q"]);
      git(["add", "regular.txt", "leak.txt"]);
      git(["commit", "-qm", "fixture"]);
      expect(git(["ls-files", "-s", "--", "leak.txt"])).toMatch(/^120000 /);
      const pack = buildTouchedFilePack(["regular.txt", "leak.txt"], git, 200_000, 3_000_000);
      expect(pack).toContain("committed regular content");
      expect(pack).toContain(outside);
      expect(pack).not.toContain(sentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([null, "length", "max_tokens", "tool_calls"])(
    "rejects non-terminal or truncated finish reason %s",
    (finishReason) => {
      expect(completionTermination(finishReason).complete).toBe(false);
    },
  );

  it("accepts only the terminal stop finish reason", () => {
    expect(completionTermination("stop")).toEqual({ complete: true, error: null });
  });

  it("parses a whole JSON-array response with at most one exact json fence", () => {
    expect(parseChecklistJson(JSON.stringify(cleanRows()))).toEqual(cleanRows());
    expect(parseChecklistJson(`\`\`\`json\n${JSON.stringify(cleanRows())}\n\`\`\``)).toEqual(
      cleanRows(),
    );
    expect(parseChecklistJson(`review:\n${JSON.stringify(cleanRows())}`)).toBeNull();
    expect(
      parseChecklistJson(`before\n\`\`\`json\n${JSON.stringify(cleanRows())}\n\`\`\``),
    ).toBeNull();
    expect(
      parseChecklistJson(
        `\`\`\`json\n${JSON.stringify(cleanRows())}\n\`\`\`\n\`\`\`json\n[]\n\`\`\``,
      ),
    ).toBeNull();
  });

  it.each([
    ["empty array", []],
    ["malformed row", [{ item: "review_protocol", verdict: "PASS" }]],
    [
      "unknown checklist item",
      [{ item: "not_a_check", verdict: "PASS", severity: "advisory", reason: "x" }],
    ],
  ])("makes %s quorum-unusable", (_name, value) => {
    expect(validateChecklistResponse(value, "model", TRIAD_ITEMS).status).not.toBe("responded");
  });

  it("makes a missing checklist item partial rather than silently clean", () => {
    const result = validateChecklistResponse(cleanRows().slice(0, 2), "model", TRIAD_ITEMS);
    expect(result.status).toBe("partial");
    expect(result.missingItems).toEqual(["security_and_secrets"]);
  });

  it("passes only complete PASS responses from quorum plus scope", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    expect(
      releaseReviewDecision({
        triadActors: [
          { status: "responded", findings },
          { status: "responded", findings },
          { status: "timed_out" },
        ],
        scope: { status: "responded", findings: [] },
      }).passed,
    ).toBe(true);
  });

  it("fails closed on any FAIL verdict even when quorum and scope are healthy", () => {
    const rows = cleanRows();
    rows[1] = { ...rows[1]!, verdict: "FAIL", severity: "advisory", reason: "concrete issue" };
    const findings = validateChecklistResponse(rows, "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        {
          status: "responded",
          findings: validateChecklistResponse(cleanRows(), "other", TRIAD_ITEMS).findings,
        },
      ],
      scope: { status: "responded", findings: [] },
    });
    expect(decision.passed).toBe(false);
    expect(decision.blockingFindings).toHaveLength(1);
    expect(decision.reasons[0]).toContain("FAIL");
  });

  it("fails closed when the required scope slot is missing", () => {
    const findings = validateChecklistResponse(cleanRows(), "model", TRIAD_ITEMS).findings;
    const decision = releaseReviewDecision({
      triadActors: [
        { status: "responded", findings },
        { status: "responded", findings },
      ],
      scope: null,
    });
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain("scope reviewer is missing");
  });
});
