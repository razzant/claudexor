// Real SQL journal recovery regressions.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { WorkProduct } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import {
  globalGeneration,
  isServedPid,
  quarantineGeneration,
  setGenerationStatusInTx,
} from "../../daemon/dist/store/generations.js";
import { createRetentionRunner } from "./retention-service.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-opus-recovery-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  // Same policy on base and head so both may retire an old no-project/registered run.
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR, "config.yaml"),
    "retention:\n  keep_last_runs_per_project: 0\n",
  );
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

function oldRun(repoRoot: string, id: string, scope: Record<string, unknown>) {
  const paths = new ArtifactStore(repoRoot).createRun(id);
  writeFileSync(join(paths.finalDir, "answer.md"), `Evidence for ${id}`);
  writeFileSync(
    join(paths.finalDir, "work_product.yaml"),
    JSON.stringify(
      WorkProduct.parse({
        id: `wp-${id}`,
        kind: "report",
        source_task_id: `task-${id}`,
        files: { answer: "final/answer.md" },
        meta: { result_kind: "report", lifecycle: "succeeded" },
      }),
    ),
  );
  const params = { mode: "ask", prompt: "investigate", scope };
  const store = sql.graph.commands.forRequest(params);
  store.accept({ id: `job-${id}`, params, idempotencyKey: `job-${id}`, clientId: "fixture" });
  store.update(`job-${id}`, {
    state: "succeeded",
    runId: id,
    runDir: paths.root,
    finishedAt: "2020-01-01T00:00:00.000Z",
  });
  return paths;
}
function runner() {
  return createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => sqlActivityRecords(sql.store), // production provider
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
  });
}
/** The documented SQL journal recovery: a corrupt partition is marked
 * recovery_required, then "quarantine and start fresh" moves authority to a new
 * generation and preserves the old one as quarantined evidence. */
function journalRecovery(pid: number, key: string) {
  sql.store.transaction(() => setGenerationStatusInTx(sql.store, pid, "recovery_required"));
  const outcome = quarantineGeneration(sql.store, sql.graph.blobs, {
    oldPid: pid,
    keyDigest: key,
    requestDigest: key,
    operationId: `op-${key}`,
    payload: { operationId: `op-${key}` },
  });
  expect(outcome.replay).toBe(false);
  return outcome.generation!;
}

it("retires old runs after completed global journal recovery", async () => {
  const noProject = noProjectRepoRoot();
  const oldGlobal = globalGeneration(sql.store)!.pid;
  const fresh = journalRecovery(oldGlobal, "global-recovery");
  expect(isServedPid(sql.store, fresh.pid)).toBe(true); // recovery finished; global is healthy again
  const status = sql.store.prepare("SELECT status FROM partition WHERE id=?").get(oldGlobal);
  console.log("PROBE-Q1 old global status after recovery:", JSON.stringify(status));
  const after = oldRun(noProject, "old-after-recovery", { kind: "none" });
  let outcome: unknown;
  try {
    const receipt = await runner()({ dry_run: false });
    outcome = { deleted: receipt.deleted_runs.map((r) => r.run_id), errors: receipt.errors };
  } catch (error) {
    outcome = { threw: error instanceof Error ? error.message : String(error) };
  }
  console.log("PROBE-Q1 outcome:", JSON.stringify(outcome));
  console.log(
    "PROBE-Q1 old run answer still on disk:",
    existsSync(join(after.finalDir, "answer.md")),
  );
  expect(outcome).toEqual({ deleted: ["old-after-recovery"], errors: [] });
});

it("retires pre- and post-recovery terminal runs after completed project recovery", async () => {
  const repo = join(root, "registered-repo");
  mkdirSync(repo);
  const project = sql.graph.projects.register({
    root: repo,
    idempotencyKey: "registered",
    clientId: "fixture",
  }).project;
  const scope = { kind: "project", root: repo };
  const beforeRecovery = oldRun(repo, "old-before-recovery", scope);
  const pid = sql.graph.projects.partition(project.id)!.pid;
  const fresh = journalRecovery(pid, "project-recovery");
  expect(isServedPid(sql.store, fresh.pid)).toBe(true);
  expect(sql.graph.threads.healthyProjectRoots()).toContain(repo);
  const afterRecovery = oldRun(repo, "old-after-recovery", scope);
  const snapshot = await sql.graph.threads.retentionReferences();
  console.log(
    "PROBE-Q2 protectedProjectRoots:",
    JSON.stringify([...snapshot.protectedProjectRoots]),
  );
  snapshot.close?.();
  const receipt = await runner()({ dry_run: false });
  console.log(
    "PROBE-Q2 receipt:",
    JSON.stringify({
      deleted: receipt.deleted_runs.map((r) => r.run_id),
      kept: receipt.kept,
      errors: receipt.errors,
    }),
  );
  console.log(
    "PROBE-Q2 answers on disk:",
    existsSync(join(beforeRecovery.finalDir, "answer.md")),
    existsSync(join(afterRecovery.finalDir, "answer.md")),
  );
  expect(receipt.deleted_runs.map((r) => r.run_id).sort()).toEqual([
    "old-after-recovery",
    "old-before-recovery",
  ]);
});

it("ignores malformed quarantined references while retiring unrelated old runs", async () => {
  const repo = join(root, "corrupt-repo");
  mkdirSync(repo);
  const project = sql.graph.projects.register({
    root: repo,
    idempotencyKey: "corrupt",
    clientId: "fixture",
  }).project;
  const pid = sql.graph.projects.partition(project.id)!.pid;
  // The row the recovery validator would reject (Thread.parse fails) — the reason for quarantine.
  sql.store.transaction(() =>
    sql.store
      .prepare("INSERT INTO thread(id,pid,state,updated_at,body) VALUES(?,?,?,?,?)")
      .run(
        "th-corrupt",
        pid,
        "active",
        "2026-09-01T00:00:00.000Z",
        Buffer.from('{"id":"th-corrupt","state":"active"}'),
      ),
  );
  journalRecovery(pid, "corrupt-project-recovery");
  // An unrelated old orphan-free no-project run elsewhere.
  const other = oldRun(noProjectRepoRoot(), "unrelated-old", { kind: "none" });
  let outcome: unknown;
  try {
    const receipt = await runner()({ dry_run: false });
    outcome = { deleted: receipt.deleted_runs.map((r) => r.run_id), errors: receipt.errors };
  } catch (error) {
    outcome = { threw: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  }
  console.log(
    "PROBE-Q3 outcome:",
    JSON.stringify(outcome),
    "unrelated answer on disk:",
    existsSync(join(other.finalDir, "answer.md")),
  );
  expect(outcome).toEqual({ deleted: ["unrelated-old"], errors: [] });
});

it.each(["recovery_required", "repairing"])(
  "names a pending global %s hold in the receipt",
  async (status) => {
    const paths = oldRun(noProjectRepoRoot(), "pending-global-old", { kind: "none" });
    const pid = globalGeneration(sql.store)!.pid;
    sql.store.transaction(() => setGenerationStatusInTx(sql.store, pid, status));
    const receipt = await runner()({ dry_run: false });
    expect(receipt.deleted_runs).toEqual([]);
    expect(receipt.errors.join("\n")).toContain(
      `global (${pid}, ${status}) awaits journal recovery`,
    );
    expect(receipt.errors.join("\n")).toContain(noProjectRepoRoot());
    expect(existsSync(join(paths.finalDir, "answer.md"))).toBe(true);
  },
);

it.each(["recovery_required", "repairing"])(
  "holds every namespace while a project awaits %s",
  async (status) => {
    const repo = join(root, "pending-project");
    mkdirSync(repo);
    const project = sql.graph.projects.register({
      root: repo,
      idempotencyKey: "pending",
      clientId: "fixture",
    }).project;
    const paths = oldRun(repo, "pending-project-old", { kind: "project", root: repo });
    oldRun(noProjectRepoRoot(), "unrelated-old", { kind: "none" });
    const pid = sql.graph.projects.partition(project.id)!.pid;
    sql.store.transaction(() => setGenerationStatusInTx(sql.store, pid, status));
    const receipt = await runner()({ dry_run: false });
    expect(receipt.deleted_runs).toEqual([]);
    expect(receipt.errors.join("\n")).toContain("all namespaces kept:");
    expect(receipt.errors.join("\n")).toContain(`(${pid}, ${status}) awaits journal recovery`);
    expect(existsSync(join(paths.finalDir, "answer.md"))).toBe(true);
  },
);

it("holds a pending owner's cross-project source at default policy, then releases completed recovery", async () => {
  rmSync(join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"));
  const foreign = join(root, "foreign-orphan");
  mkdirSync(foreign);
  const source = oldRun(foreign, "foreign-source", {
    kind: "project",
    root: foreign,
    ephemeral: true,
  });
  const destination = join(root, "destination");
  mkdirSync(destination);
  const project = sql.graph.projects.register({
    root: destination,
    idempotencyKey: "destination",
    clientId: "fixture",
  }).project;
  const params = {
    mode: "ask",
    prompt: "continue",
    scope: { kind: "project", root: destination },
    continueFrom: "foreign-source",
  };
  sql.graph.commands
    .forRequest(params)
    .accept({ id: "successor", params, idempotencyKey: "successor", clientId: "fixture" });
  const pid = sql.graph.projects.partition(project.id)!.pid;
  sql.store.transaction(() => setGenerationStatusInTx(sql.store, pid, "recovery_required"));
  const receipt = await runner()({ dry_run: false });
  expect(receipt.policy.keep_last_runs_per_project).toBe(20);
  expect(receipt.deleted_runs).toEqual([]);
  expect(receipt.errors.join("\n")).toContain(
    `(${pid}, recovery_required) awaits journal recovery`,
  );
  expect(existsSync(join(source.finalDir, "answer.md"))).toBe(true);
  journalRecovery(pid, "foreign-owner-recovery");
  const released = await runner()({ dry_run: false });
  expect(released.deleted_runs.map((run) => run.run_id)).toEqual(["foreign-source"]);
});
