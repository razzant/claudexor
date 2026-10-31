import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_INVENTORY_LIMIT, WorkspaceCaptureFailure } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { captureFailureEvidence } from "./capture-failure.js";
import { changedFileInventory } from "./capture-inventory.js";
import { estimatePatchViewBytes } from "./capture-objects.js";
import { captureWorkingTreeTransient } from "./git.js";
import { WorkspaceManager } from "./manager.js";
import { objectStorePath } from "./object-store.js";

// The patch VIEW (`diff --binary`) is refused as if it exceeded the buffer
// budget: since #535 phase 2 that leaves the exact object result unrendered,
// never a refusal. `refuseInventory` also refuses the inventory's own raw tree
// diff; `failCustody` stops the store copy with a typed Git failure (a real
// refusal). Everything else (add, write-tree, store, inventory) runs real Git.
let refuseInventory = false;
let failCustody = false;
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (...args: Parameters<typeof core.runCaptureRaw>) => {
      const command = args[1]
        .slice(2)
        .filter((arg, index, all) => all[index - 1] !== "-c" && arg !== "-c");
      if (command[0] === "diff" && (command.includes("--binary") || refuseInventory))
        return Promise.reject(new core.CaptureOutputExceeded("stdout"));
      if (failCustody && command[0] === "rev-list")
        return Promise.resolve({
          code: 128,
          signal: null,
          stdout: "",
          stderr: "fatal: read error while indexing",
        });
      return core.runCaptureRaw(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  refuseInventory = false;
  failCustody = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-capture-inventory-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  writeFileSync(join(root, "kept.txt"), "unchanged\n");
  writeFileSync(join(root, "edited.txt"), "before\n");
  writeFileSync(join(root, "removed.txt"), "x".repeat(300));
  writeFileSync(join(root, "linked"), "a regular file first\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  return root;
}

describe("an unrendered result and a refused capture name their largest changed files", () => {
  it("an over-limit view leaves the exact result unrendered, with a non-exact inventory", async () => {
    const root = repo();
    // A private temp root: the capture's scratch object store must be gone after it.
    const scratch = mkdtempSync(join(tmpdir(), "cx-capture-scratch-"));
    roots.push(scratch);
    writeFileSync(join(root, "edited.txt"), "after, and longer\n");
    writeFileSync(join(root, "added.bin"), Buffer.alloc(5000, 7));
    unlinkSync(join(root, "removed.txt"));
    unlinkSync(join(root, "linked"));
    symlinkSync("kept.txt", join(root, "linked"));

    const inherited = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    const captured = await captureWorkingTreeTransient(root, "HEAD").finally(() => {
      if (inherited === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = inherited;
    });

    expect(captured).toMatchObject({ captureIncomplete: false, patch: "" });
    expect(captured.result?.schema).toBe("git_objects/v1");
    expect(captured.result?.base_tree).not.toBe(captured.result?.candidate_tree);
    expect(captured.patchViewUnavailable?.reason).toBe("exceeds_view_limit");
    expect(captured.inventory).toEqual({
      exact: false,
      changedFiles: 4,
      largest: [
        { path: "added.bin", change: "added", sizeBytes: 5000 },
        { path: "removed.txt", change: "deleted", sizeBytes: 300 },
        { path: "edited.txt", change: "modified", sizeBytes: 18 },
        { path: "linked", change: "type_changed", sizeBytes: 8 },
      ],
    });
    // The inventory reads Git metadata only: no patch text and no file bytes.
    expect(JSON.stringify(captured.inventory)).not.toContain("after, and longer");
    // Its own pass ran before the scratch object store was removed.
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("a result whose estimate fits but whose render overflows is the typed absence, never a refusal", async () => {
    const root = repo();
    writeFileSync(join(root, "tracked.txt"), "after\n");
    const captured = await captureWorkingTreeTransient(root, "HEAD");
    expect(captured.captureFailure).toBeUndefined();
    expect(captured).toMatchObject({ captureIncomplete: false, patch: "" });
    const view = captured.patchViewUnavailable!;
    expect(view.reason).toBe("exceeds_view_limit");
    // The estimate fit but the render overflowed: the figure never contradicts the
    // absence it explains, it is the smallest size that can have overflowed.
    expect(view.estimatedBytes).toBe(view.limitBytes + 1);
    // The exact result is intact: the project store's candidate tree holds the change.
    const show = execFileSync("git", [
      "--git-dir",
      objectStorePath(root),
      "show",
      `${captured.result!.candidate_tree}:tracked.txt`,
    ]);
    expect(show.toString()).toBe("after\n");
    expect(captured.changedPaths).toContain("tracked.txt");
  });

  it("a stored inventory names a credential-shaped file exactly: a path is working content", async () => {
    const root = repo();
    const name = `${"ghp_"}${"a1".repeat(18)}.txt`;
    // The fixture really is a name the diagnostic mask rewrites.
    expect(redactSecrets(name)).not.toBe(name);
    writeFileSync(join(root, name), "new\n");

    const captured = await captureWorkingTreeTransient(root, "HEAD");

    expect(captured.patchViewUnavailable?.reason).toBe("exceeds_view_limit");
    expect(captured.inventory?.largest.map((entry) => entry.path)).toEqual([name]);
    expect(captured.changedPaths).toEqual([name]);
  });

  it("an inventory keeps its length cap", async () => {
    const root = repo();
    const git = (env: Record<string, string>, ...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { env: { ...process.env, ...env } })
        .toString()
        .trim();
    // Longer than a macOS path can be on disk: only a tree can hold it.
    const path = `${Array.from({ length: 10 }, () => "d".repeat(120)).join("/")}/deep.txt`;
    const index = { GIT_INDEX_FILE: join(mkdtempSync(join(root, ".git", "cx-index-")), "index") };
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "x\n" })
      .toString()
      .trim();
    git(index, "read-tree", "HEAD");
    git(index, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
    const tree = git(index, "write-tree");

    const inventory = await changedFileInventory(root, "HEAD", tree, {});

    expect(inventory?.largest[0]?.path).toBe(path.slice(0, 1024));
  });

  it("the view estimate is an estimate: many short changed lines render larger than it", async () => {
    const root = repo();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { maxBuffer: 1 << 26 }).toString();
    const commit = (text: string) => {
      writeFileSync(join(root, "lines.txt"), text);
      git("add", "lines.txt");
      git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "lines");
      return git("rev-parse", "HEAD").trim();
    };
    const before = commit("a\n".repeat(100_000));
    const after = commit("b\n".repeat(100_000));
    const { bytes } = await estimatePatchViewBytes(root, before, after, {});
    expect(bytes).toBe(1024 + 2 * Math.ceil((200_000 * 5) / 4));
    // Each changed line costs its prefix too: the known undershoot, about 1.2 times.
    const rendered = git("diff", "--binary", before, after).length;
    expect(rendered / bytes).toBeGreaterThan(1.1);
    expect(rendered / bytes).toBeLessThan(1.3);
  });

  it("bounds the listing and still counts every changed path", async () => {
    const root = repo();
    mkdirSync(join(root, "many"));
    for (let index = 0; index < CAPTURE_INVENTORY_LIMIT + 5; index += 1)
      writeFileSync(
        join(root, "many", `file-${String(index).padStart(2, "0")}.txt`),
        "y".repeat(index + 1),
      );

    const captured = await captureWorkingTreeTransient(root, "HEAD");
    const inventory = captured.inventory;

    expect(inventory?.changedFiles).toBe(CAPTURE_INVENTORY_LIMIT + 5);
    expect(inventory?.largest).toHaveLength(CAPTURE_INVENTORY_LIMIT);
    expect(inventory?.largest[0]).toEqual({
      path: `many/file-${CAPTURE_INVENTORY_LIMIT + 4}.txt`,
      change: "added",
      sizeBytes: CAPTURE_INVENTORY_LIMIT + 5,
    });
  });

  it("a typed Git failure refuses with an exact cause and keeps the inventory", async () => {
    const root = repo();
    writeFileSync(join(root, "added.bin"), Buffer.alloc(5000, 7));
    failCustody = true;

    const captured = await captureWorkingTreeTransient(root, "HEAD");

    expect(captured.captureIncomplete).toBe(true);
    const failure = WorkspaceCaptureFailure.parse(captureFailureEvidence(captured.captureFailure));
    expect(failure.code).toBe("capture_read_failed");
    expect(failure.message).toContain("read error");
    expect(failure.inventory?.largest[0]).toEqual({
      path: "added.bin",
      change: "added",
      sizeBytes: 5000,
    });
  });

  it("records no inventory when its own bounded pass is refused; the capture refusal stands", async () => {
    const root = repo();
    writeFileSync(join(root, "added.bin"), Buffer.alloc(5000, 7));
    failCustody = true;
    refuseInventory = true;

    const captured = await captureWorkingTreeTransient(root, "HEAD");

    expect(captured.captureIncomplete).toBe(true);
    const failure = captureFailureEvidence(captured.captureFailure);
    expect(failure.code).toBe("capture_read_failed");
    expect(failure.inventory).toBeUndefined();
  });
});

describe("in-place disposal and the run-owned artifact directory", () => {
  it.each([false, true])("keeps the directory only when asked (kept=%s)", async (kept) => {
    const root = repo();
    const runtimeRoot = mkdtempSync(join(tmpdir(), "cx-capture-runtime-"));
    roots.push(runtimeRoot);
    const manager = new WorkspaceManager(root, { runtimeRoot });
    const env = await manager.create({ taskId: "t-media", attemptId: "a01", inPlace: true });
    const directory = manager.ensureArtifactDirectory(env);
    writeFileSync(join(directory, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    if (kept) manager.keepArtifactDirectory(env);
    await manager.dispose(env);

    expect(existsSync(join(directory, "screenshot.png"))).toBe(kept);
    expect(existsSync(join(root, "edited.txt"))).toBe(true);
  });
});
