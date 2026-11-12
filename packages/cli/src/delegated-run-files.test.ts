/**
 * A delegated run's files are read from its recorded caller-owned workspace,
 * addressed through its stable project (INV-072/INV-073): the run summary
 * projects that execution root beside `project.root`, and the remote image
 * route reads it via `runId` without registering the workspace as a project.
 * A missing workspace is a typed refusal, never the project's same-named file.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonControlApiServer, type DaemonRunRecord } from "@claudexor/control-api";
import { afterEach, describe, expect, it } from "vitest";
import { remoteFilesystemServices } from "./remote-filesystem.js";

const TOKEN = "delegated-run-files-token";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (text: string) => Buffer.concat([PNG_MAGIC, Buffer.from(text)]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "cx-delegated-files-"));
  roots.push(base);
  const author = join(base, "author");
  const copy = join(base, "copy");
  const other = join(base, "other");
  for (const dir of [author, copy, other, join(base, "run")])
    mkdirSync(join(dir, "shots"), {
      recursive: true,
    });
  writeFileSync(join(author, "shots", "action.png"), png("author bytes"));
  writeFileSync(join(copy, "shots", "action.png"), png("copy bytes"));
  writeFileSync(join(copy, "shots", "new.png"), png("copy only"));
  return { base, author, copy, other };
}

function record(id: string, params: Record<string, unknown>, runDir: string): DaemonRunRecord {
  return { id: `job-${id}`, runId: id, state: "succeeded", runDir, params };
}

function projectStore(projects: Record<string, string>) {
  const entries = Object.entries(projects).map(([id, root]) => ({
    id,
    root,
    schema_version: 3,
    created_at: "",
    updated_at: "",
  }));
  return {
    get: (id: string) => entries.find((project) => project.id === id),
    // Canonical like the registry: a root that no longer resolves throws.
    findByRoot: (root: string) =>
      entries.find((project) => realpathSync(project.root) === realpathSync(root)),
  } as never;
}

async function withRemoteApi(
  records: DaemonRunRecord[],
  projects: Record<string, string>,
  fn: (get: (path: string) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const server = new DaemonControlApiServer({
    token: TOKEN,
    pollMs: 1,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async (id: string) => records.find((rec) => rec.id === id) as DaemonRunRecord,
      list: async (query?: { id?: string }) =>
        query && "id" in query
          ? records.filter((rec) => rec.id === query.id || rec.runId === query.id)
          : records,
      cancel: async (id: string) => ({ id, cancelled: false }),
    } as never,
    services: remoteFilesystemServices(() => projectStore(projects), {
      CLAUDEXOR_REMOTE_RUNTIME: "1",
    }),
  });
  const { host, port } = await server.start();
  try {
    await fn((path) =>
      fetch(`http://${host}:${port}/v2${path}`, {
        headers: { authorization: `Bearer ${TOKEN}`, "X-Claudexor-Protocol-Major": "3" },
      }),
    );
  } finally {
    await server.stop();
  }
}

function delegatedRecords(f: ReturnType<typeof fixture>) {
  const runDir = join(f.base, "run");
  return [
    record(
      "run-del",
      {
        scope: { kind: "project", root: f.author },
        execution: { delegated: true, isolation: "live", workspaceRoot: f.copy },
        threadId: "th-del",
      },
      runDir,
    ),
    record("run-plain", { scope: { kind: "project", root: f.author } }, runDir),
    record("run-plain-foreign", { scope: { kind: "project", root: f.other } }, runDir),
    record(
      "run-foreign",
      {
        scope: { kind: "project", root: f.other },
        execution: { delegated: true, isolation: "live", workspaceRoot: f.copy },
      },
      runDir,
    ),
    record("run-none", { scope: { kind: "none" } }, runDir),
    record("run-no-scope", {}, runDir),
    record(
      "run-none-workspace",
      { scope: { kind: "none" }, execution: { workspaceRoot: f.copy } },
      runDir,
    ),
    record(
      "run-moved",
      {
        scope: { kind: "project", root: join(f.base, "moved-away") },
        execution: { delegated: true, isolation: "live", workspaceRoot: f.copy },
      },
      runDir,
    ),
  ];
}

describe("delegated run file references", () => {
  it("projects the execution root beside the stable project identity", async () => {
    const f = fixture();
    await withRemoteApi(delegatedRecords(f), { "prj-1": f.author }, async (get) => {
      const summary = async (runId: string) =>
        ((await (await get(`/runs/${runId}`)).json()) as { summary: Record<string, unknown> })
          .summary;
      expect(await summary("run-del")).toMatchObject({
        project: { kind: "project", root: f.author },
        executionRoot: f.copy,
      });
      expect(await summary("run-plain")).toMatchObject({ executionRoot: f.author });
      expect(await summary("run-none")).toMatchObject({ executionRoot: null });
      const list = (await (await get("/runs")).json()) as {
        runs: Array<{ runId: string; executionRoot: string | null }>;
      };
      expect(list.runs.find((row) => row.runId === "run-del")?.executionRoot).toBe(f.copy);
    });
  });

  it("serves the run's workspace bytes, never the same-named project file", async () => {
    const f = fixture();
    await withRemoteApi(delegatedRecords(f), { "prj-1": f.author }, async (get) => {
      const bytes = async (path: string) => Buffer.from(await (await get(path)).arrayBuffer());
      expect(await bytes("/projects/prj-1/file?path=shots/action.png&runId=run-del")).toEqual(
        png("copy bytes"),
      );
      // A workspace-only image needs no project copy.
      expect(await bytes("/projects/prj-1/file?path=shots/new.png&runId=run-del")).toEqual(
        png("copy only"),
      );
      // Without a run, and for a run whose files live in its project, the
      // project tree is read exactly as before.
      expect(await bytes("/projects/prj-1/file?path=shots/action.png")).toEqual(
        png("author bytes"),
      );
      expect(await bytes("/projects/prj-1/file?path=shots/action.png&runId=run-plain")).toEqual(
        png("author bytes"),
      );
      expect((await get("/projects/prj-1/file?path=shots/new.png")).status).toBe(404);
    });
  });

  it("refuses a missing workspace typed instead of reading the project", async () => {
    const f = fixture();
    rmSync(f.copy, { recursive: true, force: true });
    await withRemoteApi(delegatedRecords(f), { "prj-1": f.author }, async (get) => {
      const response = await get("/projects/prj-1/file?path=shots/action.png&runId=run-del");
      expect(response.status).toBe(410);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("execution_workspace_unavailable");
      expect(body.message).not.toContain(f.copy);
    });
  });

  it("requires every supplied run to belong to the addressed project", async () => {
    const f = fixture();
    await withRemoteApi(
      delegatedRecords(f),
      { "prj-1": f.author, "prj-2": f.other },
      async (get) => {
        for (const runId of [
          "run-plain-foreign",
          "job-run-plain-foreign",
          "run-none",
          "run-no-scope",
          "run-none-workspace",
        ]) {
          // The image exists in the addressed project: dropping the run's
          // identity would silently serve the wrong bytes with HTTP 200.
          const response = await get(`/projects/prj-1/file?path=shots/action.png&runId=${runId}`);
          expect(response.status, runId).toBe(409);
          expect(await response.json()).toMatchObject({ code: "run_project_mismatch" });
        }
        // Both canonical run IDs and their stable job aliases retain normal
        // project reads when the supplied run belongs to this project.
        const own = await get("/projects/prj-1/file?path=shots/action.png&runId=job-run-plain");
        expect(own.status).toBe(200);
        expect(Buffer.from(await own.arrayBuffer())).toEqual(png("author bytes"));
        const unbound = await get("/projects/prj-1/file?path=shots/action.png");
        expect(unbound.status).toBe(200);
        expect(Buffer.from(await unbound.arrayBuffer())).toEqual(png("author bytes"));
      },
    );
  });

  it("keeps the project identity: foreign, unknown, and escaping reads are refused", async () => {
    const f = fixture();
    symlinkSync(join(f.author, "shots", "action.png"), join(f.copy, "shots", "linked.png"));
    await withRemoteApi(
      delegatedRecords(f),
      { "prj-1": f.author, "prj-2": f.other },
      async (get) => {
        const foreign = await get("/projects/prj-1/file?path=shots/action.png&runId=run-foreign");
        expect(foreign.status).toBe(409);
        expect(await foreign.json()).toMatchObject({ code: "run_project_mismatch" });
        expect((await get("/projects/prj-2/file?path=shots/new.png&runId=run-del")).status).toBe(
          409,
        );
        expect((await get("/projects/prj-1/file?path=shots/new.png&runId=nope")).status).toBe(404);
        // A run whose recorded project root no longer resolves names no project.
        const moved = await get("/projects/prj-1/file?path=shots/new.png&runId=run-moved");
        expect(moved.status).toBe(409);
        expect(await moved.json()).toMatchObject({ code: "run_project_mismatch" });
        const twice = await get("/projects/prj-1/file?path=x.png&runId=run-del&runId=run-del");
        expect(twice.status).toBe(400);
        // A workspace symlink into the author tree escapes the bound root.
        const escape = await get("/projects/prj-1/file?path=shots/linked.png&runId=run-del");
        expect(escape.status).toBe(403);
        expect(await escape.json()).toMatchObject({ code: "project_file_path_escape" });
      },
    );
  });
});
