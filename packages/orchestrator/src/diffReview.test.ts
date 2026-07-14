import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { FROZEN_REVIEW_EVIDENCE_FILES } from "@claudexor/context";
import { reviewCandidate, type ReviewerSpec } from "@claudexor/review";
import { runDiffReview, type DiffReviewDeps, type FrozenDiffReviewInput } from "./diffReview.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function packetFiles(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).map((file) => [file, sha256(readFileSync(join(dir, file)))]),
  );
}

function writePacket(
  dir: string,
  input: { baseSha: string; candidateSha: string; candidateTree: string; diff: string },
): string {
  mkdirSync(dir, { recursive: true });
  for (const file of FROZEN_REVIEW_EVIDENCE_FILES) {
    let content = `${file}\n`;
    if (file === "FREEZE.json") content = `${JSON.stringify(input)}\n`;
    if (file === "DIFF.patch") content = input.diff;
    if (file.endsWith(".json") && file !== "FREEZE.json") content = "{}\n";
    writeFileSync(join(dir, file), content);
  }
  const manifest = FROZEN_REVIEW_EVIDENCE_FILES.map(
    (file) => `${sha256(readFileSync(join(dir, file)))}  ${file}`,
  ).join("\n");
  writeFileSync(join(dir, "MANIFEST.sha256"), `${manifest}\n`);
  return sha256(`${manifest}\n`);
}

function reviewer(): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id: "sealed-reviewer",
    async discover() {
      throw new Error("not used");
    },
    async doctor() {
      throw new Error("not used");
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts, observed_model: "review-model" };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, providerFamily: "anthropic", requestedModel: "review-model" };
}

function fixture(): {
  repo: string;
  packet: string;
  artifacts: string;
  frozen: FrozenDiffReviewInput;
  baseSha: string;
  candidateSha: string;
  candidateTree: string;
  diff: string;
} {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-frozen-review-repo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "value.txt"), "base\n");
  git(repo, ["add", "value.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "value.txt"), "candidate\n");
  git(repo, ["add", "value.txt"]);
  git(repo, ["commit", "-q", "-m", "candidate"]);
  const candidateSha = git(repo, ["rev-parse", "HEAD"]).trim();
  const candidateTree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
  const diff = git(repo, ["diff", "--binary", `${baseSha}..${candidateSha}`]);
  const external = mkdtempSync(join(tmpdir(), "claudexor-frozen-review-external-"));
  const packet = join(external, "packet");
  const artifacts = join(external, "artifacts");
  const packetManifestSha256 = writePacket(packet, {
    baseSha,
    candidateSha,
    candidateTree,
    diff,
  });
  return {
    repo,
    packet,
    artifacts,
    baseSha,
    candidateSha,
    candidateTree,
    diff,
    frozen: {
      evidenceDir: packet,
      artifactsDir: artifacts,
      candidateSha,
      candidateTree,
      packetManifestSha256,
    },
  };
}

function deps(): DiffReviewDeps {
  return {
    resolveReviewers: async () => [reviewer()],
    reviewScoped: (input) => reviewCandidate(input),
    execRootOf: (root) => root,
    envInheritance: () => "clean",
  };
}

describe("frozen diff review", () => {
  it("reviews the exact candidate and leaves every sealed packet byte unchanged", async () => {
    const f = fixture();
    const before = packetFiles(f.packet);
    const result = await runDiffReview({ repoRoot: f.repo, frozen: f.frozen }, deps());

    expect(result.artifactsDir).toBe(f.artifacts);
    expect(existsSync(join(f.artifacts, "evidence-metadata.json"))).toBe(true);
    expect(packetFiles(f.packet)).toEqual(before);
    expect(packetFiles(join(f.artifacts, "evidence"))).toEqual(before);
    expect(readFileSync(join(f.artifacts, "01-sealed-reviewer", "prompt.md"), "utf8")).toContain(
      "read every file it seals",
    );
  });

  it("rejects wrong candidate SHA, tree, dirty state, and a tampered packet", async () => {
    const wrongSha = fixture();
    await expect(
      runDiffReview(
        { repoRoot: wrongSha.repo, frozen: { ...wrongSha.frozen, candidateSha: "a".repeat(40) } },
        deps(),
      ),
    ).rejects.toThrow(/candidate SHA mismatch/);

    const wrongTree = fixture();
    await expect(
      runDiffReview(
        {
          repoRoot: wrongTree.repo,
          frozen: { ...wrongTree.frozen, candidateTree: "b".repeat(40) },
        },
        deps(),
      ),
    ).rejects.toThrow(/candidate tree mismatch/);

    const dirty = fixture();
    writeFileSync(join(dirty.repo, "untracked.txt"), "user state\n");
    await expect(
      runDiffReview({ repoRoot: dirty.repo, frozen: dirty.frozen }, deps()),
    ).rejects.toThrow(/dirty or stale/);

    const tampered = fixture();
    writeFileSync(join(tampered.packet, "TESTS.txt"), "tampered\n");
    await expect(
      runDiffReview({ repoRoot: tampered.repo, frozen: tampered.frozen }, deps()),
    ).rejects.toThrow(/manifest digest mismatch: TESTS\.txt/);

    const changedDuringReview = fixture();
    const mutatingDeps = deps();
    mutatingDeps.reviewScoped = async () => {
      writeFileSync(join(changedDuringReview.packet, "TESTS.txt"), "changed during review\n");
      return {
        findings: [],
        routeProofs: [],
        reviewerRequests: [],
        crossFamilyHealthy: false,
        healthyProviders: [],
        crossFamilyVerified: false,
        distinctProviders: [],
        reviewSpendUsd: 0,
        reviewSpendEstimated: false,
      };
    };
    await expect(
      runDiffReview(
        { repoRoot: changedDuringReview.repo, frozen: changedDuringReview.frozen },
        mutatingDeps,
      ),
    ).rejects.toThrow(/manifest digest mismatch: TESTS\.txt/);
  }, 15_000);

  it("rejects a sealed but incomplete base-to-candidate diff", async () => {
    const f = fixture();
    const packetManifestSha256 = writePacket(f.packet, {
      baseSha: f.baseSha,
      candidateSha: f.candidateSha,
      candidateTree: f.candidateTree,
      diff: "diff --git a/value.txt b/value.txt\n",
    });
    await expect(
      runDiffReview({ repoRoot: f.repo, frozen: { ...f.frozen, packetManifestSha256 } }, deps()),
    ).rejects.toThrow(/DIFF\.patch does not match base\.\.candidate/);
  });

  it("refuses a preexisting artifacts directory without deleting its contents", async () => {
    const f = fixture();
    mkdirSync(f.artifacts, { recursive: true });
    const sentinel = join(f.artifacts, "user-sentinel.txt");
    writeFileSync(sentinel, "keep me\n");

    await expect(runDiffReview({ repoRoot: f.repo, frozen: f.frozen }, deps())).rejects.toThrow(
      /artifacts directory already exists/,
    );
    expect(readFileSync(sentinel, "utf8")).toBe("keep me\n");
  });
});
