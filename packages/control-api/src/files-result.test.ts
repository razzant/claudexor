import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stringify, parse } from "yaml";
import {
  DecisionRecord,
  makeOutcomeFacts,
  TaskContract,
  SCHEMA_VERSION,
  type WorkspaceFilesManifest,
} from "@claudexor/schema";
import {
  WorkspaceManager,
  envelopeBaseOf,
  retainForInspection,
  retainedSourcesOfRun,
} from "@claudexor/workspace";
import { DaemonControlApiServer } from "./daemon-server.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const digest = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(big = false, isolation: "envelope" | "live" = "envelope") {
  const root = await mkdtemp(join(tmpdir(), "cx-files-result-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    run = join(root, "run");
  await mkdir(source);
  await mkdir(join(run, "final/files/content"), { recursive: true });
  await mkdir(join(run, "arbitration"));
  await mkdir(join(run, "context"));
  await writeFile(
    join(run, "context/task.yaml"),
    stringify(
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task-files",
        created_at: "2026-09-13T00:00:00Z",
        repo: { root: source, base_ref: "HEAD" },
        mode: { kind: "agent" },
        user_intent: { raw: "Edit files" },
        review_requested: false,
      }),
    ),
  );
  const old = Buffer.from("baseline\n"),
    output = big ? Buffer.alloc(33 * 1024 * 1024, 0x51) : Buffer.from([0, 255, 12, 99]);
  const file = async (bytes: Buffer) => {
    const sha256 = digest(bytes),
      artifactPath = `final/files/content/${sha256.slice(7)}`;
    await writeFile(join(run, artifactPath), bytes);
    return {
      kind: "file" as const,
      sha256,
      sizeBytes: bytes.length,
      mode: (await stat(join(run, artifactPath))).mode & 0o777,
      artifactPath,
    };
  };
  await writeFile(join(source, "document.bin"), old);
  const manifest: WorkspaceFilesManifest = {
    version: 1,
    sourceRoot: source,
    executionRoot: isolation === "live" ? source : join(root, "execution"),
    isolation,
    scopePaths: ["document.bin"],
    complete: true,
    entries: [
      { path: "document.bin", before: await file(old), after: await file(output) },
      { path: "new.txt", before: null, after: await file(Buffer.from("new")) },
    ],
  };
  const text = JSON.stringify(manifest) + "\n",
    manifestSha256 = digest(text);
  await writeFile(join(run, "final/files/manifest.json"), text);
  await writeFile(
    join(run, "final/work_product.yaml"),
    stringify({
      id: "wp-files",
      kind: "files",
      source_task_id: "task-files",
      producer_attempt_id: "a01",
      files: { manifest: "final/files/manifest.json" },
      meta: {
        manifest_sha256: manifestSha256,
        result_kind: "files",
        apply_state: isolation === "live" ? "applied" : "not_applied",
        adopted: isolation === "live",
      },
    }),
  );
  await writeFile(
    join(run, "arbitration/decision.yaml"),
    stringify(
      DecisionRecord.parse({
        winner: "a01",
        facts: makeOutcomeFacts("succeeded", { review: "not_run", review_requested: false }),
      }),
    ),
  );
  const record = {
    id: "run-files",
    runId: "run-files",
    taskId: "task-files",
    runDir: run,
    state: "succeeded",
    params: {
      mode: "agent",
      scope: { kind: "project", root: source },
      execution: { workspaceKind: "directory", isolation },
    },
  };
  const commands = new Map<string, { id: string; state: string; result?: unknown }>();
  const server = new DaemonControlApiServer({
    token: "fixture-token",
    daemon: {
      enqueue: async () => {
        throw new Error("No generation permitted");
      },
      status: async () => record,
      list: async () => [record],
      cancel: async () => ({}),
    },
    services: {
      beginDelivery: async (_params, input) => {
        const key = input.operation + input.key,
          prior = commands.get(key);
        if (prior) return { ...prior, reused: true };
        const item = { id: key, state: "running" };
        commands.set(key, item);
        return { ...item, reused: false };
      },
      completeDelivery: async (id, result) => {
        Object.assign(commands.get(id)!, { state: "succeeded", result });
      },
      failDelivery: async (id) => {
        Object.assign(commands.get(id)!, { state: "failed" });
      },
    },
  });
  const { host, port } = await server.start();
  cleanup.push(() => server.stop());
  const request = (path: string, body?: unknown, key = "fixture-key") =>
    fetch(`http://${host}:${port}/v2/runs/run-files/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { source, run, manifest, output, request };
}

describe("complete files result through the ordinary control API", () => {
  it("streams exact retained binary bytes above the preview cap", async () => {
    const f = await fixture(true);
    const result = await f.request(
      `artifacts/${f.manifest.entries[0]!.after!.kind === "file" ? f.manifest.entries[0]!.after!.artifactPath : ""}`,
    );
    expect(result.status).toBe(200);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(bytes.length).toBe(f.output.length);
    expect(digest(bytes)).toBe(digest(f.output));
  });
  it("delivers selected changes, retains pending custody, and replays the same receipt", async () => {
    const f = await fixture();
    const body = { mode: "apply", target: { kind: "original_project" }, paths: ["new.txt"] };
    const res = await f.request("apply", body);
    expect(res.status).toBe(200);
    const receipt = await res.json();
    expect(receipt).toMatchObject({ applied: true, appliedPaths: ["new.txt"] });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "not_applied",
      appliedPaths: ["new.txt"],
    });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
    expect(await (await f.request("apply", body)).json()).toEqual(receipt);
    const rest = await f.request("apply", { mode: "apply", paths: ["document.bin"] }, "second");
    expect(await rest.json()).toMatchObject({ applied: true });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "applied",
    });
  });
  it("refuses a concurrent target edit without overwriting it", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "document.bin"), "owner edit");
    const response = await f.request("apply", { mode: "apply" });
    expect(await response.json()).toMatchObject({ applied: false, treeMutated: false });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("owner edit");
  });
  it("discards pending copies without applying and refuses subsequent application", async () => {
    const f = await fixture();
    expect(await (await f.request("decision", { action: "discard" })).json()).toMatchObject({
      accepted: true,
      status: "discarded",
    });
    expect((await f.request("apply", { mode: "apply" }, "after-discard")).status).toBe(409);
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "discarded",
    });
  });
  // #563: a best-of directory run can hold a refused candidate's kept copy
  // beside its winner's pending files; one discard gives up both.
  async function keptCopy(f: Awaited<ReturnType<typeof fixture>>) {
    const env = await new WorkspaceManager(f.source).create({
      taskId: "task-files",
      attemptId: "a02",
      workspaceKind: "directory",
      scopePaths: ["document.bin"],
    });
    await writeFile(join(env.worktree_path, "authored.txt"), "refused candidate output\n");
    retainForInspection(env, { runId: "run-files", runDir: f.run });
    return env;
  }
  it("discards a kept refused copy and the pending winner together", async () => {
    const f = await fixture();
    const env = await keptCopy(f);
    expect(await (await f.request("decision", { action: "discard" })).json()).toMatchObject({
      accepted: true,
      status: "discarded",
      message:
        "Custody of the kept source copies for inspection was released (file cleanup is best-effort); nothing was applied or reverted." +
        " Pending file application discarded; retained result follows normal retention.",
    });
    expect(retainedSourcesOfRun(f.run, "run-files")).toEqual([]);
    await expect(stat(envelopeBaseOf(env))).rejects.toMatchObject({ code: "ENOENT" });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "discarded",
    });
    expect((await f.request("apply", { mode: "apply" }, "after-discard")).status).toBe(409);
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
  });
  it("releases a kept copy beside an applied winner without touching its applied state", async () => {
    const f = await fixture();
    expect(await (await f.request("apply", { mode: "apply" }, "all")).json()).toMatchObject({
      applied: true,
    });
    const env = await keptCopy(f);
    const answer = (await (await f.request("decision", { action: "discard" }, "d")).json()) as {
      message: string;
    };
    expect(answer).toMatchObject({
      status: "discarded",
      message:
        "Custody of the kept source copies for inspection was released (file cleanup is best-effort); nothing was applied or reverted.",
    });
    // An inspection-only copy has no continuation to speak of.
    expect(answer.message).not.toContain("continuation");
    await expect(stat(envelopeBaseOf(env))).rejects.toMatchObject({ code: "ENOENT" });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "applied",
    });
  });
  it("refuses discarding direct effects", async () => {
    const f = await fixture(false, "live");
    expect((await f.request("decision", { action: "discard" })).status).toBe(409);
  });
  it("replaying a partial delivery receipt cannot resurrect a discarded remainder", async () => {
    const f = await fixture();
    const body = { mode: "apply", paths: ["new.txt"] };
    const first = await (await f.request("apply", body, "subset")).json();
    expect(first).toMatchObject({ applied: true, appliedPaths: ["new.txt"] });
    expect(
      await (await f.request("decision", { action: "discard" }, "discard-rest")).json(),
    ).toMatchObject({ accepted: true, status: "discarded" });
    expect(await (await f.request("apply", body, "subset")).json()).toEqual(first);
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "discarded",
      appliedPaths: ["new.txt"],
    });
    expect(await readFile(join(f.source, "document.bin"), "utf8")).toBe("baseline\n");
  });
});
