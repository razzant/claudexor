import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let configBefore: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
const old = new Date("2020-01-01");
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-retention-inventory-")));
  configBefore = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
});
afterEachClosed(async () => {
  await sql?.close();
  return () => {
    if (configBefore === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = configBefore;
    rmSync(root, { recursive: true, force: true });
  };
});
function repo(name: string) {
  const path = join(root, name);
  mkdirSync(path);
  return path;
}
function run(repoRoot: string, id: string, terminal = true) {
  const path = join(new ArtifactStore(repoRoot).runsDir(), id);
  mkdirSync(join(path, "final"), { recursive: true });
  if (terminal) writeFileSync(join(path, "final", "failure.yaml"), "terminal failure");
  utimesSync(path, old, old);
  return path;
}
function runner(cap?: number, threads = sql.graph.threads) {
  return createRetentionRunner({
    projects: () => sql.graph.projects,
    threads,
    daemonJobs: () => [],
    purgeThread: async () => {
      throw new Error("unexpected purge");
    },
    hasPurgeLeftovers: () => false,
    maxDeletionsPerPass: cap,
  });
}
it("reclaims old unregistered runs, preserves unproven and young runs, previews without writes", async () => {
  const project = repo("ghost");
  const expired = run(project, "expired");
  const unknown = run(project, "unknown", false);
  const young = run(project, "young");
  utimesSync(young, new Date(), new Date());
  const gc = runner();
  const preview = await gc({ dry_run: true });
  expect(preview.deleted_runs.map((row) => row.run_id)).toEqual(["expired"]);
  expect(preview.deleted_runs[0]!.project_root).toBe(projectRuntimeDir(project));
  expect(existsSync(join(expired, "final", "failure.yaml"))).toBe(true);
  const result = await gc({ dry_run: false });
  expect(result.deleted_runs.map((row) => row.run_id)).toEqual(["expired"]);
  expect(readFileSync(join(expired, "tombstone.yaml"), "utf8")).toContain("expired");
  expect(existsSync(join(expired, "final"))).toBe(false);
  expect(existsSync(unknown)).toBe(true);
  expect(existsSync(join(young, "final"))).toBe(true);
});
it("retains archived thread lineage and pending interactions while deleting an unreferenced neighbor", async () => {
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
    "retention:\n  keep_last_runs_per_project: 0\n",
  );
  const projectRoot = repo("archived");
  const project = sql.graph.projects.register({
    root: projectRoot,
    clientId: "test",
    idempotencyKey: "project",
  }).project;
  const thread = sql.graph.threads.createThread({
    title: "retained",
    repoRoot: projectRoot,
    workspace: "in_place",
  });
  const turn = sql.graph.threads.createTurn(thread.id, "prompt", {
    parentRunId: "parent",
    answersPlanRunId: "answer",
    planRunId: "plan",
  });
  sql.graph.threads.bindTurnRun(turn.id, "bound");
  for (const id of ["parent", "answer", "plan", "bound", "pending", "unreferenced"])
    run(projectRoot, id);
  const pid = sql.graph.projects.partition(project.id)!.pid;
  sql.store
    .prepare("INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,?,?,?)")
    .run("pending", pid, "pending", "pending", Buffer.from("{}"));
  sql.graph.projects.unregister(project.id);
  expect(sql.graph.threads.listThreads()).toEqual([]);
  const result = await runner()({ dry_run: false });
  expect(result.deleted_runs.map((row) => row.run_id)).toEqual(["unreferenced"]);
  expect(result.kept.referenced).toBe(5);
});

it("retires three old unregistered runs below the default keep-last limit", async () => {
  const projectRoot = repo("unregistered");
  const paths = [0, 1, 2].map((n) => run(projectRoot, `orphan-${n}`));
  const result = await runner()({ dry_run: false });
  expect(result.policy.keep_last_runs_per_project).toBe(20);
  expect(result.deleted_runs.map((row) => row.run_id).sort()).toEqual([
    "orphan-0",
    "orphan-1",
    "orphan-2",
  ]);
  expect(result.kept.recent).toBe(0);
  for (const path of paths) {
    expect(existsSync(join(path, "tombstone.yaml"))).toBe(true);
    expect(existsSync(join(path, "final"))).toBe(false);
  }
});

it.each(["active", "archived", "missing-active", "no-project"])(
  "keeps three old %s runs with the default keep-last policy",
  async (kind) => {
    const projectRoot = kind === "no-project" ? noProjectRepoRoot() : repo(kind);
    if (kind !== "no-project") {
      const project = sql.graph.projects.register({
        root: projectRoot,
        clientId: "test",
        idempotencyKey: kind,
      }).project;
      if (kind.endsWith("archived")) sql.graph.projects.unregister(project.id);
      if (kind.startsWith("missing-")) rmSync(projectRoot, { recursive: true });
    }
    const paths = [0, 1, 2].map((n) => run(projectRoot, `owned-${n}`));
    const result = await runner()({ dry_run: false });
    expect(result.policy.keep_last_runs_per_project).toBe(20);
    expect(result.deleted_runs).toEqual([]);
    expect(result.kept.recent).toBe(3);
    for (const path of paths) expect(existsSync(join(path, "final", "failure.yaml"))).toBe(true);
  },
);

it("keeps an orphan's referenced run while retiring its unreferenced neighbors at default keep-last", async () => {
  const projectRoot = repo("referenced-orphan");
  const thread = sql.graph.threads.createThread({
    title: "retained",
    workspace: "in_place",
  });
  sql.graph.threads.createTurn(thread.id, "continue", { parentRunId: "held" });
  rmSync(projectRoot, { recursive: true });
  const held = run(projectRoot, "held");
  for (const id of ["expired-a", "expired-b"]) run(projectRoot, id);
  const gc = runner();
  const preview = await gc({ dry_run: true });
  expect(preview.deleted_runs.map((row) => row.run_id).sort()).toEqual(["expired-a", "expired-b"]);
  const result = await gc({ dry_run: false });
  expect(result.policy.keep_last_runs_per_project).toBe(20);
  expect(result.deleted_runs.map((row) => row.run_id).sort()).toEqual(["expired-a", "expired-b"]);
  expect(result.kept.referenced).toBe(1);
  expect(existsSync(join(held, "final", "failure.yaml"))).toBe(true);
});
it("fails closed on corrupt archived thread references before deleting any namespace", async () => {
  const projectRoot = repo("broken");
  const project = sql.graph.projects.register({
    root: projectRoot,
    clientId: "test",
    idempotencyKey: "project",
  }).project;
  const thread = sql.graph.threads.createThread({
    title: "broken",
    repoRoot: projectRoot,
    workspace: "in_place",
  });
  sql.graph.projects.unregister(project.id);
  sql.store.prepare("UPDATE thread SET body=? WHERE id=?").run(Buffer.from("bad json"), thread.id);
  const path = run(repo("other"), "otherwise-deletable");
  await expect(runner()({ dry_run: false })).rejects.toThrow();
  expect(existsSync(join(path, "final"))).toBe(true);
});
it("preserves unavailable generations and never follows a linked runtime namespace", async () => {
  const projectRoot = repo("recovery-pending");
  const project = sql.graph.projects.register({
    root: projectRoot,
    clientId: "test",
    idempotencyKey: "project",
  }).project;
  sql.store
    .prepare("UPDATE partition SET status='recovery_required' WHERE id=?")
    .run(sql.graph.projects.partition(project.id)!.pid);
  const protectedRun = run(projectRoot, "protected");
  const linkedRepo = repo("linked");
  const outside = repo("outside");
  mkdirSync(join(outside, "runs", "old", "final"), { recursive: true });
  writeFileSync(join(outside, "runs", "old", "final", "failure.yaml"), "keep");
  utimesSync(join(outside, "runs", "old"), old, old);
  symlinkSync(outside, projectRuntimeDir(linkedRepo), "dir");
  run(repo("ordinary"), "delete");
  const result = await runner()({ dry_run: false });
  expect(result.deleted_runs).toEqual([]);
  expect(existsSync(join(protectedRun, "final"))).toBe(true);
  expect(existsSync(join(outside, "runs", "old", "final"))).toBe(true);
});
it("continues bounded passes until all eligible orphan runs retire", async () => {
  const projectRoot = repo("many");
  for (let i = 0; i < 5; i++) run(projectRoot, `run-${i}`);
  const gc = runner(2);
  expect((await gc({ dry_run: false })).deleted_runs).toHaveLength(2);
  expect(gc.hasMore!()).toBe(true);
  expect((await gc({ dry_run: false })).deleted_runs).toHaveLength(2);
  expect(gc.hasMore!()).toBe(true);
  expect((await gc({ dry_run: false })).deleted_runs).toHaveLength(1);
  expect(gc.hasMore!()).toBe(false);
});

it("keeps each capped receipt's continuation signal across queued manual passes", async () => {
  const projectRoot = repo("queued");
  for (let i = 0; i < 3; i++) run(projectRoot, `queued-${i}`);
  const gc = runner(2);
  const [scheduled, manual] = await Promise.all([gc({ dry_run: false }), gc({ dry_run: false })]);
  expect(scheduled.deleted_runs).toHaveLength(2);
  expect(manual.deleted_runs).toHaveLength(1);
  expect(gc.hasMore!(scheduled)).toBe(true);
  expect(gc.hasMore!(manual)).toBe(false);
  expect(gc.hasMore!()).toBe(false);
});

it("absorbs new SQL references during inventory while retiring unrelated runs", async () => {
  const projectRoot = repo("admission-during-inventory");
  const held = run(projectRoot, "new-reference");
  const cold = run(projectRoot, "unreferenced-neighbor");
  let admitted = false;
  const threads = new Proxy(sql.graph.threads, {
    get(target, key) {
      if (key === "retentionReferences")
        return async (...args: Parameters<typeof target.retentionReferences>) => {
          const snapshot = await target.retentionReferences(...args);
          if (!admitted)
            setImmediate(() => {
              const thread = target.createThread({
                title: "Admitted during inventory",
                workspace: "in_place",
              });
              target.createTurn(thread.id, "Continue retained work", {
                parentRunId: "new-reference",
              });
              admitted = true;
            });
          return snapshot;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const gc = runner(undefined, threads);
  const interrupted = await gc({ dry_run: false });
  expect(admitted).toBe(true);
  expect(interrupted.deleted_runs.map((row) => row.run_id)).toEqual(["unreferenced-neighbor"]);
  expect(interrupted.errors).toEqual([]);
  expect(gc.hasMore!(interrupted)).toBe(false);
  expect(existsSync(join(held, "final"))).toBe(true);
  expect(existsSync(join(cold, "final"))).toBe(false);
  const resumed = await gc({ dry_run: false });
  expect(resumed.deleted_runs).toEqual([]);
  expect(resumed.kept.referenced).toBe(1);
  expect(existsSync(join(held, "final"))).toBe(true);
  expect(gc.hasMore!(resumed)).toBe(false);
});

it("invalidates the SQL snapshot for writes during its cooperative read and after it returns", async () => {
  const thread = sql.graph.threads.createThread({ title: "Snapshot", workspace: "in_place" });
  const pending = sql.graph.threads.retentionReferences();
  sql.graph.threads.createTurn(thread.id, "Admitted before inventory completed", {
    parentRunId: "held",
  });
  expect((await pending).isCurrent()).toBe(false);
  const current = await sql.graph.threads.retentionReferences();
  expect(current.isCurrent()).toBe(true);
  expect(current.referencedRunIds.has("held")).toBe(true);
  sql.graph.threads.createTurn(thread.id, "Admitted after inventory completed");
  expect(current.isCurrent()).toBe(false);
});

it("limits maintenance listing to served threads while retaining unfinished purges with missing roots", async () => {
  const ids = new Map<string, string>();
  for (const kind of ["active", "archived", "missing", "purged"]) {
    const projectRoot = repo(`maintenance-${kind}`);
    const project = sql.graph.projects.register({
      root: projectRoot,
      clientId: "test",
      idempotencyKey: kind,
    }).project;
    const thread = sql.graph.threads.createThread({
      title: kind,
      repoRoot: projectRoot,
      workspace: "in_place",
    });
    ids.set(kind, thread.id);
    if (kind === "archived") sql.graph.projects.unregister(project.id);
    if (kind === "purged") {
      sql.graph.threads.trashThread(thread.id);
      sql.graph.threads.purgeThread(thread.id);
    }
    if (kind === "missing" || kind === "purged") rmSync(projectRoot, { recursive: true });
  }
  const listed = await sql.graph.threads.retentionThreads();
  expect(listed.map((thread) => thread.id).sort()).toEqual(
    [ids.get("active"), ids.get("purged")].sort(),
  );
  expect(listed.find((thread) => thread.id === ids.get("purged"))!.state).toBe("purged");
});

it("keeps a non-directory no-project namespace without probing its children", async () => {
  const cold = run(repo("ordinary-with-invalid-no-project"), "cold");
  const invalid = projectRuntimeDir(noProjectRepoRoot());
  writeFileSync(invalid, "not a runtime directory");
  const receipt = await runner()({ dry_run: false });
  expect(receipt.deleted_runs.map((row) => row.run_id)).toEqual(["cold"]);
  expect(existsSync(join(cold, "tombstone.yaml"))).toBe(true);
  expect(readFileSync(invalid, "utf8")).toBe("not a runtime directory");
});
