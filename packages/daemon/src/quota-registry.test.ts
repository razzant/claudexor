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

  it("records Claude api_retry cooldowns as retry evidence, never as statusline quota", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-claude-retry-")));
    const manager = new JournalManager(root);
    const slot = manager.registerProjection(quotaProjection());
    manager.start();
    slot.current().ingest("claude", {
      type: "thinking",
      session_id: "session-claude",
      ts: "2026-07-15T12:00:00.000Z",
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
      observed_at: "2026-07-15T10:00:00.000Z",
      freshness: "fresh",
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 0.42,
          window_seconds: 18_000,
          resets_at: "2026-07-15T11:00:00.000Z",
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
});
