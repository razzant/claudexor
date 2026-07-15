import { execFileSync, spawnSync } from "node:child_process";
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
});
