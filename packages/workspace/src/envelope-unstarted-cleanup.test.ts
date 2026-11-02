import { execFileSync } from "node:child_process";
import type { PathLike, RmOptions } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// #501: an envelope whose private clone is refused never starts, so its creator
// removes it; a removal that fails keeps the refusal and says what was left.
const fault = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (path: PathLike, options?: RmOptions) => {
      if (fault.path && String(path) === fault.path)
        throw Object.assign(new Error(`EACCES: permission denied, rmdir '${fault.path}'`), {
          code: "EACCES",
        });
      return actual.rmSync(path, options);
    },
  };
});
const { WorkspaceManager } = await import("./manager.js");
const { rmSync } = await import("node:fs");

const dirs: string[] = [];
afterEach(() => {
  fault.path = "";
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
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" } })
    .toString("utf8")
    .trim();

/** A sparse checkout of a blobless clone whose HEAD lacks outside/b.txt; upstream moved away. */
function sparsePartial() {
  const base = mkdtempSync(join(tmpdir(), "cx-unstarted-"));
  dirs.push(base);
  const work = join(base, "work");
  mkdirSync(join(work, "kept"), { recursive: true });
  mkdirSync(join(work, "outside"));
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(join(work, "kept", "value.txt"), "kept\n");
  writeFileSync(join(work, "outside", "b.txt"), "outside\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "one"]);
  const upstream = join(base, "upstream.git");
  git(base, ["clone", "-q", "--bare", work, upstream]);
  git(upstream, ["config", "uploadpack.allowFilter", "true"]);
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const target = join(base, "target");
  git(base, ["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${upstream}`, target]);
  git(target, ["sparse-checkout", "set", "--cone", "kept"]);
  git(target, ["checkout", "-q", "main"]);
  renameSync(upstream, `${upstream}.gone`);
  return { base, target };
}

describe("a never-started envelope is removed by its creator (#501)", { timeout: 120_000 }, () => {
  it("a removal that fails keeps the refusal, says what was left, and touches no source", async () => {
    const w = sparsePartial();
    const runtimeRoot = join(w.base, "runtime");
    const envelope = join(runtimeRoot, "workspaces", "t1", "a01");
    fault.path = envelope;
    const before = [
      git(w.target, ["rev-parse", "HEAD"]),
      git(w.target, ["for-each-ref"]),
      git(w.target, ["ls-files", "--stage", "-v"]),
      git(w.target, ["status", "--porcelain=v1"]),
      readFileSync(join(w.target, "kept", "value.txt"), "utf8"),
    ];
    const manager = new WorkspaceManager(w.target, { runtimeRoot });
    const error = await manager
      .create({ taskId: "t1", attemptId: "a01", dirtyPolicy: "snapshot" })
      .then(
        () => null,
        (thrown: unknown) => thrown as Error & { cleanupError?: unknown },
      );
    expect(error).toBeInstanceOf(Error);
    // The refusal leads, unchanged; the failed removal follows it and is kept beside it.
    expect(error!.message).toMatch(/^isolated clone of [0-9a-f]+ is incomplete: /);
    expect(error!.message).toContain("holds the content of 1 file(s): outside/b.txt");
    expect(error!.message).toContain(
      `; its never-started envelope ${envelope} could not be removed: EACCES`,
    );
    expect(String(error!.cleanupError)).toContain("EACCES");
    expect(existsSync(join(envelope, "owner.json"))).toBe(true);
    expect([
      git(w.target, ["rev-parse", "HEAD"]),
      git(w.target, ["for-each-ref"]),
      git(w.target, ["ls-files", "--stage", "-v"]),
      git(w.target, ["status", "--porcelain=v1"]),
      readFileSync(join(w.target, "kept", "value.txt"), "utf8"),
    ]).toEqual(before);
  });
});
