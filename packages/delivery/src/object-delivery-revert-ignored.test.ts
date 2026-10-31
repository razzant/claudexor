import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { checkResultOnTarget, revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R3 B1: a revert composes on a snapshot of the target, and a snapshot leaves
// ignored files out. A path the delivery added that the target ignores (its own
// `.git/info/exclude`, a rule written after the apply, an ignored empty directory a
// delivered file replaced) read as already gone: the revert answered reverted:true
// and the file stayed. The legacy patch revert removes it.
const dirs: string[] = [];
/** Directories a test made unsearchable, opened again before cleanup. */
const locked: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-revert-ignored-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const dir of locked.splice(0)) if (existsSync(dir)) chmodSync(dir, 0o755);
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

/** A project with a committed `.gitignore` and an ignored file of the user's, and a
 * result that adds `name` (the clone shares none of the target's own excludes). */
async function delivered(name: string, setup: (repo: string) => void = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), "cx-revert-ignored-"));
  const run = mkdtempSync(join(tmpdir(), "cx-revert-ignored-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  writeFileSync(join(repo, "kept.txt"), "kept\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "build.log"), "the user's ignored log\n");
  setup(repo);
  const clone = join(mkdtempSync(join(tmpdir(), "cx-revert-ignored-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  mkdirSync(join(clone, name, ".."), { recursive: true });
  writeFileSync(join(clone, name), "the agent's file\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  const applied = await verifyAndDeliver(
    repo,
    { result: captured.result!, renderedPatch: captured.patch },
    { mode: "apply", projectRoot: repo, owner: run },
    [],
  );
  expect(applied).toMatchObject({ applied: true });
  expect(readFileSync(join(repo, name), "utf8")).toBe("the agent's file\n");
  const anchor = await createPairRevertAnchor(repo, applied.deliveryPair!, repo);
  return { repo, revert: () => revertInPlaceFromAnchor(repo, anchor, repo) };
}

describe("a revert of a path the delivery added that the target ignores", () => {
  it("removes a name only the target's .git/info/exclude hides", async () => {
    const f = await delivered("notes.md", (repo) =>
      writeFileSync(join(repo, ".git/info/exclude"), "notes.md\n"),
    );

    expect(await f.revert()).toMatchObject({ reverted: true });

    expect(existsSync(join(f.repo, "notes.md"))).toBe(false);
    expect(readFileSync(join(f.repo, "build.log"), "utf8")).toBe("the user's ignored log\n");
    expect(git(f.repo, "status", "--porcelain")).toBe("");
  });

  it("removes a file that replaced an ignored empty directory", async () => {
    const f = await delivered("cache", (repo) => {
      writeFileSync(join(repo, ".git/info/exclude"), "cache\n");
      mkdirSync(join(repo, "cache"));
    });
    expect(lstatSync(join(f.repo, "cache")).isFile()).toBe(true);

    expect(await f.revert()).toMatchObject({ reverted: true });

    expect(existsSync(join(f.repo, "cache"))).toBe(false);
    expect(readFileSync(join(f.repo, "build.log"), "utf8")).toBe("the user's ignored log\n");
  });

  it("removes a file the user started to ignore after the apply, keeping their rule", async () => {
    const f = await delivered("notes.md");
    appendFileSync(join(f.repo, ".gitignore"), "notes.md\n");

    expect(await f.revert()).toMatchObject({ reverted: true });

    expect(existsSync(join(f.repo, "notes.md"))).toBe(false);
    expect(readFileSync(join(f.repo, ".gitignore"), "utf8")).toBe("*.log\nnotes.md\n");
    expect(readFileSync(join(f.repo, "build.log"), "utf8")).toBe("the user's ignored log\n");
  });

  it("refuses when the user changed that file since, writing nothing", async () => {
    const f = await delivered("notes.md", (repo) =>
      writeFileSync(join(repo, ".git/info/exclude"), "notes.md\n"),
    );
    writeFileSync(join(f.repo, "notes.md"), "the user's edit\n");

    expect(await f.revert()).toMatchObject({
      reverted: false,
      refusal: { code: "revert_conflict" },
    });

    expect(readFileSync(join(f.repo, "notes.md"), "utf8")).toBe("the user's edit\n");
    expect(readFileSync(join(f.repo, "build.log"), "utf8")).toBe("the user's ignored log\n");
  });
});

// #535 R4 F1: only ENOENT and ENOTDIR mean a delivered addition is gone. A parent the
// revert cannot search read as absence too, so the revert answered reverted:true (and
// the run was recorded reverted) while the delivered file stayed.
describe("a revert that cannot read what the delivery added", () => {
  it("refuses typed and writes nothing when the addition's directory cannot be searched", async () => {
    const f = await delivered("hidden/file", (repo) =>
      writeFileSync(join(repo, ".git/info/exclude"), "hidden/\n"),
    );
    chmodSync(join(f.repo, "hidden"), 0o000);
    locked.push(join(f.repo, "hidden"));

    const answer = await f.revert();
    chmodSync(join(f.repo, "hidden"), 0o755);

    expect(answer).toMatchObject({
      reverted: false,
      reasonCode: "reverse_apply_failed",
      refusal: { code: "git_failed" },
    });
    expect(answer.reason).toContain("hidden/file");
    expect(readFileSync(join(f.repo, "hidden/file"), "utf8")).toBe("the agent's file\n");
    expect(readFileSync(join(f.repo, "build.log"), "utf8")).toBe("the user's ignored log\n");
  });

  it("still removes an ignored addition it can read (the control)", async () => {
    const f = await delivered("hidden/file", (repo) =>
      writeFileSync(join(repo, ".git/info/exclude"), "hidden/\n"),
    );

    expect(await f.revert()).toMatchObject({ reverted: true });

    expect(existsSync(join(f.repo, "hidden/file"))).toBe(false);
  });

  it("a take-back that cannot read it says the write stays, never that the target is unchanged", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-revert-unreadable-"));
    const run = mkdtempSync(join(tmpdir(), "cx-revert-unreadable-run-"));
    dirs.push(repo, run);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    writeFileSync(join(repo, ".git/info/exclude"), "hidden/\n");
    // A checkout filter that does not round-trip and, run after hidden/file is
    // written (index order), leaves `hidden` unsearchable: the write must go back.
    git(repo, "config", "filter.lock.smudge", "sh -c 'chmod 000 hidden 2>/dev/null; tr a-z A-Z'");
    git(repo, "config", "filter.lock.clean", "cat");
    writeFileSync(join(repo, ".git/info/attributes"), "z.txt filter=lock\n");
    locked.push(join(repo, "hidden"));
    const clone = join(mkdtempSync(join(tmpdir(), "cx-revert-unreadable-clone-")), "tree");
    dirs.push(join(clone, ".."));
    await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
    mkdirSync(join(clone, "hidden"));
    writeFileSync(join(clone, "hidden/file"), "the agent's file\n");
    writeFileSync(join(clone, "z.txt"), "lower\n");
    const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
      projectRoot: repo,
      owner: run,
    });

    const applied = await verifyAndDeliver(
      repo,
      { result: captured.result!, renderedPatch: captured.patch },
      { mode: "apply", projectRoot: repo, owner: run },
      [],
    );
    chmodSync(join(repo, "hidden"), 0o755);

    // The content proof cannot look at hidden/file either: the write is unproven.
    expect(applied).toMatchObject({
      applied: false,
      treeMutated: true,
      refusal: { code: "git_failed" },
    });
    expect(applied.refusal!.message).toContain("the written paths could not be proven");
    expect(applied.deliveryPair).toBeDefined();
    expect(applied.refusal!.message).toContain("RECOVERY REQUIRED");
    expect(applied.refusal!.message).not.toContain("the target is unchanged");
    expect(readFileSync(join(repo, "hidden/file"), "utf8")).toBe("the agent's file\n");
  });
});

// #535 R4 class audit: the occupied check read a path under a directory the target
// cannot search as free, so apply/check answered ok where the write then refused.
describe("a write into a directory the target cannot search", () => {
  it("is refused by its dry run as by the write itself, with nothing written", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-locked-dir-"));
    const run = mkdtempSync(join(tmpdir(), "cx-locked-dir-run-"));
    dirs.push(repo, run);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "kept.txt"), "kept\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    writeFileSync(join(repo, ".git/info/exclude"), "locked/\n");
    mkdirSync(join(repo, "locked"));
    writeFileSync(join(repo, "locked/held.txt"), "the user's ignored file\n");
    const clone = join(mkdtempSync(join(tmpdir(), "cx-locked-dir-clone-")), "tree");
    dirs.push(join(clone, ".."));
    await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
    mkdirSync(join(clone, "locked"));
    writeFileSync(join(clone, "locked/new.txt"), "the agent's file\n");
    const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
      projectRoot: repo,
      owner: run,
    });
    chmodSync(join(repo, "locked"), 0o000);
    locked.push(join(repo, "locked"));

    const checked = await checkResultOnTarget(repo, captured.result!, repo);
    const applied = await verifyAndDeliver(
      repo,
      { result: captured.result!, renderedPatch: captured.patch },
      { mode: "apply", projectRoot: repo, owner: run },
      [],
    );
    chmodSync(join(repo, "locked"), 0o755);

    expect(checked.ok).toBe(false);
    expect(applied).toMatchObject({ applied: false, treeMutated: false });
    // #535 R5 E1: apply/check answers the write's own typed refusal, not bare text.
    expect(applied.refusal?.code).toBe("git_failed");
    expect(checked.refusal).toMatchObject({ code: applied.refusal!.code });
    expect(checked.refusal!.message).toContain("EACCES");
    expect(existsSync(join(repo, "locked/new.txt"))).toBe(false);
    expect(readFileSync(join(repo, "locked/held.txt"), "utf8")).toBe("the user's ignored file\n");
  });
});
