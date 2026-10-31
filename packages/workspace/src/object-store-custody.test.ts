import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { controlDir, livePendingRecords } from "./object-store-leases.js";
import { retainedPairOf } from "./object-store-roots.js";
import {
  ensureObjectStore,
  liveRootRecords,
  pruneObjectStore,
  storeEnv,
  writeRootRecord,
} from "./object-store.js";
import { transferObjects } from "./object-transfer.js";

// Custody of the project store. A root record appears whole or not at all: one
// torn by a crash or a full disk would refuse every later prune of the project.
// ESM namespaces cannot be spied, so node:fs is wrapped once for this file.
let tearNextWrite: string | null = null;
const readSizes: number[] = [];
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const [path, data] = args;
      if (tearNextWrite && String(path).includes(tearNextWrite)) {
        tearNextWrite = null;
        // What a crash or ENOSPC leaves: the first half of the record, then nothing.
        fs.writeFileSync(path, String(data).slice(0, String(data).length >> 1));
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return fs.writeFileSync(...args);
    },
    readSync: (...args: unknown[]) => {
      if (typeof args[3] === "number") readSizes.push(args[3]);
      return (fs.readSync as (...rest: unknown[]) => number)(...args);
    },
  };
});

const dirs: string[] = [];
const configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
afterEach(() => {
  tearNextWrite = null;
  process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
});
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", cwd, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();

async function emptyStore(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "cx-custody-"));
  dirs.push(root);
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const project = join(root, "project");
  mkdirSync(project);
  git(project, ["init", "-q", "-b", "main"]);
  return (await ensureObjectStore(project)).store;
}

describe("a root record", () => {
  it("that was torn while being written leaves no record, and pruning goes on", async () => {
    const store = await emptyStore();
    const owner = mkdtempSync(join(tmpdir(), "cx-custody-owner-"));
    dirs.push(owner);
    tearNextWrite = ".json";

    expect(() => writeRootRecord(store, owner, ["a".repeat(40)])).toThrow(/no space/);

    expect(readdirSync(controlDir(store, "roots"))).toEqual([]);
    expect(() => liveRootRecords(store)).not.toThrow();
    await expect(pruneObjectStore({ store, graceMs: 0, objectFormat: "sha1" })).resolves.toEqual({
      freedBytes: 0,
      yielded: false,
    });
  });

  it("is complete at its final name when it appears", async () => {
    const store = await emptyStore();
    const owner = mkdtempSync(join(tmpdir(), "cx-custody-owner-"));
    dirs.push(owner);

    const path = writeRootRecord(store, owner, ["a".repeat(40)]);

    expect(path.startsWith(controlDir(store, "roots"))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      owner,
      roots: ["a".repeat(40)],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(controlDir(store, "tmp")).filter((name) => name.includes("root"))).toEqual(
      [],
    );
    expect(liveRootRecords(store)).toEqual(["a".repeat(40)]);
  });

  it("that is whole yet unreadable still refuses pruning: custody is never treated as absent", async () => {
    const store = await emptyStore();
    writeFileSync(join(controlDir(store, "roots"), "broken.json"), "{");
    expect(() => liveRootRecords(store)).toThrow(/unreadable; pruning refused/);
  });

  // #535 R4 class audit: only ENOENT and ENOTDIR say an owner is gone. An owner under
  // a directory that cannot be searched read as gone, so its record was removed and a
  // prune could delete the objects a live run's revert needs.
  it("whose owner cannot be looked at keeps its roots and its record", async () => {
    const store = await emptyStore();
    const parent = mkdtempSync(join(tmpdir(), "cx-custody-locked-"));
    dirs.push(parent);
    const owner = join(parent, "run");
    mkdirSync(owner);
    writeRootRecord(store, owner, ["a".repeat(40)]);
    chmodSync(parent, 0o000);
    let roots: string[];
    try {
      roots = liveRootRecords(store);
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(roots).toEqual(["a".repeat(40)]);
    expect(readdirSync(controlDir(store, "roots"))).toHaveLength(1);
  });

  // #535 R5 E1: an unreadable record directory is no evidence of no custody. Every
  // reader of the control directories read one it could not search as empty, so a
  // prune could delete roots a live record names and a replay lost its pair.
  it("in a control directory that cannot be searched is never read as absent", async () => {
    const store = await emptyStore();
    const owner = mkdtempSync(join(tmpdir(), "cx-custody-owner-"));
    dirs.push(owner);
    writeRootRecord(store, owner, ["a".repeat(40)]);
    mkdirSync(controlDir(store, "pending"), { recursive: true });
    chmodSync(join(store, "claudexor"), 0o000);
    const answers: unknown[] = [];
    try {
      for (const read of [
        () => liveRootRecords(store),
        () => livePendingRecords(store, 0),
        () => retainedPairOf(store, owner, "b".repeat(40)),
      ])
        try {
          answers.push(read());
        } catch (error) {
          answers.push((error as NodeJS.ErrnoException).code);
        }
    } finally {
      chmodSync(join(store, "claudexor"), 0o755);
    }
    expect(answers).toEqual(["EACCES", "EACCES", "EACCES"]);
    expect(liveRootRecords(store)).toEqual(["a".repeat(40)]);
  });

  it("whose owner is gone is dropped (the control)", async () => {
    const store = await emptyStore();
    const owner = join(mkdtempSync(join(tmpdir(), "cx-custody-gone-")), "run");
    dirs.push(join(owner, ".."));
    writeRootRecord(store, owner, ["a".repeat(40)]);
    expect(liveRootRecords(store)).toEqual([]);
    expect(readdirSync(controlDir(store, "roots"))).toHaveLength(0);
  });
});

describe("the prune walk", () => {
  it("yields to the event loop over many loose objects", async () => {
    const store = await emptyStore();
    const objects = join(store, "objects");
    // Plain files named like loose objects: the walk reads their names and ages only.
    const old = new Date(Date.now() - 3_600_000);
    for (let at = 0; at < 12_000; at += 1) {
      const hex = at.toString(16).padStart(40, "0");
      mkdirSync(join(objects, hex.slice(0, 2)), { recursive: true });
      writeFileSync(join(objects, hex.slice(0, 2), hex.slice(2)), "");
      if (at % 4096 === 0) utimesSync(join(objects, hex.slice(0, 2), hex.slice(2)), old, old);
    }
    let turns = 0;
    let running = true;
    const tick = () => {
      turns += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);

    const pruned = await pruneObjectStore({
      store,
      graceMs: 60_000,
      dryRun: true,
      objectFormat: "sha1",
    });
    running = false;

    expect(pruned.yielded).toBe(false);
    expect(turns).toBeGreaterThanOrEqual(4);
  });

  it("deletes what it deleted before: the yields change no outcome", async () => {
    const store = await emptyStore();
    const objects = join(store, "objects");
    const hex = "ab" + "c".repeat(38);
    mkdirSync(join(objects, "ab"), { recursive: true });
    writeFileSync(join(objects, "ab", hex.slice(2)), "zzzz");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(objects, "ab", hex.slice(2)), old, old);

    const pruned = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });

    expect(pruned).toEqual({ freedBytes: 4, yielded: false });
    expect(existsSync(join(objects, "ab"))).toBe(false);
  });
});

describe("adopting whole packs", () => {
  it("compares a pack's count before reading its member ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-custody-fanout-"));
    dirs.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination.git");
    mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    const oids: string[] = [];
    for (let at = 0; at < 200; at += 1) {
      writeFileSync(join(source, `f${at}.txt`), `content ${at}\n`);
      oids.push(git(source, ["hash-object", "-w", `f${at}.txt`]));
    }
    git(source, ["add", "-A"]);
    git(source, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "c"]);
    git(source, ["repack", "-adq"]);
    expect(git(source, ["count-objects", "-v"])).toMatch(/in-pack: 20[0-9]/);
    git(root, ["init", "-q", "--bare", destination]);
    readSizes.length = 0;

    const moved = await transferObjects(
      {
        cwd: source,
        env: {},
        objectsDir: join(source, ".git/objects"),
      },
      {
        cwd: destination,
        env: storeEnv(destination),
        objectsDir: join(destination, "objects"),
      },
      oids.slice(0, 3),
      20,
    );

    expect(moved.linkedPacks).toBe(0);
    expect(moved.streamedObjects).toBe(3);
    // Only the fixed header was read: 4 KiB chunks of ids hold 80 KiB and never came.
    expect(readSizes.every((size) => size <= 8 + 256 * 4)).toBe(true);
  });

  it("still adopts a pack whose every object is wanted", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-custody-fanout-"));
    dirs.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination.git");
    mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    writeFileSync(join(source, "one.txt"), "one\n");
    git(source, ["add", "-A"]);
    git(source, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "c"]);
    git(source, ["repack", "-adq"]);
    const listed = git(source, ["rev-list", "--objects", "--all"])
      .split("\n")
      .map((line) => line.split(" ")[0]!);
    git(root, ["init", "-q", "--bare", destination]);

    const moved = await transferObjects(
      { cwd: source, env: {}, objectsDir: join(source, ".git/objects") },
      {
        cwd: destination,
        env: storeEnv(destination),
        objectsDir: join(destination, "objects"),
      },
      listed,
      20,
    );

    expect(moved.linkedPacks).toBe(1);
    expect(moved.streamedObjects).toBe(0);
  });
});
