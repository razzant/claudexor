import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaSnapshot, QuotaConstraint } from "@claudexor/schema";
import { BudgetLedger } from "../../budget/src/ledger.js";
import { profileQuotaBlock } from "../../orchestrator/src/credential-cooldown.js";
import { claudeRateLimitEvents } from "../../harness-claude/src/context-signals.js";
import {
  codexRateLimitEvents,
  parseCodexRateLimitsResponse,
} from "../../harness-codex/src/quota.js";
import { QuotaRegistry } from "./quota-registry.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";

const START = Date.parse("2026-10-04T10:00:00Z");
const RESET = START + 7 * 24 * 3_600_000;
const iso = (offset: number) => new Date(START + offset).toISOString();
const subject = {
  harness: "claude",
  credential_route: "vendor_native" as const,
  subject_id: "work",
  plan_label: null,
};
const constraint = (extra: Partial<QuotaConstraint> = {}): QuotaConstraint => ({
  id: "five_hour",
  label: "5 hour",
  used_ratio: 0.2,
  window_seconds: 18000,
  resets_at: new Date(RESET).toISOString(),
  cooldown_until: null,
  ...extra,
});
const full = (time: number, constraints: QuotaConstraint[] = [constraint()]): QuotaSnapshot => ({
  subject,
  source: "claude_oauth_usage",
  observed_at: iso(time),
  freshness: "fresh",
  constraints,
});
const partial = (time: number, extra: Partial<QuotaConstraint> = {}): QuotaSnapshot => ({
  ...full(time),
  source: "claude_rate_limit_event",
  constraints: [constraint({ used_ratio: 1, ...extra })],
});

async function fixture(
  body: (f: {
    registry: () => QuotaRegistry;
    journal: () => DurableJournal;
    now: (offset: number) => void;
    restart: () => Promise<void>;
    blocked: (model?: string, route?: "vendor_native" | "managed_api_key") => boolean;
  }) => Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-window-supersession-")));
  mkdirSync(join(root, "compaction"), { mode: 0o700 });
  let now = START;
  const open = () =>
    new DurableJournal({
      rootDir: root,
      partition: "global",
      fold: journalFoldPolicy,
      compactionThresholdBytes: 0,
      deferCompaction: true,
    });
  let journal = open();
  let registry = new QuotaRegistry(journal, [], () => new Date(now));
  try {
    await body({
      registry: () => registry,
      journal: () => journal,
      now: (offset) => {
        now = START + offset;
      },
      restart: async () => {
        expect(
          await journal.compactInBackground({ stagingDir: join(root, "compaction") }),
        ).toHaveProperty("retainedCount");
        journal.close();
        journal = open();
        registry = new QuotaRegistry(journal, [], () => new Date(now));
      },
      blocked: (model = "opus", route = "vendor_native") => {
        const snapshots = registry.read().snapshots;
        const result =
          profileQuotaBlock(
            snapshots,
            "claude",
            "work",
            route === "vendor_native" ? "local_session" : "api_key",
            model,
            new Date(now),
          ) !== null;
        const budget = new BudgetLedger();
        for (const snapshot of snapshots) budget.observeQuotaSnapshot(snapshot);
        expect(budget.cooldownActive("claude", route, "work", now, model)).toBe(result);
        return result;
      },
    });
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("full reads supersede matching native windows durably", () => {
  it("a real native measured rejection heals on early reset and remains healed after empty inventory, fold and late redelivery", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(1000);
      const events = claudeRateLimitEvents(
        {
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            utilization: 1,
            resetsAt: RESET / 1000,
          },
        },
        "session",
        iso(1000),
      );
      expect(events).toHaveLength(2);
      for (const event of events)
        f.registry().ingest("claude", {
          ...event,
          credential_route: "vendor_native",
          credential_profile_id: "work",
        });
      expect(f.blocked()).toBe(true);
      f.now(2000);
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(false);
      f.now(3000);
      f.registry().upsert(full(3000, []));
      expect(f.blocked()).toBe(false);
      await f.restart();
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
      f.now(26 * 3_600_000);
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
    }));

  it("keeps newer and equal-time partial evidence, then accepts a truly newer recovery and a subsequent new rejection", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(2000);
      f.registry().upsert(partial(2000));
      f.now(3000);
      f.registry().upsert(full(1000));
      expect(f.blocked()).toBe(true);
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(true);
      f.registry().upsert(full(3000));
      expect(f.blocked()).toBe(false);
      f.registry().upsert(partial(3000));
      expect(f.blocked()).toBe(true); // equal timestamps have no proven ordering
      f.now(4000);
      f.registry().upsert(partial(4000, { resets_at: new Date(RESET + 60_000).toISOString() }));
      await f.restart();
      expect(f.blocked()).toBe(true);
      f.registry().upsert(partial(1000));
      expect(
        f
          .registry()
          .read()
          .snapshots.find((s) => s.source === "claude_rate_limit_event")?.observed_at,
      ).toBe(iso(4000));
    }));

  it("retires only the same window, duration, scope, account and credential route", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      const others: QuotaSnapshot[] = [
        partial(0, { id: "seven_day", window_seconds: 604800 }),
        partial(0, { applies_to_models: ["fable"] }),
        partial(0, { window_seconds: 60 }),
        { ...partial(0), subject: { ...subject, credential_route: "managed_api_key" } },
        { ...partial(0), subject: { ...subject, subject_id: "other" } },
      ];
      for (const other of others) f.registry().upsert(other);
      f.now(1000);
      f.registry().upsert(full(1000));
      const remaining = f
        .registry()
        .read()
        .snapshots.filter((s) => s.source === "claude_rate_limit_event");
      expect(remaining).toEqual(others);
      await f.restart();
      expect(
        f
          .registry()
          .read()
          .snapshots.filter((s) => s.source === "claude_rate_limit_event"),
      ).toHaveLength(5);
      expect(f.blocked()).toBe(true);
      expect(f.blocked("fable")).toBe(true);
      expect(f.blocked("opus", "managed_api_key")).toBe(true);
    }));

  it("absence, unknown usage, malformed and stale full reads cannot retire a known measured window", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      f.now(1000);
      f.registry().upsert(full(1000, []));
      expect(f.blocked()).toBe(true);
      f.registry().upsert(full(1000, [constraint({ used_ratio: null })]));
      expect(f.blocked()).toBe(true);
      expect(() =>
        f.registry().upsert({ ...full(1000), constraints: null } as unknown as QuotaSnapshot),
      ).toThrow();
      f.registry().upsert({ ...full(1000), freshness: "stale" });
      expect(f.blocked()).toBe(true);
      f.now(2000);
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(false);
    }));

  it("persists an inverse timestamp-only witness and its cutoff before later inventory replacement", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(2000);
      f.registry().upsert(full(2000));
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
      const history = f.journal().records();
      expect(history.filter((r) => r.type === "quota.window.observed")).toHaveLength(1);
      expect(history.filter((r) => r.type === "quota.window.superseded")).toHaveLength(1);
      expect(
        history.filter((r) => r.type === "quota.snapshot.upserted").at(-1)?.payload,
      ).toMatchObject({ observed_at: iso(2000) });
      f.now(3000);
      f.registry().upsert(full(3000, [constraint({ id: "seven_day", window_seconds: 604800 })]));
      await f.restart();
      f.registry().upsert(partial(1000));
      expect(f.blocked()).toBe(false);
    }));

  it("remove/recreate clears the window cutoff together with that subject's evidence", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      f.now(1000);
      f.registry().upsert(full(1000));
      expect(f.blocked()).toBe(false);
      f.registry().removeSubject("claude", "work");
      await f.restart();
      expect(
        f
          .journal()
          .records()
          .filter((r) => r.type === "quota.window.superseded"),
      ).toEqual([]);
      f.registry().upsert(partial(0));
      expect(f.blocked()).toBe(true);
    }));

  it("writes witness and supersession atomically before changing effective state", async () =>
    fixture(async (f) => {
      f.registry().upsert(full(0));
      f.now(1000);
      f.registry().upsert(partial(1000));
      const append = vi.spyOn(f.journal(), "appendBatch").mockImplementationOnce(() => {
        throw new Error("simulated append failure");
      });
      f.now(2000);
      expect(() => f.registry().upsert(full(2000))).toThrow("simulated append failure");
      expect(f.blocked()).toBe(true);
      expect(
        f
          .journal()
          .records()
          .some((r) => r.type === "quota.window.superseded"),
      ).toBe(false);
      append.mockRestore();
      f.registry().upsert(full(2000));
      expect(f.blocked()).toBe(false);
      const records = f.journal().records();
      const retired = records.find((r) => r.type === "quota.window.superseded")!;
      expect(records.find((r) => r.seq === retired.seq - 1)).toMatchObject({
        type: "quota.snapshot.upserted",
        payload: { observed_at: iso(2000) },
      });
      await f.restart();
      expect(f.blocked()).toBe(false);
    }));

  it("orders observations per window rather than dropping an older sibling window", async () =>
    fixture(async (f) => {
      f.now(2000);
      f.registry().upsert(partial(2000, { used_ratio: 0.2 }));
      f.registry().upsert(partial(1000, { id: "seven_day", window_seconds: 604800 }));
      f.registry().upsert(partial(1000));
      expect(f.registry().read().snapshots).toHaveLength(2);
      expect(
        f
          .registry()
          .read()
          .snapshots.find((s) => s.constraints[0]?.id === "five_hour")?.constraints[0]?.used_ratio,
      ).toBe(0.2);
      expect(f.blocked()).toBe(true);
      await f.restart();
      expect(f.blocked()).toBe(true);
    }));
  it("the first genuinely newer partial remains durable even when its measurement repeats the retired bytes", async () =>
    fixture(async (f) => {
      f.registry().upsert(partial(0));
      f.now(1000);
      f.registry().upsert(full(1000));
      expect(f.blocked()).toBe(false);
      f.now(2000);
      f.registry().upsert(full(2000, []));
      f.now(3000);
      f.registry().upsert(partial(3000));
      expect(f.blocked()).toBe(true);
      const observations = f
        .journal()
        .records()
        .filter((r) => r.type === "quota.window.observed");
      expect(observations).toHaveLength(2);
      expect(observations.at(-1)?.payload).toMatchObject({
        version: 1,
        snapshot: {
          source: "claude_rate_limit_event",
          observed_at: iso(3000),
          constraints: [constraint({ used_ratio: 1 })],
        },
      });
      await f.restart();
      expect(f.blocked()).toBe(true);
      expect(
        f
          .registry()
          .read()
          .snapshots.find((s) => s.source === "claude_rate_limit_event")?.observed_at,
      ).toBe(iso(3000));
    }));
  it.each([0, 300])(
    "matches the recorded Codex notification/full-read window identity (duration minutes=%i)",
    async (durationMins) =>
      fixture(async (f) => {
        // The capture proves the native envelope and codex bucket name. Its zero
        // numbers are sanitized; exhaustion/reset values below are synthetic.
        const recorded = readFileSync(
          new URL(
            "../../harness-codex/fixtures/app-server/recorded-steer-0.156.1.jsonl",
            import.meta.url,
          ),
          "utf8",
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((frame) => frame.method === "account/rateLimits/updated");
        expect(recorded).toBeDefined();
        const params = structuredClone(recorded.params);
        params.rateLimits.primary = {
          usedPercent: 100,
          windowDurationMins: durationMins,
          resetsAt: RESET / 1000,
        };
        const events = codexRateLimitEvents(params, "codex-session");
        expect(events).toHaveLength(1);
        expect(events[0]?.quota?.constraints[0]).toMatchObject({
          id: "codex:primary",
          window_seconds: durationMins === 0 ? null : 18000,
        });
        const native = {
          ...events[0]!,
          ts: iso(0),
          credential_route: "vendor_native",
          credential_profile_id: "work",
        };
        f.registry().ingest("codex", native);
        const blocked = () => {
          const snapshots = f.registry().read().snapshots;
          const routing =
            profileQuotaBlock(
              snapshots,
              "codex",
              "work",
              "local_session",
              "gpt-6-astra",
              new Date(iso(2000)),
            ) !== null;
          const budget = new BudgetLedger();
          for (const snapshot of snapshots) budget.observeQuotaSnapshot(snapshot);
          expect(
            budget.cooldownActive("codex", "vendor_native", "work", START + 2000, "gpt-6-astra"),
          ).toBe(routing);
          return routing;
        };
        expect(blocked()).toBe(true);
        params.rateLimits.primary.usedPercent = 20;
        const [observed] = parseCodexRateLimitsResponse(params, new Date(iso(1000)), "work");
        expect(observed?.constraints[0]).toMatchObject({
          id: "codex:primary",
          window_seconds: durationMins === 0 ? null : 18000,
        });
        f.now(1000);
        f.registry().upsert(observed!);
        expect(blocked()).toBe(false);
        f.now(2000);
        f.registry().upsert(
          parseCodexRateLimitsResponse({ rateLimits: null }, new Date(iso(2000)), "work")[0]!,
        );
        await f.restart();
        f.registry().ingest("codex", native);
        expect(blocked()).toBe(false);
      }),
  );
});
