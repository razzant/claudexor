import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  createPairRevertAnchor,
  isolatedCloneAdd,
} from "@claudexor/workspace";
import { checkResultOnTarget, revertInPlaceFromAnchor, verifyAndDeliver } from "./index.js";

// #535 R14 A1: with `core.checkStat=minimal` and `core.trustctime=false`, a file that
// keeps its size and mtime reads as unchanged to Git's stat cache. After an `apply`
// of before\n -> after!\n whose file got its old mtime back, the snapshot a revert
// composes against said "before" while the file held "after!": the revert answered
// reverted:true and left the delivered bytes in place, and a later user edit of the
// same shape was called reverted too. An apply onto such an edit could likewise
// answer "already applied". What these operations decide on is now read by content.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-stat-cache-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
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
/** What the user's own `git status` says, without letting it rewrite the index. */
const userStatus = (repo: string) =>
  execFileSync("git", ["-C", repo, "status", "--porcelain"], {
    env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" },
  })
    .toString("utf8")
    .trim();
const Y2000 = 946_684_800;

/** f.txt: `before` at a fixed mtime, a minimal stat check; the result makes it `after`. */
async function fixture(before = "before\n", after = "after!\n") {
  const repo = mkdtempSync(join(tmpdir(), "cx-stat-cache-"));
  const run = mkdtempSync(join(tmpdir(), "cx-stat-cache-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.trustctime", "false");
  git(repo, "config", "core.checkStat", "minimal");
  writeFileSync(join(repo, "f.txt"), before);
  writeFileSync(join(repo, "g.txt"), "g\n");
  utimesSync(join(repo, "f.txt"), Y2000, Y2000);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-stat-cache-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(clone, "f.txt"), after);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  expect(captured.captureIncomplete).toBe(false);
  const delivery = { result: captured.result!, renderedPatch: captured.patch };
  const f = () => readFileSync(join(repo, "f.txt"), "utf8");
  /** Same size, same mtime as the index records: Git's stat check cannot see it. */
  const hide = (bytes: string, at = Y2000) => {
    writeFileSync(join(repo, "f.txt"), bytes);
    utimesSync(join(repo, "f.txt"), at, at);
  };
  const apply = () =>
    verifyAndDeliver(repo, delivery, { mode: "apply", projectRoot: repo, owner: run }, []);
  const revert = async (pair: Parameters<typeof createPairRevertAnchor>[1]) =>
    revertInPlaceFromAnchor(repo, await createPairRevertAnchor(repo, pair, repo), repo);
  return { repo, delivery, f, hide, apply, revert };
}

describe("apply, anchor and revert when a file kept its size and mtime", () => {
  it("a delivered file whose old mtime came back is reverted, not called reverted", async () => {
    const t = await fixture();
    const applied = await t.apply();
    expect(applied.applied).toBe(true);
    t.hide("after!\n"); // the delivered bytes, with the old mtime restored
    expect(userStatus(t.repo)).toBe("");

    const reverted = await t.revert(applied.deliveryPair!);

    expect(reverted).toMatchObject({ reverted: true });
    expect(t.f()).toBe("before\n");
  });

  it("a later user edit of that shape is a conflict: kept, never called reverted", async () => {
    const t = await fixture();
    const applied = await t.apply();
    t.hide("user!!\n"); // the user's own later edit, same size, same mtime

    const reverted = await t.revert(applied.deliveryPair!);

    expect(reverted).toMatchObject({ reverted: false, reasonCode: "postimage_diverged" });
    expect(t.f()).toBe("user!!\n");
  });

  it("a file already back to what the delivery replaced reverts as a no-op (control)", async () => {
    const t = await fixture();
    const applied = await t.apply();
    t.hide("before\n");

    const reverted = await t.revert(applied.deliveryPair!);

    expect(reverted).toMatchObject({ reverted: true });
    expect(t.f()).toBe("before\n");
  });

  it("an ordinary apply and revert, times untouched, still revert (control)", async () => {
    const t = await fixture();
    const applied = await t.apply();
    expect(t.f()).toBe("after!\n");
    expect(statSync(join(t.repo, "f.txt")).mtimeMs).not.toBe(Y2000 * 1000);

    const reverted = await t.revert(applied.deliveryPair!);

    expect(reverted).toMatchObject({ reverted: true });
    expect(t.f()).toBe("before\n");
  });
});

describe("apply and its check onto an edit the stat cache cannot see", () => {
  const LATER = Y2000 + 3_600;
  /** HEAD already holds the result's "after!\n"; the user then rewrote f.txt to
   * "other!\n" with the committed mtime, which `git status` calls clean. */
  async function committedThenHidden() {
    const t = await fixture();
    t.hide("after!\n", LATER);
    git(t.repo, "add", "-A");
    git(t.repo, "commit", "-qm", "the result, committed by hand");
    t.hide("other!\n", LATER);
    expect(userStatus(t.repo)).toBe("");
    return t;
  }

  it("is no idempotent 'already applied': the edit is refused and kept", async () => {
    const t = await committedThenHidden();

    const applied = await t.apply();

    expect(applied).toMatchObject({ applied: false, treeMutated: false });
    expect(applied.alreadyApplied).not.toBe(true);
    expect(t.f()).toBe("other!\n");
  });

  it("and apply/check says the same", async () => {
    const t = await committedThenHidden();

    const checked = await checkResultOnTarget(t.repo, t.delivery.result, t.repo);

    expect(checked.ok).toBe(false);
    expect(checked.alreadyApplied).not.toBe(true);
    expect(t.f()).toBe("other!\n");
  });

  it("an edit of another line of a file the result changes is merged and kept", async () => {
    const t = await fixture("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nd\ne\nf\nG\n");
    t.hide("A\nb\nc\nd\ne\nf\ng\n"); // the user's own edit, same size, same mtime

    const applied = await t.apply();

    expect(applied).toMatchObject({ applied: true, treeMutated: true });
    expect(t.f()).toBe("A\nb\nc\nd\ne\nf\nG\n");
  });

  it("a target that truly holds the result is still already applied (control)", async () => {
    const t = await committedThenHidden();
    t.hide("after!\n", LATER);

    const applied = await t.apply();
    const checked = await checkResultOnTarget(t.repo, t.delivery.result, t.repo);

    expect(applied).toMatchObject({ applied: true, treeMutated: false, alreadyApplied: true });
    expect(checked).toMatchObject({ ok: true, alreadyApplied: true });
    expect(t.f()).toBe("after!\n");
  });
});
