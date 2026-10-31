import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeOnTarget, parseRawRecords } from "./object-compose.js";
import { materializeTree } from "./object-materialize.js";
import { revertDeliveryPair } from "./object-revert.js";

const dirs: string[] = [];
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

function git(
  repo: string,
  args: string[],
  input?: string | Buffer,
  env: Record<string, string> = {},
) {
  return execFileSync("git", ["-C", repo, ...args], {
    env: { ...ENV, ...env },
    input,
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
}

type Files = Record<
  string,
  string | Buffer | null | { link: string } | { mode: "755"; text: string }
>;

function repo(config: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-compose-test-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [key, value] of Object.entries(config)) git(dir, ["config", key, value]);
  return dir;
}

/** Write a tree from a file map through a scratch index; returns the tree oid. */
function tree(dir: string, files: Files): string {
  const index = join(dir, ".git", `idx-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    let mode = "100644";
    let bytes: string | Buffer;
    if (typeof content === "object" && !Buffer.isBuffer(content) && "link" in content) {
      mode = "120000";
      bytes = content.link;
    } else if (typeof content === "object" && !Buffer.isBuffer(content) && "mode" in content) {
      mode = "100755";
      bytes = content.text;
    } else bytes = content as string | Buffer;
    const oid = git(dir, ["hash-object", "-w", "--stdin"], bytes).trim();
    git(dir, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`], undefined, env);
  }
  const oid = git(dir, ["write-tree"], undefined, env).trim();
  rmSync(index, { force: true });
  return oid;
}

/** Today's delivery of this result: the whole patch applied onto T by git apply rules. */
function today(dir: string, base: string, target: string, candidate: string) {
  const patch = execFileSync("git", ["-C", dir, "diff", "--binary", base, candidate], {
    env: ENV,
    maxBuffer: 256 * 1024 * 1024,
  });
  const index = join(dir, ".git", `today-${Math.random().toString(16).slice(2)}`);
  const env = { ...ENV, GIT_INDEX_FILE: index };
  execFileSync("git", ["-C", dir, "read-tree", target], { env });
  const applied = spawnSync("git", ["-C", dir, "apply", "--cached", "--whitespace=nowarn", "-"], {
    env,
    input: patch,
  });
  const result =
    applied.status === 0
      ? {
          ok: true as const,
          tree: execFileSync("git", ["-C", dir, "write-tree"], { env }).toString().trim(),
        }
      : { ok: false as const, tree: null };
  rmSync(index, { force: true });
  return result;
}

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from(
    { length: n },
    (_, i) => `${edit[i + 1] ?? `line ${i + 1} of a plain text file`}\n`,
  ).join("");

async function both(dir: string, b: Files, t: Files, c: Files) {
  const base = tree(dir, b);
  const target = tree(dir, t);
  const candidate = tree(dir, c);
  const ours = await composeOnTarget({ repo: dir, base, target, candidate });
  return { base, target, candidate, ours, today: today(dir, base, target, candidate) };
}

describe("composeOnTarget (rev 14 A) against today's whole-patch apply", () => {
  it("keeps an unrelated target change without discovery (gate closed)", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { a: "a\n", b: "b\n" },
      { a: "a2\n", b: "b\n" },
      { a: "a\n", b: "b2\n" },
    );
    expect(r.ours.ok).toBe(true);
    expect(r.ours.stats.discovery).toBe(false);
    expect(r.today.ok).toBe(true);
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
  });

  it("applies a both-sides text change by context rules (offsets allowed)", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { f: lines(200) },
      { f: lines(200, { 10: "target edit" }) },
      { f: lines(200, { 150: "candidate edit" }) },
    );
    expect(r.today.ok).toBe(true);
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
    expect(r.ours.stats.discovery).toBe(true);
  });

  it("refuses an overlapping both-sides change like today, with the path list", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { f: lines(20), g: "g\n" },
      { f: lines(20, { 5: "target" }), g: "g\n" },
      { f: lines(20, { 5: "candidate" }), g: "g2\n" },
    );
    expect(r.today.ok).toBe(false);
    expect(r.ours.ok).toBe(false);
    if (!r.ours.ok) {
      expect(r.ours.refusal.code).toBe("delivery_conflict");
      expect(r.ours.refusal.paths).toEqual(["f"]);
    }
  });

  it("accepts an identical outcome on both sides (the one deliberate difference)", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { f: "x\n", g: "g\n" },
      { f: "y\n", g: "g\n" },
      { f: "y\n", g: "g2\n" },
    );
    expect(r.today.ok).toBe(false);
    expect(r.ours.ok).toBe(true);
    expect(git(dir, ["ls-tree", r.ours.ok ? r.ours.tree : "", "f"]).trim()).toContain(
      git(dir, ["hash-object", "--stdin"], "y\n").trim(),
    );
  });

  it("carries a target edit through a pure rename of a text file", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { "old.txt": lines(50) },
      { "old.txt": lines(50, { 25: "target edit" }) },
      { "new.txt": lines(50) },
    );
    expect(r.today.ok).toBe(true);
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
    expect(r.ours.stats.components).toBe(1);
  });

  it("carries a target edit through a pure rename of a binary file", async () => {
    const dir = repo();
    const bin = (n: number) => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * n) % 251));
    const r = await both(dir, { "a.bin": bin(7) }, { "a.bin": bin(11) }, { "b.bin": bin(7) });
    expect(r.today.ok).toBe(true);
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
  });

  it("refuses a rename whose source the target deleted, like today", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { old: lines(30), k: "k\n" },
      { k: "k\n" },
      { new: lines(30), k: "k\n" },
    );
    expect(r.today.ok).toBe(false);
    expect(r.ours.ok).toBe(false);
  });

  it("refuses a both-sides binary change and modify/delete, accepts identical add/add", async () => {
    const dir = repo();
    const binary = await both(
      dir,
      { b: Buffer.from([0, 1, 2, 3]) },
      { b: Buffer.from([0, 9, 2, 3]) },
      { b: Buffer.from([0, 1, 7, 3]) },
    );
    expect(binary.today.ok).toBe(false);
    expect(binary.ours.ok).toBe(false);
    const modDel = await both(dir, { m: "m\n" }, { m: "m2\n" }, {});
    expect(modDel.today.ok).toBe(false);
    expect(modDel.ours.ok).toBe(false);
    const addAdd = await both(
      dir,
      { k: "k\n" },
      { k: "k\n", n: "same\n" },
      { k: "k\n", n: "same\n" },
    );
    expect(addAdd.ours.ok).toBe(true);
    const addAddDifferent = await both(
      dir,
      { k: "k\n" },
      { k: "k\n", n: "one\n" },
      { k: "k\n", n: "two\n" },
    );
    expect(addAddDifferent.today.ok).toBe(false);
    expect(addAddDifferent.ours.ok).toBe(false);
  });

  it("copies under diff.renames=copies carry a target-edited source (Astra's fixture)", async () => {
    const dir = repo({ "diff.renames": "copies" });
    const src = lines(100);
    const r = await both(
      dir,
      { "source.txt": src },
      { "source.txt": lines(100, { 50: "target edit line 50" }) },
      { "source.txt": lines(100, { 90: "candidate edit" }), "copy.txt": src },
    );
    const raw = parseRawRecords(
      git(dir, ["diff", "--raw", "-z", "--no-abbrev", r.base, r.candidate]),
    );
    expect(raw.map((record) => record.status).sort()).toEqual(["C", "M"]);
    expect(r.today.ok).toBe(true);
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
  });

  it("a rename and a copy of one deleted source stay one component", async () => {
    const dir = repo({ "diff.renames": "copies" });
    const src = lines(60);
    const r = await both(dir, { a: src }, { a: lines(60, { 30: "target" }) }, { b: src, c: src });
    expect(r.today.ok).toBe(true);
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
    expect(r.ours.stats.components).toBe(1);
  });

  it("a copy the target did not touch needs no record (U empty)", async () => {
    const dir = repo({ "diff.renames": "copies" });
    const src = lines(40);
    const r = await both(
      dir,
      { s: src, x: "x\n" },
      { s: src, x: "x2\n" },
      { s: lines(40, { 3: "c" }), copy: src, x: "x\n" },
    );
    expect(r.ours.ok && r.ours.tree).toBe(r.today.tree);
    expect(r.ours.stats.discovery).toBe(false);
  });

  it("a file/directory collision gives today's tree or today's refusal", async () => {
    const dir = repo();
    const r = await both(
      dir,
      { k: "k\n" },
      { k: "k\n", p: "file\n" },
      { k: "k\n", "p/child": "c\n" },
    );
    expect(r.ours.ok).toBe(r.today.ok);
    if (r.ours.ok && r.today.ok) expect(r.ours.tree).toBe(r.today.tree);
  });

  it("keeps non-UTF-8 content byte for byte", async () => {
    const dir = repo();
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0xfe, 0x0a]);
    const r = await both(
      dir,
      { t: lines(30), l: Buffer.from("x\n") },
      { t: lines(30, { 2: "t" }), l: Buffer.from("x\n") },
      { t: lines(30, { 28: "c" }), l: latin1 },
    );
    expect(r.ours.ok).toBe(true);
    if (r.ours.ok) {
      const blob = execFileSync("git", ["-C", dir, "cat-file", "blob", `${r.ours.tree}:l`], {
        env: ENV,
      });
      expect(Buffer.compare(blob, latin1)).toBe(0);
      expect(r.ours.tree).toBe(r.today.tree);
    }
  });

  it("pinned format settings make hostile diff configs harmless", async () => {
    const dir = repo({
      "diff.noprefix": "true",
      "diff.mnemonicPrefix": "true",
      "color.diff": "always",
      "color.ui": "always",
      "diff.relative": "true",
      "diff.submodule": "diff",
      "diff.suppressBlankEmpty": "true",
    });
    const r = await both(
      dir,
      { f: lines(40, { 20: "" }) },
      { f: lines(40, { 2: "t", 20: "" }) },
      { f: lines(40, { 20: "", 38: "c" }) },
    );
    expect(r.ours.ok).toBe(true);
  });

  it("the gate opens for a shared path and stays closed for unrelated large pairs", async () => {
    const dir = repo();
    const blob = (seed: number) =>
      Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * seed + 13) % 256));
    const closed = await both(
      dir,
      { "old.bin": blob(3), small: "s\n", other: "o\n" },
      { "old.bin": blob(3), small: "s\n", other: "o2\n" },
      { "new.bin": blob(5), small: "s2\n", other: "o\n" },
    );
    expect(closed.ours.stats.discovery).toBe(false);
    expect(closed.ours.ok && closed.ours.tree).toBe(closed.today.tree);
    const open = await both(
      dir,
      { "old.bin": blob(3), small: lines(10) },
      { "old.bin": blob(3), small: lines(10, { 1: "t" }) },
      { "new.bin": blob(5), small: lines(10, { 9: "c" }) },
    );
    expect(open.ours.stats.discovery).toBe(true);
    expect(open.ours.ok).toBe(open.today.ok);
    if (open.ours.ok) expect(open.ours.tree).toBe(open.today.tree);
  });
});

describe("materializeTree (rev 11 C) and revertDeliveryPair (rev 12 B)", () => {
  function worktree(files: Files): { dir: string; head: string } {
    const dir = repo();
    for (const [path, content] of Object.entries(files)) {
      if (content === null) continue;
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content as string);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base"]);
    return { dir, head: git(dir, ["rev-parse", "HEAD^{tree}"]).trim() };
  }

  it("writes M over T, leaves the real index untouched and proves content", async () => {
    const { dir, head } = worktree({ a: "a\n", b: "b\n", "d/c": "c\n" });
    const m = tree(dir, { a: "a2\n", "d/c": "c\n", n: "new\n" });
    const indexBefore = readFileSync(join(dir, ".git", "index"));
    const result = await materializeTree({ worktree: dir, from: head, to: m, index: "temporary" });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("a2\n");
    expect(existsSync(join(dir, "b"))).toBe(false);
    expect(readFileSync(join(dir, "n"), "utf8")).toBe("new\n");
    expect(Buffer.compare(readFileSync(join(dir, ".git", "index")), indexBefore)).toBe(0);
  });

  it("refuses when a path it must write changed since T (live preimage recheck)", async () => {
    const { dir, head } = worktree({ a: "a\n", b: "b\n" });
    writeFileSync(join(dir, "a"), "user edit\n");
    const m = tree(dir, { a: "a2\n", b: "b\n" });
    const result = await materializeTree({ worktree: dir, from: head, to: m, index: "temporary" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("delivery_target_changed");
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("user edit\n");
  });

  it("reverts on the delivery pair and keeps later changes", async () => {
    const { dir, head } = worktree({ f: lines(80), g: "g\n", h: "h\n" });
    const m = tree(dir, { f: lines(80, { 70: "delivered" }), g: "g2\n", h: "h\n" });
    expect(
      (await materializeTree({ worktree: dir, from: head, to: m, index: "temporary" })).ok,
    ).toBe(true);
    // A later user change inside a delivered file (far from the hunk) and in an untouched file.
    writeFileSync(join(dir, "f"), lines(80, { 5: "later user edit", 70: "delivered" }));
    writeFileSync(join(dir, "h"), "h later\n");
    const current = tree(dir, {
      f: lines(80, { 5: "later user edit", 70: "delivered" }),
      g: "g2\n",
      h: "h later\n",
    });
    const reverted = await revertDeliveryPair({
      worktree: dir,
      pair: { pre_tree: head, post_tree: m },
      currentTree: current,
    });
    expect(reverted.ok).toBe(true);
    expect(readFileSync(join(dir, "f"), "utf8")).toBe(lines(80, { 5: "later user edit" }));
    expect(readFileSync(join(dir, "g"), "utf8")).toBe("g\n");
    expect(readFileSync(join(dir, "h"), "utf8")).toBe("h later\n");
  });

  it("refuses a revert over an overlapping later edit and writes nothing", async () => {
    const { dir, head } = worktree({ f: lines(20) });
    const m = tree(dir, { f: lines(20, { 10: "delivered" }) });
    expect(
      (await materializeTree({ worktree: dir, from: head, to: m, index: "temporary" })).ok,
    ).toBe(true);
    writeFileSync(join(dir, "f"), lines(20, { 10: "user rewrote the delivered line" }));
    const current = tree(dir, { f: lines(20, { 10: "user rewrote the delivered line" }) });
    const reverted = await revertDeliveryPair({
      worktree: dir,
      pair: { pre_tree: head, post_tree: m },
      currentTree: current,
    });
    expect(reverted.ok).toBe(false);
    expect(readFileSync(join(dir, "f"), "utf8")).toBe(
      lines(20, { 10: "user rewrote the delivered line" }),
    );
  });
});
