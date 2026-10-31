import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { materializeTree } from "./object-materialize.js";

// A checkout that runs out of space stops partway, and the take-back needs space
// too. The new blob sizes are known before the first write, so a delivery that
// cannot fit refuses with nothing written. ESM namespaces cannot be spied, so
// node:fs is wrapped once for this file.
let freeBytes: number | null = null;
let statfsFails = false;
// A disk that fills between the checkout and its proof.
let proofIndexFull = false;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      if (proofIndexFull && String(args[1]).includes("claudexor-proof-"))
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      return fs.copyFileSync(...args);
    },
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      if (statfsFails)
        throw Object.assign(new Error("function not implemented"), { code: "ENOSYS" });
      const real = fs.statfsSync(...args);
      return freeBytes === null ? real : { ...real, bavail: 1, bsize: freeBytes };
    },
  };
});

const MARGIN = 64 * 1024 * 1024;
const dirs: string[] = [];
afterEach(() => {
  freeBytes = null;
  statfsFails = false;
  proofIndexFull = false;
});
afterAll(() => {
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
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();

function userRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-space-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "kept.txt"), "x".repeat(4096));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

function treeWith(repo: string, files: Record<string, string>): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-space-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  git(repo, ["read-tree", "HEAD"], env);
  let info = "";
  for (const [path, content] of Object.entries(files))
    info += `100644 ${git(repo, ["hash-object", "-w", "--stdin"], env, content)}\t${path}\0`;
  git(repo, ["update-index", "-z", "--index-info"], env, info);
  return git(repo, ["write-tree"], env);
}

describe("free space before a checkout", () => {
  it("a result that cannot fit refuses typed with nothing written", async () => {
    const repo = userRepo();
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "new.bin": "y".repeat(8192), "other.bin": "z".repeat(8192) });
    freeBytes = MARGIN + 1024;

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "space_insufficient" },
    });
    expect(existsSync(join(repo, "new.bin"))).toBe(false);
    expect(existsSync(join(repo, "other.bin"))).toBe(false);
  });

  it("what a replaced file frees counts: an equal-size edit needs no room beyond the margin", async () => {
    const repo = userRepo();
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "kept.txt": "w".repeat(4096) });
    freeBytes = MARGIN + 1024;

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("w".repeat(4096));
  });

  it("a filesystem that cannot report free space refuses nothing", async () => {
    const repo = userRepo();
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "new.bin": "y".repeat(8192) });
    statfsFails = true;

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
  });

  it("a disk that fills right after the checkout answers typed, the written paths unproven", async () => {
    const repo = userRepo();
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "new.bin": "y".repeat(8192) });
    proofIndexFull = true;

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: true,
      unproven: ["new.bin"],
      refusal: { code: "space_insufficient" },
    });
  });

  it("a result that fits is written", async () => {
    const repo = userRepo();
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "new.bin": "y".repeat(8192) });
    freeBytes = MARGIN + 1024 * 1024;

    expect(await materializeTree({ worktree: repo, from, to, index: "temporary" })).toEqual({
      ok: true,
      changed: 1,
      treeMutated: true,
    });
  });
});
