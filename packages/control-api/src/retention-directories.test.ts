import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRetentionPass } from "./retention.js";
import { pruneEmptyRuntimeDirectories } from "./retention-directories.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmdirSync: vi.fn(actual.rmdirSync) };
});
// These container tests have no patch objects. Remove incidental I/O yields so
// the between-namespace admission test proves the explicit scheduling boundary.
vi.mock("@claudexor/util", async (original) => ({
  ...(await original<typeof import("@claudexor/util")>()),
  prunePatchObjects: async () => 0,
}));
vi.mock("./retention-anchors.js", async (original) => ({
  ...(await original<typeof import("./retention-anchors.js")>()),
  pruneRunAnchors: async () => 0,
}));
const cleanup: string[] = [];
afterEach(() => {
  vi.mocked(fs.rmdirSync).mockReset();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
async function fixture() {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.rmdirSync).mockImplementation(actual.rmdirSync);
  const root = fs.mkdtempSync(join(tmpdir(), "empty-runtime-"));
  cleanup.push(root);
  const runtime = join(root, "runtime");
  for (const name of [
    "runs/.retiring",
    "anchors/objects",
    "workspaces/task",
    "patches",
    "lanes/thread",
    "threads",
  ])
    fs.mkdirSync(join(runtime, name), { recursive: true });
  age(runtime);
  return { root, runtime, actual };
}
function age(root: string) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) age(join(root, entry.name));
  fs.utimesSync(root, new Date("2020-01-01"), new Date("2020-01-01"));
}
async function pass(runtime: string, dry_run = false, refresh?: () => Promise<void>) {
  return runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
    { dry_run },
    {
      projects: () => [{ root: runtime, runsDir: join(runtime, "runs"), reviewsDir: null }],
      records: () => [],
      referencedRunIds: () => new Set(),
      refreshReferences: refresh,
    },
  );
}
it("reaps only old empty engine containers, including patches and lanes; preview keeps them", async () => {
  const { runtime } = await fixture();
  await pass(runtime, true);
  expect(fs.existsSync(join(runtime, "lanes/thread"))).toBe(true);
  await pass(runtime);
  expect(fs.existsSync(runtime)).toBe(false);
});
it("one file preserves its container, then the old empty container goes", async () => {
  const { runtime } = await fixture();
  const path = join(runtime, "workspaces/task/owner");
  fs.writeFileSync(path, "owned");
  age(runtime);
  const before = fs.statSync(runtime).mtimeMs;
  await pass(runtime);
  expect(fs.existsSync(path)).toBe(true);
  expect(fs.statSync(runtime).mtimeMs).toBe(before);
  fs.rmSync(path);
  age(runtime);
  await pass(runtime);
  expect(fs.existsSync(runtime)).toBe(false);
});
it("keeps a newly created container whose filesystem timestamp rounded down by two seconds", async () => {
  const { runtime } = await fixture();
  const start = Date.parse("2026-10-27T12:00:01.999Z");
  const path = join(runtime, "workspaces/new");
  fs.mkdirSync(path);
  fs.utimesSync(path, new Date(start - 1999), new Date(start - 1999));
  pruneEmptyRuntimeDirectories(runtime, start, () => {});
  expect(fs.existsSync(path)).toBe(true);
  age(runtime);
  pruneEmptyRuntimeDirectories(runtime, start, () => {});
  expect(fs.existsSync(runtime)).toBe(false);
});
it("keeps unknown trees, run content, envelope bases and thread payloads", async () => {
  const { runtime } = await fixture();
  const payloads = [
    "unknown/empty",
    "constructor",
    "toString",
    "runs/live/context",
    "workspaces/task/a01/tree/empty",
    "workspaces/task/a01/home/.codex",
    "threads/live/tree/empty",
    "runs/.retiring/claim/empty",
  ];
  for (const path of payloads) fs.mkdirSync(join(runtime, path), { recursive: true });
  age(runtime);
  pruneEmptyRuntimeDirectories(runtime, Date.now(), () => {});
  for (const path of payloads) expect(fs.existsSync(join(runtime, path))).toBe(true);
});
it("reaps runs/.retiring on an aged second pass after real run retirement", async () => {
  const { root, runtime } = await fixture();
  // The producer, rather than the skeleton fixture, must create this container.
  fs.rmdirSync(join(runtime, "runs/.retiring"));
  const runRoot = join(runtime, "runs/run-old");
  fs.mkdirSync(runRoot);
  fs.writeFileSync(join(runRoot, "payload.txt"), "retire this payload");
  age(runtime);
  const retire = () =>
    runRetentionPass(
      { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
      { dry_run: false },
      {
        projects: () => [{ root, runsDir: join(runtime, "runs"), reviewsDir: null }],
        records: () => [
          { runId: "run-old", state: "succeeded", finishedAt: "2020-01-01T00:00:00.000Z" },
        ],
        referencedRunIds: () => new Set(),
      },
    );
  const first = await retire();
  expect(first.errors).toEqual([]);
  expect(first.deleted_runs.map((run) => run.run_id)).toEqual(["run-old"]);
  const holding = join(runtime, "runs/.retiring");
  expect(fs.readdirSync(holding)).toEqual([]);
  expect(fs.existsSync(join(runtime, ".retiring"))).toBe(false);
  age(runtime);
  expect((await retire()).errors).toEqual([]);
  expect(fs.existsSync(holding)).toBe(false);
  expect(fs.existsSync(join(runRoot, "tombstone.yaml"))).toBe(true);
});
it("never attempts rmdir for a listed nonempty container, even after removing its sibling", async () => {
  const { runtime } = await fixture();
  const occupied = join(runtime, "lanes/thread");
  const file = join(occupied, "owner");
  const sibling = join(runtime, "lanes/empty");
  fs.writeFileSync(file, "keep");
  fs.mkdirSync(sibling);
  age(runtime);
  await pass(runtime);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(sibling)).toBe(false);
  for (const path of [occupied, join(runtime, "lanes"), runtime])
    expect(fs.rmdirSync).not.toHaveBeenCalledWith(path);
});
it("keeps ENOTEMPTY handling when a file arrives after an empty listing", async () => {
  const { runtime, actual } = await fixture();
  const target = join(runtime, "patches");
  const file = join(target, "late.patch");
  vi.mocked(fs.rmdirSync).mockImplementation((path) => {
    if (path === target) fs.writeFileSync(file, "published during removal");
    actual.rmdirSync(path);
  });
  const receipt = await pass(runtime);
  expect(receipt.errors).toEqual([]);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(join(runtime, "lanes"))).toBe(false);
});
it.each([".git", "bare"])(
  "never enters a Git repository at a container boundary: %s",
  async (kind) => {
    const { runtime } = await fixture();
    const repository = join(runtime, "workspaces");
    if (kind === ".git") fs.writeFileSync(join(repository, ".git"), "gitdir: /unused");
    else {
      fs.writeFileSync(join(repository, "HEAD"), "ref: refs/heads/main\n");
      fs.mkdirSync(join(repository, "objects"));
    }
    age(runtime);
    pruneEmptyRuntimeDirectories(runtime, Date.now(), () => {});
    expect(fs.existsSync(join(repository, "task"))).toBe(true);
  },
);
it.each(["EACCES", "EPERM", "EBUSY"])(
  "counts %s for one directory and continues to sibling containers",
  async (code) => {
    const { runtime, actual } = await fixture();
    const blocked = join(runtime, "workspaces/blocked"),
      sibling = join(runtime, "workspaces/sibling");
    fs.mkdirSync(blocked);
    fs.mkdirSync(sibling);
    age(runtime);
    vi.mocked(fs.rmdirSync).mockImplementation((path) => {
      if (path === blocked)
        throw Object.assign(new Error(`${code}: fixture busy directory`), { code });
      actual.rmdirSync(path);
    });
    const receipt = await pass(runtime);
    expect(receipt.errors.filter((error) => error.includes(code))).toEqual([
      expect.stringContaining(blocked),
    ]);
    expect(fs.existsSync(blocked)).toBe(true);
    expect(fs.existsSync(sibling)).toBe(false);
  },
);
it("yields to admission between namespace container sweeps", async () => {
  const { root, runtime, actual } = await fixture();
  const other = join(root, "other");
  fs.mkdirSync(join(other, "runs"), { recursive: true });
  age(other);
  let admitted = false;
  let admittedBeforeNext = false;
  vi.mocked(fs.rmdirSync).mockImplementation((path) => {
    actual.rmdirSync(path);
    if (path === runtime)
      setImmediate(() => {
        admitted = true;
      });
    if (path === other) admittedBeforeNext = admitted;
  });
  await runRetentionPass(
    { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 },
    { dry_run: false },
    {
      projects: () =>
        [runtime, other].map((root) => ({ root, runsDir: join(root, "runs"), reviewsDir: null })),
      records: () => [],
      referencedRunIds: () => new Set(),
    },
  );
  expect(fs.existsSync(other)).toBe(false);
  expect(admittedBeforeNext).toBe(true);
});
it("never follows links or visits tombstones and frozen stores", async () => {
  const { root, runtime } = await fixture();
  const outside = join(root, "outside/empty");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(join(root, "outside"), join(runtime, "workspaces/linked"), "dir");
  for (const name of [
    "journal-legacy",
    "journal-archived",
    "resource-store/idempotency",
    "runs/expired/keep-empty",
  ])
    fs.mkdirSync(join(runtime, name), { recursive: true });
  fs.writeFileSync(
    join(runtime, "runs/expired/tombstone.yaml"),
    "run_id: expired\ndeleted_at: 2020-01-01\n",
  );
  age(runtime);
  await pass(runtime);
  for (const name of [
    "journal-legacy",
    "journal-archived",
    "resource-store/idempotency",
    "runs/expired/keep-empty",
    "workspaces/linked",
  ])
    expect(fs.existsSync(join(runtime, name))).toBe(true);
  expect(fs.existsSync(outside)).toBe(true);
});
