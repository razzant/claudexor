import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@claudexor/schema";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { threadPurgeOwner } from "./thread-purge.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-thread-purge-owner-"));
  roots.push(root);
  return root;
}

function purgedThread(id: string, root: string, mode: "in_place" | "isolated"): Thread {
  return { id, state: "purged", repo: { root }, workspace: { mode } } as unknown as Thread;
}

describe("thread purge owner", () => {
  it("a repeated purge of a purged thread journals through the store and removes its leftovers", async () => {
    const root = projectRoot();
    const thread = purgedThread("th-1", root, "in_place");
    const lanes = join(projectRuntimeDir(root), "lanes", "th-1");
    mkdirSync(join(lanes, "claude-default", "home"), { recursive: true });
    const storeCalls: string[] = [];
    const owner = threadPurgeOwner(
      {
        getThread: () => thread,
        // The real store keeps a purged thread as it is (no new journal record).
        purgeThread: (id: string) => {
          storeCalls.push(id);
          return thread;
        },
      },
      noProjectRepoRoot(),
    );

    expect(owner.hasPurgeLeftovers(thread)).toBe(true);
    await owner.purgeThread("th-1");
    expect(storeCalls).toEqual(["th-1"]);
    expect(existsSync(lanes)).toBe(false);
    expect(owner.hasPurgeLeftovers(thread)).toBe(false);
  });

  it("counts a worktree directory only for an isolated thread, the one case it deletes", () => {
    const root = projectRoot();
    mkdirSync(join(projectRuntimeDir(root), "threads", "th-2", "tree"), { recursive: true });
    const owner = threadPurgeOwner(
      { getThread: () => undefined, purgeThread: () => undefined as never },
      noProjectRepoRoot(),
    );
    expect(owner.hasPurgeLeftovers(purgedThread("th-2", root, "isolated"))).toBe(true);
    // The owner never deletes `threads/<id>` of an in_place thread, so counting
    // it would make the retention pass retry forever.
    expect(owner.hasPurgeLeftovers(purgedThread("th-2", root, "in_place"))).toBe(false);
  });
});
