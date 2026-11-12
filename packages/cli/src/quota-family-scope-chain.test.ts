/**
 * #394 through the real producers and admission readers: a known Claude quota
 * family reaches a future full id of that family through its declared prefix,
 * never another family, an unresolved `best` or a bare default run. Unknown
 * scopes stay diagnostic instead of becoming account-wide restrictions, while
 * genuine global windows keep blocking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, QuotaSnapshot } from "@claudexor/schema";
import { BudgetLedger, observationsFromEvent } from "../../budget/src/index.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { memoryEventLedger } from "./test-support/memory-event-ledger.js";
import { profileQuotaBlock } from "../../orchestrator/src/credential-cooldown.js";
import { profileHeadroomBreach } from "../../orchestrator/src/credential-profile-rotation.js";
import { parseClaudeOauthUsage } from "./claude-oauth-codec.js";
import { parseAgyQuotaEnvelope } from "./agy-quota-source.js";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const RESET_S = Math.floor(NOW / 1000) + 3 * 86400;
const RESET_ISO = new Date(RESET_S * 1000).toISOString();

/** Real Claude stream parser, stamped like the run loop stamps a profiled event. */
function streamEvents(info: Record<string, unknown>): HarnessEvent[] {
  const parse = createClaudeParser();
  const events = parse(
    { type: "rate_limit_event", rate_limit_info: info },
    "s-1",
  ) as HarnessEvent[];
  return events.map((event) => ({
    ...event,
    ts: new Date(NOW).toISOString(),
    credential_route: "vendor_native",
    credential_profile_id: "work",
  }));
}

const MODELS = {
  futureOpus: "claude-opus-5-5",
  otherFamily: "claude-sonnet-5",
  best: "best",
} as const;

function blocks(snapshots: readonly QuotaSnapshot[], model: string | null): boolean {
  return (
    profileQuotaBlock(snapshots, "claude", "work", "local_session", model, new Date(NOW)) !== null
  );
}

describe("#394 Claude family scope through producers, registry and admission", () => {
  // One controlled decision clock for every reader (#457 judges windows then).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("binds a measured and a rejected Opus window to a future Opus id only", () => {
    const registry = new QuotaRegistry(
      memoryEventLedger(new Date(NOW).toISOString()),
      [],
      () => new Date(NOW),
    );
    const ledger = new BudgetLedger();
    const events = streamEvents({
      status: "rejected",
      rateLimitType: "seven_day_opus",
      resetsAt: RESET_S,
      unifiedWindows: {
        seven_day_opus: { utilization: 1, resetsAt: RESET_S },
        five_hour: { utilization: 0.1, resetsAt: RESET_S },
      },
    });
    expect(events.some((event) => event.rate_limit)).toBe(true);
    for (const event of events) {
      registry.ingest("claude", event);
      for (const observation of observationsFromEvent("claude", event))
        ledger.observe({ ...observation, subject_id: "work", credential_route: "vendor_native" });
    }
    const snapshots = registry.read().snapshots;
    for (const snapshot of snapshots) ledger.observeQuotaSnapshot(snapshot);

    const ledgerBlocks = (model: string | null) =>
      ledger.cooldownActive("claude", "vendor_native", "work", NOW, model);
    expect(blocks(snapshots, MODELS.futureOpus)).toBe(true);
    expect(ledgerBlocks(MODELS.futureOpus)).toBe(true);
    // Negative controls: another family, unresolved `best`, the bare default.
    for (const model of [MODELS.otherFamily, MODELS.best, null]) {
      expect(blocks(snapshots, model)).toBe(false);
      expect(ledgerBlocks(model)).toBe(false);
    }
    // The same scope is what profile headroom reads.
    expect(
      profileHeadroomBreach(snapshots, "claude", "work", 0.9, MODELS.futureOpus)?.constraint_id,
    ).toBe("seven_day_opus");
    expect(profileHeadroomBreach(snapshots, "claude", "work", 0.9, MODELS.best)).toBeNull();
  });

  it("binds an OAuth weekly_scoped family and keeps a genuine global window binding", () => {
    const snapshot = parseClaudeOauthUsage(
      {
        five_hour: { utilization: 10, resets_at: RESET_ISO },
        seven_day: { utilization: 20, resets_at: RESET_ISO },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 100,
            resets_at: RESET_ISO,
            scope: { model: { display_name: "Opus" } },
          },
        ],
      },
      "work",
      null,
      new Date(NOW),
    )!;
    const ledger = new BudgetLedger();
    ledger.observeQuotaSnapshot(snapshot);
    const ledgerBlocks = (model: string | null) =>
      ledger.cooldownActive("claude", "vendor_native", "work", NOW, model);
    expect(ledgerBlocks(MODELS.futureOpus)).toBe(true);
    expect(blocks([snapshot], MODELS.futureOpus)).toBe(true);
    for (const model of [MODELS.otherFamily, MODELS.best, null]) {
      expect(ledgerBlocks(model)).toBe(false);
      expect(blocks([snapshot], model)).toBe(false);
    }

    const global = parseClaudeOauthUsage(
      { five_hour: { utilization: 100, resets_at: RESET_ISO } },
      "work",
      null,
      new Date(NOW),
    )!;
    const globalLedger = new BudgetLedger();
    globalLedger.observeQuotaSnapshot(global);
    for (const model of [MODELS.futureOpus, MODELS.otherFamily, MODELS.best, null]) {
      expect(globalLedger.cooldownActive("claude", "vendor_native", "work", NOW, model)).toBe(true);
      expect(blocks([global], model)).toBe(true);
    }
  });

  it("keeps an unnamed OAuth weekly_scoped window diagnostic, not account-wide", () => {
    const unknown: Array<{ id: string; used_ratio: number | null }> = [];
    const snapshot = parseClaudeOauthUsage(
      {
        five_hour: { utilization: 10, resets_at: RESET_ISO },
        limits: [{ kind: "weekly_scoped", percent: 100, resets_at: RESET_ISO, scope: {} }],
      },
      "work",
      null,
      new Date(NOW),
      (window) => unknown.push(window),
    )!;
    expect(snapshot.constraints.map((constraint) => constraint.id)).toEqual(["five_hour"]);
    expect(unknown).toEqual([
      expect.objectContaining({ id: "weekly_scoped:scoped", used_ratio: 1, resets_at: RESET_ISO }),
    ]);
    const ledger = new BudgetLedger();
    ledger.observeQuotaSnapshot(snapshot);
    for (const model of [MODELS.futureOpus, MODELS.otherFamily, null]) {
      expect(ledger.cooldownActive("claude", "vendor_native", "work", NOW, model)).toBe(false);
      expect(blocks([snapshot], model)).toBe(false);
    }
    // The unknown window adds no breach of its own; the genuine global window still does.
    expect(profileHeadroomBreach([snapshot], "claude", "work", 0.5, MODELS.otherFamily)).toBeNull();
    expect(profileHeadroomBreach([snapshot], "claude", "work", 0.05, MODELS.otherFamily)).toEqual(
      expect.objectContaining({ constraint_id: "five_hour" }),
    );
  });

  it("keeps an unknown AGY group diagnostic while known groups and their prefixes bind", () => {
    const parsed = parseAgyQuotaEnvelope(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    window: "weekly",
                    remaining_fraction: 0,
                    reset_time: RESET_ISO,
                  },
                ],
              },
              {
                name: "Mystery Models",
                buckets: [
                  {
                    id: "mystery-weekly",
                    window: "weekly",
                    remaining_fraction: 0,
                    reset_time: RESET_ISO,
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(parsed.kind).toBe("constraints");
    if (parsed.kind !== "constraints") return;
    expect(parsed.constraints.map((constraint) => constraint.id)).toEqual(["gemini-weekly"]);
    expect(parsed.unknownScopes).toEqual([
      expect.objectContaining({ id: "mystery-weekly", group: "Mystery Models", used_ratio: 1 }),
    ]);
    const snapshot: QuotaSnapshot = {
      subject: {
        harness: "agy",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: parsed.constraints,
      source: "agy_command_usage",
      observed_at: new Date(NOW).toISOString(),
      freshness: "fresh",
    };
    const agyBlocks = (model: string) =>
      profileQuotaBlock([snapshot], "agy", "a", "local_session", model, new Date(NOW)) !== null;
    expect(agyBlocks("gemini-9-pro")).toBe(true);
    expect(agyBlocks("claude-sonnet-5")).toBe(false);
    expect(agyBlocks("mystery-1")).toBe(false);
  });
});
