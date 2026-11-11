import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sqlFixture } from "./test-support/sql-fixture.js";
it.each(["thread", "turn", "session", "command"] as const)(
  "names an unreadable %s row and partition before refusing retention",
  async (table) => {
    const root = mkdtempSync(join(tmpdir(), "retention-row-error-"));
    const sql = await sqlFixture(root);
    try {
      const thread = sql.graph.threads.createThread({
        title: "Reference owner",
        workspace: "in_place",
      });
      sql.graph.threads.createTurn(thread.id, "continue", { parentRunId: "held" });
      sql.graph.threads.recordSession(thread.id, "codex", "00000000-0000-0000-0000-000000000001");
      sql.graph.commands.current().accept({
        id: "command-owner",
        params: { prompt: "work" },
        idempotencyKey: "owner",
        clientId: "fixture",
      });
      const row = sql.store.prepare(`SELECT id,pid FROM ${table} LIMIT 1`).get() as {
        id: string;
        pid: number;
      };
      const saved =
        table === "command"
          ? (sql.store
              .prepare(
                "SELECT inline AS body FROM blob WHERE sha256=(SELECT params_sha FROM command WHERE id=?)",
              )
              .get(row.id) as { body: Uint8Array })
          : (sql.store.prepare(`SELECT body FROM ${table} WHERE id=?`).get(row.id) as {
              body: Uint8Array;
            });
      sql.store.transaction(() => {
        if (table === "command")
          sql.store
            .prepare(
              "UPDATE blob SET inline=? WHERE sha256=(SELECT params_sha FROM command WHERE id=?)",
            )
            .run(Buffer.from("unreadable"), row.id);
        else
          sql.store
            .prepare(`UPDATE ${table} SET body=? WHERE id=?`)
            .run(Buffer.from("unreadable"), row.id);
      });
      const error = await sql.graph.threads.retentionReferences().then(
        () => null,
        (e: unknown) => String(e),
      );
      expect(error).toContain(row.id);
      expect(error).toContain(`partition ${row.pid}`);
      sql.store.transaction(() => {
        if (table === "command")
          sql.store
            .prepare(
              "UPDATE blob SET inline=? WHERE sha256=(SELECT params_sha FROM command WHERE id=?)",
            )
            .run(saved.body, row.id);
        else sql.store.prepare(`UPDATE ${table} SET body=? WHERE id=?`).run(saved.body, row.id);
      });
      const healthy = await sql.graph.threads.retentionReferences();
      expect(healthy.referencedRunIds.has("held")).toBe(true);
      healthy.close!();
    } finally {
      await sql.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
