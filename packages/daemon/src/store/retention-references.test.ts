import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sqlFixture } from "./test-support/sql-fixture.js";
import { currentGeneration } from "./partitions.js";

it("pages command history even with no threads, admits writes between reads, and covers sparse records", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-pages-"));
  const sql = await sqlFixture(root);
  try {
    const pid = currentGeneration(sql.store, "global")!.pid;
    const body = Buffer.from("{}");
    const digest = createHash("sha256").update(body).digest("hex");
    sql.store.transaction(() => {
      sql.store
        .prepare("INSERT INTO blob(sha256,size,inline) VALUES(?,?,?)")
        .run(digest, body.length, body);
      const insert = sql.store.prepare(
        "INSERT INTO command(id,pid,operation,state,run_id,created_at,finished_at,summary,params_sha,kind) VALUES(?,?,'run.create','failed',?,'2020','2020',?,?,'product')",
      );
      for (let n = 0; n < 305; n++)
        insert.run(`command-${n}`, pid, n < 100 ? null : `run-${n}`, body, digest);
    });
    const pending = sql.graph.threads.retentionReferences();
    let admitted = false;
    const admission = new Promise<void>((resolve) =>
      setImmediate(() => {
        sql.graph.threads.createThread({
          title: "Admitted during inventory",
          workspace: "in_place",
        });
        admitted = true;
        resolve();
      }),
    );
    const snapshot = await pending;
    expect(admitted).toBe(true);
    await admission;
    expect(snapshot.isCurrent()).toBe(false);
    const current = await sql.graph.threads.retentionReferences();
    expect(current.isCurrent()).toBe(true);
    expect(current.records.map((record) => record.runId)).toEqual(
      Array.from({ length: 205 }, (_, n) => `run-${n + 100}`),
    );
  } finally {
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("catches up large reference changes cooperatively, rechecks the last arrival and releases its observer", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-catchup-"));
  const sql = await sqlFixture(root);
  try {
    const proof = await sql.graph.threads.retentionReferences();
    for (let n = 0; n < 150; n++)
      sql.graph.threads.createThread({ title: `New ${n}`, workspace: "in_place" });
    expect(proof.recheck!()).toBe(false);
    const pending = proof.refresh!();
    let admitted = false;
    const admission = new Promise<void>((resolve) =>
      setImmediate(() => {
        const thread = sql.graph.threads.createThread({
          title: "Late owner",
          workspace: "in_place",
        });
        sql.graph.threads.createTurn(thread.id, "keep it", { parentRunId: "held" });
        admitted = true;
        resolve();
      }),
    );
    await pending;
    await admission;
    expect(admitted).toBe(true);
    expect(proof.recheck!()).toBe(true);
    expect(proof.referencedRunIds.has("held")).toBe(true);
    proof.close!();
    expect(proof.recheck!()).toBe(false);
    const fresh = await sql.graph.threads.retentionReferences();
    expect(fresh.recheck!()).toBe(true);
    fresh.close!();
  } finally {
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});
