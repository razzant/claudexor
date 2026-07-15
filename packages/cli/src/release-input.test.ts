import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const verifier = resolve(repo, "scripts/verify-release-input.mjs");

function head(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

describe("candidate release input", () => {
  it("accepts only the exact workflow-dispatch SHA", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: candidateSha,
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`release input OK: candidate ${candidateSha}`);
  });

  it("rejects a resolvable candidate that differs from the workflow-dispatch SHA", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: "0".repeat(40),
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release input rejected: candidate SHA does not match the workflow-dispatch GITHUB_SHA",
    );
  });

  it("rejects a publish tag when its commit differs from the workflow-dispatch SHA", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: fixture,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git("init", "-q");
      writeFileSync(resolve(fixture, "README.md"), "fixture\n");
      git("add", "README.md");
      git("commit", "-qm", "fixture");
      git("tag", "-a", "v2.0.0", "-m", "fixture");
      git("update-ref", "refs/remotes/origin/main", "HEAD");

      const result = spawnSync(process.execPath, [verifier], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_SHA: "0".repeat(40),
          RELEASE_MODE_INPUT: "publish",
          RELEASE_REF_INPUT: "v2.0.0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish SHA does not match the workflow-dispatch GITHUB_SHA",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
