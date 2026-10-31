import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";

// A patch is only a view: any failure to render one leaves the exact objects kept,
// so the capture answers a typed absence (`render_failed`), never a refusal.
let renderAnswer: { code: number | null; stdout: string; stderr: string } | null = null;
vi.mock("./git-run.js", async (original) => {
  const actual = await original<typeof import("./git-run.js")>();
  return {
    ...actual,
    gitEnv: async (...args: Parameters<typeof actual.gitEnv>) => {
      if (renderAnswer && args[1].includes("--binary")) return renderAnswer;
      return actual.gitEnv(...args);
    },
  };
});

const dirs: string[] = [];
const configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
afterEach(() => {
  renderAnswer = null;
  process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function changedRepo() {
  const repo = mkdtempSync(join(tmpdir(), "cx-render-"));
  const config = mkdtempSync(join(tmpdir(), "cx-render-config-"));
  dirs.push(repo, config);
  process.env["CLAUDEXOR_CONFIG_DIR"] = config;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: ENV });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(join(repo, "a.txt"), "candidate\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  return repo;
}

describe("a patch view that fails to render", () => {
  it.each([
    ["the 60-second timeout", { code: null, stdout: "", stderr: "" }],
    ["a Git failure", { code: 128, stdout: "", stderr: "fatal: bad things" }],
    [
      "a binary stub",
      {
        code: 0,
        stdout:
          "diff --git a/x.bin b/x.bin\nindex 1234567..89abcde 100644\nBinary files a/x.bin and b/x.bin differ\n",
        stderr: "",
      },
    ],
  ] as const)("%s keeps the exact result with a typed absence", async (_name, answer) => {
    const repo = changedRepo();
    renderAnswer = answer;

    const captured = await captureWorkingTreeTransient(repo, "HEAD");

    expect(captured.captureIncomplete).toBe(false);
    expect(captured.captureFailure).toBeUndefined();
    expect(captured.patch).toBe("");
    expect(captured.result?.schema).toBe("git_objects/v1");
    expect(captured.patchViewUnavailable).toMatchObject({
      reason: "render_failed",
      limitBytes: 256 * 1024 * 1024,
    });
    // An estimate that fit is all that is known: a failure proves no overflow.
    expect(captured.patchViewUnavailable!.estimatedBytes).toBeLessThan(1024 * 1024);
    expect(captured.changedPaths?.sort()).toEqual(["a.txt", "new.txt"]);
    expect(captured.inventory?.changedFiles).toBe(2);
  });

  it("a clean render stays a rendered view", async () => {
    const repo = changedRepo();

    const captured = await captureWorkingTreeTransient(repo, "HEAD");

    expect(captured.patchViewUnavailable).toBeUndefined();
    expect(captured.patch).toContain("diff --git a/a.txt b/a.txt");
  });
});
