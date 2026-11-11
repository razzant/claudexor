import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sqlFixture } from "./test-support/sql-fixture.js";
import { currentGeneration } from "./partitions.js";
it("parses each distinct params body once per pass, including changed-owner refreshes", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-params-"));
  const sql = await sqlFixture(root);
  const body = JSON.stringify({ prompt: "Repeated immutable input", continueFrom: "predecessor" });
  const digest = createHash("sha256").update(body).digest("hex");
  let restore = () => {};
  try {
    const pid = currentGeneration(sql.store, "global")!.pid;
    sql.store.transaction(() => {
      sql.store
        .prepare("INSERT INTO blob(sha256,size,inline) VALUES(?,?,?)")
        .run(digest, Buffer.byteLength(body), Buffer.from(body));
      const insert = sql.store.prepare(
        "INSERT INTO command(id,pid,operation,state,created_at,summary,continue_from,params_sha,kind) VALUES(?,?,'run.create','queued','2020',?,'predecessor',?,'product')",
      );
      for (let n = 0; n < 20; n++) insert.run(`job-${n}`, pid, Buffer.from("{}"), digest);
    });
    const spy = vi.spyOn(JSON, "parse");
    restore = () => spy.mockRestore();
    const count = () => spy.mock.calls.filter(([text]) => text === body).length;
    const proof = await sql.graph.threads.retentionReferences();
    expect(count()).toBe(1);
    sql.store.transaction(() =>
      sql.store.prepare("UPDATE command SET state='running' WHERE id='job-1'").run(),
    );
    await proof.refresh!();
    expect(proof.recheck!()).toBe(true);
    expect(proof.referencedRunIds.has("predecessor")).toBe(true);
    expect(count()).toBe(1);
    proof.close!();
    const next = await sql.graph.threads.retentionReferences();
    expect(count()).toBe(2);
    next.close!();
  } finally {
    restore();
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});
