import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRetentionPass } from "./retention.js";
import type { Retirement } from "./retention-removal.js";

let beforeCommit: (path: string, retirement: Retirement) => void = () => {};
vi.mock("./retention-removal.js", async (original) => {
  const actual = await original<typeof import("./retention-removal.js")>();
  return {
    ...actual,
    prepareRetirement: async (...args: Parameters<typeof actual.prepareRetirement>) => {
      const retirement = await actual.prepareRetirement(...args);
      beforeCommit(join(args[0], args[1]), retirement);
      return retirement;
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  beforeCommit = () => {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

function oldRun(runsDir: string, id: string): string {
  const path = join(runsDir, id);
  mkdirSync(join(path, "final"), { recursive: true });
  writeFileSync(join(path, "final", "failure.yaml"), "terminal evidence");
  const old = new Date("2020-01-01");
  utimesSync(path, old, old);
  return path;
}

it("holds a namespace whose registration changed mid-pass while an independent one retires (#503)", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-deferral-"));
  roots.push(root);
  const changing = join(root, "changing");
  const independent = join(root, "independent");
  const held = oldRun(join(changing, "runs"), "held");
  const other = oldRun(join(independent, "runs"), "other");
  // Not a registered owner at inventory: no keep-last would protect its history.
  const deferred = new Set<string>();
  beforeCommit = (path) => {
    if (path === held) deferred.add(changing);
  };
  const receipt = await runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 5 },
    { dry_run: false },
    {
      projects: () => [
        { root: changing, runsDir: join(changing, "runs"), reviewsDir: null, keepLastRuns: false },
        {
          root: independent,
          runsDir: join(independent, "runs"),
          reviewsDir: null,
          keepLastRuns: false,
        },
      ],
      records: () => [],
      referencedRunIds: () => new Set(),
      referencesCurrent: () => true,
      deferredRuntimes: () => deferred,
    },
  );
  expect(receipt.deleted_runs.map((run) => run.run_id)).toEqual(["other"]);
  expect(existsSync(join(held, "final"))).toBe(true);
  expect(existsSync(join(held, "tombstone.yaml"))).toBe(false);
  expect(existsSync(join(other, "tombstone.yaml"))).toBe(true);
  expect(receipt.holds).toContainEqual(
    expect.objectContaining({ class: "references_changed", count: 1 }),
  );
  expect(receipt.truncated).toBe(false);
  expect(receipt.effects).toBeUndefined();
});

it("keeps a changed namespace's review debris while an independent one retires (#503)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-reviews-")));
  roots.push(root);
  const review = (project: string) => {
    const path = join(project, ".claudexor", "reviews", "diff-1");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "review.md"), "debris");
    const old = new Date("2020-01-01");
    utimesSync(path, old, old);
    return path;
  };
  const changing = join(root, "changing");
  const independent = join(root, "independent");
  const kept = review(changing);
  const gone = review(independent);
  const receipt = await runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 5 },
    { dry_run: false },
    {
      projects: () =>
        [changing, independent].map((project) => ({
          root: project,
          runsDir: join(project, "runs"),
          reviewsDir: join(project, ".claudexor", "reviews"),
          keepLastRuns: false,
        })),
      records: () => [],
      referencedRunIds: () => new Set(),
      referencesCurrent: () => true,
      deferredRuntimes: () => new Set([changing]),
    },
  );
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(gone)).toBe(false);
  expect(receipt.deleted_reviews.map((tree) => tree.path)).toEqual([gone]);
  expect(receipt.holds).toContainEqual(
    expect.objectContaining({ class: "references_changed", count: 1 }),
  );
});

it("reports a lower bound when a committed retirement stops partway (#503)", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-partial-"));
  roots.push(root);
  const project = join(root, "project");
  const partial = oldRun(join(project, "runs"), "partial");
  writeFileSync(join(partial, "events.jsonl"), "{}\n");
  // Its age is the run directory's mtime, which that write just refreshed.
  utimesSync(partial, new Date("2020-01-01"), new Date("2020-01-01"));
  beforeCommit = (path, retirement) => {
    if (path !== partial) return;
    // The first child goes, the next one is refused: bytes left the disk uncounted.
    retirement.finish = async () => {
      rmSync(join(partial, "events.jsonl"));
      throw Object.assign(new Error("EACCES: permission denied, rm 'final'"), { code: "EACCES" });
    };
  };
  const receipt = await runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 5 },
    { dry_run: false },
    {
      projects: () => [
        { root: project, runsDir: join(project, "runs"), reviewsDir: null, keepLastRuns: false },
      ],
      records: () => [],
      referencedRunIds: () => new Set(),
      referencesCurrent: () => true,
    },
  );
  expect(existsSync(join(partial, "events.jsonl"))).toBe(false);
  expect(receipt.deleted_runs).toEqual([]);
  expect(receipt.effects).toBe("unknown");
  expect(receipt.errors).toContainEqual(expect.stringContaining("runs/partial: EACCES"));
  // The committed marker and the rest stay: the next pass finishes the tree.
  expect(existsSync(join(partial, "tombstone.yaml"))).toBe(true);
  expect(existsSync(join(partial, "final"))).toBe(true);
});
