import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { createHash } from "node:crypto";
import { sha256 } from "@claudexor/util";
import { reviewCandidate, type ReviewCandidateInput } from "./reviewEngine.js";

/** #257 retired the owner-amended sol-lane delta scope: no reviewer lane can be
 * narrowed to a sealed delta any more. A sealed packet may still carry generic
 * delta evidence (DELTA.patch, FINGERPRINTS delta fields); every lane, Cursor
 * included, reviews the complete DIFF.patch with that evidence as context. */
type DeltaScopeInputWasRemoved = "deltaScope" extends keyof ReviewCandidateInput ? false : true;
const deltaScopeInputWasRemoved: DeltaScopeInputWasRemoved = true;

const reaped: string[] = [];
afterEach(() => {
  while (reaped.length) rmSync(reaped.pop()!, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function mk(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  reaped.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, "add", "--force", "a.ts");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Cumulative DIFF.patch (root..head) differs from the sealed delta (base..head). */
function fixture() {
  const cwd = mk("claudexor-delta-scope-");
  git(cwd, "init", "--quiet");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "root");
  const rootSha = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
  const baseSha = commit(cwd, "base");
  writeFileSync(join(cwd, "a.ts"), "export const a = 2;\n");
  const headSha = commit(cwd, "head");
  const diffOf = (range: string) =>
    execFileSync("git", ["diff", "--binary", range], { cwd, encoding: "utf8" });
  const fullDiff = diffOf(`${rootSha}..${headSha}`);
  const deltaText = diffOf(`${baseSha}..${headSha}`);
  const evidenceDir = join(cwd, ".claudexor-review-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  for (const [name, text] of [
    ["USER_INTENT.md", "review candidate\n"],
    ["FORBIDDEN_FINDINGS.md", "(none)\n"],
    ["PLAN_ACCEPTED.md", "(none)\n"],
    ["TESTS.txt", "(gate evidence)\n"],
    ["DECIDED_TRADEOFFS.md", "(none)\n"],
    ["DIFF.patch", fullDiff],
    ["DIFF_SUMMARY.md", "one file added\n"],
    ["DELTA.patch", deltaText],
    ["DELTA_SUMMARY.md", "one line changed\n"],
    ["FREEZE.json", "{}\n"],
    ["MANIFEST.sha256", "sealed fixture\n"],
    [
      "FINGERPRINTS.json",
      `${JSON.stringify({ deltaBaseSha: baseSha, deltaSha256: createHash("sha256").update(deltaText).digest("hex") }, null, 2)}\n`,
    ],
  ] as const) {
    writeFileSync(join(evidenceDir, name), text);
  }
  const artifactsDir = mk("claudexor-delta-scope-artifacts-");
  return { cwd, evidenceDir, artifactsDir, headSha, deltaText, fullDiff };
}

function adapterFor(id: string, prompts: Map<string, string>): HarnessAdapter {
  return {
    id,
    async doctor() {
      throw new Error("not used");
    },
    async *run(spec: { session_id: string; prompt: string }) {
      prompts.set(id, spec.prompt);
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        text: "[]",
      };
    },
  } as unknown as HarnessAdapter;
}

describe("retired sealed delta scope (#257)", () => {
  it("has no delta-scope input on the review engine", () => {
    expect(deltaScopeInputWasRemoved).toBe(true);
  });

  it("reviews a packet carrying delta evidence in full on every lane, Cursor included", async () => {
    const f = fixture();
    const prompts = new Map<string, string>();
    await reviewCandidate({
      candidateLabel: "Frozen candidate",
      diff: f.fullDiff,
      evidenceDir: f.evidenceDir,
      evidenceReadOnly: true,
      frozenIdentity: {
        candidateSha: f.headSha,
        candidateTree: "b".repeat(40),
        packetManifestSha256: "c".repeat(64),
      },
      env: { CLAUDEXOR_REVIEW_WAVE_ID: "11111111-1111-4111-8111-111111111111" },
      artifactsDir: f.artifactsDir,
      cwd: f.cwd,
      reviewers: [
        { adapter: adapterFor("claude", prompts), providerFamily: "anthropic" },
        { adapter: adapterFor("cursor", prompts), providerFamily: "cursor" },
      ],
    });
    const fullDigest = sha256(f.fullDiff);
    for (const [lane, id] of [
      ["01-claude", "claude"],
      ["02-cursor", "cursor"],
    ] as const) {
      const prompt = prompts.get(id) ?? "";
      expect(prompt).toContain("Review Frozen candidate's change from the file-backed patch");
      expect(prompt).toContain(`Patch digest: ${fullDigest}.`);
      expect(prompt).not.toContain("DELTA");
      const metadata = JSON.parse(
        readFileSync(join(f.artifactsDir, lane, "metadata.json"), "utf8"),
      );
      expect(metadata.diff_sha256).toBe(fullDigest);
      for (const retired of ["review_scope", "delta_base_sha", "delta_sha256"]) {
        expect(metadata).not.toHaveProperty(retired);
      }
    }
    // The sealed delta stays ordinary packet evidence in the retained copy.
    expect(readFileSync(join(f.artifactsDir, "evidence", "DELTA.patch"), "utf8")).toBe(f.deltaText);
  });
});
