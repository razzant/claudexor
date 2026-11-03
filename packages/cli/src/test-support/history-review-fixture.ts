import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { ThreadHistoryInput, isTerminalLifecycle } from "@claudexor/schema";
import { sqlFixture } from "../../../daemon/src/store/test-support/sql-fixture.js";
import { applyCommandInTx, prepareCommandRow } from "../../../daemon/src/store/command-rows.js";
import { sqlThreadHistoryReads } from "../sql-thread-history.js";

export async function historyReviewFixture(prompts = ["hello"]) {
  const root = mkdtempSync(join(tmpdir(), "cx-history-review-"));
  const f = await sqlFixture(root);
  let closed = false;
  // onTestFinished runs last-registered first, so this follows the close below. A synchronous
  // removal has no deadline (#376), and a close that failed or timed out keeps the folder.
  onTestFinished(() => {
    if (closed) rmSync(root, { recursive: true, force: true });
  }, 0);
  onTestFinished(async () => {
    await f.close();
    closed = true;
  });
  const thread = f.graph.threads.createThread({ title: "review" });
  const pid = f.graph.threads.generationForThread(thread.id)!.pid;
  const turns = prompts.map((prompt) => f.graph.threads.createTurn(thread.id, prompt));
  const reads = sqlThreadHistoryReads(() => f.graph);
  const read = (extra: Partial<ThreadHistoryInput> = {}) =>
    reads.threadHistory(ThreadHistoryInput.parse({ threadId: thread.id, ...extra }));
  function command(
    index: number,
    state = "succeeded",
    time = "2026-10-26T10:00:00.000Z",
    mode = "ask",
  ) {
    const runId = `run-${index}`;
    const runDir = join(root, runId);
    mkdirSync(join(runDir, "final"), { recursive: true });
    const record = {
      id: `job-${index}`,
      runId,
      runDir,
      taskId: `task-${index}`,
      state: state as "running",
      createdAt: time,
      startedAt: time,
      ...(isTerminalLifecycle(state) ? { finishedAt: time } : {}),
      params: {
        mode,
        prompt: "hello",
        threadId: thread.id,
        turnId: turns[index]?.id,
        harnesses: ["fake"],
      },
    };
    const prepared = prepareCommandRow(
      record,
      { pid, live: true, operation: mode, clientId: null },
      (bytes) => f.graph.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, prepared, "accept"));
    if (turns[index]) f.graph.threads.bindTurnRun(turns[index]!.id, runId);
    return record;
  }
  return { ...f, root, thread, turns, read, reads, command };
}
