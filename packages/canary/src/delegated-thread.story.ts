/**
 * [INV-073:delegated-thread-two-rounds] A persistent caller-owned checking
 * thread, driven exactly like an external orchestrator drives it: the host
 * builds a private clone with its own Git (HEAD = parent, index = staged
 * candidate, ignored evidence beside it), binds a delegated thread to it once,
 * and refreshes the subject between rounds after a quiescent terminal. Every
 * turn and mode runs in that clone under one durable lane home and resumes the
 * native session; the author repository is never touched; a missing clone is a
 * durable retryable refusal; replay survives restart; purge keeps the clone.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlRunDetail, ControlThread, ControlThreadDetail } from "@claudexor/schema";
import { type Sandbox, cli, makeSandbox, readEvents, readRunFile, readRunYaml } from "./support.js";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = makeSandbox();
});
afterEach(() => {
  sandbox.dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.email=c@x", "-c", "user.name=c", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

/** Every byte under a tree (optionally excluding `.git`), keyed by relative path. */
function treeBytes(root: string, includeGit = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (!includeGit && dir === root && name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

/** The author repository facts the delegated thread must never change. */
function authorState(root: string) {
  return {
    files: treeBytes(root),
    head: git(root, ["rev-parse", "HEAD"]),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    stash: git(root, ["stash", "list", "--format=%H %gs"]),
    index: git(root, ["ls-files", "-s"]),
    worktrees: git(root, ["worktree", "list", "--porcelain"]),
    status: git(root, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

interface Probe {
  native_session_id: string;
  resumed_from: string | null;
  home: string | null;
  cwd: string;
  cwd_entries: string[];
}

function probeOf(runDir: string): Probe {
  const probes = readEvents(runDir)
    .filter((event) => event.type === "harness.event")
    .map((event) => (event.payload as { payload?: Record<string, unknown> }).payload)
    .filter((payload) => payload?.["code"] === "fake_session_probe");
  expect(probes).toHaveLength(1);
  return probes[0] as unknown as Probe;
}

function attemptRecord(runDir: string): Record<string, unknown> {
  const [attempt] = readdirSync(join(runDir, "attempts")).filter((name) =>
    existsSync(join(runDir, "attempts", name, "attempt.yaml")),
  );
  return readRunYaml(runDir, `attempts/${attempt}/attempt.yaml`);
}

function controlApi(sb: Sandbox) {
  let address = { host: "", port: 0 };
  let token = "";
  const connect = async () => {
    address = JSON.parse(readFileSync(join(sb.configDir, "daemon", "control-api.json"), "utf8"));
    token = readFileSync(join(sb.configDir, "daemon", "token"), "utf8").trim();
    const hello = await call("POST", "/handshake", { protocolMajor: 3, client: "canary" });
    expect(hello.status).toBe(200);
  };
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-claudexor-protocol-major": "3",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as any, text };
  };
  const terminal = async (runId: string): Promise<ControlRunDetail> => {
    let detail: ControlRunDetail | undefined;
    await vi.waitFor(
      async () => {
        const read = await call("GET", `/runs/${runId}`);
        expect(read.status).toBe(200);
        detail = read.body as ControlRunDetail;
        expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(detail.summary.state);
      },
      { timeout: 60_000, interval: 100 },
    );
    return detail!;
  };
  return { connect, call, terminal };
}

describe("[INV-073:delegated-thread-two-rounds] persistent caller-owned checking thread", () => {
  it("binds every turn and mode to the caller's private clone with one durable native lane", async () => {
    const author = sandbox.repo;
    // Author state that must survive byte-for-byte: a branch, a stash, a staged
    // edit, an untracked note and a produced-output file.
    git(author, ["branch", "feature-x"]);
    writeFileSync(join(author, "math.js"), "export const stashed = true;\n");
    git(author, ["stash", "push", "-q", "-m", "author-stash", "--", "math.js"]);
    writeFileSync(join(author, "README.md"), "# canary fixture\nauthor staged edit\n");
    git(author, ["add", "README.md"]);
    writeFileSync(join(author, "notes.txt"), "untracked author note\n");
    mkdirSync(join(author, "artifacts"));
    writeFileSync(join(author, "artifacts", "author-only.txt"), "author output\n");
    const authorBefore = authorState(author);

    // The host's private clone with its own Git: HEAD = parent, index = the
    // staged candidate A, plus ignored evidence the engine never captures.
    const copy = join(sandbox.home, "checking-copy");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", author, copy]);
    const parent = git(copy, ["rev-parse", "HEAD"]);
    writeFileSync(join(copy, "math.js"), "export function add(a, b) {\n  return a + b; // A\n}\n");
    git(copy, ["add", "math.js"]);
    appendFileSync(join(copy, ".git", "info", "exclude"), "review-evidence/\n");
    mkdirSync(join(copy, "review-evidence"));
    writeFileSync(join(copy, "review-evidence", "REPORT.md"), "round 1 evidence\n");
    const subjectA = git(copy, ["write-tree"]);

    expect(cli(sandbox, ["daemon", "start", "--json"]).code).toBe(0);
    const api = controlApi(sandbox);
    await api.connect();
    const createBody = {
      scope: { kind: "project", root: author },
      workspace: "delegated",
      workspaceRoot: copy,
      mode: "agent",
      access: "full",
      primaryHarness: "fake-session",
      eligibleHarnesses: ["fake-session"],
    };
    const created = await api.call("POST", "/threads", createBody, "seat-thread");
    expect(created.status, created.text).toBe(200);
    const thread = created.body as ControlThread;
    expect(thread).toMatchObject({
      workspaceMode: "delegated",
      workspaceRoot: copy,
      repoRoot: author,
    });

    const turn = async (prompt: string, key: string, extra: Record<string, unknown> = {}) => {
      const started = await api.call(
        "POST",
        `/threads/${thread.id}/turns`,
        { prompt, ...extra },
        key,
      );
      expect(started.status, started.text).toBe(200);
      const detail = await api.terminal(started.body.runId);
      expect(detail.summary.state, started.body.runDir).toBe("succeeded");
      return started.body as { runId: string; runDir: string; turnId: string };
    };

    // Round 1: full-access Agent in the clone, fresh native session.
    const r1 = await turn("Round 1: check subject A", "round-1");
    const p1 = probeOf(r1.runDir);
    expect(p1).toMatchObject({ cwd: copy, resumed_from: null });
    expect(p1.cwd_entries).toEqual(expect.arrayContaining(["review-evidence", "math.js"]));
    const laneHome = p1.home!;
    expect(laneHome).toMatch(new RegExp(`/lanes/${thread.id}/fake-session-default/home$`));
    expect(laneHome.startsWith(copy) || laneHome.startsWith(author)).toBe(false);
    expect(existsSync(laneHome)).toBe(true);
    expect(attemptRecord(r1.runDir)).toMatchObject({
      harness_home_isolated: true,
      harness_home_dir: laneHome,
      confinement_unavailable_reason: expect.any(String),
    });
    expect(readFileSync(join(copy, "FAKE_CHANGE.txt"), "utf8")).toContain("fake-session");
    expect(readRunYaml(r1.runDir, "final/work_product.yaml")).toMatchObject({
      meta: { adopted: true, execution_root: copy },
    });
    const patch1 = readRunFile(r1.runDir, "final/patch.diff");
    expect(patch1).toContain("FAKE_CHANGE.txt");
    // The staged subject predates the turn and the evidence is ignored.
    expect(patch1).not.toContain("math.js");
    expect(patch1).not.toContain("review-evidence");
    expect(git(copy, ["rev-parse", "HEAD"])).toBe(parent);
    expect(git(copy, ["write-tree"])).toBe(subjectA);

    // Host refresh after the quiescent terminal: archive round-1 outputs,
    // move the staged subject to B, replace the evidence; HEAD stays parent.
    const archive = join(sandbox.home, "archive-round-1");
    mkdirSync(archive);
    writeFileSync(join(archive, "FAKE_CHANGE.txt"), readFileSync(join(copy, "FAKE_CHANGE.txt")));
    rmSync(join(copy, "FAKE_CHANGE.txt"));
    writeFileSync(join(copy, "math.js"), "export function add(a, b) {\n  return a + b; // B\n}\n");
    git(copy, ["add", "math.js"]);
    git(copy, ["clean", "-fdq"]);
    writeFileSync(join(copy, "review-evidence", "REPORT.md"), "round 2 evidence\n");
    const subjectB = git(copy, ["write-tree"]);
    expect(subjectB).not.toBe(subjectA);

    // Round 2 resumes the SAME native session in the SAME lane home.
    const r2 = await turn("Round 2: subject B replaced A", "round-2");
    const p2 = probeOf(r2.runDir);
    expect(p2).toMatchObject({
      cwd: copy,
      home: laneHome,
      resumed_from: p1.native_session_id,
      native_session_id: p1.native_session_id,
    });
    const patch2 = readRunFile(r2.runDir, "final/patch.diff");
    expect(patch2).toContain("FAKE_CHANGE.txt");
    expect(patch2).not.toContain("math.js");
    expect(readRunFile(r1.runDir, "final/patch.diff")).toBe(patch1);
    const afterTwo = (await api.call("GET", `/threads/${thread.id}`)).body as ControlThreadDetail;
    expect(afterTwo.turns.map((t) => t.continuity?.kind)).toEqual(["fresh", "native_resume"]);

    // Revert restores the recorded pre-turn state of the CLONE (never the
    // author tree): round 2's file goes, the staged subject B stays.
    const reverted = await api.call(
      "POST",
      `/runs/${r2.runId}/decision`,
      { action: "revert_run" },
      "revert-2",
    );
    expect(reverted.status, reverted.text).toBe(200);
    expect(existsSync(join(copy, "FAKE_CHANGE.txt"))).toBe(false);
    expect(git(copy, ["write-tree"])).toBe(subjectB);

    // Read-only Ask, Plan and read-only Agent reuse the clone and the same lane.
    const ask = await turn("What changed between the rounds?", "ask-1", { mode: "ask" });
    const plan = await turn("Plan the next check", "plan-1", { mode: "plan" });
    const roAgent = await turn("Inspect only", "ro-agent", { access: "readonly" });
    for (const run of [ask, plan, roAgent]) {
      expect(probeOf(run.runDir)).toMatchObject({
        cwd: copy,
        home: laneHome,
        resumed_from: p1.native_session_id,
      });
    }
    expect(git(copy, ["write-tree"])).toBe(subjectB);

    // /produced serves the clone, never the stable project identity.
    mkdirSync(join(copy, "artifacts"));
    writeFileSync(join(copy, "artifacts", "copy-only.txt"), "clone output\n");
    const produced = await api.call("GET", `/runs/${r1.runId}/produced`);
    expect(produced.status, produced.text).toBe(200);
    expect(produced.text).toContain("copy-only.txt");
    expect(produced.text).not.toContain("author-only.txt");
    rmSync(join(copy, "artifacts"), { recursive: true });

    // Run Again keeps the recorded execution address and authority.
    const draft = await api.call("GET", `/runs/${r1.runId}/run-again`);
    expect(draft.status, draft.text).toBe(200);
    expect(draft.body.request).toMatchObject({
      scope: { kind: "project", root: author },
      execution: { delegated: true, isolation: "live", workspaceRoot: copy },
    });
    expect(draft.body.request.threadId).toBeUndefined();

    // Thread Apply never delivers a caller-owned workspace to the project.
    const apply = await api.call(
      "POST",
      `/threads/${thread.id}/apply`,
      { mode: "apply" },
      "apply-1",
    );
    expect(apply.status).toBe(400);
    expect(apply.text).toContain("caller-owned");

    // A missing clone: the turn is durable, refused typed and retryable, and
    // nothing falls back to the author tree. Restoring it and retrying the
    // SAME turn replays the accepted request.
    const moved = `${copy}.moved`;
    renameSync(copy, moved);
    const refused = await api.call(
      "POST",
      `/threads/${thread.id}/turns`,
      { prompt: "Round 3" },
      "round-3",
    );
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body).toMatchObject({
      code: "delegated_workspace_unavailable",
      retryable: true,
    });
    const refusedTurn = refused.body.context.turnId as string;
    const withRefusal = (await api.call("GET", `/threads/${thread.id}`))
      .body as ControlThreadDetail;
    expect(withRefusal.turns.at(-1)).toMatchObject({
      id: refusedTurn,
      enqueueError: { code: "delegated_workspace_unavailable", retryable: true },
    });
    renameSync(moved, copy);
    const retried = await api.call(
      "POST",
      `/threads/${thread.id}/turns/${refusedTurn}/retry`,
      undefined,
      "round-3-retry",
    );
    expect(retried.status, retried.text).toBe(200);
    expect((await api.terminal(retried.body.runId)).summary.state).toBe("succeeded");
    expect(probeOf(retried.body.runDir)).toMatchObject({ cwd: copy, home: laneHome });

    // Restart: accepted creation and turn replays win before any path check.
    expect(cli(sandbox, ["daemon", "stop"]).code).toBe(0);
    expect(cli(sandbox, ["daemon", "start", "--json"]).code).toBe(0);
    await api.connect();
    renameSync(copy, moved);
    const replayCreate = await api.call("POST", "/threads", createBody, "seat-thread");
    expect(replayCreate.status, replayCreate.text).toBe(200);
    expect(replayCreate.body.id).toBe(thread.id);
    const replayTurn = await api.call(
      "POST",
      `/threads/${thread.id}/turns`,
      { prompt: "Round 1: check subject A" },
      "round-1",
    );
    expect(replayTurn.status, replayTurn.text).toBe(200);
    expect(replayTurn.body).toMatchObject({ runId: r1.runId, turnId: r1.turnId });
    renameSync(moved, copy);

    expect(authorState(author)).toEqual(authorBefore);

    // Purge removes the engine-owned lane, never the caller's bytes.
    const clone = treeBytes(copy, true);
    expect((await api.call("POST", `/threads/${thread.id}/trash`, undefined, "trash")).status).toBe(
      200,
    );
    expect((await api.call("POST", `/threads/${thread.id}/purge`, undefined, "purge")).status).toBe(
      200,
    );
    expect(existsSync(laneHome)).toBe(false);
    expect(treeBytes(copy, true)).toEqual(clone);
    expect(authorState(author)).toEqual(authorBefore);
  });

  it("keeps cancel and crash honest: a crash-interrupted turn is unknown custody, never quiescence", async () => {
    const author = sandbox.repo;
    const copy = join(sandbox.home, "checking-copy");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", author, copy]);
    const authorBefore = authorState(author);
    const started = cli(sandbox, ["daemon", "start", "--json"]);
    expect(started.code).toBe(0);
    const api = controlApi(sandbox);
    await api.connect();
    const created = await api.call(
      "POST",
      "/threads",
      {
        scope: { kind: "project", root: author },
        workspace: "delegated",
        workspaceRoot: copy,
        access: "workspace_write",
        primaryHarness: "fake-session",
        eligibleHarnesses: ["fake-session"],
      },
      "crash-thread",
    );
    expect(created.status, created.text).toBe(200);
    const threadId = (created.body as ControlThread).id;
    const hang = async (key: string) => {
      const response = await api.call(
        "POST",
        `/threads/${threadId}/turns`,
        { prompt: "hold", harnesses: ["fake-hang"] },
        key,
      );
      expect(response.status, response.text).toBe(200);
      await vi.waitFor(
        () => {
          expect(readEvents(response.body.runDir).some((e) => e.type === "harness.event")).toBe(
            true,
          );
        },
        { timeout: 30_000, interval: 50 },
      );
      return response.body as { runId: string; runDir: string };
    };

    // An explicit cancel ends the turn; the lane keeps working afterwards.
    const cancelled = await hang("hang-1");
    const control = await api.call(
      "POST",
      `/runs/${cancelled.runId}/control`,
      { control: { kind: "cancel" } },
      "cancel-1",
    );
    expect(control.status, control.text).toBe(200);
    expect((await api.terminal(cancelled.runId)).summary.state).toBe("cancelled");
    const ok = await api.call("POST", `/threads/${threadId}/turns`, { prompt: "after" }, "after-1");
    expect(ok.status, ok.text).toBe(200);
    expect((await api.terminal(ok.body.runId)).summary.state).toBe("succeeded");
    const first = probeOf(ok.body.runDir);
    expect(first.cwd).toBe(copy);

    // A crash mid-turn: the restarted daemon terminalizes the run, but a
    // terminal reached by restart is NOT a quiescence proof (detached
    // harness groups may outlive the daemon). The typed disposition is
    // host_restart over the caller-owned root — the caller must reconcile
    // custody before refreshing that tree.
    const crashed = await hang("hang-2");
    const pid = (started.json() as { pid: number }).pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(cli(sandbox, ["daemon", "start", "--json"]).code).toBe(0);
    await api.connect();
    const afterCrash = await api.terminal(crashed.runId);
    expect(afterCrash.summary).toMatchObject({
      state: "interrupted",
      resumable: { cause: "host_restart", workspace: { kind: "in_place", root: copy } },
    });

    // The thread continues natively in the same lane after the restart.
    const resumed = await api.call(
      "POST",
      `/threads/${threadId}/turns`,
      { prompt: "next" },
      "next-1",
    );
    expect(resumed.status, resumed.text).toBe(200);
    expect((await api.terminal(resumed.body.runId)).summary.state).toBe("succeeded");
    expect(probeOf(resumed.body.runDir)).toMatchObject({
      cwd: copy,
      home: first.home,
      resumed_from: first.native_session_id,
    });
    expect(authorState(author)).toEqual(authorBefore);
  });
});
