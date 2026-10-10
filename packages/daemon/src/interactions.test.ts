import { InteractionStore } from "./store/test-support/fixtures/legacy/daemon/interactions.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { InteractionRegistry } from "./interactions.js";

const roots: string[] = [];

function storeAndRegistry() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-disabled-interaction-"));
  roots.push(root);
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = new InteractionStore(journal);
  const registry = new InteractionRegistry({ forRequest: () => store, forRun: () => store });
  return { journal, store, registry };
}

function context(timeoutAt: string | null) {
  return {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "a01",
    harnessId: "claude",
    request: { interaction_id: "int-1", source_tool: "AskUserQuestion", questions: [] },
    requestedAt: new Date().toISOString(),
    timeoutAt,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("InteractionRegistry disabled expiry", () => {
  it("does not prune a null expiry and still releases it on run terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const { journal, registry } = storeAndRegistry();
    const pending = registry.register(context(null), {});
    expect(registry.pendingForRun("run-1")[0]?.timeoutAt).toBeNull();

    vi.setSystemTime(new Date("2036-07-28T00:00:00.000Z"));
    expect(registry.pendingForRun("run-1")).toHaveLength(1);

    registry.dropForRun("run-1");
    await expect(pending).resolves.toEqual({ kind: "released", reason: "run_terminal" });
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });

  it("continues to prune finite expiries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const { journal, registry } = storeAndRegistry();
    const pending = registry.register(context("2026-07-28T00:00:01.000Z"), {});
    vi.setSystemTime(new Date("2026-07-28T00:00:02.000Z"));
    expect(registry.pendingForRun("run-1")).toEqual([]);
    await expect(pending).resolves.toEqual({ kind: "released", reason: "timeout" });
    journal.close();
  });

  it("does not resurrect a disabled pending interaction after restart", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-disabled-restart-"));
    roots.push(root);
    const journalRoot = join(root, "journal");
    const firstJournal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    const first = new InteractionStore(firstJournal);
    first.request(context(null));
    firstJournal.close();

    const secondJournal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    const second = new InteractionStore(secondJournal);
    second.recoverAfterStartup();
    expect(second.pendingForRun("run-1")).toEqual([]);
    expect(second.status("run-1", "int-1")).toBe("resolved");
    secondJournal.close();
  });

  it("rejects an invalid internal deadline before appending durable pending state", () => {
    const { journal, registry } = storeAndRegistry();
    expect(() => registry.register(context("not-a-date"), {})).toThrow(
      "invalid interaction timeoutAt",
    );
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });
});
