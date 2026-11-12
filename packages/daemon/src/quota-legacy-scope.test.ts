/**
 * #394 compatibility: windows an older engine journaled with the retired Claude
 * alias list (`opus`, enumerated full ids and `best`), an account-wide unnamed
 * OAuth weekly_scoped row, or an account-wide unknown AGY group are restored in
 * the current representation, so a stale restriction neither keeps refusing
 * `best`/other models nor survives a newer observation of the same window.
 * Unrelated windows, routes, subjects, request kinds and sources are untouched.
 */
import { describe, expect, it } from "vitest";
import { hashJson } from "@claudexor/util";
import type { QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { quotaSnapshotAvailability } from "@claudexor/schema";
import { QuotaRegistry } from "./quota-registry.js";
import { legacyV320Snapshot } from "./quota-registry-support.js";
import { quotaSubjectIdentity, remainingQuotaRefreshDemand } from "./quota-refresh-demand.js";
import type { EventLedger } from "./store-contracts.js";

const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const RESET = new Date(T0 + 5 * 86400_000).toISOString();
const LEGACY_OPUS = [
  "opus",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "best",
];

function memoryLedger(): EventLedger {
  const rows: Array<{ seq: number; type: string; payload: unknown }> = [];
  const event = (type: string, payload: unknown) => {
    const row = { seq: rows.length + 1, type, payload };
    rows.push(row);
    return { ...row, partition: "global", epoch: 1, ts: new Date(T0).toISOString() } as never;
  };
  return {
    append: (type, payload) => event(type, payload),
    appendBatch: (entries) => entries.map((entry) => event(entry.type, entry.payload)),
    records: (afterSeq, types) =>
      rows
        .filter((row) => row.seq > afterSeq && types.includes(row.type))
        .map((row) => ({ ...row, partition: "global", epoch: 1 }) as never),
    cursorFor: (record) => `global:${record.seq}`,
  };
}

function window(
  constraint: Partial<QuotaConstraint> & { id: string },
  overrides: Partial<QuotaSnapshot> = {},
): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: "work",
    },
    source: "claude_rate_limit_event",
    observed_at: new Date(T0).toISOString(),
    freshness: "fresh",
    ...overrides,
    constraints: [
      {
        label: constraint.id,
        used_ratio: 1,
        window_seconds: 7 * 86400,
        resets_at: RESET,
        cooldown_until: null,
        ...constraint,
      },
    ],
  };
}

/** Journal records exactly as an older engine wrote them (no normalization). */
function journalOld(journal: EventLedger, snapshot: QuotaSnapshot): void {
  if (snapshot.source === "claude_rate_limit_event") {
    journal.append("quota.window.observed", { version: 1, snapshot });
    return;
  }
  const base = legacyV320Snapshot(snapshot);
  journal.append("quota.snapshot.scoped_prepared", {
    version: 1,
    base_hash: hashJson(base),
    snapshot,
  });
  journal.append("quota.snapshot.upserted", base);
}

const blocked = (snapshots: readonly QuotaSnapshot[], subject: string, model: string | null) =>
  snapshots
    .filter((snapshot) => snapshot.subject.subject_id === subject)
    .some(
      (snapshot) =>
        quotaSnapshotAvailability(snapshot, { now: new Date(T0 + 60_000), model }).state !==
        "available",
    );

describe("legacy quota scope restore (#394 compatibility)", () => {
  it("restores an old Opus alias window in the family representation and lets a newer observation replace it", () => {
    const journal = memoryLedger();
    journalOld(journal, window({ id: "seven_day_opus", applies_to_models: LEGACY_OPUS }));
    // Unrelated: a global window and another subject's identical old window.
    journalOld(journal, window({ id: "five_hour", used_ratio: 0.2, window_seconds: 18_000 }));
    journalOld(
      journal,
      window(
        { id: "seven_day_opus", applies_to_models: LEGACY_OPUS },
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "other",
          },
        },
      ),
    );
    let now = T0 + 60_000;
    const registry = new QuotaRegistry(journal, [], () => new Date(now));
    const restored = registry.read().snapshots;
    const opus = restored.find(
      (snapshot) =>
        snapshot.subject.subject_id === "work" && snapshot.constraints[0]?.id === "seven_day_opus",
    )!;
    expect(opus.constraints[0]).toMatchObject({
      applies_to_models: ["opus"],
      applies_to_model_prefixes: ["claude-opus-"],
      used_ratio: 1,
      resets_at: RESET,
    });
    expect(blocked(restored, "work", "claude-opus-5-5")).toBe(true);
    expect(blocked(restored, "work", "best")).toBe(false);
    expect(blocked(restored, "work", "claude-sonnet-5")).toBe(false);

    // A newer observation of the same window, in the current representation,
    // replaces the restored one in place (an early or purchased reset).
    now = T0 + 120_000;
    registry.upsert(
      window(
        {
          id: "seven_day_opus",
          used_ratio: 0.3,
          applies_to_models: ["opus"],
          applies_to_model_prefixes: ["claude-opus-"],
        },
        { observed_at: new Date(T0 + 90_000).toISOString() },
      ),
    );
    const after = registry.read().snapshots;
    const work = after.filter((snapshot) => snapshot.subject.subject_id === "work");
    expect(
      work.filter((snapshot) => snapshot.constraints[0]?.id === "seven_day_opus"),
    ).toHaveLength(1);
    expect(blocked(after, "work", "claude-opus-5-5")).toBe(false);
    // The other subject's restriction and the global window are untouched.
    expect(blocked(after, "other", "claude-opus-5-5")).toBe(true);
    expect(
      work.find((snapshot) => snapshot.constraints[0]?.id === "five_hour")?.constraints[0],
    ).toMatchObject({
      used_ratio: 0.2,
    });

    // Restart: the old record replays first, the newer one wins.
    const replayed = new QuotaRegistry(journal, [], () => new Date(now)).read().snapshots;
    expect(blocked(replayed, "work", "claude-opus-5-5")).toBe(false);
    expect(blocked(replayed, "other", "claude-opus-5-5")).toBe(true);
    expect(blocked(replayed, "other", "best")).toBe(false);
  });

  it("restores an old reactive Opus cooldown in the family representation, preserving its timing", () => {
    const journal = memoryLedger();
    journalOld(
      journal,
      window(
        {
          id: "cooldown:seven_day_opus",
          label: "Cooldown",
          applies_to_models: LEGACY_OPUS,
          used_ratio: null,
          window_seconds: null,
          cooldown_until: RESET,
        },
        { source: "claude_api_retry" },
      ),
    );
    const restored = new QuotaRegistry(journal, [], () => new Date(T0 + 60_000)).read().snapshots;
    expect(restored[0]?.constraints[0]).toMatchObject({
      applies_to_models: ["opus"],
      applies_to_model_prefixes: ["claude-opus-"],
      cooldown_until: RESET,
    });
    expect(blocked(restored, "work", "claude-opus-5-5")).toBe(true);
    expect(blocked(restored, "work", "best")).toBe(false);
    expect(blocked(restored, "work", "claude-sonnet-5")).toBe(false);
  });

  it("drops only source-proven unknown scopes: unnamed OAuth weekly_scoped and unknown AGY groups", () => {
    const journal = memoryLedger();
    const oauth: QuotaSnapshot = {
      ...window(
        { id: "five_hour", used_ratio: 0.1, window_seconds: 18_000 },
        { source: "claude_oauth_usage" },
      ),
    };
    oauth.constraints.push({
      id: "weekly_scoped:scoped",
      label: "7 day (scoped)",
      used_ratio: 1,
      window_seconds: 7 * 86400,
      resets_at: RESET,
      cooldown_until: null,
    });
    journalOld(journal, oauth);
    const agy: QuotaSnapshot = {
      subject: {
        harness: "agy",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      source: "agy_command_usage",
      observed_at: new Date(T0).toISOString(),
      freshness: "fresh",
      constraints: [
        {
          id: "gemini-weekly",
          label: "Weekly",
          applies_to_models: ["gemini-3.1-pro-high"],
          applies_to_model_prefixes: ["gemini-"],
          used_ratio: 1,
          window_seconds: 7 * 86400,
          resets_at: RESET,
          cooldown_until: null,
        },
        {
          id: "mystery-weekly",
          label: "Weekly",
          applies_to_models: null,
          used_ratio: 1,
          window_seconds: 7 * 86400,
          resets_at: RESET,
          cooldown_until: null,
        },
      ],
    };
    journalOld(journal, agy);
    // Control: a Codex full read without model scope is genuinely global.
    journalOld(journal, {
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "c",
      },
      source: "codex_app_server",
      observed_at: new Date(T0).toISOString(),
      freshness: "fresh",
      constraints: [
        {
          id: "codex:primary",
          label: "primary",
          applies_to_request_kinds: ["text"],
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: RESET,
          cooldown_until: null,
        },
      ],
    });
    const restored = new QuotaRegistry(journal, [], () => new Date(T0 + 60_000)).read().snapshots;
    const ids = (harness: string) =>
      restored
        .filter((s) => s.subject.harness === harness)
        .flatMap((s) => s.constraints.map((c) => c.id));
    expect(ids("claude")).toEqual(["five_hour"]);
    expect(ids("agy")).toEqual(["gemini-weekly"]);
    expect(ids("codex")).toEqual(["codex:primary"]);
    expect(blocked(restored, "work", "claude-sonnet-5")).toBe(false);
    expect(blocked(restored, "a", "claude-sonnet-5")).toBe(false);
    expect(blocked(restored, "a", "gemini-9-pro")).toBe(true);
    expect(blocked(restored, "c", "gpt-6")).toBe(true);
  });

  /** One full AGY reading of profile `a` as an older engine journaled it. */
  const agyRead = (observedMs: number, constraints: QuotaConstraint[]): QuotaSnapshot => ({
    subject: {
      harness: "agy",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: "a",
    },
    source: "agy_command_usage",
    observed_at: new Date(observedMs).toISOString(),
    freshness: "fresh",
    constraints,
  });
  const weekly = (id: string, scope: Partial<QuotaConstraint>): QuotaConstraint => ({
    id,
    label: "Weekly",
    used_ratio: 1,
    window_seconds: 7 * 86400,
    resets_at: RESET,
    cooldown_until: null,
    ...scope,
  });
  const knownGemini = weekly("gemini-weekly", {
    applies_to_models: ["gemini-3.1-pro-high"],
    applies_to_model_prefixes: ["gemini-"],
  });
  const unknownGroup = weekly("mystery-weekly", { applies_to_models: null });
  const agySubject = agyRead(T0, []).subject;

  it("an old reading left with no known window reads unknown, still replaces older records and leaves refresh due", () => {
    const journal = memoryLedger();
    // An older reading with a known spent window, then the newer reading that
    // carried only an unrecognized group.
    journalOld(journal, agyRead(T0 - 10 * 60_000, [knownGemini]));
    journalOld(journal, agyRead(T0, [unknownGroup]));
    // An OAuth reading whose only window was an unnamed weekly_scoped limit.
    journalOld(journal, {
      ...window({ id: "weekly_scoped:scoped" }, { source: "claude_oauth_usage" }),
    });
    // Restart inside the newest observation's five-minute TTL.
    const registry = new QuotaRegistry(journal, [], () => new Date(T0 + 60_000));
    const restored = registry.read().snapshots;
    const agy = restored.filter((s) => s.subject.harness === "agy");
    const oauth = restored.filter((s) => s.source === "claude_oauth_usage");
    // The newer record still supersedes the older one: no revived Gemini limit.
    expect(agy).toHaveLength(1);
    expect(agy[0]).toMatchObject({ observed_at: new Date(T0).toISOString(), constraints: [] });
    expect(blocked(restored, "a", "gemini-9-pro")).toBe(false);
    // Neither emptied reading is a fresh limit-free observation.
    expect(agy[0]?.freshness).toBe("unknown");
    expect(oauth.map((s) => [s.freshness, s.constraints.length])).toEqual([["unknown", 0]]);
    expect(
      registry.readConstraintFreshness().snapshots.find((s) => s.subject.harness === "agy")
        ?.freshness,
    ).toBe("unknown");
    expect(
      registry.readAdmission().snapshots.find((s) => s.subject.harness === "agy")?.freshness,
    ).toBe("unknown");
    // So the background poll still owes this account a reading.
    expect(
      remainingQuotaRefreshDemand(restored, [agySubject, oauth[0]!.subject], T0 + 60_000),
    ).toEqual(new Set([agySubject, oauth[0]!.subject].map(quotaSubjectIdentity)));
    // Routing stays permissive: unknown never blocks.
    expect(blocked(restored, "a", "claude-sonnet-5")).toBe(false);
    expect(blocked(restored, "work", "claude-opus-5")).toBe(false);
    // A newer live reading replaces the unknown record as usual.
    registry.upsert(agyRead(T0 + 2 * 60_000, [knownGemini]));
    const live = registry.read().snapshots.find((s) => s.subject.harness === "agy");
    expect(live).toMatchObject({ freshness: "fresh", constraints: [{ id: "gemini-weekly" }] });
    expect(
      remainingQuotaRefreshDemand(registry.read().snapshots, [agySubject], T0 + 60_000).size,
    ).toBe(0);
  });

  it("an old reading with a known window keeps it fresh beside the dropped unknown group", () => {
    const journal = memoryLedger();
    journalOld(journal, agyRead(T0, [knownGemini, unknownGroup]));
    const restored = new QuotaRegistry(journal, [], () => new Date(T0 + 60_000)).read().snapshots;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      freshness: "fresh",
      constraints: [{ id: "gemini-weekly" }],
    });
    expect(remainingQuotaRefreshDemand(restored, [agySubject], T0 + 60_000).size).toBe(0);
    expect(blocked(restored, "a", "gemini-9-pro")).toBe(true);
  });
});
