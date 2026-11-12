import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  DecisionRecord,
  makeOutcomeFacts,
  SCHEMA_VERSION,
  TaskContract,
  type CommandListQuery,
} from "@claudexor/schema";
import {
  captureDirectoryWorkspace,
  createDirectoryEnvelope,
  createRevertAnchorFromPatchOrNull,
} from "@claudexor/workspace";
import { DaemonControlApiServer } from "./daemon-server.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

const stops: Array<() => Promise<unknown>> = [];
const removals: Array<() => Promise<unknown>> = [];
// Stops first, then the fs/promises removals, each under the hook deadline (#376). A stop that
// fails or settles late keeps this test's root; the removals are taken before the first await.
afterEachClosed(
  async () => {
    const ownedRemovals = removals.splice(0).reverse();
    for (const stop of stops.splice(0).reverse()) await stop();
    return async () => {
      for (const remove of ownedRemovals) await remove();
    };
  },
  undefined,
  "awaited",
);

async function fixture(delegated = true) {
  const root = await mkdtemp(join(tmpdir(), "cx-delegated-apply-"));
  removals.push(() => rm(root, { recursive: true, force: true }));
  const author = join(root, "author");
  const workspace = join(root, "caller-workspace");
  const envelopeRoot = join(root, "envelope");
  const run = join(root, "run");
  await Promise.all(
    [author, workspace, envelopeRoot, join(run, "context"), join(run, "arbitration")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  for (const path of [author, workspace]) {
    // Identical mutable preimages make a wrong author-root check look clean.
    await writeFile(join(path, "document.txt"), "baseline\n");
    await writeFile(join(path, "context.txt"), path === author ? "author input" : "caller input");
  }
  const source = delegated ? workspace : author;
  const envelope = await createDirectoryEnvelope({
    sourceRoot: source,
    envelopeRoot,
    envelopeId: "env-files",
    homeDir: join(root, "home"),
    harnessConfigDirs: {},
    taskId: "task-files",
    attemptId: "a01",
    scopePaths: ["."],
  });
  const output = Buffer.from([0, 255, 12, 99]);
  await writeFile(join(envelope.worktree_path, "document.txt"), "prepared\n");
  await writeFile(join(envelope.worktree_path, "new.bin"), output);
  const captured = await captureDirectoryWorkspace({
    executionRoot: envelope.worktree_path,
    envelopeRoot,
    runRoot: run,
  });
  const task = TaskContract.parse({
    schema_version: SCHEMA_VERSION,
    task_id: "task-files",
    created_at: "2026-10-08T00:00:00Z",
    // Configuration identity stays with the author, even though the captured
    // baseline and the verifier's unchanged inputs belong to the caller.
    repo: { root: author, base_ref: "HEAD" },
    mode: { kind: "agent" },
    user_intent: { raw: "Edit selected caller files" },
    review_requested: false,
    tests: {
      commands: [
        {
          id: "retained-context",
          program: process.execPath,
          args: [
            "-e",
            `if(require('node:fs').readFileSync('context.txt','utf8')!==${JSON.stringify(delegated ? "caller input" : "author input")})process.exit(3)`,
          ],
        },
      ],
    },
  });
  await writeFile(join(run, "context/task.yaml"), stringify(task));
  await writeFile(
    join(run, "final/work_product.yaml"),
    stringify({
      id: "wp-files",
      kind: "files",
      source_task_id: "task-files",
      producer_attempt_id: "a01",
      files: { manifest: captured.manifestPath },
      meta: {
        manifest_sha256: captured.manifestSha256,
        result_kind: "files",
        apply_state: "not_applied",
        adopted: false,
      },
    }),
  );
  await writeFile(
    join(run, "arbitration/decision.yaml"),
    stringify(
      DecisionRecord.parse({
        winner: "a01",
        facts: makeOutcomeFacts("succeeded", {
          review: "not_run",
          review_requested: false,
          checks: "passed",
        }),
        final_verify: { attempted: true, applied_cleanly: true, gates_passed: true },
      }),
    ),
  );
  // Delivery must work from retained bytes after the candidate copy is gone.
  await rm(envelopeRoot, { recursive: true });
  const record = {
    id: "job-files",
    runId: "run-files",
    taskId: "task-files",
    runDir: run,
    state: "succeeded",
    params: {
      mode: "agent",
      scope: { kind: "project", root: author },
      execution: {
        workspaceKind: "directory",
        isolation: "envelope",
        delegated,
        ...(delegated ? { workspaceRoot: workspace } : {}),
      },
    },
  };
  const list = vi.fn(async (query: CommandListQuery) => {
    if ("id" in query && query.id === record.runId) return [record];
    if ("delegatedFromRunId" in query && query.delegatedFromRunId === record.runId) return [];
    throw new Error("Only the addressed run and its direct children may be queried");
  });
  const commands = new Map<string, { id: string; state: string; result?: unknown }>();
  const applyThread = vi.fn(async () => {
    throw new Error("A caller-owned thread workspace must never be delivered");
  });
  const server = new DaemonControlApiServer({
    token: "fixture-token",
    daemon: {
      enqueue: async () => {
        throw new Error("No generation permitted");
      },
      status: async () => record,
      list,
      cancel: async () => ({}),
    },
    services: {
      threadDetail: async () => ({
        thread: {
          id: "thread-files",
          repo: { root: author },
          workspace: { mode: "delegated", workspace_root: workspace },
          run_ids: [record.runId],
        },
        turns: [],
        sessions: [],
      }),
      applyThread,
      beginDelivery: async (_params, input) => {
        const id = input.operation + input.key;
        const prior = commands.get(id);
        if (prior) return { ...prior, reused: true };
        const command = { id, state: "running" };
        commands.set(id, command);
        return { ...command, reused: false };
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
  stops.push(() => server.stop());
  const request = async (path: string, body?: unknown, key = "fixture-key") => {
    const before = list.mock.calls.length;
    const response = await fetch(`http://${host}:${port}/v2/runs/run-files${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(list.mock.calls.slice(before)).toEqual(
      body === undefined
        ? [[{ id: record.runId }], [{ delegatedFromRunId: record.runId }]]
        : [[{ id: record.runId }]],
    );
    return response;
  };
  return {
    root,
    author,
    workspace,
    source,
    run,
    output,
    captured,
    record,
    request,
    baseUrl: `http://${host}:${port}/v2`,
    list,
    applyThread,
  };
}

describe("delegated run results through HTTP apply consumers", () => {
  it("keeps exact Git patch custody in the stable project namespace", async () => {
    const f = await fixture();
    const patch =
      "diff --git a/document.txt b/document.txt\n--- a/document.txt\n+++ b/document.txt\n@@ -1 +1 @@\n-baseline\n+prepared\n";
    const digest = createRevertAnchorFromPatchOrNull(f.author, patch);
    expect(digest).not.toBeNull();
    f.record.params.execution.workspaceKind = "git";
    f.record.params.execution.isolation = "live";
    await writeFile(join(f.run, "final/patch.diff"), patch.replace("+prepared", "+[redacted]"));
    await writeFile(
      join(f.run, "final/work_product.yaml"),
      stringify({
        id: "wp-patch",
        kind: "patch",
        source_task_id: "task-files",
        producer_attempt_id: "a01",
        meta: {
          result_kind: "patch",
          apply_state: "not_applied",
          patch_sha256: digest,
          persisted_patch: "redacted",
          exact_patch_object: digest,
          // An unadopted best-of candidate has no in-place execution anchor.
          execution_root: null,
        },
      }),
    );
    expect(await (await f.request("")).json()).toMatchObject({
      applyEligibility: { eligible: true },
    });
    const check = await f.request("/apply/check", {});
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ ok: true });
  });

  it("checks and applies to the recorded caller workspace by default", async () => {
    const f = await fixture();
    expect(f.captured.manifest.sourceRoot).toBe(f.workspace);
    expect(f.captured.manifest.executionRoot).not.toBe(f.workspace);
    expect(parse(await readFile(join(f.run, "context/task.yaml"), "utf8"))).toMatchObject({
      repo: { root: f.author },
    });
    expect(await (await f.request("")).json()).toMatchObject({
      applyEligibility: { eligible: true },
    });
    const check = await f.request("/apply/check", {});
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ ok: true, alreadyApplied: false });
    const response = await f.request("/apply", { mode: "apply" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: true,
      treeMutated: true,
      finalVerify: { attempted: true, applied_cleanly: true, gates_passed: true },
    });
    expect(await readFile(join(f.workspace, "document.txt"), "utf8")).toBe("prepared\n");
    expect(await readFile(join(f.workspace, "new.bin"))).toEqual(f.output);
    expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("baseline\n");
    await expect(readFile(join(f.author, "new.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await (await f.request("")).json()).toMatchObject({
      applyEligibility: { eligible: false, state: "already_applied" },
    });
  });

  it.each([false, true])(
    "accepts an explicit caller target (canonical alias: %s)",
    async (alias) => {
      const f = await fixture();
      const targetRoot = alias ? join(f.root, "workspace-alias") : f.workspace;
      if (alias) await symlink(f.workspace, targetRoot, "dir");
      const target = { kind: "project", root: targetRoot };
      expect(await (await f.request("/apply/check", { target })).json()).toMatchObject({
        ok: true,
      });
      const response = await f.request("/apply", { mode: "apply", target });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ applied: true });
      expect(await readFile(join(f.workspace, "document.txt"), "utf8")).toBe("prepared\n");
      expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("baseline\n");
    },
  );

  it("refuses an explicit author target even when its mutable preimages match", async () => {
    const f = await fixture();
    const target = { kind: "project", root: f.author };
    expect(await (await f.request("/apply/check", { target })).json()).toMatchObject({ ok: false });
    const response = await f.request("/apply", { mode: "apply", target });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: false, treeMutated: false });
    for (const root of [f.author, f.workspace]) {
      expect(await readFile(join(root, "document.txt"), "utf8")).toBe("baseline\n");
      await expect(readFile(join(root, "new.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps an unavailable caller workspace ineligible without falling back to the author", async () => {
    const f = await fixture();
    await rm(f.workspace, { recursive: true });
    expect(await (await f.request("")).json()).toMatchObject({
      applyEligibility: { eligible: false },
    });
    expect(await (await f.request("/apply/check", {})).json()).toMatchObject({ ok: false });
    expect((await f.request("/apply", { mode: "apply" })).status).toBeGreaterThanOrEqual(400);
    const authorTarget = { kind: "project", root: f.author };
    expect(await (await f.request("/apply/check", { target: authorTarget })).json()).toMatchObject({
      ok: false,
    });
    expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("baseline\n");
    await expect(readFile(join(f.author, "new.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an ordinary envelope without an execution override bound to the author", async () => {
    const f = await fixture(false);
    expect(f.record.params.execution).not.toHaveProperty("workspaceRoot");
    expect(await (await f.request("/apply/check", {})).json()).toMatchObject({ ok: true });
    expect(await (await f.request("/apply", { mode: "apply" })).json()).toMatchObject({
      applied: true,
      finalVerify: { gates_passed: true },
    });
    expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("prepared\n");
    expect(await readFile(join(f.workspace, "document.txt"), "utf8")).toBe("baseline\n");
  });

  it.each([false, true])(
    "accept_clean_patch uses the caller workspace (explicit: %s)",
    async (explicit) => {
      const f = await fixture();
      const body = {
        action: "accept_clean_patch",
        ...(explicit ? { target: { kind: "project", root: f.workspace } } : {}),
      };
      const response = await f.request("/decision", body);
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt).toMatchObject({ accepted: true, status: "applied" });
      expect(await (await f.request("/decision", body)).json()).toEqual(receipt);
      expect(await readFile(join(f.workspace, "document.txt"), "utf8")).toBe("prepared\n");
      expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("baseline\n");
    },
  );

  it("preserves partial custody and same-key and fresh-key idempotent delivery", async () => {
    const f = await fixture();
    const subset = { mode: "apply", paths: ["new.bin"] };
    expect(await (await f.request("/apply/check", { paths: subset.paths })).json()).toMatchObject({
      ok: true,
    });
    const receipt = await (await f.request("/apply", subset, "subset")).json();
    expect(receipt).toMatchObject({ applied: true, appliedPaths: ["new.bin"] });
    expect(await (await f.request("/apply", subset, "subset")).json()).toEqual(receipt);
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "not_applied",
      appliedPaths: ["new.bin"],
    });
    expect(await readFile(join(f.workspace, "document.txt"), "utf8")).toBe("baseline\n");
    expect(await (await f.request("/apply", { mode: "apply" }, "rest")).json()).toMatchObject({
      applied: true,
    });
    expect(parse(await readFile(join(f.run, "final/delivery_state.yaml"), "utf8"))).toMatchObject({
      applyState: "applied",
    });
    expect(await (await f.request("/apply/check", {})).json()).toMatchObject({
      ok: true,
      alreadyApplied: true,
    });
    expect(
      await (await f.request("/apply", { mode: "apply" }, "fresh-replay")).json(),
    ).toMatchObject({
      applied: true,
      treeMutated: false,
      alreadyApplied: true,
    });
    expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("baseline\n");
  });

  it("refuses delegated thread apply before history lookup or delivery", async () => {
    const f = await fixture();
    const response = await fetch(`${f.baseUrl}/threads/thread-files/apply`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": "thread-apply",
      },
      body: JSON.stringify({ mode: "apply" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "thread_workspace_caller_owned" });
    expect(f.list).not.toHaveBeenCalled();
    expect(f.applyThread).not.toHaveBeenCalled();
    expect(await readFile(join(f.author, "document.txt"), "utf8")).toBe("baseline\n");
    expect(await readFile(join(f.workspace, "document.txt"), "utf8")).toBe("baseline\n");
  });
});
