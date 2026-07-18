import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import { JournalManager } from "./journal-manager.js";
import { QuotaRegistry, quotaProjection } from "./quota-registry.js";

describe("QuotaRegistry", () => {
  it("ingests a typed harness quota event with its exact credential route", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-ingest-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("codex", {
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
    expect(slot.current().read().snapshots[0]).toMatchObject({
      subject: { harness: "codex", credential_route: "vendor_native" },
      source: "codex_rollout",
    });
    slot.current().ingest("codex", {
      type: "error",
      session_id: "session-1",
      ts: new Date().toISOString(),
      error: "rate limited",
      credential_route: "vendor_native",
      rate_limit: { resets_at: null, retry_delay_ms: 60_000 },
    });
    expect(
      slot
        .current()
        .read()
        .snapshots[0]?.constraints.map((item) => item.id),
    ).toEqual(["primary", "cooldown"]);
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a profiled quota event registers under ITS profile subject, never the engine default (round-17 #2)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-subject-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("codex", {
      type: "usage",
      session_id: "session-1",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: "acc2",
      quota: {
        source: "codex_rollout",
        plan_label: null,
        // The vendor rollout record carries no subject of its own — the
        // event's Claudexor profile stamp is the credential identity.
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
    expect(slot.current().read().snapshots[0]?.subject).toMatchObject({
      harness: "codex",
      credential_route: "vendor_native",
      subject_id: "acc2",
    });
    expect(slot.current().removeSubject("codex", "acc2")).toBe(1);
    expect(slot.current().read().snapshots).toEqual([]);
    manager.close();
    const restarted = new JournalManager(root);
    const restartedSlot = restarted.registerProjection(quotaProjection());
    restarted.start();
    expect(restartedSlot.current().read().snapshots).toEqual([]);
    restarted.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records Claude api_retry cooldowns as retry evidence, never as statusline quota", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-retry-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("claude", {
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

    expect(slot.current().read().snapshots).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          harness: "claude",
          credential_route: "managed_api_key",
        }),
        source: "claude_api_retry",
        constraints: [expect.objectContaining({ id: "cooldown" })],
      }),
    ]);
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists all windows and marks expired data stale without fabricating zero usage", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-")));
    const first = new JournalManager(root);
    const slot = first.registerProjection(quotaProjection());
    first.start();
    slot.current().upsert({
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
    first.close();

    const reopened = new JournalManager(root);
    const replayed = reopened.registerProjection(quotaProjection());
    reopened.start();
    const value = replayed.current().read();
    expect(value.snapshots[0]?.freshness).toBe("stale");
    expect(value.snapshots[0]?.constraints).toHaveLength(2);
    expect(value.snapshots[0]?.constraints[0]?.used_ratio).toBe(0.42);
    expect(value.snapshots[0]?.constraints[1]?.used_ratio).toBeNull();
    reopened.close();
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
          return [
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
          ];
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
    await expect(registry.pollStale()).resolves.toBe(false);
    expect(calls).toBe(2);

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps official quota sources independent when one refresher is unavailable", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-sources-")));
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    const registry = new QuotaRegistry(journal, [
      async () => {
        throw new Error("Codex unavailable");
      },
      async () => [
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
    ]);

    await expect(registry.refresh()).resolves.toMatchObject({
      snapshots: [expect.objectContaining({ source: "claude_statusline" })],
    });
    expect(registry.read().snapshots[0]?.subject.harness).toBe("claude");

    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("prunes snapshots older than 24h from every projection read (W17)", () => {
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

  it("keeps an old observation whose constraint still extends into the future (live weekly cooldown)", () => {
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
