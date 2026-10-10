import { fsyncSync, mkdtempSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { withQuotaAvailability, type QuotaSubject } from "@claudexor/schema";
import { hashJson, sha256 } from "@claudexor/util";
import { sqlFixture as openSqlFixture } from "./store/test-support/sql-fixture.js";
import { QuotaRegistry } from "./quota-registry.js";

const sqlStores: Array<Awaited<ReturnType<typeof openSqlFixture>>> = [];
async function sqlFixture(root: string, now?: () => Date) {
  const sql = await openSqlFixture(root, now);
  sqlStores.push(sql);
  return sql;
}
afterEach(async () => {
  for (const sql of sqlStores.splice(0).reverse()) await sql.close();
});

function quotaSnapshot(harness: string, subjectId: string | null, usedRatio: number) {
  return {
    subject: {
      harness,
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage" as const,
    observed_at: "2026-07-28T00:00:00.000Z",
    freshness: "fresh" as const,
  };
}

describe("QuotaRegistry", () => {
  it("coalesces foreground and background refreshes behind one fenced cycle", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-single-flight-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          await blocked;
          return { snapshots: [quotaSnapshot("claude", null, 0.2)] };
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
    );

    const foreground = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);
    const background = registry.pollStale();
    release();

    const [fenced, polled] = await Promise.all([foreground, background]);
    expect(polled).toBe(true);
    expect(calls).toBe(1);
    expect(
      journal
        .records()
        .filter((record) => record.type === "quota.projection.updated")
        .filter((record) => (record.payload as { reason?: unknown }).reason === "refresh"),
    ).toHaveLength(1);
    expect(journal.cursorFor(journal.records().at(-1)!)).toBe(fenced.quotaEventCursor);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("retires a held old-credential cycle before delete and recreate can resurrect it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-generation-delete-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let credential: "old" | "new" = "old";
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          const captured = credential;
          try {
            if (calls === 1) await oldHeld;
            return {
              snapshots: [quotaSnapshot("claude", "work", captured === "old" ? 0.2 : 0.7)],
            };
          } finally {
            active -= 1;
          }
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
    );

    const startedBeforeDelete = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);

    registry.removeSubject("claude", "work");
    credential = "new";
    registry.noteCredentialChange();
    const startedAfterRecreate = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseOld();
    const [beforeDeleteResult, afterRecreateResult] = await Promise.all([
      startedBeforeDelete,
      startedAfterRecreate,
    ]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    for (const result of [beforeDeleteResult, afterRecreateResult]) {
      expect(result.response.snapshots).toEqual([
        expect.objectContaining({
          subject: expect.objectContaining({ subject_id: "work" }),
          constraints: [expect.objectContaining({ used_ratio: 0.7 })],
        }),
      ]);
    }
    const records = journal.records();
    expect(records.map((record) => record.type)).toEqual([
      "quota.subject.removed",
      "quota.projection.updated",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(
      records
        .filter((record) => record.type === "quota.snapshot.upserted")
        .map(
          (record) =>
            (record.payload as ReturnType<typeof quotaSnapshot>).constraints[0]?.used_ratio,
        ),
    ).toEqual([0.7]);
    const finalCursor = journal.cursorFor(records.at(-1)!);
    expect(beforeDeleteResult.quotaEventCursor).toBe(finalCursor);
    expect(afterRecreateResult.quotaEventCursor).toBe(finalCursor);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("makes post-login foreground refresh wait for the obsolete poll, then join one new cycle", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-generation-login-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const subject = quotaSnapshot("claude", null, 0).subject;
    let credential: "logged_out" | "logged_in" = "logged_out";
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          const captured = credential;
          try {
            if (calls === 1) await oldHeld;
            return captured === "logged_in"
              ? { snapshots: [quotaSnapshot("claude", null, 0.4)] }
              : {
                  snapshots: [],
                  absences: [
                    {
                      subject,
                      reason: "not_logged_in" as const,
                      detail: null,
                      observed_at: "2026-07-28T00:00:00.000Z",
                    },
                  ],
                };
          } finally {
            active -= 1;
          }
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
      () => [subject],
    );

    const oldPoll = registry.pollStale();
    await Promise.resolve();
    expect(calls).toBe(1);
    credential = "logged_in";
    registry.noteCredentialChange();
    const foreground = registry.refreshWithCursor();
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseOld();
    const [polled, fenced] = await Promise.all([oldPoll, foreground]);
    expect(polled).toBe(false);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(fenced.response.snapshots).toEqual([
      expect.objectContaining({ constraints: [expect.objectContaining({ used_ratio: 0.4 })] }),
    ]);
    expect(fenced.response.absences).toEqual([]);
    const records = journal.records();
    expect(
      records
        .filter((record) => record.type === "quota.snapshot.upserted")
        .map(
          (record) =>
            (record.payload as ReturnType<typeof quotaSnapshot>).constraints[0]?.used_ratio,
        ),
    ).toEqual([0.4]);
    expect(
      records.filter(
        (record) =>
          record.type === "quota.projection.updated" &&
          (record.payload as { reason?: unknown }).reason === "refresh",
      ),
    ).toHaveLength(1);
    expect(fenced.quotaEventCursor).toBe(journal.cursorFor(records.at(-1)!));

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a current-generation failure instead of an obsolete success", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-generation-failure-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let calls = 0;
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const registry = new QuotaRegistry(journal, [
      async () => {
        calls += 1;
        if (calls === 1) {
          await oldHeld;
          return { snapshots: [quotaSnapshot("claude", null, 0.2)] };
        }
        throw new Error("new credential unavailable");
      },
    ]);

    const obsoleteCaller = registry.refresh();
    await Promise.resolve();
    registry.noteCredentialChange();
    const currentCaller = registry.refreshWithCursor();
    releaseOld();

    const outcomes = await Promise.allSettled([obsoleteCaller, currentCaller]);
    expect(calls).toBe(2);
    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "quota_refresh_unavailable", status: 503 }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "quota_refresh_unavailable", status: 503 }),
      }),
    ]);
    expect(journal.records()).toEqual([]);
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts top-level refreshers together but folds validated results in declaration order", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-parallel-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const missing = quotaSnapshot("claude", "missing", 0).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          started.push("first");
          await firstGate;
          return {
            snapshots: [quotaSnapshot("claude", "first", 0.2)],
            absences: [
              {
                subject: missing,
                reason: "not_logged_in" as const,
                detail: "first claim",
                observed_at: "2026-07-28T00:00:01.000Z",
              },
            ],
          };
        },
        async () => {
          started.push("second");
          await secondGate;
          return {
            snapshots: [
              {
                ...quotaSnapshot("codex", "second", 0.4),
                source: "codex_app_server" as const,
              },
            ],
            absences: [
              {
                subject: missing,
                reason: "refresh_failed" as const,
                detail: "second claim",
                observed_at: "2026-07-28T00:00:01.000Z",
              },
            ],
          };
        },
      ],
      () => new Date("2026-07-28T00:00:01.000Z"),
      () => [missing],
    );

    const refreshing = registry.refresh();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    releaseSecond();
    await Promise.resolve();
    expect(journal.records()).toEqual([]);
    releaseFirst();
    const response = await refreshing;

    expect(response.snapshots.map((snapshot) => snapshot.source)).toEqual([
      "claude_oauth_usage",
      "codex_app_server",
    ]);
    expect(response.absences).toEqual([expect.objectContaining({ detail: "first claim" })]);
    expect(journal.records().map((record) => record.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("validates snapshots and absences from every source before its first write", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-validate-batch-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [
      async () => ({
        snapshots: [quotaSnapshot("claude", null, 0.2)],
        absences: [
          {
            subject: quotaSnapshot("claude", "missing", 0).subject,
            reason: "not_logged_in" as const,
            detail: 42 as never,
            observed_at: "2026-07-28T00:00:01.000Z",
          },
        ],
      }),
      async () => Promise.reject(new Error("second source unavailable")),
    ]);

    await expect(registry.refresh()).rejects.toMatchObject({
      code: "quota_refresh_unavailable",
      status: 503,
    });
    expect(journal.records()).toEqual([]);
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("fences one refresh marker after the whole batch and replays only later direct mutations", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-fence-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const manager = await sqlFixture(root, now);
    const slot = new QuotaRegistry(
      manager.graph.globalEvents,
      [
        async () => ({
          snapshots: [quotaSnapshot("claude", null, 0.2), quotaSnapshot("claude", "work", 0.4)],
        }),
      ],
      now,
      () => [],
    );
    slot.recoverAfterStartup();

    const fenced = await slot.refreshWithCursor();
    expect(fenced.response.snapshots).toHaveLength(2);
    const refreshEvents = manager.graph.journalEvents("global");
    expect(refreshEvents.map((event) => event.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(refreshEvents.at(-1)?.payload).toMatchObject({ reason: "refresh" });
    expect(manager.graph.journalEvents("global", fenced.quotaEventCursor)).toEqual([]);

    slot.upsert(quotaSnapshot("claude", "later", 0.6));
    const laterEvents = manager.graph.journalEvents("global", fenced.quotaEventCursor);
    expect(laterEvents.map((event) => event.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(laterEvents.at(-1)?.payload).toMatchObject({ reason: "direct_mutation" });
    const afterUpsertCursor = manager.graph.journalEvents("global").at(-1)?.cursor;
    expect(afterUpsertCursor).toBeTruthy();

    slot.removeSubject("claude", "later");
    expect(
      manager.graph.journalEvents("global", afterUpsertCursor).map((event) => event.type),
    ).toEqual(["quota.subject.removed", "quota.projection.updated"]);

    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("emits a fenced projection marker for an absence-only successful refresh", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-absence-fence-")));
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const manager = await sqlFixture(root, () => new Date("2026-07-28T00:00:02.000Z"));
    const slot = new QuotaRegistry(
      manager.graph.globalEvents,
      [
        async () => ({
          snapshots: [],
          absences: [
            {
              subject,
              reason: "not_logged_in" as const,
              detail: null,
              observed_at: "2026-07-28T00:00:02.000Z",
            },
          ],
        }),
      ],
      undefined,
      () => [subject],
    );
    slot.recoverAfterStartup();

    const fenced = await slot.refreshWithCursor();
    expect(fenced.response.snapshots).toEqual([]);
    expect(fenced.response.absences).toHaveLength(1);
    const events = manager.graph.journalEvents("global");
    expect(events.map((event) => event.type)).toEqual(["quota.projection.updated"]);
    expect(events[0]?.payload).toMatchObject({ reason: "refresh" });
    expect(manager.graph.journalEvents("global", fenced.quotaEventCursor)).toEqual([]);

    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("closes a recovered raw-mutation gap with one projection marker", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-recovery-marker-")));
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    first.append("quota.snapshot.upserted", quotaSnapshot("claude", "work", 0.4));
    await first.close();

    const afterUpsert = new DurableJournal({ rootDir: root, partition: "global" });
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const recovered = new QuotaRegistry(afterUpsert, [], now);
    expect(recovered.read().snapshots).toHaveLength(1);
    expect(afterUpsert.records().map((record) => record.type)).toEqual(["quota.snapshot.upserted"]);
    recovered.recoverAfterStartup();
    expect(afterUpsert.records().map((record) => record.type)).toEqual([
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    expect(afterUpsert.records().at(-1)?.payload).toMatchObject({ reason: "recovery" });

    // A separately durable removal has the same crash boundary. Restart must
    // publish its recovered empty projection instead of leaving subscribers at
    // the preceding marker forever.
    afterUpsert.append("quota.subject.removed", { harness: "claude", subject_id: "work" });
    afterUpsert.close();
    const afterRemove = new DurableJournal({ rootDir: root, partition: "global" });
    const recoveredRemoval = new QuotaRegistry(afterRemove, [], now);
    expect(recoveredRemoval.read().snapshots).toEqual([]);
    recoveredRemoval.recoverAfterStartup();
    expect(afterRemove.records().at(-1)?.payload).toMatchObject({ reason: "recovery" });
    afterRemove.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("ingests a typed harness quota event with its exact credential route", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-ingest-")));
    const manager = await sqlFixture(root);
    const slot = new QuotaRegistry(manager.graph.globalEvents, [], undefined, undefined);
    slot.recoverAfterStartup();
    slot.ingest("codex", {
      type: "usage",
      session_id: "session-1",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      quota: {
        source: "codex_rollout",
        plan_label: null,
        subject_id: null,
        constraints: [
          {
            id: "primary",
            label: "5 hour",
            used_ratio: 0.1,
            window_seconds: 18000,
            resets_at: new Date(Date.now() + 3600000).toISOString(),
            cooldown_until: null,
          },
        ],
      },
    });
    expect(slot.read().snapshots[0]).toMatchObject({
      subject: { harness: "codex", credential_route: "vendor_native" },
      source: "codex_rollout",
    });
    slot.ingest("codex", {
      type: "error",
      session_id: "session-1",
      ts: new Date().toISOString(),
      error: "rate limited",
      credential_route: "vendor_native",
      rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
    });
    expect(slot.read().snapshots[0]?.constraints.map((item) => item.id)).toEqual([
      "primary",
      "cooldown",
    ]);
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a profiled quota event registers under ITS profile subject, never the engine default (round-17 #2)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-subject-")));
    const manager = await sqlFixture(root);
    const slot = new QuotaRegistry(manager.graph.globalEvents, [], undefined, undefined);
    slot.recoverAfterStartup();
    slot.ingest("codex", {
      type: "usage",
      session_id: "session-1",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: "acc2",
      quota: {
        source: "codex_rollout",
        plan_label: null,
        // The vendor rollout record carries no subject of its own — the
        // event's Claudexor profile stamp is the binding key for attribution.
        subject_id: null,
        constraints: [
          {
            id: "primary",
            label: "5 hour",
            used_ratio: 0.7,
            window_seconds: 18000,
            resets_at: new Date(Date.now() + 3600000).toISOString(),
            cooldown_until: null,
          },
        ],
      },
    });
    expect(slot.read().snapshots[0]?.subject).toMatchObject({
      harness: "codex",
      credential_route: "vendor_native",
      subject_id: "acc2",
    });
    expect(slot.removeSubject("codex", "acc2")).toBe(1);
    expect(slot.read().snapshots).toEqual([]);
    await manager.close();
    const restarted = await sqlFixture(root);
    const restartedSlot = new QuotaRegistry(restarted.graph.globalEvents, [], undefined, undefined);
    restartedSlot.recoverAfterStartup();
    expect(restartedSlot.read().snapshots).toEqual([]);
    await restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records Claude api_retry cooldowns as retry evidence, never as statusline quota", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-retry-")));
    const manager = await sqlFixture(root);
    const slot = new QuotaRegistry(manager.graph.globalEvents, [], undefined, undefined);
    slot.recoverAfterStartup();
    slot.ingest("claude", {
      type: "thinking",
      session_id: "session-claude",
      // Recent: observations older than 24h are pruned from reads (W17).
      ts: new Date().toISOString(),
      text: "api_retry",
      payload: { api_retry: true },
      credential_route: "managed_api_key",
      credential_source: "api_key_env",
      rate_limit: { resets_at: null, retry_delay_ms: 30_000 },
    });

    expect(slot.read().snapshots).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          harness: "claude",
          credential_route: "managed_api_key",
        }),
        source: "claude_api_retry",
        constraints: [expect.objectContaining({ id: "cooldown" })],
      }),
    ]);
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists independent model-scoped Claude cooldown windows", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-model-cooldown-")));
    const manager = await sqlFixture(root);
    const slot = new QuotaRegistry(manager.graph.globalEvents, [], undefined, undefined);
    slot.recoverAfterStartup();
    for (const [constraintId, aliases] of [
      ["seven_day_opus", ["opus", "claude-opus-5", "best"]],
      ["seven_day_sonnet", ["sonnet", "claude-sonnet-5", "best"]],
    ] as const) {
      slot.ingest("claude", {
        type: "status",
        session_id: `session-${constraintId}`,
        ts: new Date().toISOString(),
        credential_route: "vendor_native",
        rate_limit: {
          constraint_id: constraintId,
          applies_to_models: aliases,
          resets_at: null,
          retry_delay_ms: 30_000,
        },
      });
    }
    expect(slot.read().snapshots[0]?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cooldown:seven_day_opus",
          applies_to_models: ["opus", "claude-opus-5", "best"],
        }),
        expect.objectContaining({
          id: "cooldown:seven_day_sonnet",
          applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
        }),
      ]),
    );
    await manager.close();
    const restarted = await sqlFixture(root);
    const restartedSlot = new QuotaRegistry(restarted.graph.globalEvents, [], undefined, undefined);
    restartedSlot.recoverAfterStartup();
    expect(restartedSlot.read().snapshots[0]?.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cooldown:seven_day_opus",
          applies_to_models: ["opus", "claude-opus-5", "best"],
        }),
        expect.objectContaining({
          id: "cooldown:seven_day_sonnet",
          applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
        }),
      ]),
    );
    await restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the durable base upsert readable by v3.2.0 while replaying model scopes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-rollback-compat-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(first, [], now);
    registry.upsert({
      ...quotaSnapshot("claude", null, 1),
      constraints: [
        {
          id: "weekly_scoped:Fable 5",
          label: "7 day (Fable 5)",
          applies_to_models: ["fable", "claude-fable-5", "best"],
          used_ratio: 1,
          window_seconds: 604_800,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    });

    const records = first.records();
    expect(records.map((record) => record.type)).toEqual([
      "quota.snapshot.scoped_prepared",
      "quota.snapshot.upserted",
      "quota.projection.updated",
    ]);
    const prepared = records[0]?.payload as {
      version?: unknown;
      base_hash?: unknown;
      snapshot?: { constraints?: Array<Record<string, unknown>> };
    };
    expect(prepared.version).toBe(1);
    expect(prepared.base_hash).toEqual(expect.any(String));
    expect(prepared.snapshot?.constraints?.[0]).toMatchObject({
      applies_to_models: ["fable", "claude-fable-5", "best"],
    });
    const legacy = records[1]?.payload as {
      subject?: Record<string, unknown>;
      constraints?: Array<Record<string, unknown>>;
    };
    expect(legacy.constraints?.[0]).not.toHaveProperty("applies_to_models");
    expect(Object.keys(legacy).sort()).toEqual([
      "constraints",
      "freshness",
      "observed_at",
      "source",
      "subject",
    ]);
    expect(Object.keys(legacy.subject ?? {}).sort()).toEqual([
      "credential_route",
      "harness",
      "plan_label",
      "subject_id",
    ]);
    expect(Object.keys(legacy.constraints?.[0] ?? {}).sort()).toEqual([
      "cooldown_until",
      "id",
      "label",
      "resets_at",
      "used_ratio",
      "window_seconds",
    ]);
    await first.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
      id: "weekly_scoped:Fable 5",
      applies_to_models: ["fable", "claude-fable-5", "best"],
    });
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers a cursor vendor-limit cooldown under its own source and profile subject (A4)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-cooldown-")));
    const manager = await sqlFixture(root);
    const slot = new QuotaRegistry(manager.graph.globalEvents, [], undefined, undefined);
    slot.recoverAfterStartup();
    slot.ingest("cursor", {
      type: "error",
      session_id: "session-cursor",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: "valintine",
      rate_limit: { resets_at: null, retry_delay_ms: null, applies_to_models: null },
    });
    expect(slot.read().snapshots).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          harness: "cursor",
          credential_route: "vendor_native",
          subject_id: "valintine",
        }),
        source: "cursor_rate_limit",
        constraints: [expect.objectContaining({ id: "cooldown" })],
      }),
    ]);
    // The profile stamp scopes the cooldown: the default cursor subject stays
    // uncooled by a profiled limit.
    expect(
      slot.read().snapshots.filter((snapshot) => snapshot.subject.subject_id === null),
    ).toEqual([]);
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("bounds a day-granular vendor reset at end-of-that-day UTC instead of the 5-minute default", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-reset-day-")));
    const now = () => new Date("2026-08-17T10:00:00.000Z");
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [], now);
    registry.ingest("cursor", {
      type: "error",
      session_id: "session-cursor",
      ts: "2026-08-17T10:00:00.000Z",
      credential_route: "vendor_native",
      payload: { cursor_vendor_limit: true, vendor_reset_day: "2026-09-12" },
      rate_limit: { resets_at: null, retry_delay_ms: null, applies_to_models: null },
    });
    expect(registry.read().snapshots[0]?.constraints[0]).toMatchObject({
      id: "cooldown",
      resets_at: null,
      // Next-midnight UTC covers the WHOLE vendor-named reset day; a fabricated
      // same-day midnight would reopen the window before the vendor does.
      cooldown_until: "2026-09-13T00:00:00.000Z",
    });
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a v3.2.0-parseable base source for cursor cooldowns while replaying the true source", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-rollback-")));
    const now = () => new Date("2026-08-17T10:00:00.000Z");
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(first, [], now);
    registry.ingest("cursor", {
      type: "error",
      session_id: "session-cursor",
      ts: "2026-08-17T10:00:00.000Z",
      credential_route: "vendor_native",
      rate_limit: { resets_at: null, retry_delay_ms: null, applies_to_models: null },
    });
    const upserted = first.records().filter((record) => record.type === "quota.snapshot.upserted");
    // `cursor_rate_limit` postdates v3.2.0's strict enum: the durable base
    // record must stay parseable by a rolled-back engine, so it carries the
    // nearest v3.2.0 source while the paired prepare preserves the truth.
    expect(upserted).toHaveLength(1);
    expect((upserted[0]?.payload as { source?: unknown }).source).toBe("claude_api_retry");
    expect(
      first.records().filter((record) => record.type === "quota.snapshot.scoped_prepared"),
    ).toHaveLength(1);
    await first.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    expect(recovered.read().snapshots[0]).toMatchObject({
      source: "cursor_rate_limit",
      subject: expect.objectContaining({ harness: "cursor" }),
    });
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps server availability out of raw journal payloads and projection signatures", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-raw-availability-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [], () => new Date("2026-07-28T00:00:01.000Z"));
    registry.upsert({
      ...quotaSnapshot("claude", "work", 1),
      constraints: [
        {
          ...quotaSnapshot("claude", "work", 1).constraints[0]!,
          resets_at: "2026-07-28T01:00:00.000Z",
        },
      ],
    });

    const raw = registry.read();
    const decorated = withQuotaAvailability(raw, {
      now: new Date("2026-07-28T00:00:01.000Z"),
    });
    expect(decorated.snapshots[0]?.availability?.state).toBe("exhausted");
    expect(raw.snapshots[0]).not.toHaveProperty("availability");
    expect(journal.records()[0]?.payload).not.toHaveProperty("availability");
    expect(journal.records().at(-1)?.payload).toMatchObject({
      projection_signature: sha256(
        JSON.stringify({
          snapshots: raw.snapshots,
          absences: raw.absences,
        }),
      ),
    });

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("journals an upsert only when the evidence changes; observed_at alone stays in memory", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-upsert-on-change-")));
    const now = () => new Date("2026-07-28T00:10:00.000Z");
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [], now);
    const upserts = () => journal.records(0, ["quota.snapshot.upserted"]).length;
    registry.upsert(quotaSnapshot("claude", "work", 0.4));
    expect(upserts()).toBe(1);
    // Same evidence, later observation: no frame, but the live projection
    // shows the fresh observation time and a marker still publishes it.
    const reobserved = {
      ...quotaSnapshot("claude", "work", 0.4),
      observed_at: now().toISOString(),
    };
    registry.upsert(reobserved);
    expect(upserts()).toBe(1);
    expect(registry.read().snapshots[0]?.observed_at).toBe(reobserved.observed_at);
    expect(journal.records(0, ["quota.projection.updated"]).length).toBe(2);
    // Changed usage or a freshness flip is evidence and lands a frame.
    registry.upsert({
      ...reobserved,
      constraints: quotaSnapshot("claude", "work", 0.5).constraints,
    });
    expect(upserts()).toBe(2);
    registry.upsert({ ...reobserved, freshness: "stale" });
    expect(upserts()).toBe(3);
    // A second subject is independent evidence.
    registry.upsert(quotaSnapshot("codex", "other", 0.1));
    expect(upserts()).toBe(4);
    journal.close();

    // Replay carries the observation time of the last journaled change.
    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    const claude = recovered
      .read()
      .snapshots.find((snapshot) => snapshot.subject.subject_id === "work");
    expect(claude).toMatchObject({ observed_at: reobserved.observed_at, freshness: "stale" });
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the scoped prepare+upsert pair adjacent and change-gated", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-scoped-gate-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(journal, [], now);
    const scoped = (usedRatio: number, observedAt: string) => ({
      ...quotaSnapshot("claude", null, usedRatio),
      observed_at: observedAt,
      constraints: [
        {
          ...quotaSnapshot("claude", null, usedRatio).constraints[0]!,
          applies_to_models: ["fable"],
        },
      ],
    });
    registry.upsert(scoped(0.3, "2026-07-28T00:00:00.000Z"));
    registry.upsert(scoped(0.3, "2026-07-28T00:00:01.000Z"));
    registry.upsert(scoped(0.7, "2026-07-28T00:00:02.000Z"));
    const types = journal.records().map((record) => [record.seq, record.type] as const);
    const pairs = types.filter(([, type]) => type === "quota.snapshot.scoped_prepared");
    expect(pairs).toHaveLength(2);
    for (const [seq] of pairs) {
      expect(types.find(([candidate]) => candidate === seq + 1)?.[1]).toBe(
        "quota.snapshot.upserted",
      );
    }
    journal.close();
    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
      used_ratio: 0.7,
      applies_to_models: ["fable"],
    });
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("discards a scoped prepare when its atomic batch stops before the base commit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-batch-stop-")));
    const interrupted = new DurableJournal({
      rootDir: root,
      partition: "global",
      appendAndSync: (fd, batch) => {
        const secondFrameOffset = batch.indexOf(batch.subarray(0, 8), 8);
        expect(secondFrameOffset).toBeGreaterThan(0);
        writeSync(fd, batch, 0, secondFrameOffset);
        fsyncSync(fd);
        throw new Error("simulated stop between scoped prepare and base commit");
      },
    });
    const registry = new QuotaRegistry(interrupted, [], () => new Date("2026-07-28T00:00:01.000Z"));
    expect(() =>
      registry.upsert({
        ...quotaSnapshot("claude", null, 1),
        constraints: [
          {
            id: "weekly_scoped:Fable 5",
            label: "7 day (Fable 5)",
            applies_to_models: ["fable"],
            used_ratio: 1,
            window_seconds: 604_800,
            resets_at: null,
            cooldown_until: null,
          },
        ],
      }),
    ).toThrow(/append\/fsync completion is uncertain/);
    interrupted.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], () => new Date("2026-07-28T00:00:01.000Z"));
    expect(recovered.read().snapshots).toEqual([]);
    expect(replay.records().map((record) => record.type)).toEqual([
      "journal.recovery_tail_discarded",
    ]);
    // A rolled-back 3.2.0 writer may later append the identical conservative
    // base. Because the interrupted batch was fully truncated, current replay
    // must not resurrect its stale scope by pairing that later old-engine row.
    replay.append("quota.snapshot.upserted", quotaSnapshot("claude", null, 1));
    replay.close();

    const afterOldWrite = new DurableJournal({ rootDir: root, partition: "global" });
    const afterOldWriteRegistry = new QuotaRegistry(
      afterOldWrite,
      [],
      () => new Date("2026-07-28T00:00:01.000Z"),
    );
    expect(afterOldWriteRegistry.read().snapshots[0]?.constraints[0]).not.toHaveProperty(
      "applies_to_models",
    );
    afterOldWrite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the compatible base for malformed or future scoped prepares", async () => {
    const base = quotaSnapshot("claude", null, 0.2);
    const scoped = {
      ...base,
      constraints: base.constraints.map((constraint) => ({
        ...constraint,
        applies_to_models: ["fable"],
      })),
    };
    const prepares: unknown[] = [
      null,
      { version: 1, base_hash: hashJson(base), snapshot: { malformed: true } },
      { version: 2, base_hash: hashJson(base), snapshot: scoped },
    ];
    for (const [index, prepare] of prepares.entries()) {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), `claudexor-quota-future-prepare-${index}-`)),
      );
      const first = new DurableJournal({ rootDir: root, partition: "global" });
      first.appendBatch([
        { type: "quota.snapshot.scoped_prepared", payload: prepare },
        { type: "quota.snapshot.upserted", payload: base },
      ]);
      await first.close();

      const replay = new DurableJournal({ rootDir: root, partition: "global" });
      const recovered = new QuotaRegistry(replay, [], () => new Date("2026-07-28T00:00:01.000Z"));
      expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
        id: "five_hour",
        used_ratio: 0.2,
      });
      expect(recovered.read().snapshots[0]?.constraints[0]).not.toHaveProperty("applies_to_models");
      replay.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "keeps original sequence adjacency after type filtering (compacted=%s)",
    async (compacted) => {
      for (const gap of [false, true]) {
        const root = realpathSync.native(mkdtempSync(join(tmpdir(), "quota-filter-gap-")));
        const base = quotaSnapshot("claude", null, 0.2);
        const scoped = {
          ...base,
          constraints: base.constraints.map((constraint) => ({
            ...constraint,
            applies_to_models: ["fable"],
          })),
        };
        const journal = new DurableJournal({ rootDir: root, partition: "global" });
        journal.append("unrelated.history", { text: "padding ".repeat(2048) });
        journal.appendBatch([
          {
            type: "quota.snapshot.scoped_prepared",
            payload: { version: 1, base_hash: hashJson(base), snapshot: scoped },
          },
          ...(gap ? [{ type: "unknown.future.record", payload: { survives: true } }] : []),
          { type: "quota.snapshot.upserted", payload: base },
        ]);
        if (compacted) expect(journal.compact()).not.toBeNull();
        journal.close();
        const replay = new DurableJournal({ rootDir: root, partition: "global" });
        const recovered = new QuotaRegistry(replay, [], () => new Date("2026-07-28T00:00:01.000Z"));
        const constraint = recovered.read().snapshots[0]!.constraints[0]!;
        if (gap) expect(constraint).not.toHaveProperty("applies_to_models");
        else expect(constraint.applies_to_models).toEqual(["fable"]);
        expect(replay.records().some((record) => record.type === "unknown.future.record")).toBe(
          gap,
        );
        expect(replay.records().map((record) => record.seq)).toEqual(
          gap ? [1, 2, 3, 4] : [1, 2, 3],
        );
        replay.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("lets a later unscoped commit replace a previously scoped snapshot on replay", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-unscoped-replace-")));
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const first = new DurableJournal({ rootDir: root, partition: "global" });
    const registry = new QuotaRegistry(first, [], now);
    registry.upsert({
      ...quotaSnapshot("claude", null, 1),
      constraints: [
        {
          id: "five_hour",
          label: "5 hour",
          applies_to_models: ["fable"],
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    });
    registry.upsert(quotaSnapshot("claude", null, 0.2));
    await first.close();

    const replay = new DurableJournal({ rootDir: root, partition: "global" });
    const recovered = new QuotaRegistry(replay, [], now);
    expect(recovered.read().snapshots[0]?.constraints[0]).toMatchObject({
      id: "five_hour",
      used_ratio: 0.2,
    });
    expect(recovered.read().snapshots[0]?.constraints[0]).not.toHaveProperty("applies_to_models");
    replay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a new scoped cooldown fresh after an older sibling reset expires", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-cooldown-expiry-")));
    let now = new Date("2026-08-03T00:00:00.000Z");
    const manager = await sqlFixture(root);
    const slot = new QuotaRegistry(
      manager.graph.globalEvents,
      [],
      () => now,
      () => [],
    );
    slot.recoverAfterStartup();
    slot.ingest("claude", {
      type: "status",
      session_id: "session-opus",
      ts: now.toISOString(),
      credential_route: "vendor_native",
      rate_limit: {
        constraint_id: "seven_day_opus",
        applies_to_models: ["opus", "claude-opus-5", "best"],
        resets_at: "2026-08-03T00:00:01.000Z",
        retry_delay_ms: null,
      },
    });
    now = new Date("2026-08-03T00:00:02.000Z");
    slot.ingest("claude", {
      type: "status",
      session_id: "session-sonnet",
      ts: now.toISOString(),
      credential_route: "vendor_native",
      rate_limit: {
        constraint_id: "seven_day_sonnet",
        applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
        resets_at: "2026-08-03T00:01:02.000Z",
        retry_delay_ms: null,
      },
    });
    expect(slot.read().snapshots).toEqual([
      expect.objectContaining({
        freshness: "fresh",
        constraints: [
          expect.objectContaining({
            id: "cooldown:seven_day_sonnet",
            applies_to_models: ["sonnet", "claude-sonnet-5", "best"],
          }),
        ],
      }),
    ]);
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists all windows and marks expired data stale without fabricating zero usage", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-")));
    const first = await sqlFixture(root);
    const slot = new QuotaRegistry(first.graph.globalEvents, [], undefined, undefined);
    slot.recoverAfterStartup();
    slot.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: "Plus",
        subject_id: null,
      },
      source: "codex_app_server",
      // Old enough to be STALE (>5min, reset passed) but well inside the 24h
      // prune horizon — the row must be kept and honestly marked, not hidden.
      observed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      freshness: "fresh",
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.42,
          window_seconds: 18_000,
          resets_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          cooldown_until: null,
        },
        {
          id: "secondary",
          label: "Weekly",
          used_ratio: null,
          window_seconds: 604_800,
          resets_at: null,
          cooldown_until: null,
        },
      ],
    });
    await first.close();

    const reopened = await sqlFixture(root);
    const replayed = new QuotaRegistry(reopened.graph.globalEvents, [], undefined, undefined);
    replayed.recoverAfterStartup();
    const value = replayed.read();
    expect(value.snapshots[0]?.freshness).toBe("stale");
    expect(value.snapshots[0]?.constraints).toHaveLength(2);
    expect(value.snapshots[0]?.constraints[0]?.used_ratio).toBe(0.42);
    expect(value.snapshots[0]?.constraints[1]?.used_ratio).toBeNull();
    await reopened.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("refreshes healthy primary evidence on the last existing tick before TTL expiry", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-horizon-tick-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const observedAt = Date.parse("2026-07-28T00:00:00.000Z");
    let nowMs = observedAt + 4 * 60_000;
    let calls = 0;
    const subject = quotaSnapshot("codex", null, 0.2).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => {
            calls += 1;
            return {
              snapshots: [
                {
                  ...quotaSnapshot("codex", null, 0.3),
                  source: "codex_app_server" as const,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.2),
      source: "codex_app_server",
      observed_at: new Date(observedAt).toISOString(),
    });

    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(registry.read().snapshots[0]).toMatchObject({
      freshness: "fresh",
      observed_at: new Date(nowMs).toISOString(),
    });
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps explicit foreground refresh unconditional when background demand is absent", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-fg-demand-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const observedAt = Date.parse("2026-07-28T00:00:00.000Z");
    const nowMs = observedAt + 60_000;
    let calls = 0;
    const subject = quotaSnapshot("codex", null, 0.2).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => {
            calls += 1;
            return {
              snapshots: [
                {
                  ...quotaSnapshot("codex", null, 0.3),
                  source: "codex_app_server" as const,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.2),
      source: "codex_app_server",
      observed_at: new Date(observedAt).toISOString(),
    });

    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(0);
    await expect(registry.refresh()).resolves.toMatchObject({
      snapshots: [expect.objectContaining({ observed_at: new Date(nowMs).toISOString() })],
    });
    expect(calls).toBe(1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("feeds a pre-aged fresh result into the existing pacer instead of tight re-polling", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-preaged-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const observedAt = Date.parse("2026-07-28T00:00:00.000Z");
    let nowMs = observedAt + 4 * 60_000;
    let calls = 0;
    const subject = quotaSnapshot("codex", null, 0.2).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => {
            calls += 1;
            return {
              snapshots: [
                {
                  ...quotaSnapshot("codex", null, 0.3),
                  source: "codex_app_server" as const,
                  observed_at: new Date(nowMs - 4 * 60_000 - 30_000).toISOString(),
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.2),
      source: "codex_app_server",
      observed_at: new Date(observedAt).toISOString(),
    });

    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(registry.read().snapshots[0]?.freshness).toBe("fresh");
    await expect(registry.pollStale()).resolves.toBe(false);
    nowMs += 59_999;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not leak lookahead demand into current-time absence projection", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-horizon-absence-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const observedAt = Date.parse("2026-07-28T00:00:00.000Z");
    const nowMs = observedAt + 4 * 60_000;
    const subject = quotaSnapshot("codex", null, 0.2).subject;
    const registry = new QuotaRegistry(
      journal,
      [{ vendor: "codex", refresh: async () => ({ snapshots: [] }) }],
      () => new Date(nowMs),
      () => [subject],
    );
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.2),
      source: "codex_app_server",
      observed_at: new Date(observedAt).toISOString(),
    });

    await expect(registry.pollStale()).resolves.toBe(true);
    expect(registry.read()).toMatchObject({
      snapshots: [expect.objectContaining({ freshness: "fresh" })],
      absences: [],
    });

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("polls empty or stale official sources with bounded failure backoff", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-poll-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    let calls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return {
            snapshots: [
              {
                subject: {
                  harness: "codex",
                  credential_route: "vendor_native",
                  plan_label: "Plus",
                  subject_id: null,
                },
                constraints: [],
                source: "codex_app_server",
                observed_at: new Date(nowMs).toISOString(),
                freshness: "fresh",
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
    );

    await expect(registry.pollStale()).resolves.toBe(false);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(registry.read().snapshots).toEqual([
      expect.objectContaining({ source: "codex_app_server", freshness: "fresh", constraints: [] }),
    ]);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("coalesces the whole poll and anchors absence backoff to a held cycle's completion", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-poll-held-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = quotaSnapshot("codex", null, 0).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (calls === 1) await held;
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: null,
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    const first = registry.pollStale();
    const concurrent = registry.pollStale();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    nowMs += 70_000;
    release();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);
    const afterFirstCycle = journal.records().length;
    expect(afterFirstCycle).toBe(2); // initial clock fence + one refresh fence
    expect(
      journal
        .records()
        .filter(
          (record) =>
            record.type === "quota.projection.updated" &&
            (record.payload as { reason?: unknown }).reason === "refresh",
        ),
    ).toHaveLength(1);

    // Backoff begins at completedAt (t+70s), not the stale t=0 start.
    nowMs += 59_999;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    expect(journal.records()).toHaveLength(afterFirstCycle);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(journal.records()).toHaveLength(afterFirstCycle + 1);
    expect(
      journal
        .records()
        .filter(
          (record) =>
            record.type === "quota.projection.updated" &&
            (record.payload as { reason?: unknown }).reason === "refresh",
        ),
    ).toHaveLength(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("demands fresh matching primary evidence per subject and ignores reactive/spool freshness", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-primary-demand-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const now = () => new Date("2026-07-28T00:00:01.000Z");
    const native = quotaSnapshot("codex", null, 0.2).subject;
    const work = quotaSnapshot("codex", "work", 0.3).subject;
    let calls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          return {
            snapshots: [
              {
                ...quotaSnapshot("codex", "work", 0.4),
                source: "codex_app_server" as const,
                observed_at: now().toISOString(),
              },
            ],
          };
        },
      ],
      now,
      () => [native, work],
    );
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.2),
      source: "codex_app_server",
      observed_at: now().toISOString(),
    });
    registry.upsert({
      ...quotaSnapshot("codex", "work", 0.3),
      source: "codex_rollout",
      observed_at: now().toISOString(),
    });

    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(registry.read().snapshots.map((snapshot) => snapshot.source)).toEqual([
      "codex_app_server",
      "codex_rollout",
      "codex_app_server",
    ]);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    // A stale reactive sibling does not create demand after primary evidence
    // for that same subject is fresh.
    registry.upsert({
      ...quotaSnapshot("codex", null, 0.5),
      source: "codex_rollout",
      observed_at: "2026-07-27T23:00:00.000Z",
    });
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("retry pacing for an unsatisfied subject never postpones a satisfied sibling's renewal (#263)", async () => {
    // Before #263 this case pinned the bug: a lane with one satisfied and one
    // never-observed subject climbed the retry ladder as if NOTHING had been
    // observed, so the satisfied subject's renewal waited up to 15 minutes.
    // The ladder still advances after each partial cycle (the never-observed
    // subject is retried exponentially), but a renewal that comes due before
    // the ladder elapses runs anyway.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-partial-backoff-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
    let calls = 0;
    const native = quotaSnapshot("codex", null, 0).subject;
    const work = quotaSnapshot("codex", "work", 0).subject;
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          return {
            snapshots: [
              {
                ...quotaSnapshot("codex", null, 0.2),
                source: "codex_app_server" as const,
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [native, work],
    );

    await expect(registry.pollStale()).resolves.toBe(true);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(3);
    // Ladder rung 4 minutes (until t=7m); renewal of the observed subject is
    // due at t=7m too (observed t=3m, TTL 5m, last tick before expiry).
    nowMs += 4 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(4);
    // Ladder rung now 8 minutes (until t=15m) — but the subject observed at
    // t=7m is due at t=12m, so the renewal runs at t=11m instead of waiting.
    nowMs += 3 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(4);
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(5);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("publishes a clock-derived freshness transition even when refresh fails", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-clock-marker-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
    const registry = new QuotaRegistry(
      journal,
      [async () => Promise.reject(new Error("vendor offline"))],
      () => new Date(nowMs),
    );
    registry.upsert(quotaSnapshot("claude", "work", 0.8));
    const before = journal.records().length;

    nowMs += 6 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    expect(journal.records()).toHaveLength(before + 1);
    expect(journal.records().at(-1)?.payload).toMatchObject({ reason: "clock_transition" });

    // The logical projection did not change again; the failed-refresh backoff
    // and signature fence prevent marker chatter.
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(journal.records()).toHaveLength(before + 1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("an absence-only refresh cycle backs off exponentially without throwing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-absence-backoff-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    let calls = 0;
    let mode: "absence" | "fresh" | "stale" = "absence";
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (mode !== "absence") {
            return {
              snapshots: [
                {
                  subject,
                  constraints: [],
                  source: "claude_oauth_usage" as const,
                  observed_at: new Date(
                    mode === "fresh" ? nowMs : nowMs - 10 * 60_000,
                  ).toISOString(),
                  freshness: "fresh" as const,
                },
              ],
            };
          }
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: "logged out",
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    // Cycle 1: an absence-only refresh records the typed absence and arms a 60s
    // backoff. It SUCCEEDS (returns true) and never throws.
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(registry.read().absences).toHaveLength(1);
    // A second poll inside the 60s window is skipped — pollNotBefore honored.
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    // The interval doubles per absence-only cycle; poll exactly at each boundary.
    nowMs += 60_000; // 2^0 window elapsed
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    nowMs += 60_000; // half of the 2^1 (120s) window — still skipped
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);
    nowMs += 60_000; // 2^1 window elapsed
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(3);

    // Saturate the backoff at the 15-minute ceiling: a full 15 min each step
    // clears whatever the (capped) window is.
    for (let step = 0; step < 6; step += 1) {
      nowMs += 15 * 60_000;
      await expect(registry.pollStale()).resolves.toBe(true);
    }
    const atCeiling = calls;
    // The window never exceeds 15 min: one ms short is skipped, at the ceiling fires.
    nowMs += 15 * 60_000 - 1;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(atCeiling);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(atCeiling + 1);

    // Only a cycle that satisfies ALL demand resets the exponential history.
    mode = "fresh";
    nowMs += 15 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    const afterReset = calls;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(afterReset);

    // Once that primary evidence ages stale, the next partial cycle starts a
    // fresh 60s backoff rather than inheriting the former 15-minute ceiling.
    mode = "stale";
    nowMs += 6 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    const afterStale = calls;
    nowMs += 30_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(afterStale);
    nowMs += 30_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(afterStale + 1);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("noteCredentialChange drops the absence backoff", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-note-cred-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    let calls = 0;
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: "logged out",
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          };
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    // Arm the backoff: one absence-only cycle, then confirm the next immediate
    // poll is inside the 60s window and is skipped.
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(1);
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);

    // A credential change (login/logout) drops the backoff — the very next poll
    // runs the refresher at once, without waiting out the window.
    registry.noteCredentialChange();
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not let an in-flight old-credential poll restore backoff after reset", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-note-inflight-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    const subject = quotaSnapshot("claude", null, 0).subject;
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () => {
          calls += 1;
          if (calls === 1) await held;
          return {
            snapshots: [],
            absences: [
              {
                subject,
                reason: "not_logged_in" as const,
                detail: null,
                observed_at: "2026-07-28T00:00:00.000Z",
              },
            ],
          };
        },
      ],
      () => new Date("2026-07-28T00:00:00.000Z"),
      () => [subject],
    );

    const oldPoll = registry.pollStale();
    await Promise.resolve();
    expect(calls).toBe(1);
    registry.noteCredentialChange();
    release();
    await expect(oldPoll).resolves.toBe(false);
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps official quota sources independent when one refresher is unavailable", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-sources-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    const registry = new QuotaRegistry(journal, [
      () => {
        throw new Error("Codex unavailable");
      },
      async () => ({
        snapshots: [
          {
            subject: {
              harness: "claude",
              credential_route: "vendor_native",
              plan_label: null,
              subject_id: null,
            },
            constraints: [
              {
                id: "five_hour",
                label: "5 hour",
                used_ratio: 0.2,
                window_seconds: 18_000,
                resets_at: null,
                cooldown_until: null,
              },
            ],
            source: "claude_statusline",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }),
    ]);

    await expect(registry.refresh()).resolves.toMatchObject({
      snapshots: [expect.objectContaining({ source: "claude_statusline" })],
    });
    expect(registry.read().snapshots[0]?.subject.harness).toBe("claude");

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("prunes snapshots older than 24h from every projection read (W17)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-prune-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const registry = new QuotaRegistry(journal, [], () => new Date(nowIso));
    const snapshot = (observedAt: string, harness: string) => ({
      subject: {
        harness,
        credential_route: "vendor_native" as const,
        plan_label: null,
        subject_id: null,
      },
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.4,
          window_seconds: 18000,
          resets_at: null,
          cooldown_until: null,
        },
      ],
      source: "claude_statusline" as const,
      observed_at: observedAt,
      freshness: "fresh" as const,
    });
    // A day-old observation is pruned; a merely stale one is kept and marked.
    registry.upsert(snapshot("2026-07-15T11:00:00.000Z", "claude"));
    registry.upsert(snapshot("2026-07-16T11:00:00.000Z", "codex"));
    expect(registry.read().snapshots.map((item) => item.subject.harness)).toEqual(["codex"]);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    // Time passing prunes the survivor too — nothing dead lingers in the footer.
    nowIso = "2026-07-17T12:00:00.000Z";
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("aggregates typed absences: snapshot suppresses, claim wins over no_source, universe gap → no_source", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-absence-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    const now = () => new Date("2026-07-16T12:00:00.000Z");
    const subject = (harness: string, subjectId: string | null) => ({
      harness,
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    });
    // Universe: claude default (will get a snapshot), codex default (a refresher
    // claim), and a codex "work" profile (no snapshot, no claim → no_source).
    const registry = new QuotaRegistry(
      journal,
      [
        async () => ({
          snapshots: [
            {
              subject: subject("claude", null),
              constraints: [
                {
                  id: "five_hour",
                  label: "5 hour",
                  used_ratio: 0.3,
                  window_seconds: 18_000,
                  resets_at: null,
                  cooldown_until: null,
                },
              ],
              source: "claude_oauth_usage" as const,
              observed_at: now().toISOString(),
              freshness: "fresh" as const,
            },
          ],
          // A claim for the claude subject that DOES have a snapshot must be
          // suppressed; the codex-default claim must survive.
          absences: [
            {
              subject: subject("claude", null),
              reason: "not_logged_in" as const,
              detail: "should be suppressed by the snapshot",
              observed_at: now().toISOString(),
            },
            {
              subject: subject("codex", null),
              reason: "not_logged_in" as const,
              detail: "no login",
              observed_at: now().toISOString(),
            },
          ],
        }),
      ],
      now,
      () => [subject("claude", null), subject("codex", null), subject("codex", "work")],
    );

    const value = await registry.refresh();
    expect(value.snapshots.map((s) => s.subject.harness)).toEqual(["claude"]);
    const byKey = new Map(
      value.absences.map((a) => [`${a.subject.harness}/${a.subject.subject_id ?? "default"}`, a]),
    );
    // claude/default is covered by a snapshot — no absence.
    expect(byKey.has("claude/default")).toBe(false);
    // codex/default: the refresher claim wins.
    expect(byKey.get("codex/default")?.reason).toBe("not_logged_in");
    // codex/work: in the universe with neither snapshot nor claim → no_source.
    expect(byKey.get("codex/work")?.reason).toBe("no_source");
    expect(value.absences).toHaveLength(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("retires the snapshot an auth_revoked claim contradicts, for a profile and the default subject", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-revoked-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const now = () => new Date(nowIso);
    const subject = (subjectId: string | null) => ({
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    });
    // Cycle 1 observes both subjects; cycle 2 is the vendor rejecting them.
    let revoked = false;
    const registry = new QuotaRegistry(
      journal,
      [
        async () =>
          revoked
            ? {
                snapshots: [],
                absences: [null, "abstractdl"].map((id) => ({
                  subject: subject(id as string | null),
                  reason: "auth_revoked" as const,
                  detail: "oauth/usage responded 401",
                  observed_at: now().toISOString(),
                })),
              }
            : {
                snapshots: [
                  quotaSnapshot("claude", null, 0.3),
                  quotaSnapshot("claude", "abstractdl", 0.3),
                ],
                absences: [],
              },
      ],
      now,
      () => [subject(null), subject("abstractdl")],
    );

    expect((await registry.refresh()).snapshots).toHaveLength(2);

    // The revocation lands while the cached snapshots are still well inside the
    // 24h retention window — the exact case in which the coverage rule used to
    // suppress it, leaving a dead credential reported as vendor-verified.
    revoked = true;
    nowIso = "2026-07-16T12:06:00.000Z";
    const after = await registry.refresh();
    expect(after.snapshots).toEqual([]);
    expect(after.absences.map((a) => a.subject.subject_id ?? "default").sort()).toEqual([
      "abstractdl",
      "default",
    ]);
    expect(after.absences.every((a) => a.reason === "auth_revoked")).toBe(true);

    // Durable: a restart replaying this journal must not resurrect the window.
    const replayed = new QuotaRegistry(journal, [], now, () => []);
    expect(replayed.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("durably retires stale snapshots before projecting credential_profile_ambiguous and recomputes the reason after replay", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-ambiguous-")));
    const journalRoot = join(root, "journal");
    const journal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    let ambiguous = false;
    const now = () => new Date("2026-08-19T00:00:01.000Z");
    const subjects = ["agy-a", "agy-b"].map((subjectId) => ({
      harness: "agy",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    }));
    const ambiguityBatch = () => ({
      snapshots: [],
      absences: subjects.map((subject) => ({
        subject,
        reason: "credential_profile_ambiguous" as const,
        detail: "disable extra profiles",
        observed_at: now().toISOString(),
      })),
    });
    const registry = new QuotaRegistry(
      journal,
      [
        async () =>
          ambiguous
            ? ambiguityBatch()
            : {
                snapshots: subjects.map((subject) => ({
                  ...quotaSnapshot("agy", subject.subject_id, 0.2),
                  subject,
                  source: "agy_command_usage" as const,
                  observed_at: now().toISOString(),
                })),
                absences: [],
              },
      ],
      now,
      () => subjects,
    );

    expect((await registry.refresh()).snapshots).toHaveLength(2);
    ambiguous = true;
    const conflicted = await registry.refresh();
    expect(conflicted.snapshots).toEqual([]);
    expect(conflicted.absences).toHaveLength(2);
    expect(
      conflicted.absences.every((item) => item.reason === "credential_profile_ambiguous"),
    ).toBe(true);
    expect(
      journal.records().filter((record) => record.type === "quota.subject.removed"),
    ).toHaveLength(2);
    journal.close();

    const replayJournal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    const replayed = new QuotaRegistry(
      replayJournal,
      [async () => ambiguityBatch()],
      now,
      () => subjects,
    );
    expect(replayed.read().snapshots).toEqual([]);
    const replayRefresh = await replayed.refresh();
    expect(replayRefresh.snapshots).toEqual([]);
    expect(replayRefresh.absences.map((item) => item.reason)).toEqual([
      "credential_profile_ambiguous",
      "credential_profile_ambiguous",
    ]);

    replayJournal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a REMOVED append failure leaves state and journal agreeing (no silent live-only retirement)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-revoke-crash-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const now = () => new Date(nowIso);
    const subject = (subjectId: string | null) => ({
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: subjectId,
    });
    let revoked = false;
    const registry = new QuotaRegistry(
      journal,
      [
        async () =>
          revoked
            ? {
                snapshots: [],
                absences: [
                  {
                    subject: subject(null),
                    reason: "auth_revoked" as const,
                    detail: "oauth/usage responded 401",
                    observed_at: now().toISOString(),
                  },
                ],
              }
            : { snapshots: [quotaSnapshot("claude", null, 0.3)], absences: [] },
      ],
      now,
      () => [subject(null)],
    );
    expect((await registry.refresh()).snapshots).toHaveLength(1);

    // The retirement's durable authority write fails (disk error). The live
    // projection must NOT have been mutated first: journal and state still
    // agree that the snapshot exists, so a restart cannot diverge from the
    // running daemon (wave-5 f-dace28127b7a ordering inversion).
    revoked = true;
    nowIso = "2026-07-16T12:06:00.000Z";
    const realAppend = journal.append.bind(journal);
    const spy = vi.spyOn(journal, "append").mockImplementation((type, payload) => {
      if (type === "quota.subject.removed") throw new Error("append failed: no space left");
      return realAppend(type, payload);
    });
    await expect(registry.refresh()).rejects.toThrow("no space left");
    expect(registry.read().snapshots).toHaveLength(1);
    spy.mockRestore();
    const replayedMid = new QuotaRegistry(journal, [], now, () => []);
    expect(replayedMid.read().snapshots).toHaveLength(1);

    // A later healthy cycle completes the retirement durably.
    const after = await registry.refresh();
    expect(after.snapshots).toEqual([]);
    const replayed = new QuotaRegistry(journal, [], now, () => []);
    expect(replayed.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps an old observation whose constraint still extends into the future (live weekly cooldown)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-live-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowIso = "2026-07-16T12:00:00.000Z";
    const registry = new QuotaRegistry(journal, [], () => new Date(nowIso));
    registry.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: null,
      },
      constraints: [
        {
          id: "weekly",
          label: "Weekly",
          used_ratio: 1,
          window_seconds: 604_800,
          resets_at: "2026-07-20T00:00:00.000Z",
          cooldown_until: "2026-07-20T00:00:00.000Z",
        },
      ],
      source: "codex_rollout",
      observed_at: "2026-07-14T12:00:00.000Z", // 2 days old — past the 24h horizon
      freshness: "fresh",
    });
    // The cap is still LIVE (resets in the future): kept and stale-marked —
    // hiding it would blind both the footer and the router's ledger.
    expect(registry.read().snapshots).toHaveLength(1);
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    // Once the window itself expires, the old observation finally prunes.
    nowIso = "2026-07-21T00:00:00.000Z";
    expect(registry.read().snapshots).toEqual([]);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("QuotaRegistry per-vendor pacing lanes", () => {
  const subjectOf = (harness: string, subjectId: string | null) => ({
    harness,
    credential_route: "vendor_native" as const,
    plan_label: null,
    subject_id: subjectId,
  });

  it("one vendor's unsatisfiable subject backs off alone; siblings keep their cadence", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-lane-iso-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let codexCalls = 0;
    let claudeCalls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => {
            codexCalls += 1;
            return {
              snapshots: [
                {
                  ...quotaSnapshot("codex", null, 0.1),
                  source: "codex_app_server" as const,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
        {
          vendor: "claude",
          refresh: async () => {
            claudeCalls += 1;
            return {
              snapshots: [],
              absences: [
                {
                  subject: subjectOf("claude", null),
                  reason: "not_logged_in" as const,
                  detail: null,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subjectOf("codex", null), subjectOf("claude", null)],
    );

    // Drive claude's absence-only lane to its 15-minute ceiling.
    await expect(registry.pollStale()).resolves.toBe(true);
    for (let step = 0; step < 6; step += 1) {
      nowMs += 15 * 60_000;
      await expect(registry.pollStale()).resolves.toBe(true);
    }
    const claudeAtCeiling = claudeCalls;
    const codexBefore = codexCalls;
    // 6 minutes later codex's snapshot is stale again (fresh window is 5 min):
    // codex MUST refresh even though claude sits mid-way through its 15-minute
    // window — the old global pacer pinned exactly this at the ceiling.
    nowMs += 6 * 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(codexCalls).toBe(codexBefore + 1);
    expect(claudeCalls).toBe(claudeAtCeiling);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("honors the vendor Retry-After floor over the exponential ladder and feeds it from foreground too", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-lane-floor-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let calls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "claude",
          refresh: async () => {
            calls += 1;
            return {
              snapshots: [],
              absences: [
                {
                  subject: subjectOf("claude", null),
                  reason: "rate_limited" as const,
                  detail: "oauth/usage responded 429",
                  observed_at: new Date(nowMs).toISOString(),
                  retry_after_ms: 30 * 60_000,
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subjectOf("claude", null)],
    );

    // FOREGROUND refresh observes the 429 — the floor arms from it as well.
    await registry.refresh();
    expect(calls).toBe(1);
    expect(registry.read().absences[0]?.reason).toBe("rate_limited");

    // The exponential ladder alone would re-poll after 60s; the vendor said
    // 30 minutes. One ms short of the floor stays skipped, at the floor polls.
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 29 * 60_000 - 1;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("honors a multi-day vendor floor in full and caps a hostile one at 7 days", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-lane-ceiling-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let calls = 0;
    let retryAfterMs = 3 * 24 * 60 * 60_000; // valid 3-day vendor floor
    const subject = subjectOf("claude", null);
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "claude",
          refresh: async () => {
            calls += 1;
            return {
              snapshots: [],
              absences: [
                {
                  subject,
                  reason: "rate_limited" as const,
                  detail: null,
                  observed_at: new Date(nowMs).toISOString(),
                  retry_after_ms: retryAfterMs,
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    await expect(registry.pollStale()).resolves.toBe(true);
    // Above the OLD 24h cap, below the 7-day ceiling: honored in full.
    nowMs += 3 * 24 * 60 * 60_000 - 1;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 1;
    retryAfterMs = 30 * 24 * 60 * 60_000; // hostile 30-day floor
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);
    // Clamped at the 7-day ceiling, not silenced for a month.
    nowMs += 7 * 24 * 60 * 60_000 - 1;
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);
    nowMs += 1;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(calls).toBe(3);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists the rate-limit floor across restart and credential change, journal-free", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-lane-persist-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    const saved = new Map<string, number>();
    const store = {
      load: (vendor: string) => saved.get(vendor) ?? 0,
      save: (vendor: string, notBeforeMs: number) => {
        saved.set(vendor, notBeforeMs);
      },
      loadSubject: (subject: QuotaSubject) =>
        saved.get(
          JSON.stringify([subject.harness, subject.credential_route, subject.subject_id]),
        ) ?? 0,
      saveSubject: (subject: QuotaSubject, until: number) => {
        saved.set(
          JSON.stringify([subject.harness, subject.credential_route, subject.subject_id]),
          until,
        );
      },
    };
    let calls = 0;
    const refresher = {
      vendor: "claude",
      refresh: async () => {
        calls += 1;
        return {
          snapshots: [],
          absences: [
            {
              subject: subjectOf("claude", null),
              reason: "rate_limited" as const,
              detail: null,
              observed_at: new Date(nowMs).toISOString(),
              retry_after_ms: 45 * 60_000,
            },
          ],
        };
      },
    };
    const subjects = () => [subjectOf("claude", null)];
    const registry = new QuotaRegistry(
      journal,
      [refresher],
      () => new Date(nowMs),
      subjects,
      store,
    );

    await expect(registry.pollStale()).resolves.toBe(true);
    expect(saved.get(JSON.stringify(["claude", "vendor_native", null]))).toBe(nowMs + 45 * 60_000);
    expect(saved.has("claude")).toBe(false);
    // Owner decision 7=A: the floor never becomes a quota fact — no snapshot
    // or cooldown upsert reaches the journal (the typed absence itself rides
    // only the ephemeral projection, whose markers are the sole records here).
    expect([...new Set(journal.records().map((record) => record.type))]).toEqual([
      "quota.projection.updated",
    ]);

    // "Restart": a NEW registry over the same store inherits the floor and
    // does not re-hammer the vendor; noteCredentialChange (which resets only
    // the credential-demand backoff) does not lift it either.
    nowMs += 10 * 60_000;
    const restarted = new QuotaRegistry(
      journal,
      [refresher],
      () => new Date(nowMs),
      subjects,
      store,
    );
    await expect(restarted.pollStale()).resolves.toBe(false);
    restarted.noteCredentialChange();
    await expect(restarted.pollStale()).resolves.toBe(false);
    expect(calls).toBe(1);
    nowMs += 35 * 60_000;
    await expect(restarted.pollStale()).resolves.toBe(true);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a foreground refresh joining a lane-scoped poll cycle re-runs a FULL cycle (no silent partial join)", async () => {
    // Regression vs base: on 0c376844 the poll ran a FULL cycle, so a joiner
    // always got a genuine full refresh. With per-lane poll cycles, an
    // explicit refresh that joined a scoped cycle must re-run full instead of
    // returning with sibling vendors unre-fetched and no disclosure.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-joinrace-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let codexCalls = 0;
    let claudeCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claudeSubject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => {
            codexCalls += 1;
            return {
              snapshots: [
                {
                  ...quotaSnapshot("codex", null, 0.1),
                  source: "codex_app_server" as const,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
        {
          vendor: "claude",
          refresh: async () => {
            claudeCalls += 1;
            if (claudeCalls === 1) await held;
            return {
              snapshots: [],
              absences: [
                {
                  subject: claudeSubject,
                  reason: "not_logged_in" as const,
                  detail: null,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      // Only claude has a registered subject, so the poll sweep runs ONLY the
      // claude lane — the exact scoped cycle the foreground caller joins.
      () => [claudeSubject],
    );

    const sweep = registry.pollStale();
    await Promise.resolve();
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(0);
    const foreground = registry.refresh();
    await Promise.resolve();
    nowMs += 1000;
    release();
    const [swept, fg] = await Promise.all([sweep, foreground]);
    expect(swept).toBe(true);
    // The joiner re-ran a FULL cycle: codex was actually fetched, fresh.
    expect(codexCalls).toBe(1);
    expect(claudeCalls).toBe(2);
    expect(fg.snapshots.map((snapshot) => [snapshot.subject.harness, snapshot.freshness])).toEqual([
      ["codex", "fresh"],
    ]);
    expect(fg.refresh_skipped).toBeUndefined();

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("foreground refresh honors an armed vendor cooldown: serves last-known data and disclosed skips", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-fg-cooldown-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let claudeCalls = 0;
    let codexCalls = 0;
    const subjectOf = (harness: string) => ({
      harness,
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    });
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => {
            codexCalls += 1;
            return {
              snapshots: [
                {
                  ...quotaSnapshot("codex", null, 0.1),
                  source: "codex_app_server" as const,
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
        {
          vendor: "claude",
          refresh: async () => {
            claudeCalls += 1;
            return {
              snapshots: [],
              absences: [
                {
                  subject: subjectOf("claude"),
                  reason: "rate_limited" as const,
                  detail: "oauth/usage responded 429",
                  observed_at: new Date(nowMs).toISOString(),
                  retry_after_ms: 20 * 60_000,
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subjectOf("codex"), subjectOf("claude")],
    );

    // First explicit refresh observes the 429 and arms the claude floor.
    const first = await registry.refresh();
    expect(first.refresh_skipped).toBeUndefined();
    expect(claudeCalls).toBe(1);

    // A second explicit refresh inside the cooldown re-fans-out codex only;
    // claude's HTTP is skipped, its last-known typed absence still serves,
    // and the skip is disclosed additively with the release instant.
    nowMs += 60_000;
    const second = await registry.refresh();
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(2);
    expect(second.refresh_skipped).toEqual([
      {
        vendor: "claude",
        subject: subjectOf("claude"),
        not_before: new Date(Date.parse("2026-08-28T00:20:00.000Z")).toISOString(),
      },
    ]);
    expect(second.absences.map((absence) => [absence.subject.harness, absence.reason])).toEqual([
      ["claude", "rate_limited"],
    ]);
    expect(second.refreshed_at).not.toBeNull();

    // POST /v2/quota and the atomic Accounts response ride this same cycle;
    // an all-cooled cycle still serves rather than failing. Exhaust codex's
    // eligibility by... codex has no floor, so it always runs — assert the
    // single-vendor skip shape stays stable on a third refresh instead.
    nowMs += 60_000;
    const third = await registry.refreshWithCursor();
    expect(third.response.refresh_skipped?.map((skip) => skip.vendor)).toEqual(["claude"]);
    expect(third.quotaEventCursor).toBeTruthy();
    expect(claudeCalls).toBe(1);

    // After the floor elapses the fan-out resumes and the disclosure clears.
    nowMs = Date.parse("2026-08-28T00:20:00.000Z");
    const fourth = await registry.refresh();
    expect(claudeCalls).toBe(2);
    expect(fourth.refresh_skipped).toBeUndefined();

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("an all-cooled foreground refresh serves last-known data instead of failing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-fg-allcooled-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let calls = 0;
    const subject = {
      harness: "claude",
      credential_route: "vendor_native" as const,
      plan_label: null,
      subject_id: null,
    };
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "claude",
          refresh: async () => {
            calls += 1;
            return {
              snapshots: [],
              absences: [
                {
                  subject,
                  reason: "rate_limited" as const,
                  detail: null,
                  observed_at: new Date(nowMs).toISOString(),
                  retry_after_ms: 10 * 60_000,
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subject],
    );

    await registry.refresh();
    nowMs += 60_000;
    const cooled = await registry.refreshWithCursor();
    expect(calls).toBe(1);
    expect(cooled.response.refresh_skipped?.map((skip) => skip.vendor)).toEqual(["claude"]);
    // The typed absence is preserved (not degraded to no_source), and the
    // cycle still fences a valid cursor for snapshot-then-SSE clients.
    expect(cooled.response.absences.map((absence) => absence.reason)).toEqual(["rate_limited"]);
    expect(cooled.quotaEventCursor).toBeTruthy();

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a vendor-scoped poll cycle preserves sibling vendors' typed absences and refresherless no_source rows", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-lane-absence-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    let claudeCalls = 0;
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "codex",
          refresh: async () => ({
            snapshots: [],
            absences: [
              {
                subject: subjectOf("codex", null),
                reason: "not_logged_in" as const,
                detail: null,
                observed_at: new Date(nowMs).toISOString(),
              },
            ],
          }),
        },
        {
          vendor: "claude",
          refresh: async () => {
            claudeCalls += 1;
            return {
              snapshots: [],
              absences: [
                {
                  subject: subjectOf("claude", null),
                  reason: "refresh_failed" as const,
                  detail: "flaky",
                  observed_at: new Date(nowMs).toISOString(),
                },
              ],
            };
          },
        },
      ],
      () => new Date(nowMs),
      () => [subjectOf("codex", null), subjectOf("claude", null), subjectOf("cursor", "row-a")],
    );

    // Full sweep: codex claims not_logged_in, claude claims refresh_failed,
    // and the refresherless cursor subject is stated as no_source.
    await expect(registry.pollStale()).resolves.toBe(true);
    const byHarness = () =>
      new Map(registry.read().absences.map((absence) => [absence.subject.harness, absence.reason]));
    expect(byHarness().get("codex")).toBe("not_logged_in");
    expect(byHarness().get("claude")).toBe("refresh_failed");
    expect(byHarness().get("cursor")).toBe("no_source");

    // Claude's ladder recovers first (both armed 60s at the same completion);
    // advance exactly one claude-only cycle ahead of codex by draining codex's
    // eligibility with an equal cycle, then verify a claude-scoped cycle does
    // not degrade codex's typed reason to no_source and keeps cursor stated.
    nowMs += 60_000;
    await expect(registry.pollStale()).resolves.toBe(true);
    expect(byHarness().get("codex")).toBe("not_logged_in");
    expect(byHarness().get("claude")).toBe("refresh_failed");
    expect(byHarness().get("cursor")).toBe("no_source");
    expect(claudeCalls).toBeGreaterThanOrEqual(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("QuotaRegistry gap-absence honesty (suppressed polls stay stated)", () => {
  const subjectOf = (harness: string, subjectId: string | null) => ({
    harness,
    credential_route: "vendor_native" as const,
    plan_label: null,
    subject_id: subjectId,
  });

  it.each([
    { harness: "claude", source: "claude_oauth_usage", reason: "probe_skipped_rate_limited" },
    { harness: "claude", source: "claude_oauth_usage", reason: "refresh_failed" },
    { harness: "codex", source: "codex_app_server", reason: "refresh_failed" },
    { harness: "agy", source: "agy_command_usage", reason: "refresh_failed" },
  ] as const)(
    "$harness $reason coexists with stale data until a fresh reading",
    async ({ harness, source, reason }) => {
      // The stale spent window is exactly the state the gap row explains: an
      // exhaustion reader that skips stale snapshots must still see an absence
      // (fail-open), or "spent + silence" would read as window exhausted.
      const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-gap-stale-")));
      const journal = new DurableJournal({ rootDir: root, partition: "global" });
      let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
      const a = subjectOf(harness, "acc-a");
      const b = subjectOf(harness, "acc-b");
      const snapshot = (id: string, used: number) => ({
        ...quotaSnapshot(harness, id, used),
        source,
        observed_at: new Date(nowMs).toISOString(),
      });
      let cycle = 0;
      const registry = new QuotaRegistry(
        journal,
        [
          {
            vendor: harness,
            refresh: async () => {
              cycle += 1;
              if (cycle === 1 || cycle === 4) {
                // Both probed: two fresh snapshots.
                return {
                  snapshots: [snapshot("acc-a", 1), snapshot("acc-b", 0.4)],
                };
              }
              // A refreshes; B reports a failed or skipped quota observation.
              return {
                snapshots: [snapshot("acc-a", 1)],
                absences: [
                  {
                    subject: b,
                    reason,
                    detail: "current quota reading unavailable",
                    observed_at: new Date(nowMs).toISOString(),
                  },
                ],
              };
            },
          },
        ],
        () => new Date(nowMs),
        () => [a, b],
      );

      await registry.refresh();
      // B has a FRESH snapshot: no absence row for B (fresh cover silences).
      expect(registry.read().absences).toEqual([]);
      nowMs += 1_000;
      await registry.refresh();
      expect(registry.read().absences).toEqual([]);

      // 10 minutes on: B's snapshot is STALE; the new cycle re-freshens A and
      // claims B's probe skip. The gap row must be visible ALONGSIDE B's stale
      // snapshot, never dropped for stale cover.
      nowMs += 10 * 60_000;
      const refreshed = await registry.refresh();
      const view = registry.read();
      expect(refreshed.absences).toEqual(view.absences);
      expect(
        view.snapshots.map((snapshot) => [snapshot.subject.subject_id, snapshot.freshness]),
      ).toEqual([
        ["acc-a", "fresh"],
        ["acc-b", "stale"],
      ]);
      expect(view.absences.map((absence) => [absence.subject.subject_id, absence.reason])).toEqual([
        ["acc-b", reason],
      ]);
      expect(view.absences[0]).toMatchObject({
        detail: "current quota reading unavailable",
        observed_at: new Date(nowMs).toISOString(),
      });
      nowMs += 1_000;
      await registry.refresh();
      expect(registry.read().snapshots.every((entry) => entry.freshness === "fresh")).toBe(true);
      expect(registry.read().absences).toEqual([]);

      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  );

  it("derives stable poll_paced rows for a floor-suppressed token aliases, restart included", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-gap-paced-")));
    const journal = new DurableJournal({ rootDir: root, partition: "global" });
    let nowMs = Date.parse("2026-08-28T00:00:00.000Z");
    const saved = new Map<string, number>();
    const store = {
      load: (vendor: string) => saved.get(vendor) ?? 0,
      save: (vendor: string, notBeforeMs: number) => {
        saved.set(vendor, notBeforeMs);
      },
      loadSubject: (subject: QuotaSubject) =>
        saved.get(
          JSON.stringify([subject.harness, subject.credential_route, subject.subject_id]),
        ) ?? 0,
      saveSubject: (subject: QuotaSubject, until: number) => {
        saved.set(
          JSON.stringify([subject.harness, subject.credential_route, subject.subject_id]),
          until,
        );
      },
    };
    const a = subjectOf("claude", "acc-a");
    const b = subjectOf("claude", "acc-b");
    const subjects = () => [a, b];
    const refresher = {
      vendor: "claude",
      refresh: async (cycle?: import("./quota-poll-lanes.js").QuotaRefreshCycle) => {
        cycle?.pacing?.bindCredentials([
          { subject: a, credentialHash: "same-token-hash" },
          { subject: b, credentialHash: "same-token-hash" },
        ]);
        return {
          snapshots: [],
          absences: [
            {
              subject: a,
              reason: "rate_limited" as const,
              detail: null,
              observed_at: new Date(nowMs).toISOString(),
              retry_after_ms: 30 * 60_000,
            },
            {
              subject: b,
              reason: "probe_skipped_rate_limited" as const,
              detail: null,
              observed_at: new Date(nowMs).toISOString(),
            },
          ],
        };
      },
    };
    const registry = new QuotaRegistry(
      journal,
      [refresher],
      () => new Date(nowMs),
      subjects,
      store,
    );
    await expect(registry.pollStale()).resolves.toBe(true);
    // Typed claims exist for both; no derived duplicates.
    expect(
      registry
        .read()
        .absences.map((absence) => absence.reason)
        .sort(),
    ).toEqual(["probe_skipped_rate_limited", "rate_limited"]);

    // "Restart": absences are ephemeral, the floor is store-loaded. Without a
    // derived row both subjects would fall SILENT for the rest of the floor.
    nowMs += 5 * 60_000;
    const restarted = new QuotaRegistry(
      journal,
      [refresher],
      () => new Date(nowMs),
      subjects,
      store,
    );
    const view = restarted.read();
    expect(view.absences.map((absence) => [absence.subject.subject_id, absence.reason])).toEqual([
      ["acc-a", "poll_paced"],
      ["acc-b", "poll_paced"],
    ]);
    expect(view.absences[0]?.detail).toContain("2026-08-28T00:30:00.000Z");
    // Stable per floor: repeated reads/sweeps never churn the projection.
    const stampA = view.absences[0]?.observed_at;
    nowMs += 60_000;
    await expect(restarted.pollStale()).resolves.toBe(false);
    const markersAfterFirstSweep = journal.records().length;
    expect(restarted.read().absences[0]?.observed_at).toBe(stampA);
    nowMs += 60_000;
    await expect(restarted.pollStale()).resolves.toBe(false);
    expect(journal.records().length).toBe(markersAfterFirstSweep);

    // Floor elapsed: the pause lifts, the lane repolls, derived rows vanish.
    nowMs = Date.parse("2026-08-28T00:30:00.000Z");
    await expect(restarted.pollStale()).resolves.toBe(true);
    expect(restarted.read().absences.every((absence) => absence.reason !== "poll_paced")).toBe(
      true,
    );

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("quotaPacerFileStore", () => {
  it("round-trips subject floors, retains old vendor deadlines, survives junk and writes atomically", async () => {
    const { quotaPacerFileStore } = await import("./quota-poll-pacer.js");
    const { writeFileSync, readFileSync, readdirSync } = await import("node:fs");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-pacer-store-")));
    const store = quotaPacerFileStore(dir);
    expect(store.load("claude")).toBe(0);
    const at = Date.parse("2026-08-28T00:45:00.000Z");
    writeFileSync(
      join(dir, "quota-pacer-state.json"),
      JSON.stringify({
        version: 1,
        vendors: {
          claude: { not_before: new Date(at).toISOString() },
          codex: { not_before: new Date(at + 1000).toISOString() },
        },
      }),
    );
    const subject = quotaSnapshot("claude", "one-account", 0).subject;
    store.saveSubject?.(subject, at + 2000);
    expect(store.loadSubject?.(subject)).toBe(at + 2000);
    expect(store.load("claude")).toBe(at);
    expect(store.load("codex")).toBe(at + 1000);
    // The file is daemon-private state, not a journal record.
    const raw = JSON.parse(readFileSync(join(dir, "quota-pacer-state.json"), "utf8"));
    expect(raw).toMatchObject({ version: 2 });
    expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
    // Corrupt file: fail-open to no floor, and the next save repairs it.
    writeFileSync(join(dir, "quota-pacer-state.json"), "{not json");
    expect(store.load("claude")).toBe(0);
    store.saveSubject?.(subject, at);
    expect(store.loadSubject?.(subject)).toBe(at);
    rmSync(dir, { recursive: true, force: true });
  });
});
