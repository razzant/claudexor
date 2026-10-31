import child, { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkingTreeTransient,
  objectStorePath,
  pruneObjectStore,
} from "@claudexor/workspace";
import { checkResultOnTarget } from "./object-check.js";

// An apply/check mounts the project store as an alternate and snapshots a dirty
// target through it. Git writes no object it finds there, so without the store's
// pending lease a scheduled prune can delete a blob the snapshot just relied on,
// and the check refuses a valid result. Real Git, real prune: the check's own
// write-tree waits for the prune that has to run right before it.
const roots: string[] = [];
const originalSpawn = child.spawn;
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
});
afterEach(() => {
  child.spawn = originalSpawn;
  syncBuiltinESMExports();
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

function stage() {
  const root = mkdtempSync(join(tmpdir(), "cx-check-lease-"));
  roots.push(root);
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const user = join(root, "repo");
  const liveOwner = join(root, "live-run");
  const deadOwner = join(root, "dead-run");
  for (const dir of [user, liveOwner, deadOwner]) mkdirSync(dir);
  git(user, ["init", "-q", "-b", "main"]);
  writeFileSync(join(user, "f.txt"), "before\n");
  git(user, ["add", "-A"]);
  git(user, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"]);
  // Above this size `git add` reuses an object it finds without touching its mtime.
  git(user, ["config", "core.bigFileThreshold", "1k"]);
  return { root, user, liveOwner, deadOwner };
}

/** Age every object of `store` past the prune's grace window. */
function ageObjects(store: string): void {
  const old = new Date(Date.now() - 3 * 3_600_000);
  const objects = join(store, "objects");
  for (const name of readdirSync(objects)) {
    if (name !== "pack" && !/^[0-9a-f]{2}$/.test(name)) continue;
    for (const file of readdirSync(join(objects, name)))
      utimesSync(join(objects, name, file), old, old);
  }
}

/**
 * Run `during` the moment the check's snapshot write-tree is about to start: the
 * child waits for it (delayed by one small Node parent), as a daemon timer can land
 * between the awaited Git steps. The only seam: dist code calls node's own spawn.
 */
function aroundSnapshotWriteTree(root: string, during: () => Promise<unknown>) {
  const released = join(root, "released");
  let done: Promise<unknown> | undefined;
  const waiter = `const fs=require('node:fs'),cp=require('node:child_process');const wait=setInterval(()=>{if(!fs.existsSync(process.argv[1]))return;clearInterval(wait);cp.spawn(process.argv[2],JSON.parse(process.argv[3]),{stdio:'inherit'}).on('exit',(code)=>process.exit(code??1));},5);`;
  child.spawn = function (this: unknown, command: string, args: string[], options: never) {
    const env = (options as { env?: Record<string, string> }).env;
    if (
      !done &&
      args.includes("write-tree") &&
      env?.["GIT_OBJECT_DIRECTORY"]?.includes("claudexor-result-check-")
    ) {
      const delayed = originalSpawn.call(
        this,
        process.execPath,
        ["-e", waiter, released, command, JSON.stringify(args)],
        options,
      );
      done = during().finally(() => writeFileSync(released, ""));
      return delayed;
    }
    return originalSpawn.call(this, command, args, options);
  } as typeof child.spawn;
  syncBuiltinESMExports();
  return { settled: () => done };
}

describe.skipIf(process.platform === "win32")("apply/check and the project store", () => {
  it("a prune during the check's dirty snapshot yields, and the check passes", async () => {
    const { root, user, liveOwner, deadOwner } = stage();
    const bytes = Buffer.alloc(10_000, 1);
    writeFileSync(join(user, "x.bin"), bytes);
    const dead = await captureWorkingTreeTransient(user, "HEAD", [], { owner: deadOwner });
    rmSync(join(user, "x.bin"));
    writeFileSync(join(user, "f.txt"), "candidate\n");
    const live = await captureWorkingTreeTransient(user, "HEAD", [], { owner: liveOwner });
    expect(dead.result && live.result).toBeTruthy();
    // The dead run's custody is gone, while the user holds the same bytes again.
    rmSync(deadOwner, { recursive: true });
    writeFileSync(join(user, "f.txt"), "before\n");
    writeFileSync(join(user, "x.bin"), bytes);
    const store = objectStorePath(user);
    ageObjects(store);

    let pruned: unknown;
    const seam = aroundSnapshotWriteTree(root, async () => {
      pruned = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
    });

    const outcome = await checkResultOnTarget(user, live.result!);
    await seam.settled();

    expect(pruned).toEqual({ freedBytes: 0, yielded: true });
    expect(outcome).toMatchObject({ ok: true, code: 0 });
    expect(readFileSync(join(user, "x.bin")).equals(bytes)).toBe(true);
    // The lease ended with the check, whatever its answer.
    expect(readdirSync(join(store, "claudexor/pending"))).toEqual([]);
  });

  it("a refused check releases its lease too", async () => {
    const { user, liveOwner } = stage();
    writeFileSync(join(user, "f.txt"), "candidate\n");
    const live = await captureWorkingTreeTransient(user, "HEAD", [], { owner: liveOwner });
    writeFileSync(join(user, "f.txt"), "the user's overlapping edit\n");
    const store = objectStorePath(user);

    const outcome = await checkResultOnTarget(user, live.result!);

    expect(outcome).toMatchObject({ ok: false, refusal: { code: "delivery_conflict" } });
    expect(readdirSync(join(store, "claudexor/pending"))).toEqual([]);
  });

  it("answers what the write would: a file Git does not track at a path the result adds", async () => {
    const { user, liveOwner } = stage();
    writeFileSync(join(user, "notes.md"), "the agent's\n");
    const live = await captureWorkingTreeTransient(user, "HEAD", [], { owner: liveOwner });
    writeFileSync(join(user, ".git/info/exclude"), "notes.md\n");
    writeFileSync(join(user, "notes.md"), "the user's own\n");

    const outcome = await checkResultOnTarget(user, live.result!);

    expect(outcome).toMatchObject({
      ok: false,
      refusal: { code: "delivery_path_occupied", paths: ["notes.md"] },
    });
    expect(readFileSync(join(user, "notes.md"), "utf8")).toBe("the user's own\n");
  });

  it("a check that finds no project store makes none and mounts nothing", async () => {
    const { root, user } = stage();
    const foreign = mkdtempSync(join(tmpdir(), "cx-check-lease-foreign-"));
    roots.push(foreign);
    writeFileSync(join(user, "f.txt"), "candidate\n");
    const live = await captureWorkingTreeTransient(user, "HEAD", [], {
      owner: root,
      projectRoot: foreign,
    });
    git(user, ["checkout", "-q", "--", "f.txt"]);
    const otherProject = join(root, "other-project");

    const outcome = await checkResultOnTarget(user, live.result!, otherProject);

    expect(outcome).toMatchObject({ ok: false, refusal: { code: "result_objects_missing" } });
    expect(existsSync(objectStorePath(otherProject))).toBe(false);
  });
});
