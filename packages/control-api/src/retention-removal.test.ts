import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareRetirement, RETIRING } from "./retention-removal.js";
import { readRunTombstone, runRetentionPass } from "./retention.js";

const deletion = vi.hoisted(() => ({ before: async (_path: string) => {} }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await deletion.before(String(args[0]));
      return actual.rm(...args);
    },
  };
});
let root: string;
let runs: string;
let reviews: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "retirement-")));
  runs = join(root, "runs");
  reviews = join(root, ".claudexor", "reviews");
  mkdirSync(runs);
  mkdirSync(reviews, { recursive: true });
});
afterEach(() => {
  deletion.before = async () => {};
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function seed(name = "old", parent = runs): string {
  const path = join(parent, name);
  mkdirSync(join(path, "final"), { recursive: true });
  writeFileSync(join(path, "final", "failure.yaml"), "terminal");
  utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
  return path;
}
const marker = (name: string) =>
  `run_id: ${name}\ndeleted_at: 2026-01-01T00:00:00.000Z\nreason: retention\n`;
function pass(dryRun = false, cap = 500) {
  return runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
    { dry_run: dryRun },
    {
      projects: () => [{ root, runsDir: runs, reviewsDir: reviews }],
      records: () => [],
      referencedRunIds: () => new Set(),
      maxDeletionsPerPass: cap,
    },
  );
}

it("admits callbacks with a tombstone already visible while recursive removal is pending", async () => {
  const path = seed();
  let observed = false;
  deletion.before = async (pathToRemove) => {
    if (basename(pathToRemove) !== "final") return;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(readRunTombstone(path)?.run_id).toBe("old");
        expect(existsSync(join(path, "final"))).toBe(true);
        expect(existsSync(join(pathToRemove, "failure.yaml"))).toBe(true);
        observed = true;
        resolve();
      }),
    );
  };
  const receipt = await pass();
  expect(observed).toBe(true);
  expect(receipt.deleted_runs.map((row) => row.run_id)).toEqual(["old"]);
  expect(receipt.freed_bytes).toBe(8);
  expect(receipt.errors).toEqual([]);
});

it.each(["after publish", "during cleanup"])(
  "recovers interruption %s within the existing batch cap",
  async (point) => {
    const source = seed();
    writeFileSync(join(source, "leftover"), "leftover");
    const claim = await prepareRetirement(runs, "old", marker("old"));
    claim.commit();
    if (point === "during cleanup") rmSync(join(source, "final"), { recursive: true });
    seed("neighbor");
    const preview = await pass(true, 1);
    expect(preview.deleted_runs.map((row) => row.run_id)).toEqual(["old"]);
    expect(existsSync(claim.tree)).toBe(true);
    const first = await pass(false, 1);
    expect(first.deleted_runs.map((row) => row.run_id)).toEqual(["old"]);
    expect(first.freed_bytes).toBe(point === "after publish" ? 16 : 8);
    expect(first.errors.join()).toContain("truncated");
    expect(readRunTombstone(source)?.run_id).toBe("old");
    expect(existsSync(claim.claim)).toBe(false);
    const next = await pass();
    expect(next.deleted_runs.map((row) => row.run_id)).toEqual(["neighbor"]);
    expect(next.errors).toEqual([]);
  },
);

it("discards an uncommitted preparation without expiring a still-protected source", async () => {
  const source = seed();
  const claim = await prepareRetirement(runs, "old", marker("old"));
  writeFileSync(
    join(source, "final", "work_product.yaml"),
    "kind: patch\nmeta:\n  apply_state: pending\n",
  );
  seed("neighbor");
  expect((await pass(true)).deleted_runs.map((row) => row.run_id)).toEqual(["neighbor"]);
  expect(existsSync(claim.claim)).toBe(true);
  const receipt = await pass();
  expect(receipt.deleted_runs.map((row) => row.run_id)).toEqual(["neighbor"]);
  expect(existsSync(join(source, "final"))).toBe(true);
  expect(existsSync(claim.claim)).toBe(false);
});

it("reports failed physical removal and finishes it on the next pass", async () => {
  const source = seed();
  deletion.before = async (path) => {
    if (basename(path) === "final") throw new Error("fixture removal refused");
  };
  const failed = await pass();
  expect(failed.deleted_runs).toEqual([]);
  expect(failed.freed_bytes).toBe(0);
  expect(failed.errors.join()).toContain("fixture removal refused");
  expect(readRunTombstone(source)?.run_id).toBe("old");
  deletion.before = async () => {};
  const recovered = await pass();
  expect(recovered.deleted_runs.map((row) => row.run_id)).toEqual(["old"]);
  expect(recovered.freed_bytes).toBe(8);
  expect(recovered.errors).toEqual([]);
});

it("keeps completed deletion facts when only claim bookkeeping fails", async () => {
  seed();
  deletion.before = async (path) => {
    if (path.includes("claim-") && basename(path) !== "tree")
      throw new Error("fixture bookkeeping refused");
  };
  const receipt = await pass();
  expect(receipt.deleted_runs).toHaveLength(1);
  expect(receipt.freed_bytes).toBe(8);
  expect(receipt.errors.join()).toContain("bookkeeping");
  deletion.before = async () => {};
  const next = await pass();
  expect(next.deleted_runs).toEqual([]);
  expect(next.freed_bytes).toBe(0);
  expect(next.errors).toEqual([]);
  expect(readdirSync(join(runs, RETIRING))).toEqual([]);
});

it("recovers expired standalone reviews without creating a run tombstone", async () => {
  seed("diff-old", reviews);
  const claim = await prepareRetirement(reviews, "diff-old", null);
  claim.commit();
  const receipt = await pass();
  expect(receipt.deleted_reviews).toEqual([{ path: join(reviews, "diff-old"), freed_bytes: 8 }]);
  expect(existsSync(join(reviews, "diff-old"))).toBe(false);
  expect(existsSync(claim.claim)).toBe(false);
  expect(receipt.errors).toEqual([]);
});

it.each([
  "corrupt intent",
  "new source",
  "linked claim",
  "replaced source",
  "changed marker",
  "escaped child",
])("keeps an unsafe %s and still removes a valid neighbor", async (kind) => {
  seed();
  const claim = await prepareRetirement(runs, "old", marker("old"));
  claim.commit();
  if (kind === "corrupt intent") writeFileSync(join(claim.claim, "intent.json"), "unreadable");
  if (kind === "new source") writeFileSync(join(runs, "old", "new-data"), "preserve");
  if (kind === "replaced source") {
    renameSync(join(runs, "old"), join(root, "preserved"));
    seed();
    writeFileSync(join(runs, "old", "tombstone.yaml"), marker("old"));
  }
  if (kind === "changed marker") writeFileSync(join(runs, "old", "tombstone.yaml"), "unreadable");
  if (kind === "escaped child") {
    const path = join(claim.claim, "intent.json");
    const intent = JSON.parse(readFileSync(path, "utf8"));
    intent.children = ["final", "../neighbor"];
    writeFileSync(path, JSON.stringify(intent));
  }
  if (kind === "linked claim") {
    const target = join(root, "detached");
    renameSync(claim.claim, target);
    symlinkSync(target, claim.claim, "dir");
  }
  seed("neighbor");
  const receipt = await pass();
  expect(receipt.deleted_runs.map((row) => row.run_id)).toEqual(["neighbor"]);
  expect(receipt.errors.length).toBeGreaterThan(0);
  expect(readFileSync(join(claim.tree, "final", "failure.yaml"), "utf8")).toBe("terminal");
});

it("fences a linked holding directory before preparing a claim", async () => {
  seed();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(runs, RETIRING), "dir");
  const receipt = await pass();
  expect(receipt.deleted_runs).toEqual([]);
  expect(receipt.errors.join()).toContain("plain directory");
  expect(existsSync(join(runs, "old", "final"))).toBe(true);
});
