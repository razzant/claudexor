import { expect, it, vi } from "vitest";
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
import { ArtifactStore } from "@claudexor/artifact-store";
import { projectRuntimeDir, writePatchObject } from "@claudexor/util";
import { sha256 } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
import { recordLastRetention, readLastRetention } from "./retention-last-pass.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const close: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const fn of close.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
it.each(["archived-null", "active-null", "dangling", "both", "healthy-and-dangling"])(
  "owns runs/native retirement for %s truthfully",
  async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-binding-")));
    removals.push(() => rmSync(root, { recursive: true, force: true }));
    const before = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
    close.push(() => {
      if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = before;
    });
    mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
    writeFileSync(
      join(process.env.CLAUDEXOR_CONFIG_DIR, "config.yaml"),
      "retention:\n  keep_last_runs_per_project: 0\n",
    );
    const sql = await sqlFixture(join(root, "sql"));
    close.push(() => sql.close());
    const repo = join(root, "repo");
    mkdirSync(repo);
    const p = sql.graph.projects.register({
      root: repo,
      idempotencyKey: "p",
      clientId: "test",
    }).project;
    if (kind === "archived-null") sql.graph.projects.unregister(p.id);
    sql.store.transaction(() =>
      sql.store
        .prepare("UPDATE project SET current_pid=? WHERE id=?")
        .run(kind === "dangling" ? 999999 : null, p.id),
    );
    if (kind === "both" || kind === "healthy-and-dangling") {
      sql.graph.projects.unregister(p.id);
      const other = sql.graph.projects.register({
        root: repo,
        idempotencyKey: "other",
        clientId: "test",
      }).project;
      sql.store.transaction(() => {
        sql.store.prepare("UPDATE project SET current_pid=999999 WHERE id=?").run(p.id);
        if (kind === "both")
          sql.store.prepare("UPDATE project SET current_pid=NULL WHERE id=?").run(other.id);
      });
      if (kind === "healthy-and-dangling")
        expect(sql.graph.threads.healthyProjectRoots()).toContain(repo);
    }
    const run = new ArtifactStore(repo).createRun("old");
    writeFileSync(join(run.finalDir, "failure.yaml"), "terminal");
    utimesSync(run.root, new Date("2020-01-01"), new Date("2020-01-01"));
    const lane = join(projectRuntimeDir(repo), "lanes", "th-000000000001", "default", "home");
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, "session.jsonl"), "retained lane state");
    const runtime = projectRuntimeDir(join(root, "other"));
    const anchor = join(runtime, "anchors/objects", `${sha256("old anchor").slice(7)}.patch`);
    writePatchObject(runtime, anchor, "old anchor");
    utimesSync(anchor, new Date("2020-01-01"), new Date("2020-01-01"));
    const nativeFile = join(root, "native-rollout");
    writeFileSync(nativeFile, "cold session");
    const prune = vi.fn(async () => {
      rmSync(nativeFile);
      return {
        deleted_files: [nativeFile],
        errors: [],
        freed_bytes: 12,
        kept_referenced: 0,
        kept_recent: 0,
        kept_unknown: 0,
        truncated: false,
      };
    });
    const native = createNativeHomeRetention({
      threads: sql.graph.threads,
      isBusy: () => false,
      profiles: () => [],
      registry: () =>
        new Map([
          [
            "fixture",
            {
              nativeHomeLifetime: {
                status: "managed",
                home: () => join(root, "native"),
                preserves: "fixture",
                prune,
              },
            },
          ],
        ]) as never,
    });
    const collect = recordLastRetention(
      createRetentionRunner({
        projects: () => sql.graph.projects,
        threads: sql.graph.threads,
        daemonJobs: () => [],
        purgeThread: async () => {},
        hasPurgeLeftovers: () => false,
        nativeHomes: native,
      }),
      sql.store,
    );
    const receipt = await collect({ dry_run: false });
    const last = readLastRetention(sql.store)!;
    if (kind === "archived-null") {
      expect(receipt.held).toEqual({ roots: 0, native_homes: 0 });
      expect(receipt.holds).toEqual([]);
      expect(receipt.deleted_runs.map((r) => r.run_id)).toEqual(["old"]);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(existsSync(nativeFile)).toBe(false);
      expect(existsSync(anchor)).toBe(false);
      expect(last.outcome).toBe("completed");
    } else {
      const reason =
        kind === "dangling" || kind === "healthy-and-dangling"
          ? "missing_partition"
          : "unbound_active_registration";
      expect(receipt.held).toEqual({ roots: 1, native_homes: 1 });
      expect(receipt.kept.unknown_state).toBe(0);
      expect(receipt.deleted_runs).toEqual([]);
      expect(prune).not.toHaveBeenCalled();
      expect(existsSync(nativeFile)).toBe(true);
      expect(existsSync(anchor)).toBe(true);
      expect(existsSync(join(lane, "session.jsonl"))).toBe(true);
      expect(last).toMatchObject({
        outcome: "held",
        held: { roots: 1, native_homes: 1 },
        holds: expect.arrayContaining([
          { class: reason, count: 1, example: repo, since: expect.any(String) },
        ]),
      });
      expect(receipt.errors.join(" ")).not.toContain("awaits journal recovery");
      if (kind === "both")
        expect(last.holds.map((hold) => hold.class)).toEqual(
          expect.arrayContaining(["missing_partition", "unbound_active_registration"]),
        );
    }
  },
);
