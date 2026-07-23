import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandProjection } from "./command-store.js";
import { interactionProjection } from "./interactions.js";
import { JournalManager } from "./journal-manager.js";
import { operatorDecisionProjection } from "./operator-decisions.js";
import { ProjectPartitions } from "./project-partitions.js";
import { projectProjection } from "./projects.js";
import { runEventProjection } from "./run-events.js";
import { threadHeadPingProjection } from "./thread-head-ping.js";
import { threadProjection } from "./threads.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(reapMk(join(tmpdir(), "claudexor-project-partitions-")));
  roots.push(root);
  const manager = new JournalManager(root);
  const commands = manager.registerProjection(commandProjection());
  const interactions = manager.registerProjection(interactionProjection());
  const decisions = manager.registerProjection(operatorDecisionProjection());
  const runEvents = manager.registerProjection(runEventProjection());
  const projects = manager.registerProjection(projectProjection());
  const headPingSlot = manager.registerProjection(threadHeadPingProjection());
  const headPing = (ping: { threadId: string; projectId: string | null }) =>
    headPingSlot.current().ping(ping);
  const threads = manager.registerProjection(threadProjection(headPing));
  manager.start();
  return {
    root,
    manager,
    projects,
    partitions: new ProjectPartitions(
      root,
      projects,
      commands,
      interactions,
      decisions,
      runEvents,
      threads,
      headPing,
    ),
  };
}

describe("ProjectPartitions", () => {
  it("persists idempotent delivery receipts and rejects key reuse for another request", () => {
    const f = fixture();
    const input = {
      key: "delivery-key",
      client: "test",
      operation: "run.apply",
      request: { runId: "run-1", patchSha256: `sha256:${"a".repeat(64)}` },
    };
    const first = f.partitions.beginDelivery({}, input);
    expect(first).toMatchObject({ state: "running", reused: false });
    f.partitions.completeDelivery(first.id, { applied: true, receipt: "receipt-1" });
    expect(f.partitions.beginDelivery({}, input)).toMatchObject({
      id: first.id,
      state: "succeeded",
      result: { applied: true, receipt: "receipt-1" },
      reused: true,
    });
    expect(() => f.partitions.beginDelivery({}, { ...input, request: { runId: "run-2" } })).toThrow(
      /different request/,
    );
    f.partitions.close();
    f.manager.close();

    const restarted = fixtureAt(f.root);
    expect(restarted.partitions.beginDelivery({}, input)).toMatchObject({
      id: first.id,
      state: "succeeded",
      result: { applied: true, receipt: "receipt-1" },
      reused: true,
    });
    restarted.partitions.close();
    restarted.manager.close();
  });

  it("routes registered project commands and threads through stable project partitions", () => {
    const f = fixture();
    const projectA = join(f.root, "project-a");
    const projectB = join(f.root, "project-b");
    const projectB2 = join(f.root, "project-b-moved");
    mkdirSync(projectA);
    mkdirSync(projectB);
    mkdirSync(projectB2);
    const a = f.partitions.registerProject({
      root: projectA,
      idempotencyKey: "register-a",
      clientId: "test",
    });
    const b = f.partitions.registerProject({
      root: projectB,
      idempotencyKey: "register-b",
      clientId: "test",
    });
    const noProjectCommands = f.partitions.forRequest({ scope: { kind: "none" } });
    const aCommands = f.partitions.forRequest({ scope: { kind: "project", root: projectA } });
    const bCommands = f.partitions.forRequest({ scope: { kind: "project", root: projectB } });
    expect(noProjectCommands).not.toBe(aCommands);
    expect(aCommands).not.toBe(bCommands);

    const threadA = f.partitions.createThread({ repoRoot: projectA });
    const threadB = f.partitions.createThread({ repoRoot: projectB });
    expect(f.partitions.forRequest({ threadId: threadA.id })).toBe(aCommands);
    expect(f.partitions.forRequest({ threadId: threadB.id })).toBe(bCommands);
    const turnA = f.partitions.createTurn(threadA.id, "A", {
      idempotency: { key: "same", client: "test", request: { prompt: "A" } },
    });
    const turnB = f.partitions.createTurn(threadB.id, "B", {
      idempotency: { key: "same", client: "test", request: { prompt: "B" } },
    });
    expect(turnA.id).not.toBe(turnB.id);
    const aInteractions = f.partitions.interactionsForRequest({
      scope: { kind: "project", root: projectA },
    });
    aInteractions.request({
      runId: "run-a",
      taskId: "task-a",
      attemptId: "a01",
      harnessId: "test",
      request: { interaction_id: "question", source_tool: "AskUserQuestion", questions: [] },
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(aInteractions.pendingForRun("run-a")).toHaveLength(1);
    f.partitions.recordRunEvent(
      { scope: { kind: "project", root: projectA } },
      {
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        run_id: "run-a",
        task_id: "task-a",
        type: "run.created",
        payload: { mode: "agent" },
      },
    );
    expect(
      f.partitions
        .journal(`project:${a.id}`)
        .events()
        .some((event) => event.type === "run.event"),
    ).toBe(true);
    const decisionRequest = { runId: "run-a", action: "accept_risk" };
    const recordedDecision = f.partitions.recordOperatorDecision(
      { scope: { kind: "project", root: projectA } },
      {
        runId: "run-a",
        action: "accept_risk",
        findingIds: ["finding-a"],
        acceptedRisks: ["owner accepted"],
        patchSha256: `sha256:${"a".repeat(64)}`,
        decidedAt: "2026-01-01T00:00:00.000Z",
      },
      { key: "decision-1", client: "test", request: decisionRequest },
    );
    expect(
      f.partitions.recordOperatorDecision(
        { scope: { kind: "project", root: projectA } },
        { ...recordedDecision, decidedAt: "2099-01-01T00:00:00.000Z" },
        { key: "decision-1", client: "test", request: decisionRequest },
      ),
    ).toEqual(recordedDecision);
    expect(() =>
      f.partitions.recordOperatorDecision(
        { scope: { kind: "project", root: projectA } },
        recordedDecision,
        { key: "decision-1", client: "test", request: { ...decisionRequest, action: "other" } },
      ),
    ).toThrow(/different request/);

    f.partitions.relinkProject(b.id, projectB2);
    expect(f.partitions.getThread(threadB.id)?.repo?.root).toBe(realpathSync(projectB2));
    expect(f.projects.current().get(a.id)?.root).toBe(realpathSync(projectA));
    f.partitions.close();
    f.manager.close();

    const restarted = fixtureAt(f.root);
    expect(restarted.partitions.listThreads().map((thread) => thread.id)).toEqual(
      expect.arrayContaining([threadA.id, threadB.id]),
    );
    expect(restarted.partitions.getThread(threadB.id)?.repo?.root).toBe(realpathSync(projectB2));
    expect(
      restarted.partitions.interactionStores().flatMap((store) => store.pendingForRun("run-a")),
    ).toEqual([]);
    expect(
      restarted.partitions.operatorDecision({ scope: { kind: "project", root: projectA } }, "run-a")
        ?.patchSha256,
    ).toBe(`sha256:${"a".repeat(64)}`);
    expect(
      restarted.partitions
        .journal(`project:${a.id}`)
        .events()
        .some(
          (event) =>
            event.type === "run.event" && (event.payload as { run_id?: string }).run_id === "run-a",
        ),
    ).toBe(true);
    restarted.partitions.close();
    restarted.manager.close();
  });

  it("refuses an unregistered project instead of falling back to global", () => {
    const f = fixture();
    const project = join(f.root, "unregistered");
    mkdirSync(project);
    expect(() => f.partitions.forRequest({ scope: { kind: "project", root: project } })).toThrow(
      /not registered/,
    );
    const thread = f.partitions.createThread({ repoRoot: project });
    expect(f.partitions.getThread(thread.id)?.repo?.root).toBe(realpathSync(project));
    expect(f.projects.current().list()).toHaveLength(1);
    f.partitions.close();
    f.manager.close();
  });

  it("listThreadsResilient skips a project whose root vanished, disclosing a typed problem (F2)", () => {
    const f = fixture();
    const alive = join(f.root, "alive-project");
    const doomed = join(f.root, "doomed-project");
    mkdirSync(alive);
    mkdirSync(doomed);
    const aliveThread = f.partitions.createThread({ repoRoot: alive });
    f.partitions.createThread({ repoRoot: doomed });
    const doomedId = f.projects.current().findByRoot(realpathSync(doomed))!.id;
    // The doomed project's root disappears from disk (swept ghost worktree).
    rmSync(doomed, { recursive: true, force: true });
    const { threads, problems } = f.partitions.listThreadsResilient();
    // The alive project's threads still load; the dead one is skipped + disclosed.
    expect(threads.map((t) => t.id)).toContain(aliveThread.id);
    expect(problems).toEqual([
      {
        projectId: doomedId,
        root: doomed,
        code: "project_root_missing",
        message: expect.stringContaining("project root no longer exists"),
      },
    ]);
    f.partitions.close();
    f.manager.close();
  });

  it("quarantineGhostProjects retires owned-tree and permanently-missing roots, keeps healthy ones (F2 cleanup)", () => {
    const f = fixture();
    const prev = process.env["CLAUDEXOR_CONFIG_DIR"];
    // Survivor + missing live OUTSIDE f.root; the ghost lives UNDER f.root and
    // becomes "owned" only after we point CLAUDEXOR_CONFIG_DIR at f.root below.
    const survivor = realpathSync(reapMk(join(tmpdir(), "claudexor-survivor-")));
    const missing = realpathSync(reapMk(join(tmpdir(), "claudexor-missing-")));
    roots.push(survivor, missing);
    const ghostRoot = join(f.root, "projects", "d", "workspaces", "task-9", "a01", "tree");
    mkdirSync(ghostRoot, { recursive: true });
    try {
      // Register all three BEFORE the owned-root env is set, so the register
      // guard (default owned root ~/.claudexor/v3) admits them.
      const survivorProj = f.partitions.registerProject({
        root: survivor,
        idempotencyKey: "s",
        clientId: "t",
      });
      const ghostProj = f.partitions.registerProject({
        root: ghostRoot,
        idempotencyKey: "g",
        clientId: "t",
      });
      const missingProj = f.partitions.registerProject({
        root: missing,
        idempotencyKey: "m",
        clientId: "t",
      });
      // Now f.root is the owned runtime tree (ghostRoot is inside it), and the
      // missing project's root disappears from disk.
      process.env["CLAUDEXOR_CONFIG_DIR"] = f.root;
      rmSync(missing, { recursive: true, force: true });

      const retired = f.partitions.quarantineGhostProjects();
      const byId = new Map(retired.map((r) => [r.projectId, r.reason]));
      expect(byId.get(ghostProj.id)).toBe("root_inside_claudexor_runtime");
      expect(byId.get(missingProj.id)).toBe("root_permanently_missing");
      // The healthy survivor stays registered; the two ghosts are gone.
      expect(f.projects.current().get(survivorProj.id)).toBeDefined();
      expect(f.projects.current().get(ghostProj.id)).toBeUndefined();
      expect(f.projects.current().get(missingProj.id)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
      else process.env["CLAUDEXOR_CONFIG_DIR"] = prev;
      f.partitions.close();
      f.manager.close();
    }
  });

  it("pings thread.head.updated into the GLOBAL partition for project-thread mutations (W12)", () => {
    const f = fixture();
    const project = join(f.root, "pinged-project");
    mkdirSync(project);
    const thread = f.partitions.createThread({ repoRoot: project });
    const projectId = f.projects.current().findByRoot(realpathSync(project))!.id;

    const globalPings = () =>
      f.manager.events().filter((event) => event.type === "thread.head.updated");
    // The mutation record stays in the OWNING project partition; the
    // invalidation ping is the only thread trace on the global stream.
    expect(
      f.partitions
        .journal(`project:${projectId}`)
        .events()
        .some((event) => event.type === "thread.entities_upserted"),
    ).toBe(true);
    expect(
      f.partitions
        .journal(`project:${projectId}`)
        .events()
        .some((event) => event.type === "thread.head.updated"),
    ).toBe(false);
    expect(globalPings().map((event) => event.payload)).toEqual([
      { thread_id: thread.id, project_id: projectId, revision: 1 },
    ]);

    f.partitions.updateThread(thread.id, { title: "renamed" });
    expect(globalPings().at(-1)?.payload).toEqual({
      thread_id: thread.id,
      project_id: projectId,
      revision: 2,
    });

    // Run-terminal path: no store mutation exists to ride, so the daemon
    // pings the owning store's head directly.
    f.partitions.pingThreadHead(thread.id);
    expect(globalPings().at(-1)?.payload).toEqual({
      thread_id: thread.id,
      project_id: projectId,
      revision: 3,
    });
    f.partitions.close();
    f.manager.close();
  });

  it("removes a project with no threads: unregisters it and archives its partition (QA-049)", () => {
    const f = fixture();
    const root = join(f.root, "removable");
    mkdirSync(root);
    const project = f.partitions.registerProject({
      root,
      idempotencyKey: "register-removable",
      clientId: "test",
    });
    // Materialize the partition on disk (a project-scoped command).
    f.partitions.forRequest({ scope: { kind: "project", root } });
    const receipt = f.partitions.removeProject(project.id, new Set());
    expect(receipt).toMatchObject({
      projectId: project.id,
      root,
      registryRemoved: true,
      journalPartitionArchived: true,
      artifactsRetained: true,
      // W2: the active-run fence is a disclosed snapshot, not an atomic guarantee.
      activeRunCheck: "snapshot",
    });
    expect(typeof receipt.archivedPartitionPath).toBe("string");
    expect(existsSync(receipt.archivedPartitionPath as string)).toBe(true);
    // The durable registry no longer knows the project.
    expect(f.projects.current().get(project.id)).toBeUndefined();
    f.partitions.close();
    f.manager.close();
  });

  it("a failed partition archival leaves the registry entry intact (archive-before-unregister)", () => {
    const f = fixture();
    const root = join(f.root, "archive-fails");
    mkdirSync(root);
    const project = f.partitions.registerProject({
      root,
      idempotencyKey: "register-archive-fails",
      clientId: "test",
    });
    // Materialize the partition so removeProject reaches the archival step.
    f.partitions.forRequest({ scope: { kind: "project", root } });
    // Inject an archival failure (a rename/fsync error). Archival runs BEFORE
    // the registry unregister, so the throw must leave nothing half-removed.
    const archiveSpy = vi
      .spyOn(JournalManager.prototype, "archivePartition")
      .mockImplementation(() => {
        throw new Error("simulated archive rename failure");
      });
    try {
      expect(() => f.partitions.removeProject(project.id, new Set())).toThrow(/archive/);
      // The durable registry STILL knows the project — no removed registration
      // stranded against an unarchived partition.
      expect(f.projects.current().get(project.id)?.id).toBe(project.id);
      // And the partition is still routable.
      expect(f.partitions.forRequest({ scope: { kind: "project", root } })).toBeDefined();
    } finally {
      archiveSpy.mockRestore();
    }
    f.partitions.close();
    f.manager.close();
  });

  it("refuses to remove a project that still has a non-purged thread (QA-049)", () => {
    const f = fixture();
    const root = join(f.root, "referenced");
    mkdirSync(root);
    const project = f.partitions.registerProject({
      root,
      idempotencyKey: "register-referenced",
      clientId: "test",
    });
    f.partitions.createThread({ repoRoot: root });
    expect(() => f.partitions.removeProject(project.id, new Set())).toThrow(/thread/);
    // Fence is closed: the project is still registered and its partition intact.
    expect(f.partitions.forRequest({ scope: { kind: "project", root } })).toBeDefined();
    f.partitions.close();
    f.manager.close();
  });

  it("refuses to remove a project with a live/queued run referencing it (QA-049)", () => {
    const f = fixture();
    const root = join(f.root, "busy");
    mkdirSync(root);
    const project = f.partitions.registerProject({
      root,
      idempotencyKey: "register-busy",
      clientId: "test",
    });
    expect(() => f.partitions.removeProject(project.id, new Set([root]))).toThrow(/live or queued/);
    f.partitions.close();
    f.manager.close();
  });

  it("rejects removal of an unknown project id with a typed 404 (QA-049)", () => {
    const f = fixture();
    expect(() => f.partitions.removeProject("prj-does-not-exist", new Set())).toThrow(
      /no such project/,
    );
    f.partitions.close();
    f.manager.close();
  });
});

function fixtureAt(root: string) {
  const manager = new JournalManager(root);
  const commands = manager.registerProjection(commandProjection());
  const interactions = manager.registerProjection(interactionProjection());
  const decisions = manager.registerProjection(operatorDecisionProjection());
  const runEvents = manager.registerProjection(runEventProjection());
  const projects = manager.registerProjection(projectProjection());
  const threads = manager.registerProjection(threadProjection());
  manager.start();
  return {
    manager,
    partitions: new ProjectPartitions(
      root,
      projects,
      commands,
      interactions,
      decisions,
      runEvents,
      threads,
    ),
  };
}
