import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { importIntoRepository, objectStorePath, retainInObjectStore } from "./object-store.js";
import { GitOperationError } from "./git-observed.js";
import { assertSpaceFor, availableBytes, transferObjects } from "./object-transfer.js";

// A filesystem that refuses hard links (FAT/exFAT, some network mounts) must
// make the transfer stream a pack, never fail a capture. ESM namespaces cannot
// be spied, so node:fs is wrapped once for this file.
let refuseLinks = false;
// A simulated filesystem boundary (#535 r1 F4): links and renames between two
// "volumes" fail with EXDEV, as they do between real devices.
let volumeOf: ((path: string) => string) | null = null;
const crossDevice = (from: unknown, to: unknown) =>
  volumeOf !== null && volumeOf(String(from)) !== volumeOf(String(to));
const exdev = () => Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
// Unknown free space (#535 r1 F8): statfs unavailable or failing on a platform;
// and a write that really runs out of space.
let statfsFails = false;
let writeFails: string | null = null;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      if (refuseLinks) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      if (crossDevice(args[0], args[1])) throw exdev();
      return fs.linkSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (crossDevice(args[0], args[1])) throw exdev();
      return fs.renameSync(...args);
    },
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      if (statfsFails)
        throw Object.assign(new Error("function not implemented"), { code: "ENOSYS" });
      return fs.statfsSync(...args);
    },
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (writeFails)
        throw Object.assign(new Error("no space left on device"), { code: writeFails });
      return (fs.writeSync as (...rest: unknown[]) => number)(...args);
    },
  };
});
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", cwd, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();

describe("transferObjects on a filesystem without hard links", () => {
  it("streams loose objects it cannot link", async () => {
    const source = mkdtempSync(join(tmpdir(), "cx-transfer-src-"));
    const dest = mkdtempSync(join(tmpdir(), "cx-transfer-dst-"));
    dirs.push(source, dest);
    git(source, ["init", "-q", "--bare"]);
    git(dest, ["init", "-q", "--bare"]);
    const oids = ["alpha\n", "beta\n"].map((text) =>
      git(source, ["hash-object", "-w", "--stdin"], { GIT_DIR: source }, text),
    );
    refuseLinks = true;
    try {
      const moved = await transferObjects(
        { cwd: source, env: { GIT_DIR: source }, objectsDir: join(source, "objects") },
        { cwd: dest, env: { GIT_DIR: dest }, objectsDir: join(dest, "objects") },
        oids,
        20,
      );
      expect(moved).toMatchObject({ linkedPacks: 0, linkedLoose: 0, streamedObjects: 2 });
    } finally {
      refuseLinks = false;
    }
    for (const oid of oids)
      expect(git(dest, ["cat-file", "-t", oid], { GIT_DIR: dest })).toBe("blob");
  });
});

describe("transfer into a repository on another filesystem (F4)", () => {
  it("imports streamed objects from the store into a user repository on another device", async () => {
    const config = mkdtempSync(join(tmpdir(), "cx-transfer-config-"));
    const repo = mkdtempSync(join(tmpdir(), "cx-transfer-user-"));
    dirs.push(config, repo);
    const previous = process.env["CLAUDEXOR_CONFIG_DIR"];
    process.env["CLAUDEXOR_CONFIG_DIR"] = config;
    const userEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    try {
      git(repo, ["init", "-q", "-b", "main"]);
      writeFileSync(join(repo, "kept.txt"), "committed\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "base"], userEnv);
      const head = git(repo, ["rev-parse", "HEAD"]);
      // The candidate's objects exist only in a capture scratch (never in the user's repository).
      const scratch = mkdtempSync(join(tmpdir(), "cx-transfer-scratch-"));
      dirs.push(scratch);
      mkdirSync(join(scratch, "objects"));
      const env = {
        GIT_INDEX_FILE: join(scratch, "index"),
        GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects"),
      };
      git(repo, ["read-tree", "HEAD"], env);
      const blob = git(repo, ["hash-object", "-w", "--stdin"], env, "candidate bytes\n");
      git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},new.txt`], env);
      const tree = git(repo, ["write-tree"], env);
      // Claudexor's config directory (and so the project store) is one volume,
      // everything else (the user's repository, temp scratch) another.
      const storeVolume = [config, realpathSync(config)];
      volumeOf = (path) => (storeVolume.some((root) => path.startsWith(root)) ? "store" : "user");
      await retainInObjectStore({
        projectRoot: repo,
        source: { cwd: repo, env, objectsDir: join(scratch, "objects") },
        roots: [tree],
        boundary: { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) },
        objectFormat: "sha1",
        owner: repo,
      });
      rmSync(scratch, { recursive: true, force: true });
      expect(spawnSync("git", ["-C", repo, "cat-file", "-e", tree], { env: ENV }).status).not.toBe(
        0,
      );
      const imported = await importIntoRepository({ projectRoot: repo, repo, roots: [tree] });
      expect(imported.missing).toEqual([]);
      expect(imported.streamedObjects).toBeGreaterThan(0);
      expect(git(repo, ["cat-file", "-p", `${tree}:new.txt`])).toBe("candidate bytes");
      // Nothing staged for the publication is left behind on either side.
      const objects = join(repo, ".git", "objects");
      expect(readdirSync(objects).filter((name) => name.startsWith("tmp_"))).toEqual([]);
      expect(readdirSync(join(objectStorePath(repo), "claudexor", "tmp"))).toEqual([]);
    } finally {
      volumeOf = null;
      if (previous === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
      else process.env["CLAUDEXOR_CONFIG_DIR"] = previous;
    }
  });
});

describe("free space that cannot be measured (F8)", () => {
  it("is unknown, not a crash: the preflight passes and the copy proceeds", async () => {
    const source = mkdtempSync(join(tmpdir(), "cx-transfer-src-"));
    const dest = mkdtempSync(join(tmpdir(), "cx-transfer-dst-"));
    dirs.push(source, dest);
    git(source, ["init", "-q", "--bare"]);
    git(dest, ["init", "-q", "--bare"]);
    const oid = git(source, ["hash-object", "-w", "--stdin"], { GIT_DIR: source }, "gamma\n");
    statfsFails = true;
    refuseLinks = true;
    try {
      expect(availableBytes(dest)).toBeNull();
      expect(() => assertSpaceFor(dest, 1 << 30, "object copy")).not.toThrow();
      const moved = await transferObjects(
        { cwd: source, env: { GIT_DIR: source }, objectsDir: join(source, "objects") },
        { cwd: dest, env: { GIT_DIR: dest }, objectsDir: join(dest, "objects") },
        [oid],
        20,
      );
      expect(moved.streamedObjects).toBe(1);
    } finally {
      statfsFails = false;
      refuseLinks = false;
    }
    expect(git(dest, ["cat-file", "-t", oid], { GIT_DIR: dest })).toBe("blob");
  });
});

describe("a copy that really runs out of space (F8)", () => {
  it("ends as a typed space refusal, never an untyped throw", async () => {
    const source = mkdtempSync(join(tmpdir(), "cx-transfer-src-"));
    const dest = mkdtempSync(join(tmpdir(), "cx-transfer-dst-"));
    dirs.push(source, dest);
    git(source, ["init", "-q", "--bare"]);
    git(dest, ["init", "-q", "--bare"]);
    const oid = git(source, ["hash-object", "-w", "--stdin"], { GIT_DIR: source }, "delta\n");
    refuseLinks = true;
    writeFails = "ENOSPC";
    try {
      const failure = await transferObjects(
        { cwd: source, env: { GIT_DIR: source }, objectsDir: join(source, "objects") },
        { cwd: dest, env: { GIT_DIR: dest }, objectsDir: join(dest, "objects") },
        [oid],
        20,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(GitOperationError);
      expect((failure as GitOperationError).code).toBe("capture_space_insufficient");
    } finally {
      writeFails = null;
      refuseLinks = false;
    }
  });
});
