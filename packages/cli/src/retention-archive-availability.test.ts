// INV-034/035: optional archive availability cannot stop unrelated retirement.
import {
  chmodSync,
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
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";

for (const kind of ["ENOENT", "ENOTDIR", "EACCES"] as const) {
  it.skipIf(kind === "EACCES" && (process.platform === "win32" || process.getuid?.() === 0))(
    `continues both passes when an archived root reports ${kind}`,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-archive-availability-")));
      const before = process.env.CLAUDEXOR_CONFIG_DIR;
      process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
      mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
      const sql = await sqlFixture(join(root, "sql"));
      const parent = join(root, "parent");
      const repo = join(parent, "repo");
      try {
        mkdirSync(repo, { recursive: true });
        const project = sql.graph.projects.register({
          root: repo,
          idempotencyKey: "archive",
          clientId: "fixture",
        }).project;
        sql.graph.projects.unregister(project.id);
        const thread = sql.graph.threads.createThread({
          title: "foreign reference",
          workspace: "in_place",
        });
        sql.graph.threads.createTurn(thread.id, "keep evidence", { parentRunId: "archive-held" });
        const seed = (projectRoot: string, id: string) => {
          const paths = new ArtifactStore(projectRoot).createRun(id);
          writeFileSync(join(paths.finalDir, "failure.yaml"), "terminal failure");
          utimesSync(paths.root, new Date("2020-01-01"), new Date("2020-01-01"));
          return paths.root;
        };
        const cold = seed(repo, "archive-cold");
        const held = seed(repo, "archive-held");
        if (kind === "EACCES") chmodSync(parent, 0o000);
        else {
          rmSync(parent, { recursive: true });
          if (kind === "ENOTDIR") writeFileSync(parent, "parent became a file");
        }
        const nativeHomes = vi.fn(async () => ({
          reports: [],
          errors: [],
          freedBytes: 0,
          truncated: false,
        }));
        const gc = createRetentionRunner({
          projects: () => sql.graph.projects,
          threads: sql.graph.threads,
          daemonJobs: () => [],
          purgeThread: async () => {},
          hasPurgeLeftovers: () => false,
          nativeHomes,
        });
        for (let pass = 1; pass <= 2; pass++) {
          const neighbor = `neighbor-${pass}`;
          seed(join(root, "orphan"), neighbor);
          const receipt = await gc({ dry_run: false });
          expect(receipt.policy.keep_last_runs_per_project).toBe(20);
          expect(receipt.deleted_runs.map((run) => run.run_id).sort()).toEqual(
            pass === 1 && kind !== "EACCES" ? ["archive-cold", neighbor] : [neighbor],
          );
          expect(existsSync(join(held, "final", "failure.yaml"))).toBe(true);
          expect(existsSync(join(cold, "final", "failure.yaml"))).toBe(kind === "EACCES");
          if (kind === "EACCES") {
            expect(receipt.errors).toHaveLength(1);
            expect(receipt.errors[0]).toContain(repo);
            expect(receipt.errors[0]).toContain("EACCES");
            expect(receipt.errors[0]).toContain("keep-last preserved");
          } else expect(receipt.errors).toEqual([]);
        }
        expect(nativeHomes).toHaveBeenCalledTimes(2);
      } finally {
        if (kind === "EACCES") chmodSync(parent, 0o755);
        await sql.close();
        if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
        else process.env.CLAUDEXOR_CONFIG_DIR = before;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
