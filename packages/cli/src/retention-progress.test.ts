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
import { beforeEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { scheduleStartupRetention } from "./retention-schedule.js";
import type { ControlGcReceipt } from "@claudexor/schema";
import { createRetentionRunner } from "./retention-service.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const hook = vi.hoisted(() => ({
  afterPrepare: undefined as ((name: string) => void) | undefined,
}));
// The CLI imports the built package. Route that export to its source owner so
// the preparation hook below exercises the same pass with real SQL rechecks.
vi.mock("@claudexor/control-api", async (original) => ({
  ...(await original<typeof import("@claudexor/control-api")>()),
  runRetentionPass: (await import("../../control-api/src/retention.js")).runRetentionPass,
}));
vi.mock("../../control-api/src/retention-removal.js", async (original) => {
  const owner = await original<typeof import("../../control-api/src/retention-removal.js")>();
  return {
    ...owner,
    prepareRetirement: async (...args: Parameters<typeof owner.prepareRetirement>) => {
      const prepared = await owner.prepareRetirement(...args);
      hook.afterPrepare?.(args[1]);
      return prepared;
    },
  };
});

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-retention-progress-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
});
afterEachClosed(async () => {
  hook.afterPrepare = undefined;
  await sql.close();
  return () => {
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  };
});
function oldRun(id: string) {
  const path = new ArtifactStore(join(root, "orphan")).createRun(id).root;
  writeFileSync(join(path, "final", "failure.yaml"), "terminal failure");
  utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
  return path;
}
function runner(cap?: number) {
  return createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => [],
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
    maxDeletionsPerPass: cap,
  });
}

it("makes bounded progress under a stream of real thread, quota and command metadata writes", async () => {
  const paths = Array.from({ length: 7 }, (_, i) => oldRun(`old-${i}`));
  const thread = sql.graph.threads.createThread({ title: "Unrelated", workspace: "in_place" });
  const commands = sql.graph.commands.current();
  commands.accept({
    id: "unrelated",
    params: { prompt: "unrelated" },
    idempotencyKey: "unrelated",
    clientId: "fixture",
  });
  commands.update("unrelated", { state: "succeeded", finishedAt: new Date().toISOString() });
  let writes = 0;
  const errors: unknown[] = [];
  const timer = setInterval(() => {
    try {
      writes++;
      sql.graph.threads.updateThread(thread.id, { title: `Unrelated ${writes}` });
      commands.update("unrelated", { result: { observation: writes } });
      sql.graph.quota.upsert({
        subject: {
          harness: "claude",
          credential_route: "vendor_native",
          plan_label: null,
          subject_id: "fixture",
        },
        constraints: [
          {
            id: "five_hour",
            label: "5 hour",
            used_ratio: (writes % 2) / 10,
            window_seconds: 18000,
            resets_at: null,
            cooldown_until: null,
          },
        ],
        source: "claude_oauth_usage",
        observed_at: new Date().toISOString(),
        freshness: "fresh",
      });
    } catch (error) {
      errors.push(error);
    }
  }, 5);
  try {
    const gc = runner(2);
    const counts: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      const before = writes;
      const receipt = await gc({ dry_run: false });
      expect(writes).toBeGreaterThan(before);
      expect(receipt.errors.join()).not.toContain("references changed");
      counts.push(receipt.deleted_runs.length);
    }
    expect(errors).toEqual([]);
    expect(counts).toEqual([2, 2, 2, 1]);
    expect(gc.hasMore!()).toBe(false);
    for (const path of paths) expect(existsSync(join(path, "tombstone.yaml"))).toBe(true);
  } finally {
    clearInterval(timer);
  }
});

it.each(["thread", "continuation", "active run", "pending interaction"])(
  "rereads a new %s owner after retirement preparation while retiring its neighbor",
  async (kind) => {
    const held = oldRun("held");
    oldRun("neighbor");
    let added = false;
    hook.afterPrepare = (name) => {
      if (name !== "held") return;
      added = true;
      if (kind === "thread") {
        const thread = sql.graph.threads.createThread({
          title: "New owner",
          workspace: "in_place",
        });
        sql.graph.threads.createTurn(thread.id, "use the evidence", { parentRunId: "held" });
      } else if (kind === "pending interaction") {
        const pid = (
          sql.store.prepare("SELECT id FROM partition WHERE name='global'").get() as { id: number }
        ).id;
        sql.store.transaction(() =>
          sql.store
            .prepare(
              "INSERT INTO interaction(id,pid,run_id,state,request) VALUES('interaction',?,'held','pending',?)",
            )
            .run(pid, Buffer.from("{}")),
        );
      } else {
        const commands = sql.graph.commands.current();
        commands.accept({
          id: "new-owner",
          params: {
            prompt: "use the evidence",
            ...(kind === "continuation" ? { continueFrom: "held" } : {}),
          },
          idempotencyKey: "new-owner",
          clientId: "fixture",
        });
        if (kind === "active run")
          commands.update("new-owner", { state: "running", runId: "held", runDir: held });
      }
    };
    const receipt = await runner()({ dry_run: false });
    expect(added).toBe(true);
    expect(receipt.deleted_runs.map((r) => r.run_id)).toEqual(["neighbor"]);
    expect(receipt.errors).toEqual([]);
    expect(existsSync(join(held, "final", "failure.yaml"))).toBe(true);
    expect(existsSync(join(held, "tombstone.yaml"))).toBe(false);
  },
);

it("keeps remaining candidates when a changed reference owner becomes unreadable", async () => {
  const held = oldRun("held");
  const thread = sql.graph.threads.createThread({ title: "Readable", workspace: "in_place" });
  hook.afterPrepare = () =>
    sql.store.transaction(() =>
      sql.store
        .prepare("UPDATE thread SET body=? WHERE id=?")
        .run(Buffer.from("broken"), thread.id),
    );
  const receipt = await runner()({ dry_run: false });
  expect(receipt.deleted_runs).toEqual([]);
  expect(receipt.errors.join()).toContain("reference refresh failed");
  expect(receipt.holds).toContainEqual({
    class: "references_changed",
    count: 1,
    example: expect.stringContaining(thread.id),
  });
  expect(existsSync(join(held, "final", "failure.yaml"))).toBe(true);
});

it("stops a scheduled pass promptly and resumes its remaining candidates", async () => {
  const paths = Array.from({ length: 24 }, (_, i) => oldRun(`cancel-${i}`));
  const gc = runner();
  let receipt: ControlGcReceipt | undefined;
  const scheduled = Object.assign(async (request: Parameters<typeof gc>[0]) => {
    receipt = await gc(request);
    return receipt;
  }, gc);
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let stopping: Promise<void> | undefined;
  let stoppedAt = 0;
  const stop = scheduleStartupRetention(scheduled, {
    logPath: join(root, "retention.log"),
    shuttingDown: () => false,
    delayMs: 1,
  });
  hook.afterPrepare = () => {
    if (stopping) return;
    stoppedAt = performance.now();
    stopping = stop();
    reached();
  };
  try {
    await ready;
    await stopping;
    expect(performance.now() - stoppedAt).toBeLessThan(3000);
    expect(receipt!.deleted_runs.length).toBeLessThan(paths.length);
    expect(receipt!.errors.join()).toContain("cancelled");
    expect(gc.hasMore!(receipt)).toBe(true);
    hook.afterPrepare = undefined;
    const resumed = await gc({ dry_run: false });
    expect(resumed.deleted_runs.length + receipt!.deleted_runs.length).toBe(paths.length);
    expect(resumed.errors).toEqual([]);
    for (const path of paths) expect(existsSync(join(path, "tombstone.yaml"))).toBe(true);
  } finally {
    await stop();
  }
});
