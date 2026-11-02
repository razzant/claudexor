import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sqlActivityRecords } from "../../cli/src/sql-daemon-queries.js";
import { sqlFixture } from "./store/test-support/sql-fixture.js";

it("keeps each run's recorded scope and turn ids in retention activity without hydrating bodies", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "activity-sql-")));
  const sql = await sqlFixture(root);
  try {
    const commands = sql.graph.commands.current();
    // `undefined` omits scope from the request, as a raw daemon enqueue may.
    const scopes: Record<string, unknown> = {
      global: { kind: "none" },
      project: { kind: "project", root: "/fixture/project" },
      omitted: undefined,
      malformed: { kind: "project" },
      unreadable: { kind: "none" },
      "no-params": { kind: "none" },
      "delivery-hidden": { kind: "none" },
      "model-hidden": { kind: "none" },
    };
    for (const [id, scope] of Object.entries(scopes)) {
      commands.accept({
        id,
        idempotencyKey: id,
        clientId: "test",
        params: {
          ...(id === "model-hidden" ? { kind: "model" } : {}),
          ...(scope === undefined ? {} : { scope }),
          threadId: id === "project" ? "t-1" : undefined,
          prompt: "full retained input".repeat(4096),
        },
      });
      commands.update(id, { runId: `run-${id}`, state: "running" });
    }
    // Summary bytes the store accepts but that record no request params.
    const summary = sql.store.prepare("UPDATE command SET summary=? WHERE id=?");
    sql.store.transaction(() => {
      summary.run(Buffer.from('{"params":'), "unreadable");
      summary.run(Buffer.from("{}"), "no-params");
    });
    const body = vi.spyOn(sql.graph.blobs, "read").mockImplementation(() => {
      throw new Error("body traversed");
    });
    const activity = sqlActivityRecords(sql.store);
    const scopeOf = (runId: string) => activity.find((item) => item.runId === runId)?.params.scope;
    expect(activity).toHaveLength(6);
    expect(activity).toEqual(
      expect.arrayContaining([
        {
          runId: "run-global",
          state: "running",
          finishedAt: undefined,
          params: { scope: { kind: "none" }, threadId: undefined },
        },
        {
          runId: "run-project",
          state: "running",
          finishedAt: undefined,
          params: { scope: { kind: "project", root: "/fixture/project" }, threadId: "t-1" },
        },
      ]),
    );
    // An omitted scope reads as the request schema's default; a malformed one
    // stays as recorded; no recorded params means no scope (removal refuses).
    expect(scopeOf("run-omitted")).toEqual({ kind: "none" });
    expect(scopeOf("run-malformed")).toEqual({ kind: "project" });
    expect(
      activity
        .filter((item) => item.params.scope === undefined)
        .map((item) => item.runId)
        .sort(),
    ).toEqual(["run-no-params", "run-unreadable"]);
    expect(body).not.toHaveBeenCalled();
    // The same poison trips a full detail read, proving the activity guard is live.
    expect(() => commands.get("global")).toThrow("body traversed");
    body.mockRestore();
  } finally {
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});
