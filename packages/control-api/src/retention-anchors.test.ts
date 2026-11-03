import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRevertAnchorFromPatchOrNull } from "@claudexor/workspace";
import { projectRuntimeDir, sha256, writePatchObject } from "@claudexor/util";
import { runRetentionPass, type RetentionDeps } from "./retention.js";
import { pruneRunAnchors } from "./retention-anchors.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const old = new Date("2020-01-01");
const policy = { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anchor-retention-"));
  cleanup.push(root);
  const runtime = join(root, "runtime");
  const other = join(root, "other");
  const projects = [runtime, other].map((dir) => ({
    root: dir,
    runsDir: join(dir, "runs"),
    reviewsDir: null,
  }));
  for (const p of projects) mkdirSync(p.runsDir, { recursive: true });
  const deps: RetentionDeps = {
    projects: () => projects,
    records: () => [],
    referencedRunIds: () => new Set(),
  };
  const anchor = (text: string, age = old) => {
    const name = `${sha256(text).slice(7)}.patch`;
    const path = join(runtime, "anchors", "objects", name);
    writePatchObject(runtime, path, text);
    utimesSync(path, age, age);
    return { id: sha256(text), path, cache: join(runtime, "patches", name) };
  };
  return { root, runtime, other, projects, deps, anchor };
}
it.each(["revert_anchor_id", "exact_patch_object", "delivery"])(
  "retains an old anchor named only by %s across namespaces",
  async (field) => {
    const f = fixture();
    const anchor = f.anchor("named");
    const garbage = f.anchor("unnamed");
    const final = join(f.other, "runs", "survivor", "final");
    mkdirSync(final, { recursive: true });
    writeFileSync(
      join(final, "work_product.yaml"),
      JSON.stringify({ kind: "report", meta: field === "delivery" ? {} : { [field]: anchor.id } }),
    );
    if (field === "delivery")
      writeFileSync(
        join(final, "delivery_state.yaml"),
        JSON.stringify({ revertAnchorId: anchor.id }),
      );
    const receipt = await runRetentionPass(policy, { dry_run: false }, f.deps);
    expect(receipt.errors).toEqual([]);
    expect(readFileSync(anchor.path, "utf8")).toBe("named");
    expect(existsSync(garbage.path)).toBe(false);
    expect(existsSync(garbage.cache)).toBe(false);
  },
);
it("removes old unnamed links and their cache, keeps young anchors, and previews without unlinking", async () => {
  const f = fixture();
  const cold = f.anchor("cold");
  const young = f.anchor("young", new Date());
  const preview = await runRetentionPass(policy, { dry_run: true }, f.deps);
  expect(preview.freed_bytes).toBe(4);
  expect(existsSync(cold.path)).toBe(true);
  expect(existsSync(cold.cache)).toBe(true);
  const receipt = await runRetentionPass(policy, { dry_run: false }, f.deps);
  expect(receipt.freed_bytes).toBe(4);
  expect(existsSync(cold.path)).toBe(false);
  expect(existsSync(cold.cache)).toBe(false);
  expect(existsSync(young.path)).toBe(true);
  expect(existsSync(young.cache)).toBe(true);
});
it("frees zero bytes when another hard link still owns the inode", async () => {
  const f = fixture();
  const anchor = f.anchor("shared");
  const retained = join(f.root, "retained");
  linkSync(anchor.path, retained);
  expect(lstatSync(anchor.path).nlink).toBe(3);
  const result = await runRetentionPass(policy, { dry_run: false }, f.deps);
  expect(result.freed_bytes).toBe(0);
  expect(existsSync(anchor.path)).toBe(false);
  expect(readFileSync(retained, "utf8")).toBe("shared");
});
it.each(["bad-meta", "held-namespace", "linked-namespace"])(
  "keeps all anchors on %s uncertainty",
  async (kind) => {
    const f = fixture();
    const anchor = f.anchor("held");
    if (kind === "held-namespace") f.deps.anchorsHeld = true;
    else if (kind === "linked-namespace") {
      rmSync(f.projects[1]!.runsDir, { recursive: true });
      symlinkSync(f.projects[0]!.runsDir, f.projects[1]!.runsDir, "dir");
    } else {
      const final = join(f.other, "runs", "corrupt", "final");
      mkdirSync(final, { recursive: true });
      writeFileSync(join(final, "work_product.yaml"), "meta: [unterminated");
    }
    const held = await runRetentionPass(policy, { dry_run: false }, f.deps);
    expect(existsSync(anchor.path)).toBe(true);
    if (kind !== "held-namespace")
      expect(held.holds[0]?.class).toBe("anchor_references_unreadable");
    if (kind === "bad-meta") rmSync(join(f.other, "runs", "corrupt"), { recursive: true });
    if (kind === "linked-namespace") {
      rmSync(f.projects[1]!.runsDir);
      mkdirSync(f.projects[1]!.runsDir);
    }
    f.deps.anchorsHeld = false;
    await runRetentionPass(policy, { dry_run: false }, f.deps);
    expect(existsSync(anchor.path)).toBe(false);
  },
);
it.each(["create", "reuse"])(
  "touches on %s, including a fresh hard link to an old cache inode",
  async (kind) => {
    const f = fixture();
    const repo = join(f.root, "repo");
    mkdirSync(repo);
    const runtime = projectRuntimeDir(repo);
    cleanup.push(runtime);
    const patch = "publication";
    const id = sha256(patch);
    const path = join(runtime, "anchors", "objects", `${id.slice(7)}.patch`);
    if (kind === "reuse") expect(createRevertAnchorFromPatchOrNull(repo, patch)).toBe(id);
    else writePatchObject(runtime, join(runtime, "display.patch"), patch);
    const cache = join(runtime, "patches", `${id.slice(7)}.patch`);
    utimesSync(cache, old, old);
    expect(createRevertAnchorFromPatchOrNull(repo, patch)).toBe(id);
    expect(lstatSync(path).mtimeMs).toBeGreaterThan(Date.now() - 5000);
    await runRetentionPass(
      policy,
      { dry_run: false },
      {
        ...f.deps,
        projects: () => [{ root: repo, runsDir: join(runtime, "runs"), reviewsDir: null }],
      },
    );
    expect(existsSync(path)).toBe(true);
  },
);
it("rechecks mtime immediately before unlink after inventory yields", async () => {
  const f = fixture();
  const anchor = f.anchor("late publication");
  const result = await pruneRunAnchors({
    runtime: f.runtime,
    named: new Set(),
    cutoff: Date.now() - 30 * 86400000,
    dryRun: false,
    planned: new Map(),
    current: () => {
      utimesSync(anchor.path, new Date(), new Date());
      return true;
    },
  });
  expect(result).toBe(0);
  expect(existsSync(anchor.path)).toBe(true);
});

it("masks parser excerpts in the anchor hold disclosure", async () => {
  const f = fixture();
  f.anchor("held");
  const final = join(f.other, "runs", "corrupt", "final");
  mkdirSync(final, { recursive: true });
  const secret = ["sk", "x".repeat(24)].join("-");
  writeFileSync(join(final, "work_product.yaml"), `meta: [${secret}\n`);
  const receipt = await runRetentionPass(policy, { dry_run: false }, f.deps);
  expect(receipt.holds[0]?.example).not.toContain(secret);
  expect(receipt.holds[0]?.example).toContain("[redacted]");
});
