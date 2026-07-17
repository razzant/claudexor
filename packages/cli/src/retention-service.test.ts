import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectPartitions, ProjectStore } from "@claudexor/daemon";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createRetentionRunner } from "./retention-service.js";

const roots: string[] = [];
let previousConfigDir: string | undefined;

beforeEach(() => {
  // Run trees live in the per-project RUNTIME dir under the user config dir,
  // not inside the repo — scope it so fixtures never touch the real one.
  previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  const configDir = mkdtempSync(join(tmpdir(), "claudexor-retention-cfg-"));
  roots.push(configDir);
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  // keep_last_runs_per_project defaults to 20 — a single aged run would be
  // spared as "recent". These tests are about the health/serialization gates,
  // so the keep-N sparing (covered in retention.test.ts) is set aside.
  writeFileSync(join(configDir, "config.yaml"), "retention:\n  keep_last_runs_per_project: 0\n");
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project root whose runtime dir holds one long-terminal run tree. */
function projectWithAgedRun(runId: string): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-retention-svc-"));
  roots.push(root);
  const runDir = join(new ArtifactStore(root).runsDir(), runId);
  mkdirSync(join(runDir, "final"), { recursive: true });
  writeFileSync(join(runDir, "final", "summary.md"), "# done\n");
  return root;
}

function deps(input: {
  projectRoots: string[];
  healthyRoots: string[];
  threadRunIds?: string[];
  records: Array<{ runId: string; state: string; finishedAt: string }>;
}) {
  const projects = {
    list: () => input.projectRoots.map((root, i) => ({ id: `p${i}`, root })),
  } as unknown as ProjectStore;
  const threads = {
    healthyProjectRoots: () => input.healthyRoots,
    listThreads: () => (input.threadRunIds ? [{ id: "t1", run_ids: input.threadRunIds }] : []),
    turnsFor: () => [],
  } as unknown as ProjectPartitions;
  return {
    projects: () => projects,
    threads,
    daemonJobs: async () => input.records,
  };
}

const ancient = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();

describe("retention service composition", () => {
  it("fails CLOSED for a project whose partition journal is quarantined (W3.6)", async () => {
    // The reference set (listThreads/turnsFor) only spans READY partitions. If
    // a quarantined project's runs were still swept, they would be judged
    // against an EMPTY reference set and a live thread's history would vanish.
    const root = projectWithAgedRun("run-quarantined");
    const run = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [], // partition not ready
        records: [{ runId: "run-quarantined", state: "succeeded", finishedAt: ancient }],
      }),
    )({ dry_run: true });
    // Not examined at all — the project is skipped, its runs protected.
    expect(run.deleted_runs).toEqual([]);
    expect(run.examined_runs).toBe(0);
  });

  it("sweeps a project once its partition is healthy", async () => {
    const root = projectWithAgedRun("run-healthy");
    const run = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        records: [{ runId: "run-healthy", state: "succeeded", finishedAt: ancient }],
      }),
    )({ dry_run: true });
    expect(run.examined_runs).toBe(1);
    expect(run.deleted_runs.map((d) => d.run_id)).toEqual(["run-healthy"]);
  });

  it("serializes concurrent passes so receipts never cross-report deletions", async () => {
    const root = projectWithAgedRun("run-serial");
    const runner = createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        records: [{ runId: "run-serial", state: "succeeded", finishedAt: ancient }],
      }),
    );
    // Startup pass and an operator `gc` firing together: the second waits, so
    // exactly one pass performs (and reports) the deletion.
    const [first, second] = await Promise.all([
      runner({ dry_run: false }),
      runner({ dry_run: false }),
    ]);
    const deleted = [...first.deleted_runs, ...second.deleted_runs];
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.run_id).toBe("run-serial");
  });
});
