import { InteractionStore } from "./store/test-support/fixtures/legacy/daemon/interactions.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import type { InteractionContext } from "./interactions.js";
import { QuotaRegistry } from "./quota-registry.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function journalRoot(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
  roots.push(root);
  return join(root, "journal");
}

function pendingInteraction(): InteractionContext {
  return {
    runId: "run-restart",
    taskId: "task-restart",
    attemptId: "a01",
    harnessId: "claude",
    request: {
      interaction_id: "question",
      source_tool: "AskUserQuestion",
      questions: [],
    },
    requestedAt: "2026-08-13T00:00:00.000Z",
    timeoutAt: null,
  };
}

function quotaSnapshot() {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: "work",
    },
    constraints: [
      {
        id: "five-hour",
        label: "5 hour",
        used_ratio: 0.4,
        window_seconds: 18_000,
        resets_at: "2026-08-13T05:00:00.000Z",
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage" as const,
    observed_at: "2026-08-13T00:00:00.000Z",
    freshness: "fresh" as const,
  };
}

describe("bootstrap replay and deferred recovery", () => {
  it("constructs CommandStore by replay only, then interrupts active commands explicitly", () => {
    const root = journalRoot("command-prepare");
    const writer = new DurableJournal({ rootDir: root, partition: "global" });
    const first = new CommandStore(writer);
    first.accept({
      id: "job-queued",
      params: { prompt: "keep queued during preparation" },
      idempotencyKey: "queued",
      clientId: "test",
    });
    writer.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const before = replay.records().length;
    const prepared = new CommandStore(replay);
    expect(prepared.get("job-queued")?.state).toBe("queued");
    expect(replay.records()).toHaveLength(before);

    prepared.recoverAfterStartup();
    expect(prepared.get("job-queued")?.state).toBe("interrupted");
    expect(replay.records()).toHaveLength(before + 1);
    prepared.recoverAfterStartup();
    expect(replay.records()).toHaveLength(before + 1);
    replay.close();
  });

  it("constructs InteractionStore by replay only, then interrupts pending questions explicitly", () => {
    const root = journalRoot("interaction-prepare");
    const writer = new DurableJournal({ rootDir: root, partition: "global" });
    const first = new InteractionStore(writer);
    first.request(pendingInteraction());
    writer.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const before = replay.records().length;
    const prepared = new InteractionStore(replay);
    expect(prepared.pendingForRun("run-restart")).toHaveLength(1);
    expect(replay.records()).toHaveLength(before);

    prepared.recoverAfterStartup();
    expect(prepared.pendingForRun("run-restart")).toEqual([]);
    expect(prepared.status("run-restart", "question")).toBe("resolved");
    expect(replay.records()).toHaveLength(before + 1);
    prepared.recoverAfterStartup();
    expect(replay.records()).toHaveLength(before + 1);
    replay.close();
  });

  it("constructs QuotaRegistry without publishing a recovered projection marker", () => {
    const root = journalRoot("quota-prepare");
    const writer = new DurableJournal({ rootDir: root, partition: "global" });
    writer.append("quota.snapshot.upserted", quotaSnapshot());
    writer.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const before = replay.records().length;
    const prepared = new QuotaRegistry(replay, [], () => new Date("2026-08-13T00:00:01.000Z"));
    expect(prepared.read().snapshots).toHaveLength(1);
    expect(replay.records()).toHaveLength(before);

    prepared.recoverAfterStartup();
    expect(replay.records().map((record) => record.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(replay.records().at(-1)?.payload).toMatchObject({ reason: "recovery" });
    prepared.recoverAfterStartup();
    expect(replay.records()).toHaveLength(before + 1);
    replay.close();
  });
});
