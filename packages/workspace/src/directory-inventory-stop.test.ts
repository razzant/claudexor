import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreparationCancelled } from "./git-run.js";
import { WorkspaceManager } from "./manager.js";

// #694 (directory preparation): a copied directory workspace scans its source
// footprint twice, once to copy it and once to prove it did not change meanwhile.
// Stop must end either scan between entries, after the entry being read finishes,
// instead of reading the rest of the tree. The stop is pressed from inside the
// filesystem call that reads a chosen entry: exact synchronization, no timer.

const observed = vi.hoisted(() => ({
  lstats: [] as string[],
  onLstat: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = ((...args: Parameters<typeof real.lstat>) => {
    const path = String(args[0]);
    observed.lstats.push(path);
    observed.onLstat?.(path);
    return real.lstat(...args);
  }) as typeof real.lstat;
  return { ...real, lstat, default: { ...real, lstat } };
});

const dirs: string[] = [];
afterEach(() => {
  observed.lstats = [];
  observed.onLstat = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

function source() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-dir-scan-")));
  dirs.push(root);
  const tree = join(root, "source");
  mkdirSync(tree);
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(join(tree, name), name);
  return { root, tree, runtime: join(root, "runtime") };
}

/** How often a scan lstats each entry it reads: the copy scan hashes the file, then
 * copies it, and checks the source after each against its first lstat (#783: within
 * a run a file is hashed before it is kept); the control scan only hashes it. */
const LSTATS_PER_ENTRY: Record<number, number> = { 1: 3, 2: 2 };

/** Which scan an lstat belongs to: each scan starts by reading the source root. */
function scanOf(tree: string) {
  let scan = 0;
  return (path: string) => (path === tree ? ++scan : scan);
}

describe("Stop inside a copied directory's source scans (#694)", () => {
  it.each([
    ["the copy scan", 1],
    ["the control scan after the copy", 2],
  ])("a stop pressed while %s reads an entry ends that scan after it", async (_label, stopIn) => {
    const s = source();
    const stop = new AbortController();
    const scan = scanOf(s.tree);
    let current = 0;
    const seen: string[] = [];
    observed.onLstat = (path) => {
      current = scan(path);
      if (current === stopIn) seen.push(path);
      if (current === stopIn && path === join(s.tree, "b.txt") && !stop.signal.aborted)
        stop.abort();
    };
    const created = new WorkspaceManager(s.tree, { runtimeRoot: s.runtime }).create({
      taskId: "t1",
      attemptId: "a01",
      workspaceKind: "directory",
      scopePaths: ["."],
      signal: stop.signal,
    });
    await expect(created).rejects.toBeInstanceOf(PreparationCancelled);
    // The entry being read when Stop came finished (its last, post-read lstat);
    // nothing after it was read in that scan.
    expect(seen.filter((path) => path === join(s.tree, "b.txt"))).toHaveLength(
      LSTATS_PER_ENTRY[stopIn]!,
    );
    expect(seen.filter((path) => /[cd]\.txt$/.test(path))).toEqual([]);
    expect(current).toBe(stopIn); // the stop ended the work: no later scan began
    expect(existsSync(join(s.runtime, "workspaces", "t1", "a01"))).toBe(false);
  });

  it("an unstopped copy reads every entry in both scans", async () => {
    const s = source();
    const scan = scanOf(s.tree);
    const reads = new Map<number, string[]>();
    observed.onLstat = (path) => {
      const n = scan(path);
      reads.set(n, [...(reads.get(n) ?? []), path]);
    };
    const env = await new WorkspaceManager(s.tree, { runtimeRoot: s.runtime }).create({
      taskId: "t2",
      attemptId: "a01",
      workspaceKind: "directory",
      scopePaths: ["."],
      signal: new AbortController().signal,
    });
    for (const n of [1, 2])
      for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"])
        expect(reads.get(n)?.filter((path) => path === join(s.tree, name))).toHaveLength(
          LSTATS_PER_ENTRY[n]!,
        );
    expect(existsSync(join(env.worktree_path, "d.txt"))).toBe(true);
  });
});
