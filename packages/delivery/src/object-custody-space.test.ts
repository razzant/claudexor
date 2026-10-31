import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceError } from "@claudexor/core";
import {
  captureWorkingTreeTransient,
  GitOperationError,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { storeFaultRefusal } from "./object-custody.js";
import { verifyAndDeliver } from "./index.js";

// #535 R5 E1: INV-146 says a full disk refuses `space_insufficient`. A Git child that
// met it said so, but a direct write that met it (the pair's root record, a pending
// record) raised a bare ENOSPC, which refused as `git_failed`.
let fullDisk = false;
vi.mock("@claudexor/workspace", async (original) => {
  const actual = await original<typeof import("@claudexor/workspace")>();
  return {
    ...actual,
    retainInObjectStore: async (...args: Parameters<typeof actual.retainInObjectStore>) => {
      if (fullDisk)
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        });
      return actual.retainInObjectStore(...args);
    },
  };
});

const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-custody-space-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
  fullDisk = false;
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
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
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();

describe("a full disk on the way to a write", () => {
  it.each([
    ["ENOSPC", "space_insufficient"],
    ["EDQUOT", "space_insufficient"],
    ["EACCES", "git_failed"],
  ])("a bare %s refuses %s", (errno, code) => {
    const error = Object.assign(new Error(`${errno}: write`), { code: errno });
    expect(storeFaultRefusal(error, "nothing was written").code).toBe(code);
  });

  it("a Git child's full disk and any other store fault keep their codes (the control)", () => {
    expect(
      storeFaultRefusal(
        new GitOperationError("capture_space_insufficient", "git: No space left on device"),
        "x",
      ).code,
    ).toBe("space_insufficient");
    expect(storeFaultRefusal(new WorkspaceError("store unreadable"), "x").code).toBe("git_failed");
  });

  it("keeping the delivery pair refuses space_insufficient, writing nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-custody-space-"));
    const run = mkdtempSync(join(tmpdir(), "cx-custody-space-run-"));
    dirs.push(repo, run);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const clone = join(mkdtempSync(join(tmpdir(), "cx-custody-space-clone-")), "tree");
    dirs.push(join(clone, ".."));
    await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
    writeFileSync(join(clone, "a.txt"), "delivered\n");
    const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
      projectRoot: repo,
      owner: run,
    });
    fullDisk = true;

    const delivered = await verifyAndDeliver(
      repo,
      { result: captured.result!, renderedPatch: captured.patch },
      { mode: "apply", projectRoot: repo, owner: run },
      [],
    );

    expect(delivered).toMatchObject({
      applied: false,
      treeMutated: false,
      refusal: { code: "space_insufficient" },
    });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  });
});
