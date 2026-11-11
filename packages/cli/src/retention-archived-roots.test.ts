// INV-034/035: recent history belongs to active projects and extant archives.
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
import { expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";

it.each(["archived-present", "active-missing", "archived-missing", "reregistered-active-missing"])(
  "applies default keep-last to %s while always preserving references",
  async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-archive-history-")));
    const before = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
    mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
    const sql = await sqlFixture(join(root, "sql"));
    try {
      const repo = join(root, "review-checkout");
      mkdirSync(repo);
      const project = sql.graph.projects.register({
        root: repo,
        idempotencyKey: "project",
        clientId: "fixture",
      }).project;
      if (kind === "reregistered-active-missing") {
        sql.graph.projects.unregister(project.id);
        sql.graph.projects.register({
          root: repo,
          idempotencyKey: "new-registration",
          clientId: "fixture",
        });
      }
      const thread = sql.graph.threads.createThread({ title: "reference", workspace: "in_place" });
      sql.graph.threads.createTurn(thread.id, "retain foreign evidence", { parentRunId: "held" });
      if (kind.endsWith("missing")) rmSync(repo, { recursive: true });
      if (kind === "archived-present") sql.graph.projects.unregister(project.id);
      if (kind === "archived-missing")
        expect(sql.graph.threads.quarantineGhostProjects()).toEqual([
          { projectId: project.id, root: repo, reason: "root_permanently_missing" },
        ]);
      const coldIds = Array.from(
        { length: kind === "archived-missing" ? 3 : 20 },
        (_, i) => `cold-${i}`,
      );
      const paths = new Map<string, string>();
      for (const id of ["held", ...coldIds]) {
        const run = new ArtifactStore(repo).createRun(id);
        writeFileSync(join(run.finalDir, "failure.yaml"), "terminal failure");
        utimesSync(
          run.root,
          new Date(id === "held" ? "2019-01-01" : "2020-01-01"),
          new Date(id === "held" ? "2019-01-01" : "2020-01-01"),
        );
        paths.set(id, run.root);
      }
      const receipt = await createRetentionRunner({
        projects: () => sql.graph.projects,
        threads: sql.graph.threads,
        daemonJobs: () => [],
        purgeThread: async () => {},
        hasPurgeLeftovers: () => false,
      })({ dry_run: false });
      expect(receipt.policy.keep_last_runs_per_project).toBe(20);
      expect(existsSync(join(paths.get("held")!, "final", "failure.yaml"))).toBe(true);
      expect(receipt.kept.referenced).toBe(1);
      if (kind === "archived-missing") {
        expect(receipt.deleted_runs.map((run) => run.run_id).sort()).toEqual(coldIds);
        expect(receipt.kept.recent).toBe(0);
      } else {
        expect(receipt.deleted_runs).toEqual([]);
        expect(receipt.kept.recent).toBe(20);
      }
    } finally {
      await sql.close();
      if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = before;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
