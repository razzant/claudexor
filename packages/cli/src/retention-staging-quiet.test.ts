// #694 V17: the daemon's ordinary retention pass reads a held object-store
// staging with what the daemon recorded of its scope. A staging whose writer
// was never recorded (`writer: null`: the transfer's next write failed, or its
// daemon died) and whose creator is gone is decided by its scope read; the
// scope's index row names a captured member whose birth cannot be read now,
// which a bare marker census cannot see. The real runner, its real store prune
// and the real `preparationQuietFor(index)` read it; that staging stays. Once
// the member is gone from the table, the same pass removes it, and a legacy
// staging without a record keeps its age policy.
//
// Nothing here starts, probes or signals a process: the creator's pid 0 is read
// as gone without any probe, and only the platform's census and process table
// are replaced (deterministic objects, below `preparationQuiet`).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CapturedProcess, ProcessTableReader } from "@claudexor/core";

const reads: Array<{ marker?: string; captured?: readonly CapturedProcess[] }> = [];
let table: ProcessTableReader;
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  const census = core.createLinuxScopeCensusReader({
    listProc: async () => ["self"],
    readTextFile: async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    statUid: async () => 501,
    selfUid: 501,
  });
  return {
    ...core,
    preparationQuiet: (
      facts: Parameters<typeof core.preparationQuiet>[0],
      options: Parameters<typeof core.preparationQuiet>[1] = {},
    ) => {
      reads.push({ marker: facts.marker, captured: options.sources?.captured });
      return core.preparationQuiet(facts, {
        ...options,
        platform: "linux",
        table,
        census: (opts) => new core.ScopeReaper().reap({ ...opts, census }),
      });
    },
  };
});

const { NO_GROUP_BASIS, mintRunScopeMarker } = await import("@claudexor/core");
const { ensureObjectStore, objectStorePath, writeStagingOwner } =
  await import("@claudexor/workspace");
const { sqlFixture } = await import("../../daemon/src/store/test-support/sql-fixture.js");
const { createRetentionRunner } = await import("./retention-service.js");
const { preparationQuietFor } = await import("./thread-preparation-scope.js");
type RunScopeEntry = import("./run-scope-index-rows.js").RunScopeEntry;

const roots: string[] = [];
afterEach(() => {
  reads.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const BIRTH = "Sat Nov 15 10:00:00 2026";
const MEMBER: CapturedProcess = { pid: 30, pgid: NO_GROUP_BASIS, birth: BIRTH };
const OLD = new Date(Date.now() - 2 * 3_600_000);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function staging(store: string, name: string, marker: string | null): string {
  const dir = join(store, "objects", `tmp_claudexor-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transfer.pack"), "x");
  if (marker)
    writeStagingOwner(dir, {
      schema: 1,
      intent: "index-pack",
      creator: { pid: 0 },
      scope: { marker },
      writer: null,
    });
  for (const path of [join(dir, "transfer.pack"), join(dir, "owner.json"), dir])
    if (existsSync(path)) utimesSync(path, OLD, OLD);
  return dir;
}

it("ordinary retention keeps a writer-null staging while its scope's recorded member is unreadable, and removes it once that member is gone (#694 V17)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-retention-staging-")));
  roots.push(root);
  const before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  const sql = await sqlFixture(join(root, "sql"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, env: ENV });
    sql.graph.projects.register({ root: repo, idempotencyKey: "project", clientId: "fixture" });
    await ensureObjectStore(repo, "sha1");
    const store = objectStorePath(repo);
    const marker = mintRunScopeMarker();
    const held = staging(store, "held", marker);
    const legacy = staging(store, "legacy", null);
    const entry: RunScopeEntry = {
      marker,
      run_id: "thread-preparation:job-1",
      owner: null,
      state: "unresolved",
      opened_at: "2026-11-15T09:59:00.000Z",
      scope_start: null,
      root_groups: [],
      captured: [MEMBER],
    };
    const runner = createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => [],
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
      preparationQuiet: preparationQuietFor({ list: () => [entry] }),
    });

    table = {
      snapshot: async () => [{ pid: 30, ppid: 1, pgid: 30, birth: BIRTH }],
      row: async () => "unreadable",
    };
    const first = await runner({ dry_run: false });
    expect(first.errors).toEqual([]);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    // The read the prune made carried the index row's captured member.
    expect(reads).toEqual([{ marker, captured: [MEMBER] }]);

    table = { snapshot: async () => [], row: async () => null };
    await runner({ dry_run: false });
    expect(existsSync(held)).toBe(false);
  } finally {
    await sql.close();
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
  }
});
