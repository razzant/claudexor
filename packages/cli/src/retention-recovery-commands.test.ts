// Real SQL journal recovery regressions.
// A delivery that was in flight when its project generation needed recovery is
// never settled afterwards (startup recovery settles only served generations).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { SqlPartitionRecovery } from "@claudexor/daemon";
import { WorkProduct } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import {
  globalGeneration,
  quarantineGeneration,
  setGenerationStatusInTx,
} from "../../daemon/dist/store/generations.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
import { createRetentionRunner } from "./retention-service.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-opus-qdelivery-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
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

it.each([
  ["delivery", "project"],
  ["product", "project"],
  ["delivery", "global"],
  ["product", "global"],
  ["pending-child", "global"],
])("ignores a hidden %s after completed %s recovery and SQL reopen", async (kind, owner) => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const project = sql.graph.projects.register({
    root: repo,
    idempotencyKey: "repo",
    clientId: "fixture",
  }).project;
  const scope = { kind: "project", root: repo };
  if (kind === "delivery")
    sql.graph.commands.beginDelivery(
      { mode: "agent", prompt: "apply", scope },
      {
        key: "apply-1",
        client: "fixture",
        operation: "run.apply",
        request: { runId: "some-run" },
      },
    );
  else if (kind === "product") {
    const commands = sql.graph.commands.forRequest({ scope });
    commands.accept({
      id: "abandoned",
      params: { mode: "ask", prompt: "continue", scope },
      idempotencyKey: "abandoned",
      clientId: "fixture",
    });
    commands.update("abandoned", { state: "running" });
  }
  const pid = sql.graph.projects.partition(project.id)!.pid;
  if (owner === "project" || kind === "pending-child")
    sql.store.transaction(() => setGenerationStatusInTx(sql.store, pid, "recovery_required"));
  if (owner === "global") {
    const globalPid = globalGeneration(sql.store)!.pid;
    sql.store.transaction(() => setGenerationStatusInTx(sql.store, globalPid, "recovery_required"));
    const recovery = new SqlPartitionRecovery(
      sql.store,
      sql.graph.blobs,
      sql.graph.maintenance,
      "global",
      { projections: () => [] },
    );
    recovery.quarantineAndStartFresh({
      confirmation: "quarantine_and_start_fresh",
      expectedFingerprint: recovery.inspect().fingerprint,
      idempotencyKey: "global-recovery",
    });
  } else
    quarantineGeneration(sql.store, sql.graph.blobs, {
      oldPid: pid,
      keyDigest: "k",
      requestDigest: "k",
      operationId: "op-k",
      payload: { operationId: "op-k" },
    });
  await sql.close();
  sql = await sqlFixture(join(root, "sql"));
  await sql.graph.recoverAfterStartup(); // a later daemon restart
  const left = sql.store.prepare("SELECT state,live FROM command WHERE kind='delivery'").all();
  // An unrelated old run in the healthy no-project scope.
  const paths = new ArtifactStore(noProjectRepoRoot()).createRun("unrelated-old");
  writeFileSync(join(paths.finalDir, "answer.md"), "old");
  writeFileSync(
    join(paths.finalDir, "work_product.yaml"),
    JSON.stringify(
      WorkProduct.parse({
        id: "wp",
        kind: "report",
        source_task_id: "t",
        files: { answer: "final/answer.md" },
        meta: { result_kind: "report", lifecycle: "succeeded" },
      }),
    ),
  );
  const params = { mode: "ask", prompt: "x", scope: { kind: "none" } };
  const store = sql.graph.commands.current();
  store.accept({ id: "job-unrelated", params, idempotencyKey: "u", clientId: "fixture" });
  store.update("job-unrelated", {
    state: "succeeded",
    runId: "unrelated-old",
    runDir: paths.root,
    finishedAt: "2020-01-01T00:00:00.000Z",
  });
  let outcome: unknown;
  try {
    const receipt = await createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => sqlActivityRecords(sql.store),
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
    })({ dry_run: false });
    outcome = { deleted: receipt.deleted_runs.map((r) => r.run_id), errors: receipt.errors };
  } catch (error) {
    outcome = { threw: error instanceof Error ? error.message : String(error) };
  }
  console.log(
    "PROBE-Q4 delivery rows after restart:",
    JSON.stringify(left),
    "outcome:",
    JSON.stringify(outcome),
    "unrelated answer on disk:",
    existsSync(join(paths.finalDir, "answer.md")),
  );
  expect(outcome).toEqual({ deleted: ["unrelated-old"], errors: [] });
  const proof = await sql.graph.threads.retentionReferences();
  expect(proof.hasActiveCommands!()).toBe(false);
  expect(proof.nativeCurrent!()).toBe(true);
  proof.close?.();
  let pruneCalls = 0;
  const native = createNativeHomeRetention({
    threads: sql.graph.threads,
    isBusy: () => false,
    profiles: () => [],
    registry: () =>
      new Map([
        [
          "codex",
          {
            nativeHomeLifetime: {
              status: "managed",
              preserves: "fixture",
              home: () => join(root, "engine", "native"),
              prune: async () => {
                pruneCalls++;
                return {
                  deleted_files: [],
                  errors: [],
                  freed_bytes: 0,
                  kept_referenced: 0,
                  kept_recent: 0,
                  kept_unknown: 0,
                  truncated: false,
                };
              },
            },
          },
        ],
      ]) as never,
  });
  const nativeReceipt = await native({
    dryRun: false,
    olderThan: Date.now(),
    ignoredRunIds: new Set(),
    ignoredThreadIds: new Set(),
  });
  expect(nativeReceipt.errors).toEqual([]);
  expect(pruneCalls).toBe(1);
});
