import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandProjection } from "./command-store.js";
import { interactionProjection } from "./interactions.js";
import { JournalManager } from "./journal-manager.js";
import { ProjectPartitions } from "./project-partitions.js";
import { projectProjection } from "./projects.js";
import { threadProjection } from "./threads.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-project-partitions-")));
  roots.push(root);
  const manager = new JournalManager(root);
  const commands = manager.registerProjection(commandProjection());
  const interactions = manager.registerProjection(interactionProjection());
  const projects = manager.registerProjection(projectProjection());
  const threads = manager.registerProjection(threadProjection());
  manager.start();
  return {
    root,
    manager,
    projects,
    partitions: new ProjectPartitions(root, projects, commands, interactions, threads),
  };
}

describe("ProjectPartitions", () => {
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
});

function fixtureAt(root: string) {
  const manager = new JournalManager(root);
  const commands = manager.registerProjection(commandProjection());
  const interactions = manager.registerProjection(interactionProjection());
  const projects = manager.registerProjection(projectProjection());
  const threads = manager.registerProjection(threadProjection());
  manager.start();
  return {
    manager,
    partitions: new ProjectPartitions(root, projects, commands, interactions, threads),
  };
}
