import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import { ConformanceReport, HarnessManifest, type ProviderFamily } from "@claudexor/schema";
import {
  ensureThreadWorktree,
  objectStorePath,
  pruneProjectObjectStore,
  storeEnv,
} from "@claudexor/workspace";
import { projectRuntimeDir } from "@claudexor/util";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";

// #535 round 8 (P4-F1): config, artifacts and custody are anchored to the
// project (repoRoot); only the Git working directory is the execution root. A
// Git result of a delegated run or an isolated thread keeps its objects where
// delivery and retention look for them, through the real capture and routes.
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function repo(prefix: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), `cx-custody-${prefix}-`));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), content);
  git(root, "add", ".");
  git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return root;
}

function editing(id: string): HarnessAdapter {
  return {
    ...createFakeHarness(id as "fake-success"),
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      writeFileSync(join(spec.cwd, "added.txt"), "added\n");
      yield {
        ...common,
        type: "message",
        text: "Done.",
        final: true,
        payload: { final_source: "fake" },
      };
      yield { ...common, type: "completed", exit_code: 0 };
    },
  };
}

/** Writes the same files, then fails: the live write stays recorded and revertable. */
function failingAfterWrite(id: string): HarnessAdapter {
  return {
    ...createFakeHarness(id as "fake-success"),
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      yield { ...common, type: "error", text: "boom", payload: { code: "boom" } };
      yield { ...common, type: "completed", exit_code: 1 };
    },
  };
}

function cleanReviewer(id: string, providerFamily: ProviderFamily): ReviewerSpec {
  const model = `${id}-model`;
  return {
    providerFamily,
    requestedModel: model,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [model] },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        const route = { credential_route: "managed_api_key" as const };
        yield { ...base, ...route, type: "started", observed_model: model };
        yield { ...base, type: "message", text: "```json\n[]\n```" };
        yield { ...base, type: "completed" };
      },
    },
  };
}

function editingOrchestrator(): Orchestrator {
  const adapters = [...["fake-success", "fake-other"].map(editing), failingAfterWrite("fake-fail")];
  return new Orchestrator({
    registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
    reviewers: [cleanReviewer("rev-o", "openai"), cleanReviewer("rev-g", "google")],
  });
}

type GitResultMeta = {
  git_result: { base_tree: string; candidate_tree: string; base_commit: string | null };
  apply_state: string;
  revert_anchor_id?: string | null;
  execution_root?: string | null;
};

async function runToResult(
  input: Pick<RunInput, "repoRoot" | "executionRoot"> & Partial<RunInput>,
) {
  const result = await editingOrchestrator().run({
    mode: "agent",
    prompt: "edit",
    harnesses: ["fake-success"],
    n: 1,
    review: false,
    ...input,
  });
  expect(result.lifecycle).toBe("succeeded");
  const meta = new ArtifactStore(result.runDir).readYaml<{ meta: GitResultMeta }>(
    join(result.runDir, "final/work_product.yaml"),
  )!.meta;
  expect(meta.git_result).toBeTruthy();
  return { result, meta };
}

function storeHolds(project: string, oid: string): boolean {
  const store = objectStorePath(project);
  if (!existsSync(join(store, "objects"))) return false;
  try {
    execFileSync("git", ["-C", store, "cat-file", "-e", `${oid}^{tree}`], {
      env: { ...process.env, ...storeEnv(store) },
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const anchorIsThere = (project: string, id: string) =>
  existsSync(join(projectRuntimeDir(project), "anchors", "objects", `${id.slice(7)}.pair`));

/** The real control API over one run record; only the job list is a stub. */
async function routes(input: {
  runDir: string;
  runId: string;
  project: string;
  execution: Record<string, unknown>;
}) {
  const facts = new ArtifactStore(input.runDir).readYaml<{ task_id: string }>(
    join(input.runDir, "final/run_facts.yaml"),
  )!;
  const record = {
    id: "job-custody",
    runId: input.runId,
    taskId: facts.task_id,
    runDir: input.runDir,
    state: "succeeded",
    params: {
      mode: "agent",
      scope: { kind: "project", root: input.project },
      execution: input.execution,
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
      beginDelivery: async (_params: unknown, begin: { operation: string; key: string }) => {
        const id = begin.operation + begin.key;
        const prior = commands.get(id);
        if (prior) return { ...prior, reused: true };
        const command = { id, state: "running" };
        commands.set(id, command);
        return { ...command, reused: false };
      },
      completeDelivery: async (id: string, result: unknown) => {
        Object.assign(commands.get(id)!, { state: "succeeded", result });
      },
      failDelivery: async (id: string) => {
        Object.assign(commands.get(id)!, { state: "failed" });
      },
    },
  } as unknown as ConstructorParameters<typeof DaemonControlApiServer>[0]);
  const { host, port } = await server.start();
  cleanup.push(() => server.stop());
  return (path: string, body: unknown, key = "custody-key") =>
    fetch(`http://${host}:${port}/v2/runs/${input.runId}${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
}

describe("custody of a Git result whose execution root is not its project", () => {
  it("a delegated envelope run keeps its objects in the project store, with no store for its execution root", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    const { meta } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
    });

    // The store keeps what lies beyond the boundary commit; the base is that commit's.
    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(git(execution, "rev-parse", "HEAD^{tree}")).toBe(meta.git_result.base_tree);
    expect(existsSync(objectStorePath(execution))).toBe(false);
    // Git stays where the run executed: the user's own repositories gain no ref.
    expect(git(execution, "status", "--porcelain")).toBe("");
    expect(git(project, "status", "--porcelain")).toBe("");
  });

  it("a delegated envelope run's result checks and applies on its execution root", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    const { result } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
    });
    const request = await routes({
      runDir: result.runDir,
      runId: result.runId,
      project,
      execution: {
        workspaceKind: "git",
        isolation: "envelope",
        delegated: true,
        workspaceRoot: execution,
      },
    });
    const check = await request("/apply/check", {});
    expect(await check.json()).toMatchObject({ ok: true, alreadyApplied: false });
    expect(check.status).toBe(200);
    const apply = await request("/apply", { mode: "apply" });
    expect(await apply.json()).toMatchObject({ applied: true });
    expect(apply.status).toBe(200);
    expect(readFileSync(join(execution, "file.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(execution, "added.txt"), "utf8")).toBe("added\n");
    expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("project bytes\n");
    // The delivery's own anchor is the project's too, and revert finds it there.
    expect(existsSync(objectStorePath(execution))).toBe(false);
    const revert = await request("/decision", { action: "revert_run" }, "revert-key");
    expect(await revert.json()).toMatchObject({ accepted: true, status: "applied" });
    expect(readFileSync(join(execution, "file.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(execution, "added.txt"))).toBe(false);
  });

  it("a delegated delivery whose write stays anchors it under the project", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    const { result } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
    });
    const request = await routes({
      runDir: result.runDir,
      runId: result.runId,
      project,
      execution: {
        workspaceKind: "git",
        isolation: "envelope",
        delegated: true,
        workspaceRoot: execution,
      },
    });
    // The target's own filter fails: the proof cannot run, nor can the take-back.
    writeFileSync(join(execution, ".git/info/attributes"), "added.txt filter=up\n");
    git(execution, "config", "filter.up.clean", "exit 1");
    git(execution, "config", "filter.up.smudge", "cat");
    git(execution, "config", "filter.up.required", "true");

    const apply = await request("/apply", { mode: "apply" });

    expect(apply.status).toBe(409);
    expect(await apply.json()).toMatchObject({ context: { treeMutated: true } });
    expect(existsSync(objectStorePath(execution))).toBe(false);
    const state = new ArtifactStore(result.runDir).readYaml<{ revertAnchorId: string }>(
      join(result.runDir, "final/delivery_state.yaml"),
    )!;
    expect(anchorIsThere(project, state.revertAnchorId)).toBe(true);
  });

  it("retention keeps a delegated run's objects under the project while its run lives and drops them with it", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    const { result, meta } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
    });
    const candidate = meta.git_result.candidate_tree;
    expect(storeHolds(project, candidate)).toBe(true);

    await pruneProjectObjectStore(projectRuntimeDir(project), { dryRun: false, graceMs: 0 });
    expect(storeHolds(project, candidate)).toBe(true);

    await pruneProjectObjectStore(projectRuntimeDir(project), {
      dryRun: false,
      graceMs: 0,
      retiredOwners: new Set([result.runDir]),
    });
    expect(storeHolds(project, candidate)).toBe(false);
  });

  it("an isolated thread's turn keeps its objects in the project store, with no store for its worktree", async () => {
    const project = repo("project", "before\n");
    const worktree = await ensureThreadWorktree(project, "thread-custody");
    const { result, meta } = await runToResult({
      repoRoot: project,
      executionRoot: worktree.path,
      inPlace: true,
    });

    expect(meta.git_result).toBeTruthy();
    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(existsSync(objectStorePath(worktree.path))).toBe(false);
    expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("before\n");
    expect(meta.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));

    // The turn's own revert handle still works, on the tree that holds the turn:
    // an isolated thread's record names no workspace root, so the route resolves
    // the execution root the turn recorded.
    expect(meta.execution_root).toBe(worktree.path);
    const request = await routes({
      runDir: result.runDir,
      runId: result.runId,
      project,
      execution: { workspaceKind: "git", isolation: "live" },
    });
    const revert = await request("/decision", { action: "revert_run" });
    expect(await revert.json()).toMatchObject({ accepted: true, status: "applied" });
    expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(worktree.path, "added.txt"))).toBe(false);
  });

  it("a delegated in-place run keeps its objects and its revert anchor under the project", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    const { meta } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
      inPlace: true,
    });

    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(existsSync(objectStorePath(execution))).toBe(false);
    expect(meta.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    expect(anchorIsThere(project, meta.revert_anchor_id!)).toBe(true);
  });

  it("a best-of in an isolated thread adopts its winner from the project store", async () => {
    const project = repo("project", "before\n");
    const worktree = await ensureThreadWorktree(project, "thread-race");
    const { result, meta } = await runToResult({
      repoRoot: project,
      executionRoot: worktree.path,
      inPlace: true,
      harnesses: ["fake-success", "fake-other"],
      n: 2,
      review: true,
    });

    const decision = readFileSync(join(result.runDir, "arbitration/decision.yaml"), "utf8");
    expect(meta.apply_state, decision).toBe("applied");
    expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("before\n");
    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(existsSync(objectStorePath(worktree.path))).toBe(false);
    expect(meta.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    expect(anchorIsThere(project, meta.revert_anchor_id!)).toBe(true);
    expect(meta.execution_root).toBe(worktree.path);
    const request = await routes({
      runDir: result.runDir,
      runId: result.runId,
      project,
      execution: { workspaceKind: "git", isolation: "live" },
    });
    const revert = await request("/decision", { action: "revert_run" }, "revert-race");
    expect(await revert.json()).toMatchObject({ accepted: true, status: "applied" });
    expect(readFileSync(join(worktree.path, "file.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(worktree.path, "added.txt"))).toBe(false);
  });

  it("a delegated run over a dirty execution root keeps its base snapshot in the project store", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    writeFileSync(join(execution, "dirty.txt"), "the caller's uncommitted file\n");
    const { result, meta } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
    });

    // The envelope's base is a dirty snapshot no ref keeps: the project's store does.
    const snapshot = meta.git_result.base_commit!;
    expect(snapshot).not.toBe(git(execution, "rev-parse", "HEAD"));
    expect(storeHolds(project, snapshot)).toBe(true);
    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(existsSync(objectStorePath(execution))).toBe(false);
    const request = await routes({
      runDir: result.runDir,
      runId: result.runId,
      project,
      execution: {
        workspaceKind: "git",
        isolation: "envelope",
        delegated: true,
        workspaceRoot: execution,
      },
    });
    const apply = await request("/apply", { mode: "apply" });
    expect(await apply.json()).toMatchObject({ applied: true });
    expect(readFileSync(join(execution, "file.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(execution, "dirty.txt"), "utf8")).toBe(
      "the caller's uncommitted file\n",
    );
  });

  it("a delegated attempts run keeps its objects in the project store", async () => {
    const project = repo("project", "project bytes\n");
    const execution = repo("exec", "before\n");
    const { meta } = await runToResult({
      repoRoot: project,
      executionRoot: execution,
      delegated: true,
      attempts: 2,
    });

    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(existsSync(objectStorePath(execution))).toBe(false);
  });

  it("an attempts turn in an isolated thread keeps its anchor under the project", async () => {
    const project = repo("project", "before\n");
    const worktree = await ensureThreadWorktree(project, "thread-attempts");
    const { meta } = await runToResult({
      repoRoot: project,
      executionRoot: worktree.path,
      inPlace: true,
      attempts: 2,
    });

    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
    expect(existsSync(objectStorePath(worktree.path))).toBe(false);
    expect(meta.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    expect(anchorIsThere(project, meta.revert_anchor_id!)).toBe(true);
  });

  it("a failed turn in an isolated thread keeps its live write's anchor under the project", async () => {
    const project = repo("project", "before\n");
    const worktree = await ensureThreadWorktree(project, "thread-failed");
    const result = await editingOrchestrator().run({
      repoRoot: project,
      executionRoot: worktree.path,
      inPlace: true,
      mode: "agent",
      prompt: "edit",
      harnesses: ["fake-fail"],
      n: 1,
      review: false,
    });

    const meta = new ArtifactStore(result.runDir).readYaml<{ meta: GitResultMeta }>(
      join(result.runDir, "final/work_product.yaml"),
    )!.meta;
    expect(meta.apply_state).toBe("applied_review_blocked");
    expect(meta.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    expect(anchorIsThere(project, meta.revert_anchor_id!)).toBe(true);
    expect(existsSync(objectStorePath(worktree.path))).toBe(false);
  });

  it("a cancelled turn in an isolated thread keeps its live write's anchor under the project", async () => {
    const project = repo("project", "before\n");
    const worktree = await ensureThreadWorktree(project, "thread-cancelled");
    const abort = new AbortController();
    const base = editing("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        yield* base.run(spec);
        abort.abort("user_cancelled");
      },
    };
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: project,
      executionRoot: worktree.path,
      inPlace: true,
      mode: "agent",
      prompt: "edit",
      harnesses: [adapter.id],
      n: 1,
      review: false,
      signal: abort.signal,
    });

    expect(result.lifecycle).toBe("cancelled");
    const meta = new ArtifactStore(result.runDir).readYaml<{ meta: GitResultMeta }>(
      join(result.runDir, "final/work_product.yaml"),
    )!.meta;
    expect(meta.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    expect(anchorIsThere(project, meta.revert_anchor_id!)).toBe(true);
    expect(existsSync(objectStorePath(worktree.path))).toBe(false);
  });

  it("sanity: an ordinary run, whose execution root is its project, keeps its objects there", async () => {
    const project = repo("project", "before\n");
    const { meta } = await runToResult({ repoRoot: project, executionRoot: undefined });
    expect(storeHolds(project, meta.git_result.candidate_tree)).toBe(true);
  });
});
