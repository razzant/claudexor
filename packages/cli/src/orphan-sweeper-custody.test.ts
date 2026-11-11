import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commandScopeRoots } from "@claudexor/daemon";
import { RawContextPacket, RawGitPatchEnvelope } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import {
  WorkspaceManager,
  adoptRetainedEnvelope,
  consumeRawPatchEnvelope,
  envelopeBaseOf,
  rawCandidateTree,
  readEnvelopeCustody,
  retainForContinuation,
  retainForInspection,
  retainedEnvelopeOfRun,
  retainedSourcesOfRun,
} from "@claudexor/workspace";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-sweep-custody-${name}-`)));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

/** The previous daemon process is gone: its owner marker names a dead pid. */
function ownerDied(base: string): void {
  writeFileSync(
    join(base, "owner.json"),
    JSON.stringify({ pid: 999_999_990, started: "Thu Jan  1 00:00:00 1970" }) + "\n",
  );
}

async function editedEnvelope(repo: string, runDir: string, taskId: string) {
  const env = await new WorkspaceManager(repo).create({
    taskId,
    attemptId: "a01",
    baseRef: "HEAD",
    custody: { runId: `run-${taskId}`, runDir },
  });
  writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
  writeFileSync(join(env.worktree_path, "new.txt"), "new file\n");
  return env;
}

describe("crash GC honors continuation custody", () => {
  it("keeps a retained envelope across a daemon restart; a successor adopts the same files", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const env = await editedEnvelope(repo, runDir, "task-kept");
    retainForContinuation(env, { runId: "run-task-kept", runDir }, "pool_exhausted");
    ownerDied(envelopeBaseOf(env));

    const knownProjectRoots = () =>
      commandScopeRoots([{ params: { scope: { kind: "project", root: repo } } }]);
    const actions = await sweepOrphanWorkspaces({ knownProjectRoots });

    expect(actions.some((a) => a.startsWith("kept retained envelope task-kept/a01"))).toBe(true);
    expect(actions.find((a) => a.includes("task-kept/a01"))).toMatch(/ for continueFrom$/);
    const custody = retainedEnvelopeOfRun(runDir, "run-task-kept");
    expect(custody?.envelope.id).toBe(env.id);
    const adopted = adoptRetainedEnvelope(custody!, { runId: "run-next", runDir: temp("next") });
    expect(readFileSync(join(adopted.worktree_path, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(adopted.worktree_path, "new.txt"), "utf8")).toBe("new file\n");
  });

  it("keeps a capture-refused directory copy for inspection, not continuation (#563)", async () => {
    const source = temp("folder");
    writeFileSync(join(source, "input.txt"), "selected\n");
    const runDir = temp("run");
    const env = await new WorkspaceManager(source).create({
      taskId: "task-inspect",
      attemptId: "a01",
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
    });
    writeFileSync(join(env.worktree_path, "authored.txt"), "authored\n");
    retainForInspection(env, { runId: "run-task-inspect", runDir });
    rmSync(join(runDir, "attempts/a01/retained-envelope.json"));
    ownerDied(envelopeBaseOf(env));

    const knownProjectRoots = () =>
      commandScopeRoots([{ params: { scope: { kind: "project", root: source } } }]);
    const actions = await sweepOrphanWorkspaces({ knownProjectRoots });

    const line = actions.find((a) => a.includes("task-inspect/a01"));
    expect(line).toMatch(/^kept retained envelope task-inspect\/a01 under .* for inspection$/);
    expect(line).not.toContain("continueFrom");
    expect(readFileSync(join(env.worktree_path, "authored.txt"), "utf8")).toBe("authored\n");
    // Recovery restored its per-attempt address; it is not a continuation source.
    expect(retainedSourcesOfRun(runDir, "run-task-inspect")).toHaveLength(1);
    expect(retainedEnvelopeOfRun(runDir, "run-task-inspect")).toBeNull();
  });

  it("keeps an interrupted envelope whose only change is an ignored file an accepted raw patch wrote", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "ignore logs"]);
    const runDir = temp("run");
    const custodyOf = (taskId: string, dir: string) => ({ runId: `run-${taskId}`, runDir: dir });
    const accepted = await new WorkspaceManager(repo).create({
      taskId: "task-raw",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: custodyOf("task-raw", runDir),
    });
    // The engine accepts a raw proposal that writes only an ignored file.
    const tree = await rawCandidateTree(accepted.worktree_path);
    const context = RawContextPacket.parse({
      schema_version: 1,
      packet_hash: `sha256:${tree}`,
      base_commit_sha: accepted.base_sha,
      base_tree_sha: tree,
      readable_files: [],
      editable_paths: [],
      creatable_roots: ["."],
      file_manifest: [],
      omissions: [],
      evidence_refs: [],
    });
    const patch =
      "diff --git a/debug.log b/debug.log\nnew file mode 100644\n--- /dev/null\n+++ b/debug.log\n@@ -0,0 +1 @@\n+accepted\n";
    await consumeRawPatchEnvelope({
      repoRoot: repo,
      worktreePath: accepted.worktree_path,
      baseCommitSha: accepted.base_sha!,
      context,
      envelope: RawGitPatchEnvelope.parse({
        schema_version: 1,
        context_packet_hash: context.packet_hash,
        base_tree_sha: tree,
        patch,
        patch_hash: sha256(patch),
        touched_paths: [{ path: "debug.log", expected_blob_oid: null }],
      }),
    });
    // What a gate or a native process leaves ignored is no reason to keep an envelope.
    const incidental = await new WorkspaceManager(repo).create({
      taskId: "task-raw-idle",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: custodyOf("task-raw-idle", temp("idle-run")),
    });
    writeFileSync(join(incidental.worktree_path, "gate.log"), "incidental\n");
    ownerDied(envelopeBaseOf(accepted));
    ownerDied(envelopeBaseOf(incidental));

    const actions = await sweepOrphanWorkspaces({
      knownProjectRoots: () =>
        commandScopeRoots([{ params: { scope: { kind: "project", root: repo } } }]),
    });

    expect(actions.some((a) => a.startsWith("retained interrupted envelope task-raw/a01"))).toBe(
      true,
    );
    expect(existsSync(envelopeBaseOf(incidental))).toBe(false);
    // Its successor adopts the same files, and a manager that never saw the run
    // captures and shows the accepted one.
    const custody = retainedEnvelopeOfRun(runDir, "run-task-raw");
    expect(custody?.envelope.id).toBe(accepted.id);
    const adopted = adoptRetainedEnvelope(custody!, { runId: "run-next", runDir: temp("next") });
    const captured = await new WorkspaceManager(repo).captureDiff(adopted);
    expect(captured.captureIncomplete).toBe(false);
    expect(captured.diff).toContain("diff --git a/debug.log b/debug.log");
    const next = await rawCandidateTree(adopted.worktree_path);
    expect(
      execFileSync("git", ["-C", adopted.worktree_path, "ls-tree", "--name-only", next], {
        encoding: "utf8",
      }).split("\n"),
    ).toContain("debug.log");
  });

  it("keeps the edits of a run interrupted mid-attempt and sweeps an untouched one", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const edited = await editedEnvelope(repo, runDir, "task-crash");
    const untouched = await new WorkspaceManager(repo).create({
      taskId: "task-idle",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-task-idle", runDir: temp("idle-run") },
    });
    ownerDied(envelopeBaseOf(edited));
    ownerDied(envelopeBaseOf(untouched));

    const actions = await sweepOrphanWorkspaces({
      knownProjectRoots: () =>
        commandScopeRoots([{ params: { scope: { kind: "project", root: repo } } }]),
    });

    expect(actions.some((a) => a.startsWith("retained interrupted envelope task-crash/a01"))).toBe(
      true,
    );
    expect(readEnvelopeCustody(envelopeBaseOf(edited))).toMatchObject({
      state: "retained",
      cause: "host_restart",
      holder_run_id: "run-task-crash",
    });
    expect(retainedEnvelopeOfRun(runDir, "run-task-crash")?.envelope.id).toBe(edited.id);
    expect(existsSync(envelopeBaseOf(untouched))).toBe(false);
  });
});
