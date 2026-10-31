import child, { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  DecisionRecord,
  GIT_OBJECTS_V1,
  makeOutcomeFacts,
  SCHEMA_VERSION,
  TaskContract,
  type GitObjectResult,
} from "@claudexor/schema";
import {
  captureWorkingTreeTransient,
  gitResultDigest,
  isolatedCloneAdd,
  objectStorePath,
} from "@claudexor/workspace";
import {
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
  sha256,
} from "@claudexor/util";
import { locateScanner } from "@claudexor/delivery";
import { DaemonControlApiServer } from "./daemon-server.js";
import { markRunApplyState } from "./run-delivery-state.js";

// INV-062: a delivery the owner refuses for a typed reason answers that reason as
// the 409's problem code on every route, the way patch_exact_bytes_unavailable
// does, so a client never parses prose. Real server, real delivery owner.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

// The fixtures' own Git never reads the operator's global or system config.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const COMMIT = ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm"];

const decision = (checks: "passed" | "failed") =>
  stringify(
    DecisionRecord.parse({
      winner: "a01",
      facts: makeOutcomeFacts("succeeded", { review: "not_run", review_requested: false, checks }),
      final_verify: { attempted: true, applied_cleanly: true, gates_passed: true },
    }),
  );

const workProduct = (meta: Record<string, unknown>) =>
  stringify({
    id: "wp",
    kind: "patch",
    source_task_id: "task-1",
    producer_attempt_id: "a01",
    meta: { result_kind: "patch", apply_state: "not_applied", adopted: false, ...meta },
  });

/** A Git result's meta whose patch view is not rendered. */
const unrendered = (result: GitObjectResult) => ({
  patch_sha256: null,
  git_result: result,
  patch_view: { available: false, reason: "exceeds_view_limit", limitBytes: 1, estimatedBytes: 2 },
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-refusal-code-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const run = join(root, "run");
  mkdirSync(project);
  mkdirSync(join(run, "final"), { recursive: true });
  mkdirSync(join(run, "context"));
  mkdirSync(join(run, "arbitration"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args], { env: GIT_ENV })
      .toString("utf8")
      .trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(project, "x"), "old\n");
  git("add", "x");
  git(...COMMIT, "base");
  // A valid descriptor whose trees exist nowhere: the run has no rendered patch view.
  const result: GitObjectResult = {
    schema: GIT_OBJECTS_V1,
    object_format: "sha1",
    base_tree: "1".repeat(40),
    candidate_tree: "2".repeat(40),
    base_commit: null,
    store_boundary_commit: null,
    digest: "",
  };
  result.digest = gitResultDigest(result);
  writeFileSync(join(run, "final/work_product.yaml"), workProduct(unrendered(result)));
  writeFileSync(
    join(run, "context/task.yaml"),
    stringify(
      TaskContract.parse({
        schema_version: SCHEMA_VERSION,
        task_id: "task-1",
        created_at: "2026-10-30T00:00:00Z",
        repo: { root: project, base_ref: "HEAD" },
        mode: { kind: "agent" },
        user_intent: { raw: "edit" },
        review_requested: false,
      }),
    ),
  );
  writeFileSync(join(run, "arbitration/decision.yaml"), decision("passed"));
  const record = {
    id: "job-1",
    runId: "run-1",
    taskId: "task-1",
    runDir: run,
    state: "succeeded",
    params: {
      mode: "agent",
      scope: { kind: "project", root: project, context: "auto" },
      execution: { workspaceKind: "git", isolation: "envelope" },
    },
  };
  const commands = new Map<string, Record<string, unknown>>();
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
      beginDelivery: async (_params: unknown, input: { operation: string; key: string }) => {
        const id = input.operation + input.key;
        const prior = commands.get(id);
        if (prior) return { ...prior, reused: true };
        const command = { id, state: "running" };
        commands.set(id, command);
        return { ...command, reused: false };
      },
      completeDelivery: async (id: string, result: unknown) => {
        Object.assign(commands.get(id)!, { state: "succeeded", result });
      },
      // failDeliveryCommand's own shape (packages/daemon/src/delivery-command.ts),
      // which control-api cannot import: a replay answers what the journal kept.
      failDelivery: async (id: string, error: unknown) => {
        const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const context = safeProblemContext(value["context"]);
        const requiredActions = safeProblemRequiredActions(value["requiredActions"]);
        Object.assign(commands.get(id)!, {
          state: "failed",
          error: safeProblemMessage(error),
          errorCode: typeof value["code"] === "string" ? value["code"] : undefined,
          ...(requiredActions.length > 0 ? { errorRequiredActions: requiredActions } : {}),
          ...(Object.keys(context).length > 0 ? { errorContext: context } : {}),
          result: {
            status: typeof value["status"] === "number" ? value["status"] : 500,
            code: typeof value["code"] === "string" ? value["code"] : null,
          },
        });
      },
    } as never,
  } as never);
  const { host, port } = await server.start();
  cleanup.push(() => server.stop());
  const post = (path: string, body: unknown, key: string) =>
    fetch(`http://${host}:${port}/v2/runs/run-1${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-token",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const get = async () =>
    (await (
      await fetch(`http://${host}:${port}/v2/runs/run-1`, {
        headers: { Authorization: "Bearer fixture-token", "X-Claudexor-Protocol-Major": "3" },
      })
    ).json()) as { summary?: { result?: { applyState?: string; revertable?: boolean } } };
  /** The durable journal row of one route's command. */
  const journal = (path: string, key: string) =>
    commands.get(`${path === "/apply" ? "run.apply" : "run.decision.accept_clean_patch"}${key}`);
  return { project, run, git, post, get, journal };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Capture a real result in a clone of the project's HEAD without the project's
 * config: `edit` writes the candidate; `rendered` keeps the patch view. */
async function realResult(f: Fixture, edit: (clone: string) => void, rendered = false) {
  const clone = join(mkdtempSync(join(tmpdir(), "cx-refusal-clone-")), "tree");
  cleanup.push(() => rmSync(join(clone, ".."), { recursive: true, force: true }));
  await isolatedCloneAdd(f.project, clone, "claudexor/t/a01", f.git("rev-parse", "HEAD"));
  edit(clone);
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: f.project,
    owner: f.run,
    ...(rendered ? {} : { viewLimitBytes: 1 }),
  });
  const result = captured.result!;
  if (rendered) {
    writeFileSync(join(f.run, "final/patch.diff"), captured.patch);
    writeFileSync(
      join(f.run, "final/work_product.yaml"),
      workProduct({ patch_sha256: sha256(captured.patch), git_result: result }),
    );
  } else writeFileSync(join(f.run, "final/work_product.yaml"), workProduct(unrendered(result)));
  return result;
}

/** A real result whose delivery fails the content proof for real: it adds a file
 * under a filter the project configures only after the capture. */
async function realUnprovableResult(f: Fixture) {
  writeFileSync(join(f.project, ".gitattributes"), "*.weird filter=up\n");
  f.git("add", ".gitattributes");
  f.git(...COMMIT, "attrs");
  await realResult(f, (clone) => writeFileSync(join(clone, "new.weird"), "lower bytes\n"));
  f.git("config", "filter.up.smudge", "cat");
}

const unchanged = (project: string) => {
  expect(readFileSync(join(project, "x"), "utf8")).toBe("old\n");
  expect(
    execFileSync("git", ["-C", project, "status", "--porcelain"], { env: GIT_ENV }).toString(),
  ).toBe("");
};

interface Problem {
  code: string;
  message: string;
  requiredActions: string[];
  context: Record<string, unknown>;
}

/** POST twice with one key: the first answer, and that a replay answers the same. */
async function refusedTwice(f: Fixture, path: string, body: unknown, key: string) {
  const first = await f.post(path, body, key);
  expect(first.status).toBe(409);
  const problem = (await first.json()) as Problem;
  const replay = await f.post(path, body, key);
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({
    code: problem.code,
    requiredActions: problem.requiredActions,
    context: problem.context,
  });
  // A refusal is a failed command in the durable journal, never a succeeded one.
  expect(f.journal(path, key)).toMatchObject({ state: "failed", errorCode: problem.code });
  return problem;
}

const pinned = locateScanner({ env: process.env, configDir: null });

const CASES = [
  { code: "result_objects_missing", mode: "apply" },
  { code: "pr_unrendered_result", mode: "pr" },
] as const;

const ROUTES = [
  ["POST /runs/:id/apply", "/apply", { mode: "apply" }],
  ["POST /runs/:id/decision", "/decision", { action: "accept_clean_patch" }],
] as const;

// A replay of a successful POST /apply answers its stored receipt. It may converge
// a run whose first mark was lost; it never overwrites a later decision of the
// user and never rewrites an anchor. Only a new key is a new delivery.
describe("a replayed apply never records over what happened after it", () => {
  const STATE = "final/delivery_state.yaml";
  const recorded = (f: Fixture) =>
    parse(readFileSync(join(f.run, STATE), "utf8")) as {
      applyState: string;
      revertAnchorId: string | null;
    };
  /** A real Git result applied with key K1: the tree holds the candidate. */
  async function applied() {
    const f = await fixture();
    await realResult(f, (clone) => writeFileSync(join(clone, "x"), "candidate\n"));
    const first = await f.post("/apply", { mode: "apply" }, "K1");
    expect(first.status).toBe(200);
    expect(readFileSync(join(f.project, "x"), "utf8")).toBe("candidate\n");
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "applied",
      revertable: true,
    });
    return { f, anchor: recorded(f).revertAnchorId! };
  }
  const replayK1 = async (f: Fixture) => {
    const replay = await f.post("/apply", { mode: "apply" }, "K1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ applied: true });
  };

  it("a replay after revert_run stays reverted over the reverted tree, its anchor unchanged", async () => {
    const { f } = await applied();
    expect((await f.post("/decision", { action: "revert_run" }, "R1")).status).toBe(200);
    unchanged(f.project);
    const reverted = recorded(f);
    expect(reverted.applyState).toBe("reverted");
    await replayK1(f);
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "reverted",
      revertable: false,
    });
    expect(recorded(f)).toEqual(reverted);
    unchanged(f.project);
  });

  it("a replay after a discard stays discarded, its anchor unchanged", async () => {
    const { f } = await applied();
    // The route refuses `discard` of a patch result, so the state a later decision
    // records is written through its one owner.
    markRunApplyState({ id: "job-1", runId: "run-1", runDir: f.run } as never, "discarded");
    const discarded = recorded(f);
    expect(discarded.applyState).toBe("discarded");
    await replayK1(f);
    expect(recorded(f)).toEqual(discarded);
    expect((await f.get()).summary?.result?.applyState).toBe("discarded");
  });

  it("a replay of an applied run rewrites nothing", async () => {
    const { f, anchor } = await applied();
    const before = recorded(f);
    await replayK1(f);
    expect(recorded(f)).toEqual(before);
    expect(recorded(f).revertAnchorId).toBe(anchor);
  });

  it("after a revert, a new key is a new delivery and records applied with its own anchor", async () => {
    const { f, anchor } = await applied();
    expect((await f.post("/decision", { action: "revert_run" }, "R1")).status).toBe(200);
    // An anchor is named by its pair: a target that moved on makes this delivery's own.
    writeFileSync(join(f.project, "y"), "later\n");
    f.git("add", "y");
    f.git(...COMMIT, "later");
    const second = await f.post("/apply", { mode: "apply" }, "K2");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ applied: true, treeMutated: true });
    expect(readFileSync(join(f.project, "x"), "utf8")).toBe("candidate\n");
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "applied",
      revertable: true,
    });
    expect(recorded(f).revertAnchorId).toBeTruthy();
    expect(recorded(f).revertAnchorId).not.toBe(anchor);
    expect((await f.post("/decision", { action: "revert_run" }, "R2")).status).toBe(200);
    unchanged(f.project);
  });

  it("a delivery whose mark was lost converges on replay, revertable on its pair", async () => {
    const { f } = await applied();
    rmSync(join(f.run, STATE));
    expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
    await replayK1(f);
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "applied",
      revertable: true,
    });
    expect((await f.post("/decision", { action: "revert_run" }, "R1")).status).toBe(200);
    unchanged(f.project);
  });
});

describe("a refused delivery answers its typed reason as the 409 problem code", () => {
  it.each(CASES)("POST /runs/:id/apply: $code", async ({ code, mode }) => {
    const f = await fixture();
    const problem = await refusedTwice(f, "/apply", { mode }, `apply-${code}`);
    expect(problem).toMatchObject({ code, requiredActions: [] });
    expect(problem.context).toEqual({});
    unchanged(f.project);
    expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
  });

  it.each(CASES)("POST /runs/:id/decision accept_clean_patch: $code", async ({ code, mode }) => {
    const f = await fixture();
    const body = { action: "accept_clean_patch", applyMode: mode };
    const problem = await refusedTwice(f, "/decision", body, `decision-${code}`);
    expect(problem).toMatchObject({ code, requiredActions: [] });
    expect(problem.context).toEqual({});
    unchanged(f.project);
    expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
  });

  it.each(ROUTES)(
    "%s: a refusal its owner has no typed reason for answers delivery_refused",
    async (_route, path, body) => {
      const f = await fixture();
      await realResult(f, (clone) => writeFileSync(join(clone, "x"), "candidate\n"));
      // The apply gate refuses after the fresh verify: failed checks, no override.
      writeFileSync(join(f.run, "arbitration/decision.yaml"), decision("failed"));
      const problem = await refusedTwice(f, path, body, "untyped");
      expect(problem.code).toBe("delivery_refused");
      expect(problem.context).toEqual({});
      expect(problem.message).toContain("isn't ready to apply");
      unchanged(f.project);
    },
  );

  it.each(ROUTES)(
    "%s: a write taken back answers its typed reason and the run stays not_applied",
    async (_route, path, body) => {
      const f = await fixture();
      await realUnprovableResult(f);
      f.git("config", "filter.up.clean", "tr a-z A-Z");
      const problem = await refusedTwice(f, path, body, "take-back");
      expect(problem).toMatchObject({ code: "delivery_content_mismatch", requiredActions: [] });
      expect(problem.context).toEqual({ paths: ["new.weird"], pathCount: 1 });
      expect(problem.message).toContain("the write was taken back, so the target is unchanged");
      expect(existsSync(join(f.project, "new.weird"))).toBe(false);
      unchanged(f.project);
      expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
    },
  );

  it("a write taken back whose HEAD could not return is recorded without a revert anchor, naming the way back", async () => {
    const f = await fixture();
    await realUnprovableResult(f);
    const headBefore = f.git("rev-parse", "HEAD");
    // The proof's own filter deletes the branch HEAD came from: the take-back
    // restores the tree, the return to `main` then has nothing to return to.
    const clean = join(mkdtempSync(join(tmpdir(), "cx-refusal-filter-")), "clean.sh");
    cleanup.push(() => rmSync(join(clean, ".."), { recursive: true, force: true }));
    writeFileSync(
      clean,
      `#!/bin/sh\nenv -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "${f.project}" update-ref -d refs/heads/main 2>/dev/null\nexec tr a-z A-Z\n`,
    );
    chmodSync(clean, 0o755);
    f.git("config", "filter.up.clean", clean);

    const response = await f.post("/apply", { mode: "branch", branch: "claudexor/gone" }, "gone");

    expect(response.status).toBe(409);
    const problem = (await response.json()) as Problem;
    expect(f.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("claudexor/gone");
    expect(existsSync(join(f.project, "new.weird"))).toBe(false);
    expect(problem.context).toMatchObject({ treeMutated: true });
    expect(problem.message).toContain("the write was taken back");
    expect(problem.message).toContain(`git checkout --detach ${headBefore}`);
    expect(problem.message).not.toContain("can be reverted");
    expect(problem.message).toContain("without a revert anchor");
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "applied_review_blocked",
      revertable: false,
      revertAnchorId: null,
    });
  });

  it.each(ROUTES)(
    "%s: a store fault on the import answers typed, and a replay the same",
    async (_route, path, body) => {
      const f = await fixture();
      await realResult(f, (clone) => writeFileSync(join(clone, "x"), "candidate\n"));
      // The store cannot even be read as a repository: every import through it faults.
      rmSync(join(objectStorePath(f.project), "HEAD"));
      const problem = await refusedTwice(f, path, body, "store-fault");
      expect(problem.code).toBe("git_failed");
      expect(problem.message).toContain("nothing was written");
      unchanged(f.project);
      expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
    },
  );

  it.each(ROUTES)(
    "%s: a file only .git/info/exclude hides at a path the result adds answers typed and stays",
    async (_route, path, body) => {
      const f = await fixture();
      await realResult(f, (clone) => writeFileSync(join(clone, "notes.md"), "the agent's\n"));
      writeFileSync(join(f.project, ".git/info/exclude"), "notes.md\n");
      writeFileSync(join(f.project, "notes.md"), "the user's own\n");
      const problem = await refusedTwice(f, path, body, "occupied");
      expect(problem).toMatchObject({ code: "delivery_path_occupied", requiredActions: [] });
      expect(problem.context).toEqual({ paths: ["notes.md"], pathCount: 1 });
      expect(readFileSync(join(f.project, "notes.md"), "utf8")).toBe("the user's own\n");
      unchanged(f.project);
      expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
    },
  );

  it("a stranded delivery after an earlier apply and revert clears that old anchor: revert_run refuses and the run stays blocked", async () => {
    const f = await fixture();
    await realUnprovableResult(f);
    expect((await f.post("/apply", { mode: "apply" }, "first")).status).toBe(200);
    const stateFile = join(f.run, "final/delivery_state.yaml");
    const oldAnchor = parse(readFileSync(stateFile, "utf8")).revertAnchorId as string;
    expect(oldAnchor).toBeTruthy();
    expect((await f.post("/decision", { action: "revert_run" }, "R1")).status).toBe(200);
    // The same fault as above: the take-back restores the tree, HEAD cannot return.
    const clean = join(mkdtempSync(join(tmpdir(), "cx-refusal-filter-")), "clean.sh");
    cleanup.push(() => rmSync(join(clean, ".."), { recursive: true, force: true }));
    writeFileSync(
      clean,
      `#!/bin/sh\nenv -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "${f.project}" update-ref -d refs/heads/main 2>/dev/null\nexec tr a-z A-Z\n`,
    );
    chmodSync(clean, 0o755);
    f.git("config", "filter.up.clean", clean);

    const response = await f.post("/apply", { mode: "branch", branch: "claudexor/gone" }, "gone");

    expect(response.status).toBe(409);
    expect(((await response.json()) as Problem).message).toContain("without a revert anchor");
    expect(f.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("claudexor/gone");
    // What the receipt said is what every reader sees: the old anchor is gone.
    expect(parse(readFileSync(stateFile, "utf8")).revertAnchorId).toBeNull();
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "applied_review_blocked",
      revertable: false,
      revertAnchorId: null,
    });
    const revert = await f.post("/decision", { action: "revert_run" }, "R2");
    expect(revert.status).toBe(409);
    expect((await f.get()).summary?.result?.applyState).toBe("applied_review_blocked");
    expect(f.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("claudexor/gone");
    // A later state write without an anchor of its own does not bring the old one back.
    markRunApplyState(
      { id: "job-1", runId: "run-1", runDir: f.run } as never,
      "applied_review_blocked",
    );
    expect(parse(readFileSync(stateFile, "utf8")).revertAnchorId).toBeNull();
  });

  it("a write taken back whose branch alone could not be deleted stays not_applied, naming the leftover branch", async () => {
    const f = await fixture();
    await realUnprovableResult(f);
    const headBefore = f.git("rev-parse", "HEAD");
    // The proof's own filter takes the new branch's ref lock, as another Git process
    // would: HEAD returns to `main`, only `git branch -D` fails.
    const lock = join(f.project, ".git", "refs", "heads", "claudexor", "kept.lock");
    const clean = join(mkdtempSync(join(tmpdir(), "cx-refusal-filter-")), "clean.sh");
    cleanup.push(() => rmSync(join(clean, ".."), { recursive: true, force: true }));
    writeFileSync(clean, `#!/bin/sh\n: > "${lock}"\nexec tr a-z A-Z\n`);
    chmodSync(clean, 0o755);
    f.git("config", "filter.up.clean", clean);

    const response = await f.post("/apply", { mode: "branch", branch: "claudexor/kept" }, "kept");

    expect(response.status).toBe(409);
    const problem = (await response.json()) as Problem;
    expect(problem.code).toBe("delivery_content_mismatch");
    expect(problem.context).not.toHaveProperty("treeMutated");
    expect(problem.message).toContain("the write was taken back");
    expect(problem.message).toContain("git branch -D claudexor/kept");
    for (const untrue of ["RECOVERY REQUIRED", "revert anchor", "by hand", "git checkout"])
      expect(problem.message).not.toContain(untrue);
    expect(f.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(f.git("rev-parse", "HEAD")).toBe(headBefore);
    expect(f.git("rev-parse", "claudexor/kept")).toBe(headBefore);
    expect(existsSync(join(f.project, "new.weird"))).toBe(false);
    expect(f.git("status", "--porcelain")).toBe("");
    expect((await f.get()).summary?.result).toMatchObject({
      applyState: "not_applied",
      revertable: false,
      revertAnchorId: null,
    });
  });

  /** A delivery whose proof cannot run and whose take-back then fails: its write stays. */
  async function writeThatStays(path: string, body: unknown) {
    const f = await fixture();
    await realUnprovableResult(f);
    f.git("config", "filter.up.clean", "exit 1");
    f.git("config", "filter.up.required", "true");
    const response = await f.post(path, body, "write-stays");
    expect(response.status).toBe(409);
    const problem = (await response.json()) as Problem;
    expect(problem.context).toEqual({ treeMutated: true, paths: ["new.weird"], pathCount: 1 });
    expect(existsSync(join(f.project, "new.weird"))).toBe(true);
    /** Once the fault is gone, the run's recorded handle reverts that write. */
    const revert = async () => {
      f.git("config", "--unset", "filter.up.required");
      f.git("config", "--unset", "filter.up.clean");
      const reverted = await f.post("/decision", { action: "revert_run" }, "revert");
      expect(reverted.status).toBe(200);
      expect(existsSync(join(f.project, "new.weird"))).toBe(false);
      expect((await f.get()).summary?.result).toMatchObject({
        applyState: "reverted",
        revertable: false,
      });
    };
    return { f, problem, revert };
  }

  it.each(ROUTES)(
    "%s: a write that stays is said on the wire with its recovery and recorded revertable, never not_applied",
    async (_route, path, body) => {
      const { f, problem, revert } = await writeThatStays(path, body);
      expect(problem).toMatchObject({
        code: "git_failed",
        requiredActions: ["Fix the cause, then revert the run with the revert_run decision"],
      });
      expect(problem.message).toContain("RECOVERY REQUIRED");
      expect(problem.message).toContain(
        "the run is recorded applied_review_blocked and can be reverted once the cause is fixed",
      );
      expect((await f.get()).summary?.result).toMatchObject({
        applyState: "applied_review_blocked",
        revertable: true,
      });
      await revert();
    },
  );

  it.each(ROUTES)(
    "%s: a replay of a refusal whose write stayed answers its journal, and a reverted run stays reverted",
    async (_route, path, body) => {
      const { f, problem, revert } = await writeThatStays(path, body);
      await revert();
      const replay = await f.post(path, body, "write-stays");
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({
        code: problem.code,
        requiredActions: problem.requiredActions,
        context: problem.context,
      });
      // The replay records nothing: the run stays reverted over its clean tree.
      expect((await f.get()).summary?.result).toMatchObject({
        applyState: "reverted",
        revertable: false,
      });
      expect(f.journal(path, "write-stays")).toMatchObject({ state: "failed" });
    },
  );

  it.each(["legacy patch", "Git result"] as const)(
    "a %s pr the publication gate refuses answers that typed reason on both routes, journaled (#555)",
    async (kind) => {
      const f = await fixture();
      if (kind === "legacy patch") {
        const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+publish me\n";
        writeFileSync(join(f.run, "final/patch.diff"), patch);
        writeFileSync(
          join(f.run, "final/work_product.yaml"),
          workProduct({ patch_sha256: sha256(patch) }),
        );
      } else await realResult(f, (clone) => writeFileSync(join(clone, "x"), "publish me\n"), true);
      // No pinned scanner: the gate refuses before any branch, commit or push.
      const saved = process.env.CLAUDEXOR_BETTERLEAKS_PATH;
      delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
      try {
        for (const [path, body] of [
          ["/apply", { mode: "pr" }],
          ["/decision", { action: "accept_clean_patch", applyMode: "pr" }],
        ] as const) {
          const problem = await refusedTwice(f, path, body, `publication-${kind}${path}`);
          expect(problem).toMatchObject({
            code: "publication_scan_unavailable",
            requiredActions: [],
          });
          expect(problem.context).toEqual({});
        }
      } finally {
        if (saved === undefined) delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
        else process.env.CLAUDEXOR_BETTERLEAKS_PATH = saved;
      }
      unchanged(f.project);
      expect(f.git("branch", "--list")).toBe("* main");
    },
  );

  it.each(ROUTES)("%s: an empty result is refused delivery_refused", async (_route, path, body) => {
    const f = await fixture();
    const result = await realResult(f, () => undefined);
    expect(result.base_tree).toBe(result.candidate_tree);
    const objects = f.git("cat-file", "--batch-all-objects", "--batch-check");
    const problem = await refusedTwice(f, path, body, "empty");
    expect(problem).toMatchObject({ code: "delivery_refused", requiredActions: [] });
    expect(problem.message).toContain("empty result");
    expect(problem.context).toEqual({});
    unchanged(f.project);
    expect(f.git("cat-file", "--batch-all-objects", "--batch-check")).toBe(objects);
    expect(f.git("branch", "--list")).toBe("* main");
    expect((await f.get()).summary?.result?.applyState).toBe("not_applied");
  });

  it("POST /runs/:id/apply/check names the same typed reason on its dry run", async () => {
    const f = await fixture();
    const check = await f.post("/apply/check", {}, "check");
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({
      ok: false,
      refusal: { code: "result_objects_missing" },
    });
    unchanged(f.project);
  });

  it("a result whose root trees exist but whose objects inside them do not is refused typed", async () => {
    const f = await fixture();
    // The candidate tree is real and names a blob that exists nowhere.
    const missing = "3".repeat(40);
    const candidate = execFileSync("git", ["-C", f.project, "mktree", "--missing"], {
      env: GIT_ENV,
      input: `100644 blob ${missing}\tx\n`,
    })
      .toString()
      .trim();
    const result: GitObjectResult = {
      schema: GIT_OBJECTS_V1,
      object_format: "sha1",
      base_tree: f.git("rev-parse", "HEAD^{tree}"),
      candidate_tree: candidate,
      base_commit: null,
      store_boundary_commit: null,
      digest: "",
    };
    result.digest = gitResultDigest(result);
    writeFileSync(join(f.run, "final/work_product.yaml"), workProduct(unrendered(result)));
    const check = await f.post("/apply/check", {}, "interior-check");
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({
      ok: false,
      refusal: { code: "result_objects_missing" },
    });
    for (const [path, body] of ROUTES.map(([, path, body]) => [path, body] as const)) {
      const problem = await refusedTwice(f, path, body, `interior${path}`);
      expect(problem.code).toBe("result_objects_missing");
      expect(problem.context).toEqual({});
    }
  });

  it("a composition conflict names its paths on the dry run and on both routes", async () => {
    const f = await fixture();
    await realResult(f, (clone) => writeFileSync(join(clone, "x"), "candidate\n"));
    // The target moved on the same line after the capture.
    writeFileSync(join(f.project, "x"), "theirs\n");
    f.git(...COMMIT, "theirs", "--", "x");
    const check = await f.post("/apply/check", {}, "conflict-check");
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({
      ok: false,
      refusal: { code: "delivery_conflict", paths: ["x"], pathCount: 1 },
    });
    for (const [path, body] of ROUTES.map(([, path, body]) => [path, body] as const)) {
      const problem = await refusedTwice(f, path, body, `conflict${path}`);
      expect(problem).toMatchObject({ code: "delivery_conflict", requiredActions: [] });
      expect(problem.context).toEqual({ paths: ["x"], pathCount: 1 });
    }
  });

  // The push happens only after a clean publication scan (#555): needs the pinned scanner.
  it
    .skipIf(process.platform === "win32" || !pinned.ok)
    .each(["legacy patch", "Git result"] as const)(
    "a %s pr whose push and checkout back both fail leaves HEAD on its branch, recorded without a revert anchor",
    async (kind) => {
      const f = await fixture();
      if (kind === "legacy patch") {
        const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+pr\n";
        writeFileSync(join(f.run, "final/patch.diff"), patch);
        writeFileSync(
          join(f.run, "final/work_product.yaml"),
          workProduct({ patch_sha256: sha256(patch) }),
        );
      } else await realResult(f, (clone) => writeFileSync(join(clone, "x"), "pr\n"), true);
      // The push fails, and meanwhile the user deletes the branch HEAD came from.
      const hook = join(mkdtempSync(join(tmpdir(), "cx-refusal-remote-")), "receive.sh");
      cleanup.push(() => rmSync(join(hook, ".."), { recursive: true, force: true }));
      writeFileSync(
        hook,
        `#!/bin/sh\nenv -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "${f.project}" update-ref -d refs/heads/main\nexit 1\n`,
      );
      chmodSync(hook, 0o755);
      // A real bare origin that has the base (the publication gate reads what it
      // already has); only the delivery's own push runs the failing hook.
      const origin = join(hook, "..", "origin.git");
      execFileSync("git", ["init", "-q", "--bare", origin], { env: GIT_ENV });
      f.git("remote", "add", "origin", origin);
      f.git("push", "-q", "origin", "main");
      f.git("config", "remote.origin.receivepack", hook);
      const headBefore = f.git("rev-parse", "HEAD");
      const response = await f.post("/apply", { mode: "pr" }, "pr-stranded");
      expect(response.status).toBe(200);
      const delivered = (await response.json()) as Record<string, string | boolean>;
      expect(delivered).toMatchObject({ applied: false, treeMutated: true });
      expect(f.git("rev-parse", "--abbrev-ref", "HEAD")).toBe(delivered["branch"]);
      expect(f.git("rev-parse", "HEAD")).toBe(delivered["commit"]);
      // No revert anchor returns branch state: recorded live, not revertable.
      expect((await f.get()).summary?.result).toMatchObject({
        applyState: "applied_review_blocked",
        revertable: false,
      });
      // The receipt names where HEAD is and the way back.
      expect(delivered["detail"]).toContain(`HEAD stayed on it: checking out main failed`);
      expect(delivered["detail"]).toContain("RECOVERY REQUIRED");
      // `main` is gone, so the way back that works names the commit HEAD was on.
      expect(delivered["detail"]).toContain(`git checkout --detach ${headBefore}`);
      f.git("checkout", "-q", "--detach", headBefore);
      expect(f.git("rev-parse", "HEAD")).toBe(headBefore);
      expect(f.git("status", "--porcelain")).toBe("");
    },
  );
});

// #535 R14 O3: an unrendered result's record that is there but cannot be read (EACCES,
// EIO) was read as absent, so the mutating routes answered 404 "no patch artifact" and
// a decision "nothing to unblock". Only ENOENT and ENOTDIR are absence; anything else
// is refused typed before any tree is touched.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a result record that is there but cannot be read",
  () => {
    /** `act` while the run's work product cannot be read (mode 000), restored after. */
    const unreadable = async <T>(f: Fixture, act: () => Promise<T>) => {
      const record = join(f.run, "final/work_product.yaml");
      chmodSync(record, 0o000);
      try {
        return await act();
      } finally {
        chmodSync(record, 0o600);
      }
    };
    const READS = [
      ["POST /runs/:id/apply", "/apply", { mode: "apply" }],
      ["POST /runs/:id/apply/check", "/apply/check", {}],
      ["POST /runs/:id/decision accept_clean_patch", "/decision", { action: "accept_clean_patch" }],
    ] as const;

    it.each(READS)("%s answers typed, never 404 'no patch artifact'", async (_name, path, body) => {
      const f = await fixture();
      await realResult(f, (clone) => writeFileSync(join(clone, "x"), "new\n"));

      const response = await unreadable(f, () => f.post(path, body, `unreadable${path}`));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "artifact_read_failed" });
      unchanged(f.project);
    });

    it("POST /runs/:id/decision accept_risk answers typed, never 'nothing to unblock'", async () => {
      const f = await fixture();
      await realResult(f, (clone) => writeFileSync(join(clone, "x"), "new\n"));
      writeFileSync(join(f.run, "arbitration/decision.yaml"), decision("failed"));

      const response = await unreadable(f, () =>
        f.post("/decision", { action: "accept_risk", acceptedRisks: ["checks"] }, "risk"),
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "artifact_read_failed" });
    });

    it.each(READS)(
      "%s: a record that is not there is still no patch artifact (control)",
      async (_name, path, body) => {
        const f = await fixture();
        rmSync(join(f.run, "final/work_product.yaml"));

        const response = await f.post(path, body, `absent${path}`);

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ message: "no patch artifact for this run" });
        unchanged(f.project);
      },
    );
  },
);

// #535 teardown: a disposable scratch or pending lease record that cannot be removed
// after the operation answered never replaces that answer on the routes. Real server,
// real Git, real POSIX denials (a directory made read-only); the one seam is node's
// own spawn, which the compiled process runner calls, to act as a Git child starts.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "teardown never replaces a delivery answer on the routes",
  () => {
    const originalSpawn = child.spawn;
    const locked: string[] = [];
    afterEach(() => {
      child.spawn = originalSpawn;
      syncBuiltinESMExports();
      for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o700);
    });
    const lock = (dir: string) => {
      locked.push(dir);
      chmodSync(dir, 0o500);
    };
    /** Call `act` with each Git child's environment as it starts. */
    const atSpawn = (act: (env: Record<string, string | undefined>) => void) => {
      child.spawn = function (this: unknown, command: string, args: string[], options: never) {
        act((options as { env?: Record<string, string> } | undefined)?.env ?? {});
        return originalSpawn.call(this, command, args, options);
      } as typeof child.spawn;
      syncBuiltinESMExports();
    };
    /** The next temporary-index write's scratch is locked at its content proof, after
     * its checkout wrote: only that scratch's removal can fail. */
    const lockWriteScratchAtProof = () => {
      let scratch: string | undefined;
      atSpawn((env) => {
        const index = env["GIT_INDEX_FILE"];
        if (index?.includes("claudexor-materialize-")) scratch = dirname(index);
        if (index?.includes("claudexor-proof-") && scratch && !locked.includes(scratch))
          lock(scratch);
      });
      return () => scratch;
    };
    const STATE = "final/delivery_state.yaml";

    it("POST /apply records applied and revertable; revert_run then records reverted", async () => {
      const f = await fixture();
      await realResult(f, (clone) => writeFileSync(join(clone, "x"), "candidate\n"));
      const applyScratch = lockWriteScratchAtProof();

      const applied = await f.post("/apply", { mode: "apply" }, "T1");

      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({ applied: true, treeMutated: true });
      expect(locked).toContain(applyScratch());
      expect(readFileSync(join(f.project, "x"), "utf8")).toBe("candidate\n");
      expect((await f.get()).summary?.result).toMatchObject({
        applyState: "applied",
        revertable: true,
      });

      const revertScratch = lockWriteScratchAtProof();
      const reverted = await f.post("/decision", { action: "revert_run" }, "T2");

      expect(locked).toContain(revertScratch());
      unchanged(f.project);
      expect(reverted.status).toBe(200);
      expect(
        (parse(readFileSync(join(f.run, STATE), "utf8")) as { applyState: string }).applyState,
      ).toBe("reverted");
    });

    it("POST /apply/check keeps result_objects_missing when its lease cannot be released", async () => {
      const f = await fixture();
      const store = objectStorePath(f.project);
      mkdirSync(join(store, "objects"), { recursive: true });
      const pending = join(store, "claudexor", "pending");
      atSpawn((env) => {
        if (
          env["GIT_OBJECT_DIRECTORY"]?.includes("claudexor-result-check-") &&
          existsSync(pending) &&
          readdirSync(pending).length === 1 &&
          !locked.includes(pending)
        )
          lock(pending);
      });

      const check = await f.post("/apply/check", {}, "check");

      expect(locked).toContain(pending);
      expect(check.status).toBe(200);
      expect(await check.json()).toMatchObject({
        ok: false,
        refusal: { code: "result_objects_missing" },
      });
      expect(readdirSync(pending)).toHaveLength(1);
      unchanged(f.project);
    });
  },
);
