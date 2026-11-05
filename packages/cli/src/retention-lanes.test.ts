// Lane sweeping observes live ownership at the synchronous deletion boundary.
// Orphan lane sweeping (INV-034 owner c) under ordinary unrelated SQL writes.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-opus-lanes-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
});
afterEachClosed(async () => {
  await sql.close();
  return () => {
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  };
});

it("sweeps an orphan in the first pass while unrelated thread writes continue", async () => {
  const lane = join(
    projectRuntimeDir(noProjectRepoRoot()),
    "lanes",
    "th-000000000001",
    "default",
    "home",
  );
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, "session.jsonl"), "orphaned lane state");
  const busy = sql.graph.threads.createThread({ title: "busy", workspace: "in_place" });
  const held = join(projectRuntimeDir(noProjectRepoRoot()), "lanes", busy.id, "default", "home");
  mkdirSync(held, { recursive: true });
  let writes = 0;
  // An unrelated metadata write every millisecond, like a busy daemon's routine traffic.
  const timer = setInterval(() => {
    sql.graph.threads.updateThread(busy.id, { title: `busy ${++writes}` });
  }, 1);
  const outcomes: Array<{ pass: number; laneExists: boolean; errors: string[] }> = [];
  try {
    const gc = createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => sqlActivityRecords(sql.store),
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
    });
    for (let pass = 1; pass <= 1; pass++) {
      const receipt = await gc({ dry_run: false });
      outcomes.push({ pass, laneExists: existsSync(lane), errors: receipt.errors });
    }
  } finally {
    clearInterval(timer);
  }
  expect(writes).toBeGreaterThan(0);
  expect(outcomes).toEqual([{ pass: 1, laneExists: false, errors: [] }]);
  expect(existsSync(held)).toBe(true);
  expect(existsSync(lane)).toBe(false);
});

it("names the root when live lane ownership cannot be read", async () => {
  const repoRoot = noProjectRepoRoot();
  const lane = join(projectRuntimeDir(repoRoot), "lanes", "th-000000000001", "default", "home");
  mkdirSync(lane, { recursive: true });
  const other = join(root, "healthy");
  mkdirSync(other);
  sql.graph.projects.register({ root: other, idempotencyKey: "healthy", clientId: "fixture" });
  const otherLane = join(projectRuntimeDir(other), "lanes", "th-000000000002", "default", "home");
  mkdirSync(otherLane, { recursive: true });
  const read = sql.graph.threads.retentionReferences.bind(sql.graph.threads);
  vi.spyOn(sql.graph.threads, "retentionReferences").mockImplementation(async (...args) => {
    const refs = await read(...args);
    return {
      ...refs,
      laneThreadIds: (projectRoot) => {
        if (projectRoot === repoRoot) throw new Error("root ownership cannot be read");
        return refs.laneThreadIds!(projectRoot);
      },
    };
  });
  const gc = createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => sqlActivityRecords(sql.store),
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
  });
  const receipt = await gc({ dry_run: false });
  expect(existsSync(lane)).toBe(true);
  expect(receipt.errors.filter((error) => error.startsWith("lane sweep"))).toEqual([
    expect.stringContaining(`lane sweep skipped for ${repoRoot}`),
  ]);
  expect(existsSync(otherLane)).toBe(false);
});

/** Twelve orphan lanes, one live lane, and a topology change at the chosen moment. */
function topologyFixture(when: string, changeTopology: (projects: readonly string[]) => void) {
  const lanes: string[] = [];
  const projects: string[] = [];
  for (let i = 0; i < 12; i++) {
    const repo = join(root, `repo-${i}`);
    mkdirSync(repo);
    const { project } = sql.graph.projects.register({
      root: repo,
      idempotencyKey: `repo-${i}`,
      clientId: "fixture",
    });
    const lane = join(projectRuntimeDir(repo), "lanes", "th-000000000001", "default", "home");
    mkdirSync(lane, { recursive: true });
    lanes.push(lane);
    projects.push(project.id);
  }
  const thread = sql.graph.threads.createThread({ title: "live lane", workspace: "in_place" });
  const held = join(projectRuntimeDir(noProjectRepoRoot()), "lanes", thread.id, "default", "home");
  mkdirSync(held, { recursive: true });
  const read = sql.graph.threads.retentionReferences.bind(sql.graph.threads);
  vi.spyOn(sql.graph.threads, "retentionReferences").mockImplementationOnce(async (...args) => {
    const refs = await read(...args);
    if (when === "before-loop") changeTopology(projects);
    else {
      const laneIds = refs.laneThreadIds!;
      let changed = false;
      refs.laneThreadIds = (projectRoot) => {
        if (!changed) {
          changed = true;
          changeTopology(projects);
        }
        return laneIds(projectRoot);
      };
    }
    return refs;
  });
  const gc = createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => [],
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
  });
  return { gc, lanes, held };
}
const laneLines = (errors: readonly string[]) =>
  errors.filter((error) => error.startsWith("lane sweep"));

it.each(["before-loop", "during-loop"])(
  "a late registration %s stops no other namespace: orphan lanes retire in that pass",
  async (when) => {
    const { gc, lanes, held } = topologyFixture(when, () => {
      const late = join(root, "late");
      mkdirSync(late);
      sql.graph.projects.register({ root: late, idempotencyKey: "late", clientId: "fixture" });
    });
    const receipt = await gc({ dry_run: false });
    // Registered before the sweep, the new root is among its roots and holds itself alone.
    expect(laneLines(receipt.errors)).toEqual(
      when === "before-loop" ? [expect.stringContaining("lane sweep deferred")] : [],
    );
    for (const lane of lanes) expect(existsSync(lane)).toBe(false);
    expect(existsSync(held)).toBe(true);
  },
);

it.each(["before-loop", "during-loop"])(
  "a project relinked %s keeps its namespace's lanes, once named, while others retire",
  async (when) => {
    const moved = join(root, "moved");
    let changed = "";
    const { gc, lanes, held } = topologyFixture(when, (projects) => {
      mkdirSync(moved);
      changed = sql.graph.projects.relink(projects[0]!, moved).root;
    });
    const receipt = await gc({ dry_run: false });
    expect(changed).toBe(moved);
    expect(laneLines(receipt.errors)).toEqual([expect.stringContaining("lane sweep deferred")]);
    expect(receipt.truncated).toBe(true);
    // The relinked project's old namespace was never swept while its owners moved.
    expect(existsSync(lanes[0]!)).toBe(true);
    for (const lane of lanes.slice(1)) expect(existsSync(lane)).toBe(false);
    expect(existsSync(held)).toBe(true);
    const resumed = await gc({ dry_run: false });
    expect(resumed.errors).toEqual([]);
    expect(existsSync(held)).toBe(true);
  },
);
