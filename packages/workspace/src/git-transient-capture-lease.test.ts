import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
import {
  objectStorePath,
  pruneObjectStore,
  retainInObjectStore,
  storeEnv,
} from "./object-store.js";

// #535 repair r1 (F2): a capture that mounts the project store as an alternate
// may find an old, unreferenced store object present and never write it to its
// scratch. A prune running at that moment must yield. The hook below runs a
// real prune immediately before a chosen Git step of the capture.
let beforeStep: { label: string; run: () => Promise<void> } | null = null;
vi.mock("./git-observed.js", async (original) => {
  const actual = await original<typeof import("./git-observed.js")>();
  return {
    ...actual,
    gitObserved: async (...args: Parameters<typeof actual.gitObserved>) => {
      const hook = beforeStep;
      if (hook && args[2].label === hook.label) {
        beforeStep = null;
        await hook.run();
      }
      return actual.gitObserved(...args);
    },
  };
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-lease-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
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

describe("transient capture holds custody while the store is its alternate (F2)", () => {
  it("a prune during the capture's Git steps yields; the object Git found in the store survives", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-lease-user-"));
    dirs.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    // Large blobs stream through bulk check-in, which never refreshes an
    // object it finds present (small blobs would get a fresh mtime).
    git(repo, ["config", "core.bigFileThreshold", "1k"]);
    writeFileSync(join(repo, "kept.txt"), "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "base"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const shared = "payload an earlier, expired run also produced\n".repeat(200);

    // An earlier run's capture put `shared` in the store; that run is gone, so
    // its blob is old and no root record keeps it.
    const scratch = mkdtempSync(join(tmpdir(), "cx-lease-scratch-"));
    dirs.push(scratch);
    mkdirSync(join(scratch, "objects"));
    const env = {
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects"),
    };
    git(repo, ["read-tree", "HEAD"], env);
    const blob = git(repo, ["hash-object", "-w", "--stdin"], env, shared);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},old.txt`], env);
    const oldTree = git(repo, ["write-tree"], env);
    const expired = mkdtempSync(join(tmpdir(), "cx-lease-expired-run-"));
    await retainInObjectStore({
      projectRoot: repo,
      source: { cwd: repo, env, objectsDir: join(scratch, "objects") },
      roots: [oldTree],
      boundary: { commit: head, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) },
      objectFormat: "sha1",
      owner: expired,
    });
    rmSync(expired, { recursive: true, force: true });
    const store = objectStorePath(repo);
    const then = new Date(Date.now() - 3 * 3_600_000);
    for (const fan of readdirSync(join(store, "objects")).filter((name) =>
      /^[0-9a-f]{2}$/.test(name),
    ))
      for (const name of readdirSync(join(store, "objects", fan)))
        utimesSync(join(store, "objects", fan, name), then, then);

    // This run's candidate produced the same bytes.
    writeFileSync(join(repo, "copy.txt"), shared);
    const run = mkdtempSync(join(tmpdir(), "cx-lease-run-"));
    dirs.push(run);
    let pass: Awaited<ReturnType<typeof pruneObjectStore>> | undefined;
    beforeStep = {
      label: "write-tree",
      run: async () => {
        pass = await pruneObjectStore({ store, graceMs: 60_000, objectFormat: "sha1" });
      },
    };
    const captured = await captureWorkingTreeTransient(repo, head, [], {
      projectRoot: repo,
      owner: run,
    });
    expect(captured.captureFailure?.message).toBeUndefined();
    expect(captured.captureIncomplete).toBe(false);
    expect(pass).toMatchObject({ yielded: true });
    expect(captured.result?.candidate_tree).toBeTruthy();
    expect(
      spawnSync(
        "git",
        ["-C", store, "cat-file", "-e", `${captured.result!.candidate_tree}:copy.txt`],
        {
          env: { ...ENV, ...storeEnv(store) },
        },
      ).status,
    ).toBe(0);
  });
});
