import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeOnTarget } from "./object-compose.js";
import { revertDeliveryPair } from "./object-revert.js";

// Git paths are bytes; Claudexor reads Git's `-z` output as UTF-8 and cannot pass
// other bytes in a pathspec argument. A tree entry whose name is not UTF-8 would
// reach the filesystem under the wrong name and fail its proof as a false content
// mismatch, so a delivery or revert that must address one refuses it typed, first,
// with nothing written. A name only the target changed is never addressed: it stays
// byte-opaque (#535 R3 B3). The entry exists only in Git: APFS refuses such a name.
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: Buffer) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-compose-encoding-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

function tree(dir: string, entries: { path: Buffer; content: string }[]): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-compose-encoding-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const oid = execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], {
      env: ENV,
      input: entry.content,
    })
      .toString("utf8")
      .trim();
    parts.push(Buffer.from(`100644 ${oid}\t`), entry.path, Buffer.from([0]));
  }
  git(dir, ["update-index", "-z", "--index-info"], env, Buffer.concat(parts));
  return git(dir, ["write-tree"], env);
}

const LATIN1 = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(".txt")]);

describe("a result with a tree entry whose name is not UTF-8", () => {
  it("refuses typed on the trivial path, where no record was ever parsed before", async () => {
    const dir = repo();
    const base = tree(dir, [{ path: Buffer.from("a.txt"), content: "a\n" }]);
    const candidate = tree(dir, [
      { path: Buffer.from("a.txt"), content: "a\n" },
      { path: LATIN1, content: "latin1 name\n" },
    ]);

    const composed = await composeOnTarget({ repo: dir, base, target: base, candidate });

    expect(composed).toMatchObject({ ok: false, refusal: { code: "result_path_encoding" } });
    if (composed.ok) return;
    expect(composed.refusal.message).toContain("not valid UTF-8");
    expect(composed.refusal.pathCount).toBe(1);
  });

  it("keeps a name only the target changed byte-opaque: an unrelated result composes", async () => {
    const dir = repo();
    const base = tree(dir, [{ path: LATIN1, content: "one\n" }]);
    const target = tree(dir, [{ path: LATIN1, content: "two\n" }]);
    const candidate = tree(dir, [
      { path: LATIN1, content: "one\n" },
      { path: Buffer.from("a.txt"), content: "a\n" },
    ]);

    const composed = await composeOnTarget({ repo: dir, base, target, candidate });

    expect(composed).toMatchObject({
      ok: true,
      tree: tree(dir, [
        { path: LATIN1, content: "two\n" },
        { path: Buffer.from("a.txt"), content: "a\n" },
      ]),
    });
  });

  it("refuses typed when the result changes a name the target changed too", async () => {
    const dir = repo();
    const base = tree(dir, [{ path: LATIN1, content: "one\n" }]);
    const target = tree(dir, [{ path: LATIN1, content: "two\n" }]);
    const candidate = tree(dir, [{ path: LATIN1, content: "three\n" }]);

    const composed = await composeOnTarget({ repo: dir, base, target, candidate });

    expect(composed).toMatchObject({
      ok: false,
      refusal: { code: "result_path_encoding", pathCount: 1 },
    });
  });

  it("a revert that must address such a name keeps the encoding code", async () => {
    const dir = repo();
    const pre = tree(dir, [{ path: Buffer.from("a.txt"), content: "a\n" }]);
    const post = tree(dir, [
      { path: Buffer.from("a.txt"), content: "a\n" },
      { path: LATIN1, content: "latin1 name\n" },
    ]);

    const reverted = await revertDeliveryPair({
      worktree: dir,
      pair: { pre_tree: pre, post_tree: post },
      currentTree: post,
    });

    expect(reverted).toMatchObject({
      ok: false,
      reverted: false,
      treeMutated: false,
      refusal: { code: "result_path_encoding" },
    });
  });

  it("composes a valid name that really holds U+FFFD", async () => {
    const dir = repo();
    const base = tree(dir, [{ path: Buffer.from("a.txt"), content: "a\n" }]);
    const candidate = tree(dir, [
      { path: Buffer.from("a.txt"), content: "a\n" },
      { path: Buffer.from("replacement-\uFFFD-char.txt"), content: "valid utf-8 name\n" },
    ]);

    const composed = await composeOnTarget({ repo: dir, base, target: base, candidate });

    expect(composed).toMatchObject({ ok: true, tree: candidate });
  });

  it("composes a valid non-ASCII name as before", async () => {
    const dir = repo();
    const base = tree(dir, [{ path: Buffer.from("a.txt"), content: "a\n" }]);
    const candidate = tree(dir, [
      { path: Buffer.from("a.txt"), content: "a\n" },
      { path: Buffer.from("café-日本語.txt"), content: "utf-8 name\n" },
    ]);

    const composed = await composeOnTarget({ repo: dir, base, target: base, candidate });

    expect(composed).toMatchObject({ ok: true, tree: candidate });
  });
});
