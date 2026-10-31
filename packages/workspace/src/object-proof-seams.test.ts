import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { composeOnTarget } from "./object-compose.js";
import { materializeTree } from "./object-materialize.js";

// Branches no ordinary fixture reaches, through real Git: the one seam below acts
// on a single named command, right after it ran.
let afterCheckout: (() => void) | null = null;
let rewriteComponentRaw: ((stdout: string) => string) | null = null;
// A disk that answers an I/O error when one path is looked at (set after the checkout).
const failingLstat = new Set<string>();
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((path: string, options?: object) => {
      if (failingLstat.has(String(path)))
        throw Object.assign(new Error(`EIO: i/o error, lstat '${String(path)}'`), {
          code: "EIO",
        });
      return fs.lstatSync(path, options as never);
    }) as typeof fs.lstatSync,
  };
});
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: async (...args: Parameters<typeof core.runCaptureRaw>) => {
      const result = await core.runCaptureRaw(...args);
      const argv = args[1];
      if (afterCheckout && argv.includes("read-tree") && argv.includes("-u")) {
        const act = afterCheckout;
        afterCheckout = null;
        act();
      }
      if (
        rewriteComponentRaw &&
        argv.includes("--raw") &&
        argv.includes("--") &&
        argv.some((arg) => String(arg).startsWith("--find-renames="))
      )
        return { ...result, stdout: rewriteComponentRaw(result.stdout) };
      return result;
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  afterCheckout = null;
  rewriteComponentRaw = null;
  failingLstat.clear();
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
const OLD = new Date("2020-01-01T00:00:00Z");

function userRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-proof-seams-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "core.fileMode", "true"]);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
    utimesSync(join(repo, path), OLD, OLD);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

/** HEAD's tree with `changes` (null removes a path), through a private index. */
function treeWith(repo: string, changes: Record<string, string | null>, mode = "100644"): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-proof-seams-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  git(repo, ["read-tree", "HEAD"], env);
  let info = "";
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) info += `0 ${"0".repeat(40)}\t${path}\0`;
    else info += `${mode} ${git(repo, ["hash-object", "-w", "--stdin"], env, content)}\t${path}\0`;
  }
  git(repo, ["update-index", "-z", "--index-info"], env, info);
  return git(repo, ["write-tree"], env);
}

describe.skipIf(process.platform === "win32")("the content proof of a checkout", () => {
  it("a path with the right bytes and the wrong executable bit does not hold the delivered content", async () => {
    const repo = userRepo({ "tool.sh": "echo before\n" });
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "tool.sh": "echo after\n" }, "100755");
    afterCheckout = () => chmodSync(join(repo, "tool.sh"), 0o644);

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: true,
      refusal: { code: "delivery_content_mismatch", paths: ["tool.sh"] },
    });
    expect(readFileSync(join(repo, "tool.sh"), "utf8")).toBe("echo after\n");
  });

  // #535 R5 E1: only ENOENT and ENOTDIR say a path is gone; the proof read every lstat
  // error as absence, so a removal it could not look at was reported done.
  it("a removal the proof cannot look at is unproven, never done", async () => {
    const repo = userRepo({ "gone.txt": "gone\n", "kept.txt": "kept\n" });
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "gone.txt": null });
    afterCheckout = () => failingLstat.add(join(repo, "gone.txt"));

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: true,
      unproven: ["gone.txt"],
      refusal: { code: "git_failed", message: expect.stringContaining("could not be proven") },
    });
    expect(String((written as { refusal: { message: string } }).refusal.message)).toContain("EIO");
  });

  it("a written file the proof cannot look at is unproven, not a mismatch", async () => {
    const repo = userRepo({ "a.txt": "a\n" });
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "a.txt": "delivered\n" });
    afterCheckout = () => failingLstat.add(join(repo, "a.txt"));

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: true,
      refusal: { code: "git_failed", message: expect.stringContaining("EIO") },
    });
  });

  it("under core.fileMode=false the same executable bit is not compared", async () => {
    const repo = userRepo({ "tool.sh": "echo before\n" });
    git(repo, ["config", "core.fileMode", "false"]);
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "tool.sh": "echo after\n" }, "100755");
    afterCheckout = () => chmodSync(join(repo, "tool.sh"), 0o644);

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
  });
});

// Windows filesystems cannot hold these names.
describe.skipIf(process.platform === "win32")("a checkout over paths with special names", () => {
  const NAMES = [
    "with space.txt",
    '"quoted".txt',
    "new\nline.txt",
    "tab\there.txt",
    "ünï-çødé.txt",
    "-leading-dash.txt",
    "back\\slash.txt",
  ];
  const base = Object.fromEntries(NAMES.map((name) => [name, `base ${name.length}\n`]));

  it("replaces and removes them", async () => {
    const repo = userRepo(base);
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const [removed, ...replaced] = NAMES as [string, ...string[]];
    const to = treeWith(repo, {
      [removed]: null,
      ...Object.fromEntries(replaced.map((name) => [name, "delivered\n"])),
    });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: NAMES.length, treeMutated: true });
    for (const name of replaced) expect(readFileSync(join(repo, name), "utf8")).toBe("delivered\n");
  });

  it.each(NAMES)("compares %j by content: a stat-preserving edit refuses", async (name) => {
    const repo = userRepo(base);
    git(repo, ["config", "core.trustctime", "false"]);
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { [name]: "delivered\n" });
    // Same size, same inode, the old mtime: the user's index trusts this file.
    writeFileSync(join(repo, name), base[name]!.toUpperCase());
    utimesSync(join(repo, name), OLD, OLD);
    expect(git(repo, ["status", "--porcelain"])).toBe("");

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_target_changed" },
    });
    expect(readFileSync(join(repo, name), "utf8")).toBe(base[name]!.toUpperCase());
  });
});

describe("composition of a rename", () => {
  it("refuses when a path-limited regeneration does not reproduce the record", async () => {
    const text = Array.from({ length: 40 }, (_, at) => `line ${at}\n`).join("");
    const repo = userRepo({ "a.txt": text });
    const base = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const target = treeWith(repo, { "a.txt": `first\n${text.slice(7)}` });
    const candidate = treeWith(repo, { "a.txt": null, "b.txt": text });

    // The seam is live: unrewritten, this composition carries the edit through the rename.
    expect(await composeOnTarget({ repo, base, target, candidate })).toMatchObject({ ok: true });

    rewriteComponentRaw = (stdout) => stdout.replace(/R100/, "R090");
    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({
      ok: false,
      refusal: {
        code: "delivery_pairing_mismatch",
        paths: expect.arrayContaining(["a.txt", "b.txt"]),
      },
    });
  });
});
