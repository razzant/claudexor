import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { RESTARTED_BEFORE_START, recordInterruptedRunlessTurns } from "./runless-turn-recovery.js";
import { ThreadStore } from "./store/test-support/fixtures/legacy/daemon/threads.js";

const roots: string[] = [];
const closable: Array<{ close(): void }> = [];
afterEach(() => {
  for (const value of closable.splice(0)) value.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-delegated-thread-")));
  roots.push(root);
  return root;
}

function journalAt(root: string): DurableJournal {
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  closable.push(journal);
  return journal;
}

describe("delegated thread binding in the thread store", () => {
  it("persists the caller-owned root separately from managed worktree state, across restart", () => {
    const root = tempRoot();
    const journal = journalAt(root);
    const store = new ThreadStore(journal);
    const thread = store.createThread({
      repoRoot: "/author/project",
      workspace: "delegated",
      workspaceRoot: "/caller/copy",
    });
    expect(thread.workspace).toMatchObject({
      mode: "delegated",
      workspace_root: "/caller/copy",
      worktree_path: null,
    });
    journal.close();
    const reloaded = new ThreadStore(journalAt(root));
    expect(reloaded.getThread(thread.id)?.workspace.workspace_root).toBe("/caller/copy");
  });

  it("never degrades an incoherent delegated create into an in-place thread", () => {
    const store = new ThreadStore(journalAt(tempRoot()));
    for (const input of [
      { repoRoot: "/author/project", workspace: "delegated" as const },
      { workspace: "delegated" as const, workspaceRoot: "/caller/copy" },
      { repoRoot: "/author/project", workspaceRoot: "/caller/copy" },
      { repoRoot: "/author/project", workspace: "isolated" as const, workspaceRoot: "/x" },
    ]) {
      expect(() => store.createThread(input)).toThrow(
        expect.objectContaining({ code: "thread_workspace_invalid", status: 400 }),
      );
    }
    expect(store.listThreads()).toEqual([]);
  });

  it("refuses managed worktree mutation and keeps the binding through trash and purge", () => {
    const store = new ThreadStore(journalAt(tempRoot()));
    const thread = store.createThread({
      repoRoot: "/author/project",
      workspace: "delegated",
      workspaceRoot: "/caller/copy",
    });
    expect(() => store.setThreadWorktree(thread.id, "/runtime/tree", "sha")).toThrow(
      expect.objectContaining({ code: "thread_workspace_caller_owned" }),
    );
    store.trashThread(thread.id);
    const purged = store.purgeThread(thread.id);
    expect(purged.state).toBe("purged");
    expect(purged.workspace).toMatchObject({ mode: "delegated", workspace_root: "/caller/copy" });
  });

  it("keeps legacy creation digests, conflicts on a changed root, and replays without path checks", () => {
    const root = tempRoot();
    const journal = journalAt(root);
    const store = new ThreadStore(journal);
    // A pre-upgrade request carries no workspaceRoot key at all; the store
    // hashes the parsed wire request, so its digest is byte-identical.
    const legacy = store.createThread({
      repoRoot: "/author/project",
      idempotency: { key: "legacy", client: "c", request: { scope: { kind: "project" } } },
    });
    expect(
      store.findThreadCreation({
        key: "legacy",
        client: "c",
        request: { scope: { kind: "project" } },
      })?.id,
    ).toBe(legacy.id);
    const request = { workspace: "delegated", workspaceRoot: "/caller/copy" };
    const created = store.createThread({
      repoRoot: "/author/project",
      workspace: "delegated",
      workspaceRoot: "/caller/copy",
      idempotency: { key: "seat-1", client: "c", request },
    });
    expect(() =>
      store.findThreadCreation({
        key: "seat-1",
        client: "c",
        request: { ...request, workspaceRoot: "/caller/other" },
      }),
    ).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    journal.close();
    const reloaded = new ThreadStore(journalAt(root));
    // The lookup is pure: it needs no filesystem and recovers the thread even
    // though neither path exists on this machine.
    expect(reloaded.findThreadCreation({ key: "seat-1", client: "c", request })?.id).toBe(
      created.id,
    );
    expect(reloaded.findThreadCreation({ key: "never", client: "c", request })).toBeUndefined();
  });
});

describe("restart before a turn's run starts (R1)", () => {
  function seedAcceptedRunlessTurn(root: string) {
    const journal = journalAt(root);
    const threads = new ThreadStore(journal);
    const thread = threads.createThread({ repoRoot: "/author/project" });
    const turn = threads.createTurn(thread.id, "check the candidate");
    const bound = threads.createTurn(thread.id, "a later turn that started");
    threads.bindTurnRun(bound.id, "run-bound");
    const commands = new CommandStore(journal);
    // Accepted (durable) but the daemon died before the runner bound a run.
    commands.accept({
      id: "job-runless",
      params: { threadId: thread.id, turnId: turn.id, prompt: "check the candidate" },
      idempotencyKey: "turn-key",
      clientId: "control-api",
    });
    commands.update("job-runless", { state: "running" });
    commands.accept({
      id: "job-bound",
      params: { threadId: thread.id, turnId: bound.id },
      idempotencyKey: "turn-key-2",
      clientId: "control-api",
    });
    commands.update("job-bound", { state: "running", runId: "run-bound" });
    journal.close();
    return { turnId: turn.id, boundId: bound.id };
  }

  function restart(root: string, recover: boolean) {
    const journal = journalAt(root);
    const commands = new CommandStore(journal);
    const threads = new ThreadStore(journal);
    commands.validateProjection();
    threads.validateProjection();
    commands.recoverAfterStartup();
    if (recover) recordInterruptedRunlessTurns(threads, commands.records());
    return { commands, threads, journal };
  }

  it("reproduces the lost refusal without the recovery composition", () => {
    const root = tempRoot();
    const { turnId } = seedAcceptedRunlessTurn(root);
    const { commands, threads } = restart(root, false);
    expect(commands.get("job-runless")).toMatchObject({ state: "interrupted" });
    expect(commands.get("job-runless")?.runId).toBeUndefined();
    // The bug: an accepted, now-terminal command whose turn shows nothing —
    // Turn Retry answers "no recorded refusal; its job may still be queued".
    expect(threads.getTurn(turnId)?.enqueue_error ?? null).toBeNull();
  });

  it("records a retryable typed refusal on exactly the runless turn, idempotently", () => {
    const root = tempRoot();
    const { turnId, boundId } = seedAcceptedRunlessTurn(root);
    const first = restart(root, true);
    const refusal = first.threads.getTurn(turnId)?.enqueue_error;
    expect(refusal).toMatchObject({
      code: RESTARTED_BEFORE_START,
      retryable: true,
      message: expect.stringContaining("daemon restarted"),
    });
    // A bound turn's honesty lives on its run; it is never given a refusal.
    expect(first.threads.getTurn(boundId)?.enqueue_error ?? null).toBeNull();
    // No duplicate command is created; the accepted params stay the replay source.
    expect(
      first.commands
        .records()
        .map((record) => record.id)
        .sort(),
    ).toEqual(["job-bound", "job-runless"]);
    first.journal.close();
    const second = restart(root, true);
    expect(second.threads.getTurn(turnId)?.enqueue_error?.failed_at).toBe(refusal?.failed_at);
  });
});
