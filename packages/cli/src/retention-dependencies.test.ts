import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { ControlRunStartRequest, WorkProduct } from "@claudexor/schema";
import { writeContinuationSources } from "@claudexor/workspace";
import { completeDeliveryCommand } from "../../daemon/src/delivery-command.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { admitCommandRequest } from "../../daemon/src/command-rpc.js";
import { createRetentionRunner } from "./retention-service.js";
import { continuationForRun } from "./continue-from-run.js";
import { exactRetryProcessingIntent } from "./retry-processing.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let repo: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-retention-dependencies-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  repo = join(root, "ephemeral-checkout");
  mkdirSync(repo);
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
const params = () => ({
  mode: "ask",
  prompt: "investigate",
  scope: { kind: "project", root: repo, ephemeral: true },
});
function accept(id: string, extra: Record<string, unknown> = {}) {
  const request = { ...params(), ...extra };
  admitCommandRequest(sql.graph.commands, request, "run.create");
  sql.graph.commands
    .current()
    .accept({ id, params: request, idempotencyKey: id, clientId: "fixture" });
  return request;
}
function oldRun(id: string, extra: Record<string, unknown> = {}) {
  const paths = new ArtifactStore(repo).createRun(id);
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
  accept(`job-${id}`, extra);
  sql.graph.commands.current().update(`job-${id}`, {
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
    daemonJobs: () => sql.records(),
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
  });
}

it.each(["queued", "running"])(
  "retains a %s continuation's predecessor and ancestors at default keep-last",
  async (state) => {
    const ancestor = oldRun("ancestor");
    const parent = oldRun("parent", { continueFrom: "ancestor" });
    const neighbor = oldRun("neighbor");
    const request = accept("successor", { continueFrom: "parent" });
    if (state === "running")
      sql.graph.commands.current().update("successor", { state: "running", runId: "successor" });
    const resolve = () =>
      continuationForRun(ControlRunStartRequest.parse(request), sql.graph.commands.queries);
    expect(resolve().from?.ancestors?.map((r) => r.runId)).toEqual(["ancestor"]);
    const snapshot = await sql.graph.threads.retentionReferences();
    expect(snapshot.referencedRunIds.has("parent")).toBe(true);
    expect(snapshot.referencedRunIds.has("ancestor")).toBe(true);
    const receipt = await runner()({ dry_run: false });
    expect(receipt.policy.keep_last_runs_per_project).toBe(20);
    expect(receipt.deleted_runs.map((r) => r.run_id)).toEqual(["neighbor"]);
    expect(receipt.errors).toEqual([]);
    for (const paths of [ancestor, parent])
      expect(existsSync(join(paths.finalDir, "answer.md"))).toBe(true);
    expect(existsSync(join(neighbor.finalDir, "answer.md"))).toBe(false);
    expect(resolve().from?.runDir).toBe(parent.root);
  },
);

it.each(["queued", "running"])(
  "retains %s Exact Retry processing intent and frozen plan sources",
  async (state) => {
    const source = oldRun("retry-source");
    const plan = oldRun("plan-source");
    oldRun("neighbor");
    const intent = {
      codex: {
        requested: null,
        submitted: "fast",
        submittedNative: "fast",
        observed: "unknown",
        observedNative: [],
        reason: "native_explicit",
        source: "codex.managed_config",
      },
    };
    writeFileSync(
      join(source.root, "context", "processing_intent.yaml"),
      JSON.stringify({ schema_version: 1, harnesses: intent }),
    );
    writeFileSync(join(plan.finalDir, "plan.md"), "Frozen plan");
    const request = accept("retry", {
      retryOf: "retry-source",
      planRef: {
        runId: "plan-source",
        path: join(plan.finalDir, "plan.md"),
        sha256: "a".repeat(64),
      },
    });
    if (state === "running")
      sql.graph.commands.current().update("retry", { state: "running", runId: "retry" });
    const receipt = await runner()({ dry_run: false });
    expect(receipt.deleted_runs.map((r) => r.run_id)).toEqual(["neighbor"]);
    expect(receipt.errors).toEqual([]);
    expect(
      exactRetryProcessingIntent(
        ControlRunStartRequest.parse(request),
        sql.graph.commands.queries,
        repo,
      ),
    ).toEqual(intent);
    expect(readFileSync(join(plan.finalDir, "plan.md"), "utf8")).toBe("Frozen plan");
  },
);

it("refuses an expired predecessor while allowing intact evidence beyond an expired ancestor", async () => {
  const source = oldRun("expired");
  const gc = runner();
  expect((await gc({ dry_run: false })).deleted_runs.map((r) => r.run_id)).toEqual(["expired"]);
  expect(existsSync(source.root)).toBe(true);
  expect(() => accept("too-late", { continueFrom: "expired" })).toThrow(
    expect.objectContaining({ code: "run_expired_by_retention", status: 410 }),
  );
  expect(sql.graph.commands.current().get("too-late")).toBeUndefined();
  // A historical intact head supplies its own evidence after upgrade.
  const ancestor = oldRun("ancestor");
  oldRun("head", { continueFrom: "ancestor" });
  writeFileSync(join(ancestor.root, "tombstone.yaml"), "published expiration");
  expect(() => accept("intact-chain", { continueFrom: "head" })).not.toThrow();
});

it("fails closed on unreadable immutable command dependencies", async () => {
  const source = oldRun("otherwise-deletable");
  accept("queued");
  sql.store.transaction(() =>
    sql.store
      .prepare(
        "UPDATE blob SET inline=? WHERE sha256=(SELECT params_sha FROM command WHERE id='queued')",
      )
      .run(Buffer.from("unreadable")),
  );
  await expect(runner()({ dry_run: false })).rejects.toThrow();
  expect(existsSync(join(source.finalDir, "answer.md"))).toBe(true);
});

it("retains durable continuation ancestors after intermediate command history is pruned", async () => {
  const ancestor = oldRun("ancestor");
  const parent = oldRun("parent", { continueFrom: "ancestor" });
  const head = oldRun("head", { continueFrom: "parent" });
  oldRun("neighbor");
  writeContinuationSources(
    head.root,
    [ancestor, parent].map((p) => ({
      runId: p === ancestor ? "ancestor" : "parent",
      runDir: p.root,
      state: "succeeded",
    })),
  );
  sql.store.transaction(() =>
    sql.store.prepare("DELETE FROM command WHERE id IN ('job-ancestor','job-parent')").run(),
  );
  const receipt = await runner()({ dry_run: false });
  expect(receipt.deleted_runs.map((r) => r.run_id).sort()).toEqual(["head", "neighbor"]);
  for (const p of [ancestor, parent]) expect(existsSync(join(p.finalDir, "answer.md"))).toBe(true);
});

it("fails closed on unreadable durable continuation sources", async () => {
  const head = oldRun("head");
  const neighbor = oldRun("neighbor");
  writeFileSync(join(head.root, "context", "continuation.json"), "malformed");
  await expect(runner()({ dry_run: false })).rejects.toThrow();
  expect(existsSync(join(neighbor.finalDir, "answer.md"))).toBe(true);
});

it("keeps delivery source files while unsettled and retires the old unreferenced run after settlement", async () => {
  const source = oldRun("source");
  const input = {
    key: "delivery",
    client: "fixture",
    operation: "run.apply",
    request: { runId: "source" },
  };
  const command = sql.graph.commands.beginDelivery(params(), input);
  await expect(runner()({ dry_run: false })).rejects.toThrow("delivery command is unsettled");
  expect(existsSync(join(source.finalDir, "answer.md"))).toBe(true);
  completeDeliveryCommand(sql.graph.commands.current(), command.id, { applied: true });
  expect((await runner()({ dry_run: false })).deleted_runs.map((r) => r.run_id)).toEqual([
    "source",
  ]);
  expect(sql.graph.commands.beginDelivery(params(), input).reused).toBe(true);
  expect(() =>
    sql.graph.commands.beginDelivery(params(), { ...input, key: "new-delivery" }),
  ).toThrow(expect.objectContaining({ code: "run_expired_by_retention" }));
});

it.each(["retryOf", "planRunId", "planRef"])(
  "refuses a new %s claim on expired evidence while preserving a live source claim",
  async (dependency) => {
    const expired = oldRun("expired-source");
    const live = oldRun("live-source");
    const ref = (id: string, dir: string) =>
      dependency === "planRef"
        ? { runId: id, path: join(dir, "final", "plan.md"), sha256: "a".repeat(64) }
        : id;
    accept("allowed", { [dependency]: ref("live-source", live.root) });
    expect((await runner()({ dry_run: false })).deleted_runs.map((r) => r.run_id)).toEqual([
      "expired-source",
    ]);
    expect(() => accept("too-late", { [dependency]: ref("expired-source", expired.root) })).toThrow(
      expect.objectContaining({ code: "run_expired_by_retention", status: 410 }),
    );
    expect(existsSync(join(live.finalDir, "answer.md"))).toBe(true);
  },
);
