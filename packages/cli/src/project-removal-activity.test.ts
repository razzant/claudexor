/**
 * #549 through the production activity projection, the removal service and a
 * real SQL store. A live run's scope is the one its accepted request recorded:
 * a run with no project, or whose request omitted scope (the request schema's
 * default), never refuses removal of an unrelated idle project. The project's
 * own live run, also under another spelling of its root, and a live run whose
 * recorded scope cannot be resolved still refuse; terminal runs never do. No
 * command body is read on the way.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { projectRemovalService } from "./project-removal.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";

let root: string;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
let body: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-remove-activity-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
  sql = await sqlFixture(join(root, "sql"));
});

afterEach(async () => {
  body?.mockRestore();
  await sql.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function project(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "USER-SENTINEL"), "user data must remain");
  return sql.graph.threads.registerProject({ root: dir, clientId: "test", idempotencyKey: dir })
    .project;
}

/** Accepted where enqueue routes it, then bound to a run as the daemon's runner does. */
function liveRun(id: string, params: Record<string, unknown>) {
  const commands = sql.graph.commands.forRequest(params);
  commands.accept({
    id,
    idempotencyKey: id,
    clientId: "test",
    params: { mode: "ask", prompt: "full retained input".repeat(4096), ...params },
  });
  commands.update(id, { runId: `run-${id}`, state: "running" });
  return {
    finish: () => commands.update(id, { state: "cancelled", finishedAt: new Date().toISOString() }),
  };
}

/** Command bodies are poisoned from here on; the removal fence must not need them. */
function poisonBodies() {
  body = vi.spyOn(sql.graph.blobs, "read").mockImplementation(() => {
    throw new Error("body traversed");
  });
}

const remove = (id: string, options?: { trashedThreads: "purge" }) =>
  projectRemovalService(
    sql.graph.threads,
    () => sqlActivityRecords(sql.store),
    async () => undefined,
  )(id, options);
const registered = (id: string) => sql.graph.projects.list().some((item) => item.id === id);

describe("project removal over recorded run scopes (#549)", () => {
  it("removes unrelated idle projects while a run with no project, or with an omitted scope, is live", async () => {
    const plain = project("unrelated");
    const trashed = project("unrelated-with-trash-opt-in");
    liveRun("no-project", { scope: { kind: "none" } });
    liveRun("omitted-scope", {});
    poisonBodies();

    await expect(remove(plain.id)).resolves.toMatchObject({
      projectId: plain.id,
      registryRemoved: true,
    });
    await expect(remove(trashed.id, { trashedThreads: "purge" })).resolves.toMatchObject({
      projectId: trashed.id,
      registryRemoved: true,
      purgedThreads: [],
    });
    expect([registered(plain.id), registered(trashed.id)]).toEqual([false, false]);
    expect(readFileSync(join(plain.root, "USER-SENTINEL"), "utf8")).toBe("user data must remain");
    // The runs themselves are untouched and still live.
    expect(
      sqlActivityRecords(sql.store)
        .map((item) => [item.runId, item.state])
        .sort(),
    ).toEqual([
      ["run-no-project", "running"],
      ["run-omitted-scope", "running"],
    ]);
    expect(body).not.toHaveBeenCalled();
    expect(() => sql.graph.commands.findById("no-project")!.get("no-project")).toThrow(
      "body traversed",
    );
  });

  it("still refuses the project's own live run, also under another spelling of its root", async () => {
    const own = project("own");
    const spelled = project("spelled");
    const alias = join(root, "spelled-alias");
    symlinkSync(spelled.root, alias, "dir");
    const ownRun = liveRun("own-run", { scope: { kind: "project", root: own.root } });
    // A one-shot root lives in the global partition, so only the root fence sees it.
    const aliasRun = liveRun("alias-run", {
      scope: { kind: "project", root: alias, ephemeral: true },
    });
    liveRun("no-project", { scope: { kind: "none" } });
    poisonBodies();

    for (const item of [own, spelled]) {
      await expect(remove(item.id)).rejects.toMatchObject({
        code: "project_has_active_run",
        status: 409,
      });
      expect(registered(item.id)).toBe(true);
    }
    expect(body).not.toHaveBeenCalled();
    body.mockRestore();
    ownRun.finish();
    aliasRun.finish();
    poisonBodies();
    for (const item of [own, spelled])
      await expect(remove(item.id)).resolves.toMatchObject({ registryRemoved: true });
    expect(body).not.toHaveBeenCalled();
  });

  it("fails closed on a live run whose recorded scope cannot be resolved, never on a terminal one", async () => {
    const idle = project("idle");
    const refusal = (runId: string) => ({
      code: "active_run_scope_unresolved",
      status: 409,
      message: expect.stringContaining(runId),
    });
    const refusedBoth = async (runId: string) => {
      for (const options of [undefined, { trashedThreads: "purge" as const }])
        await expect(remove(idle.id, options)).rejects.toMatchObject(refusal(runId));
      expect(registered(idle.id)).toBe(true);
    };
    const write = (text: string, ...values: Array<string | Buffer>) =>
      sql.store.transaction(() => sql.store.prepare(text).run(...values));

    // A one-shot project scope without a root is routed globally and indexes no root.
    const malformed = liveRun("malformed", { scope: { kind: "project", ephemeral: true } });
    poisonBodies();
    await refusedBoth("run-malformed");
    expect(body).not.toHaveBeenCalled();
    body.mockRestore();
    malformed.finish();

    liveRun("unreadable", { scope: { kind: "none" } });
    // Summary bytes the store accepts but that record no request params.
    write("UPDATE command SET summary=? WHERE id=?", Buffer.from('{"params":'), "unreadable");
    poisonBodies();
    await refusedBoth("run-unreadable");
    // Terminal runs never refuse, whatever scope they recorded.
    write(
      "UPDATE command SET state='cancelled',finished_at=? WHERE id=?",
      new Date().toISOString(),
      "unreadable",
    );
    await expect(remove(idle.id)).resolves.toMatchObject({ registryRemoved: true });
    expect(body).not.toHaveBeenCalled();
  });
});
