import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sqlActivityRecords } from "../../cli/src/sql-daemon-queries.js";
import { sqlFixture } from "./store/test-support/sql-fixture.js";

it("keeps global/project scopes and turn ids in retention activity without hydrating bodies", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "activity-sql-")));
  const sql = await sqlFixture(root);
  try {
    const commands = sql.graph.commands.current();
    for (const id of ["global", "project", "delivery-hidden", "model-hidden"]) {
      commands.accept({
        id,
        idempotencyKey: id,
        clientId: "test",
        params: {
          ...(id === "model-hidden" ? { kind: "model" } : {}),
          scope:
            id === "project" ? { kind: "project", root: "/fixture/project" } : { kind: "none" },
          threadId: id === "project" ? "t-1" : undefined,
          prompt: "full retained input".repeat(4096),
        },
      });
      commands.update(id, { runId: `run-${id}`, state: "running" });
    }
    const body = vi.spyOn(sql.graph.blobs, "read").mockImplementation(() => {
      throw new Error("body traversed");
    });
    const activity = sqlActivityRecords(sql.store);
    expect(activity).toHaveLength(2);
    expect(activity).toEqual(
      expect.arrayContaining([
        {
          runId: "run-global",
          state: "running",
          finishedAt: undefined,
          params: { scope: { kind: "global" }, threadId: undefined },
        },
        {
          runId: "run-project",
          state: "running",
          finishedAt: undefined,
          params: { scope: { kind: "project", root: "/fixture/project" }, threadId: "t-1" },
        },
      ]),
    );
    expect(body).not.toHaveBeenCalled();
    // The same poison trips a full detail read, proving the activity guard is live.
    expect(() => commands.get("global")).toThrow("body traversed");
    body.mockRestore();
  } finally {
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});
