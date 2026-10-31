import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { defaultProcessIdentityService } from "@claudexor/core";
import {
  beginPendingRoots,
  endPendingRoots,
  ensureObjectStore,
  importIntoRepository,
  objectStorePath,
  pruneObjectStore,
  retainInObjectStore,
  storeEnv,
} from "./object-store.js";
import { transferObjects, type ObjectEndpoint } from "./object-transfer.js";

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
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input, maxBuffer: 1 << 26 })
    .toString("utf8")
    .trim();

function userRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-store-user-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "kept.txt"), "committed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

/** A capture-shaped scratch: candidate objects in a private object dir, the user ODB as alternate. */
function scratchCapture(
  repo: string,
  files: Record<string, string>,
): { source: ObjectEndpoint; tree: string } {
  const scratch = mkdtempSync(join(tmpdir(), "claudexor-store-scratch-"));
  dirs.push(scratch);
  const objects = join(scratch, "objects");
  mkdirSync(objects, { recursive: true });
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects"),
  };
  git(repo, ["read-tree", "HEAD"], env);
  for (const [path, content] of Object.entries(files)) {
    const oid = git(repo, ["hash-object", "-w", "--stdin"], env, content);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], env);
  }
  return { source: { cwd: repo, env, objectsDir: objects }, tree: git(repo, ["write-tree"], env) };
}

beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "claudexor-store-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});

describe("project object store (rev 12/14 D)", () => {
  it("retains a capture beyond its boundary and verifies it against the store alone", async () => {
    const repo = userRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const { source, tree } = scratchCapture(repo, {
      "big.txt": "x".repeat(200_000),
      "small.txt": "s\n",
    });
    const retained = await retainInObjectStore({
      projectRoot: repo,
      source,
      roots: [tree],
      boundary: { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) },
      objectFormat: "sha1",
      owner: repo,
    });
    const store = objectStorePath(repo);
    expect(existsSync(join(store, "objects", "info", "alternates"))).toBe(false);
    // tree + 2 new blobs; the committed blob stays the user's.
    expect(retained.objects).toBe(3);
    const check = git(
      store,
      ["cat-file", "--batch-check"],
      storeEnv(store),
      `${tree}\n${tree}:kept.txt\n`,
    );
    expect(check.split("\n")[0]).toContain(" tree ");
  });

  it("deduplicates: a second retain of the same bytes copies nothing", async () => {
    const repo = userRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const boundary = { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) };
    const first = scratchCapture(repo, { "dirty.bin": "d".repeat(50_000) });
    await retainInObjectStore({
      projectRoot: repo,
      source: first.source,
      roots: [first.tree],
      boundary,
      objectFormat: "sha1",
      owner: repo,
    });
    const second = scratchCapture(repo, { "dirty.bin": "d".repeat(50_000) });
    const again = await retainInObjectStore({
      projectRoot: repo,
      source: second.source,
      roots: [second.tree],
      boundary,
      objectFormat: "sha1",
      owner: repo,
    });
    expect(again.linkedLoose + again.linkedPacks + again.streamedObjects).toBe(0);
  });

  it("imports into the user repository after its gc --prune=now; fsck stays clean", async () => {
    const repo = userRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const boundary = { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) };
    const { source, tree } = scratchCapture(repo, { "new.txt": "candidate bytes\n" });
    await retainInObjectStore({
      projectRoot: repo,
      source,
      roots: [tree],
      boundary,
      objectFormat: "sha1",
      owner: repo,
    });
    rmSync(source.objectsDir, { recursive: true, force: true });
    git(repo, ["reflog", "expire", "--expire=now", "--all"]);
    git(repo, ["gc", "-q", "--prune=now"]);
    expect(spawnSync("git", ["-C", repo, "cat-file", "-e", tree], { env: ENV }).status).not.toBe(0);
    const imported = await importIntoRepository({ projectRoot: repo, repo, roots: [tree] });
    expect(imported.missing).toEqual([]);
    const commit = git(repo, ["commit-tree", tree, "-p", head, "-m", "result"]);
    git(repo, ["update-ref", "refs/heads/result", commit]);
    expect(spawnSync("git", ["-C", repo, "fsck", "--connectivity-only"], { env: ENV }).status).toBe(
      0,
    );
    git(repo, ["gc", "-q", "--prune=now"]);
    expect(git(repo, ["show", `result:new.txt`])).toBe("candidate bytes");
  });

  it("reports objects neither side holds instead of pretending success", async () => {
    const repo = userRepo();
    await ensureObjectStore(repo, "sha1");
    const ghost = "1".repeat(40);
    const imported = await importIntoRepository({ projectRoot: repo, repo, roots: [ghost] });
    expect(imported.missing).toEqual([ghost]);
  });

  it("prunes by reachability, keeps young objects, and yields to a live import", async () => {
    const repo = userRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const boundary = { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) };
    const live = scratchCapture(repo, { "live.txt": "keep me\n" });
    const dead = scratchCapture(repo, { "dead.txt": "drop me\n" });
    const liveOwner = mkdtempSync(join(tmpdir(), "claudexor-store-owner-"));
    const deadOwner = mkdtempSync(join(tmpdir(), "claudexor-store-owner-"));
    dirs.push(liveOwner, deadOwner);
    for (const [capture, owner] of [
      [live, liveOwner],
      [dead, deadOwner],
    ] as const)
      await retainInObjectStore({
        projectRoot: repo,
        source: capture.source,
        roots: [capture.tree],
        boundary,
        objectFormat: "sha1",
        owner,
      });
    // The dead run's directory is deleted by retention: its root record dies with it.
    rmSync(deadOwner, { recursive: true, force: true });
    const store = objectStorePath(repo);
    // Young objects survive any prune.
    let pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.freedBytes).toBe(0);
    // Age every object past the grace window.
    const old = new Date(Date.now() - 3_600_000);
    const objects = join(store, "objects");
    for (const fan of readdirSync(objects).filter((entry) => /^[0-9a-f]{2}$/.test(entry)))
      for (const name of readdirSync(join(objects, fan)))
        utimesSync(join(objects, fan, name), old, old);
    const pending = await beginPendingRoots(store, [dead.tree]);
    pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(true);
    endPendingRoots(pending);
    pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(false);
    expect(pass.freedBytes).toBeGreaterThan(0);
    const env = storeEnv(store);
    expect(git(store, ["cat-file", "-t", live.tree], env)).toBe("tree");
    expect(
      spawnSync("git", ["-C", store, "cat-file", "-e", dead.tree], { env: { ...ENV, ...env } })
        .status,
    ).not.toBe(0);
  });

  it("streams a wanted subset of a pack (bounded memory) when the pack cannot be adopted whole", async () => {
    const repo = userRepo();
    const blobs = ["one", "two", "three"].map((name) => {
      writeFileSync(join(repo, `${name}.txt`), `${name} `.repeat(50_000));
      return name;
    });
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "packed"]);
    git(repo, ["gc", "-q"]);
    const wanted = git(repo, ["rev-parse", "HEAD:two.txt"]);
    const dest = mkdtempSync(join(tmpdir(), "claudexor-store-dest-"));
    dirs.push(dest);
    git(dest, ["init", "-q", "--bare"]);
    const moved = await transferObjects(
      { cwd: repo, env: {}, objectsDir: join(repo, ".git", "objects") },
      { cwd: dest, env: { GIT_DIR: dest }, objectsDir: join(dest, "objects") },
      [wanted],
      20,
    );
    expect(blobs).toHaveLength(3);
    expect(moved).toMatchObject({ linkedPacks: 0, linkedLoose: 0, streamedObjects: 1 });
    expect(git(dest, ["cat-file", "-t", wanted], { GIT_DIR: dest })).toBe("blob");
    // Only the wanted object travelled; the rest of the pack stayed behind.
    const unwanted = git(repo, ["rev-parse", "HEAD:one.txt"]);
    expect(
      spawnSync("git", ["-C", dest, "cat-file", "-e", unwanted], { env: { ...ENV, GIT_DIR: dest } })
        .status,
    ).not.toBe(0);
  });

  it("adopts a capture's big-blob pack by hard link instead of copying it", async () => {
    const repo = userRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const scratch = mkdtempSync(join(tmpdir(), "claudexor-store-pack-"));
    dirs.push(scratch);
    const objects = join(scratch, "objects");
    mkdirSync(objects, { recursive: true });
    const env = {
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects"),
    };
    writeFileSync(join(repo, "huge.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
    git(repo, ["read-tree", "HEAD"], env);
    // core.bigFileThreshold below the file size makes `add` stream it into a pack (bulk checkin).
    git(repo, ["-c", "core.bigFileThreshold=1m", "add", "huge.bin"], env);
    const tree = git(repo, ["write-tree"], env);
    rmSync(join(repo, "huge.bin"));
    const packs = readdirSync(join(objects, "pack")).filter((name) => name.endsWith(".pack"));
    expect(packs.length).toBe(1);
    const retained = await retainInObjectStore({
      projectRoot: repo,
      source: { cwd: repo, env, objectsDir: objects },
      roots: [tree],
      boundary: { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) },
      objectFormat: "sha1",
      owner: repo,
    });
    expect(retained.linkedPacks).toBe(1);
    expect(statSync(join(objects, "pack", packs[0]!)).nlink).toBe(2);
  });
});

// #535 repair r1 (F1, F2): custody of live imports and the prune lock.
describe("pending custody and the prune lock under concurrency", () => {
  const hour = 3_600_000;
  function age(path: string, ms: number) {
    const then = new Date(Date.now() - ms);
    utimesSync(path, then, then);
  }
  /** A store whose only content is an old capture no root record keeps any more. */
  async function storeWithUnreferencedCapture() {
    const repo = userRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    const boundary = { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) };
    const capture = scratchCapture(repo, { "old.txt": "found present by an import\n" });
    const owner = mkdtempSync(join(tmpdir(), "claudexor-store-owner-"));
    await retainInObjectStore({
      projectRoot: repo,
      source: capture.source,
      roots: [capture.tree],
      boundary,
      objectFormat: "sha1",
      owner,
    });
    rmSync(owner, { recursive: true, force: true });
    const store = objectStorePath(repo);
    const objects = join(store, "objects");
    for (const fan of readdirSync(objects).filter((entry) => /^[0-9a-f]{2}$/.test(entry)))
      for (const name of readdirSync(join(objects, fan))) age(join(objects, fan, name), 3 * hour);
    return { store, tree: capture.tree };
  }
  const present = (store: string, oid: string) =>
    spawnSync("git", ["-C", store, "cat-file", "-e", oid], {
      env: { ...ENV, ...storeEnv(store) },
    }).status === 0;
  const pendingDir = (store: string) => join(store, "claudexor", "pending");
  function writePending(store: string, record: Record<string, unknown>, ageMs: number): string {
    const path = join(pendingDir(store), `${String(record["pid"])}-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify({ created_at: new Date().toISOString(), ...record }));
    age(path, ageMs);
    return path;
  }
  /** This process's PID with another process's kernel birth (a reused PID). */
  function reusedPidIdentity(): Record<string, unknown> | null {
    const self = defaultProcessIdentityService.self();
    if (self.status !== "known") return null;
    const startToken = self.platform === "darwin" ? "darwin:1:000001" : "linux:1";
    return { ...self, startToken };
  }
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    return Number(child.stdout.toString("utf8"));
  }

  it("keeps a live import's custody past any age while its process lives (F1)", async () => {
    const { store, tree } = await storeWithUnreferencedCapture();
    // An import found `tree` present and skipped it; it has been progressing for two hours.
    const pending = await beginPendingRoots(store, [tree]);
    try {
      age(pending.path, 2 * hour);
      const pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
      expect(pass).toMatchObject({ yielded: true, freedBytes: 0 });
      expect(existsSync(pending.path)).toBe(true);
      expect(present(store, tree)).toBe(true);
    } finally {
      endPendingRoots(pending);
    }
    // Once the import ends, the unreferenced objects are reclaimable again.
    const pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(false);
    expect(present(store, tree)).toBe(false);
  });

  it("reclaims custody of a dead owner and of a reused PID (F1)", async () => {
    const reused = reusedPidIdentity();
    if (!reused) return; // no kernel birth identity on this platform: nothing to compare
    const { store, tree } = await storeWithUnreferencedCapture();
    const dead = writePending(store, { pid: deadPid(), roots: [tree] }, 30 * 60_000);
    const impostor = writePending(
      store,
      { pid: process.pid, identity: reused, roots: [tree] },
      30 * 60_000,
    );
    const pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(impostor)).toBe(false);
    expect(present(store, tree)).toBe(false);
  });

  it("treats a prune lock still being created as held, and reaps an abandoned one (F2)", async () => {
    const { store, tree } = await storeWithUnreferencedCapture();
    const lock = join(store, "claudexor", "prune.lock");
    // A racing pruner between creating the lock and naming itself in it.
    mkdirSync(lock);
    let pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(present(store, tree)).toBe(true);
    // An ownerless lock left long ago is debris and must not block pruning forever.
    age(lock, hour);
    pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(present(store, tree)).toBe(false);
  });

  it("reaps a prune lock whose PID now names another process (F2)", async () => {
    const reused = reusedPidIdentity();
    if (!reused) return;
    const { store, tree } = await storeWithUnreferencedCapture();
    const lock = join(store, "claudexor", "prune.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, identity: reused }));
    const pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    expect(pass.yielded).toBe(false);
    expect(present(store, tree)).toBe(false);
  });

  it("an import waits for a prune lock that is still being created (F2)", async () => {
    const { store } = await storeWithUnreferencedCapture();
    const lock = join(store, "claudexor", "prune.lock");
    mkdirSync(lock);
    const started = Date.now();
    const released = setTimeout(() => rmSync(lock, { recursive: true, force: true }), 500);
    try {
      const pending = await beginPendingRoots(store, []);
      expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      endPendingRoots(pending);
    } finally {
      clearTimeout(released);
    }
  });
});
