import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";

// #502: a live in-place turn snapshots the tree before it (pre-turn A), at its
// envelope (base B) and after it (post-turn fence P). P is only the revert
// target's postimage, so a turn whose COMPLETE final capture changed nothing
// has no use for it: no anchor, no post_turn_sha, revert refuses. A changed or
// never-captured turn keeps P; a refused capture keeps its existing skip.
//
// Every Git snapshot goes through the workspace's one `snapshotTree`; every
// in-place capture through its one transient capture. Both are observed at
// their own module (the orchestrator's and the envelope's calls alike), with
// the real implementation underneath.
const observed = vi.hoisted(() => ({
  snapshots: [] as string[],
  captures: 0,
  afterCapture: undefined as ((n: number) => void) | undefined,
  refuseCaptures: false,
}));

vi.mock(import("../../workspace/dist/git-snapshot.js"), async (original) => {
  const real = await original();
  return {
    ...real,
    snapshotTree: async (repo: string, exact?: readonly string[]) => {
      observed.snapshots.push(repo);
      return real.snapshotTree(repo, exact);
    },
  };
});

vi.mock(import("../../workspace/dist/git-transient-capture.js"), async (original) => {
  const real = await original();
  return {
    ...real,
    captureWorkingTreeTransient: async (
      ...args: Parameters<typeof real.captureWorkingTreeTransient>
    ) => {
      observed.captures += 1;
      const captured = observed.refuseCaptures
        ? { patch: "", captureIncomplete: true, captureFailure: new Error("fixture refusal") }
        : await real.captureWorkingTreeTransient(...args);
      observed.afterCapture?.(observed.captures);
      return captured;
    },
  };
});

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  observed.snapshots = [];
  observed.captures = 0;
  observed.afterCapture = undefined;
  observed.refuseCaptures = false;
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function repo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `cx-fence-${prefix}-`));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), "before\n");
  writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return root;
}

type Behaviour =
  "edit" | "none" | "fail-after-edit" | "fail-without-edit" | "throw-after-edit" | "throw";

function harness(behaviour: Behaviour, after?: () => void): HarnessAdapter {
  return {
    ...createFakeHarness("fake-success"),
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      if (["edit", "fail-after-edit", "throw-after-edit"].includes(behaviour))
        writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      if (behaviour.startsWith("throw")) throw new Error("fixture harness crashed");
      after?.();
      if (behaviour.startsWith("fail")) {
        yield { ...common, type: "error", text: "boom", payload: { code: "boom" } };
        yield { ...common, type: "completed", exit_code: 1 };
      } else {
        const final = { final: true, payload: { final_source: "fake" } };
        yield { ...common, type: "message", text: "Done.", ...final };
        yield { ...common, type: "completed", exit_code: 0 };
      }
    },
  };
}

type WorkProductMeta = {
  git_result?: { base_tree: string; candidate_tree: string };
  adopted?: boolean | null;
  apply_state?: string;
  pre_turn_sha?: string | null;
  post_turn_sha?: string | null;
  revert_anchor_id?: string | null;
  capture_refused?: boolean;
};

async function turn(
  behaviour: Behaviour,
  input: Partial<RunInput> & { afterHarness?: () => void } = {},
) {
  const project = repo("project");
  const execution = repo("exec");
  const adapter = harness(behaviour, input.afterHarness);
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: project,
    executionRoot: execution,
    delegated: true,
    inPlace: true,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: false,
    ...input,
  });
  const wpPath = join(result.runDir, "final/work_product.yaml");
  const meta = existsSync(wpPath)
    ? new ArtifactStore(result.runDir).readYaml<{ meta: WorkProductMeta }>(wpPath)!.meta
    : null;
  const snapshots = observed.snapshots.filter((root) => root === execution).length;
  return { project, execution, result, meta, snapshots };
}

/** Real HTTP revert route and Git operations; daemon lookup and delivery-ledger services are stubs. */
async function revert(run: Awaited<ReturnType<typeof turn>>) {
  const facts = new ArtifactStore(run.result.runDir).readYaml<{ task_id: string }>(
    join(run.result.runDir, "final/run_facts.yaml"),
  )!;
  const record = {
    id: "job-fence",
    runId: run.result.runId,
    taskId: facts.task_id,
    runDir: run.result.runDir,
    state: run.result.lifecycle,
    params: {
      mode: "agent",
      scope: { kind: "project", root: run.project },
      execution: {
        workspaceKind: "git",
        isolation: "live",
        delegated: true,
        workspaceRoot: run.execution,
      },
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
  try {
    const response = await fetch(`http://${host}:${port}/v2/runs/${run.result.runId}/decision`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": "fence-revert",
      },
      body: JSON.stringify({ action: "revert_run" }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    await server.stop();
  }
}

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

describe("the post-turn fence of a live single-candidate turn (#502)", () => {
  it("an unchanged turn takes no post-turn snapshot and keeps its no-change result and revert refusal", async () => {
    // A caller edit after the final capture: outside the result either way.
    let caller: string | undefined;
    observed.afterCapture = (n) => {
      if (n === 2 && caller) writeFileSync(join(caller, "other.txt"), "caller edit\n");
    };
    const run = await turn("none", {
      afterHarness: () => {
        caller = observed.snapshots.at(-1);
      },
    });

    expect(run.result.lifecycle).toBe("succeeded");
    expect(run.result.facts.noChanges).toBe(true);
    // A (pre-turn) and B (envelope base) only: no post-turn fence.
    expect.soft(run.snapshots).toBe(2);
    expect(observed.captures).toBe(2);
    expect(run.meta?.git_result?.base_tree).toBe(run.meta?.git_result?.candidate_tree);
    expect(run.meta).toMatchObject({
      adopted: null,
      apply_state: "not_applied",
      post_turn_sha: null,
      revert_anchor_id: null,
    });
    const refused = await revert(run);
    expect(refused.status).toBe(409);
    expect(read(run.execution, "file.txt")).toBe("before\n");
    expect(read(run.execution, "other.txt")).toBe("caller edit\n");
  });

  it("a changed turn still fences its postimage after the final capture, a later caller edit included", async () => {
    // The counterexample to reusing the capture as the postimage: an edit
    // between the final capture and the fence lands in P, not in the result.
    let execution: string | undefined;
    observed.afterCapture = (n) => {
      if (n === 2 && execution) writeFileSync(join(execution, "other.txt"), "caller edit\n");
    };
    const run = await turn("edit", {
      afterHarness: () => {
        execution = observed.snapshots.at(-1);
      },
    });

    expect(run.result.lifecycle).toBe("succeeded");
    expect(run.snapshots).toBe(3);
    const postTree = git(run.execution, "rev-parse", `${run.meta?.post_turn_sha}^{tree}`);
    expect(postTree).not.toBe(run.meta?.git_result?.candidate_tree);
    expect(run.meta).toMatchObject({ adopted: true, apply_state: "applied" });
    expect(run.meta?.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    const reverted = await revert(run);
    expect(reverted.body).toMatchObject({ accepted: true, status: "applied" });
    expect(read(run.execution, "file.txt")).toBe("before\n");
    expect(read(run.execution, "other.txt")).toBe("other\n");
  });

  it("a refused capture still takes no fence and keeps its capture-refused record", async () => {
    observed.refuseCaptures = true;
    const run = await turn("edit");

    expect.soft(run.snapshots).toBe(2);
    expect(run.meta).toMatchObject({
      capture_refused: true,
      post_turn_sha: null,
      revert_anchor_id: null,
    });
    expect(read(run.execution, "file.txt")).toBe("after\n");
  });

  it("a failed turn that wrote keeps its fence and revert; one that did not write takes none", async () => {
    const wrote = await turn("fail-after-edit");
    expect(wrote.result.lifecycle).toBe("failed");
    expect(wrote.snapshots).toBe(3);
    expect(wrote.meta).toMatchObject({ apply_state: "applied_review_blocked" });
    expect(wrote.meta?.post_turn_sha).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
    expect((await revert(wrote)).body).toMatchObject({ accepted: true, status: "applied" });
    expect(read(wrote.execution, "file.txt")).toBe("before\n");

    const idle = await turn("fail-without-edit");
    expect(idle.result.lifecycle).toBe("failed");
    expect.soft(idle.snapshots).toBe(2);
    expect(idle.meta).toBeNull();
    expect((await revert(idle)).status).toBe(409);
    expect(read(idle.execution, "file.txt")).toBe("before\n");
  });

  it("a crashed harness is still captured: its fence follows what that capture found", async () => {
    const wrote = await turn("throw-after-edit");
    expect(wrote.result.lifecycle).not.toBe("succeeded");
    // Captured (a crashed try may be tried again in the same tree).
    expect(observed.captures).toBeGreaterThan(0);
    expect(wrote.snapshots).toBe(3);
    expect(wrote.meta?.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
    expect((await revert(wrote)).body).toMatchObject({ accepted: true, status: "applied" });
    expect(read(wrote.execution, "file.txt")).toBe("before\n");

    observed.captures = 0;
    const idle = await turn("throw");
    expect(idle.result.lifecycle).not.toBe("succeeded");
    expect(observed.captures).toBeGreaterThan(0);
    expect.soft(idle.snapshots).toBe(2);
    expect(idle.meta).toBeNull();
    expect((await revert(idle)).status).toBe(409);
  });

  it("a cancelled turn fences only when it changed the tree", async () => {
    for (const behaviour of ["edit", "none"] as const) {
      const abort = new AbortController();
      const run = await turn(behaviour, {
        signal: abort.signal,
        afterHarness: () => abort.abort("user_cancelled"),
      });
      expect(run.result.lifecycle).toBe("cancelled");
      if (behaviour === "edit") {
        expect(run.snapshots).toBe(3);
        expect(run.meta?.revert_anchor_id).toEqual(expect.stringMatching(/^sha256:/));
      } else {
        expect.soft(run.snapshots).toBe(2);
        expect(run.meta).toBeNull();
        expect((await revert(run)).status).toBe(409);
      }
    }
  });

  it("an in-place convergence attempt fences only when it changed the tree", async () => {
    const changed = await turn("edit", { attempts: 2 });
    expect(changed.snapshots).toBe(3);
    expect(changed.meta).toMatchObject({ adopted: true });
    expect(changed.meta?.post_turn_sha).toEqual(expect.stringMatching(/^[0-9a-f]{40}$/));
    expect((await revert(changed)).body).toMatchObject({ accepted: true, status: "applied" });
    expect(read(changed.execution, "file.txt")).toBe("before\n");

    const unchanged = await turn("none", { attempts: 2 });
    expect(unchanged.result.facts.noChanges).toBe(true);
    expect.soft(unchanged.snapshots).toBe(2);
    expect(unchanged.meta).toMatchObject({
      adopted: null,
      apply_state: "not_applied",
      post_turn_sha: null,
      revert_anchor_id: null,
    });
    expect((await revert(unchanged)).status).toBe(409);
  });
});
