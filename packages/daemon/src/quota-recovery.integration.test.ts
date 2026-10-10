import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { BudgetLedger } from "../../budget/src/ledger.js";
import { profileQuotaBlock } from "../../orchestrator/src/credential-cooldown.js";
import { journalFoldPolicy } from "./journal-fold-policy.js";
import { QuotaRegistry } from "./quota-registry.js";

const START = Date.parse("2026-10-04T10:00:00Z");
const at = (offset: number) => new Date(START + offset).toISOString();
const subject = {
  harness: "claude",
  credential_route: "vendor_native" as const,
  subject_id: "account",
  plan_label: null,
};
const windowOf = (extra: Partial<QuotaConstraint> = {}): QuotaConstraint => ({
  id: "five_hour",
  label: "5 hour",
  used_ratio: 0.2,
  window_seconds: 18_000,
  resets_at: at(3_600_000),
  cooldown_until: null,
  ...extra,
});
const primary = (time: number, constraints: QuotaConstraint[] = [windowOf()]): QuotaSnapshot => ({
  subject,
  source: "claude_oauth_usage",
  observed_at: at(time),
  freshness: "fresh",
  constraints,
});
const refusal = (
  time: number,
  constraints: QuotaConstraint[] = [
    windowOf({
      id: "cooldown",
      label: "Cooldown",
      used_ratio: null,
      window_seconds: null,
      cooldown_until: at(3_600_000),
    }),
  ],
): QuotaSnapshot => ({
  subject,
  source: "claude_api_retry",
  observed_at: at(time),
  freshness: "fresh",
  constraints,
});

async function fixture(
  body: (state: {
    registry: () => QuotaRegistry;
    journal: () => DurableJournal;
    setTime: (time: number) => void;
    restart: (compact: boolean) => Promise<void>;
    assertBlock: (
      blocked: boolean,
      model?: string,
      route?: "vendor_native" | "managed_api_key",
    ) => void;
  }) => Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-recovery-integration-")));
  const stagingDir = join(root, "staging");
  mkdirSync(stagingDir, { mode: 0o700 });
  let clock = START;
  const open = () =>
    new DurableJournal({
      rootDir: root,
      partition: "global",
      fold: journalFoldPolicy,
      compactionThresholdBytes: 0,
      deferCompaction: true,
    });
  let journal = open();
  let registry = new QuotaRegistry(journal, [], () => new Date(clock));
  try {
    await body({
      registry: () => registry,
      journal: () => journal,
      setTime: (offset) => {
        clock = START + offset;
      },
      restart: async (compact) => {
        if (compact)
          expect(await journal.compactInBackground({ stagingDir })).toHaveProperty("retainedCount");
        journal.close();
        journal = open();
        registry = new QuotaRegistry(journal, [], () => new Date(clock));
      },
      assertBlock: (blocked, model = "opus", route = "vendor_native") => {
        const snapshots = registry.read().snapshots;
        expect(
          profileQuotaBlock(
            snapshots,
            "claude",
            "account",
            route === "vendor_native" ? "local_session" : "api_key",
            model,
            new Date(clock),
          ) !== null,
        ).toBe(blocked);
        // This is the real initialization path into a fresh per-run budget.
        const ledger = new BudgetLedger();
        for (const snapshot of snapshots) ledger.observeQuotaSnapshot(snapshot);
        expect(ledger.cooldownActive("claude", route, "account", clock, model)).toBe(blocked);
      },
    });
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("QuotaRegistry recovery through journal replay, fold and real consumers", () => {
  it.each([false, true])(
    "journals an unchanged primary's newer recovery witness (compact=%s)",
    (compact) =>
      fixture(async (f) => {
        f.registry().upsert(primary(0));
        f.setTime(1000);
        f.registry().upsert(refusal(1000));
        f.assertBlock(true);
        f.setTime(2000);
        f.registry().upsert(primary(2000));
        f.assertBlock(false);
        const primaryRows = f
          .journal()
          .records()
          .filter(
            (row) =>
              row.type === "quota.snapshot.upserted" &&
              (row.payload as QuotaSnapshot).source === "claude_oauth_usage",
          );
        expect((primaryRows.at(-1)!.payload as QuotaSnapshot).observed_at).toBe(at(2000));
        await f.restart(compact);
        f.assertBlock(false);
        const recovered = f
          .registry()
          .read()
          .snapshots.find((item) => item.source === "claude_api_retry");
        expect(recovered?.constraints).toEqual([]);
      }),
  );

  it.each([false, true])(
    "a delayed reactive event cannot return after replay (compact=%s)",
    (compact) =>
      fixture(async (f) => {
        f.registry().upsert(primary(0));
        // This unchanged primary observation initially has no restriction to retire.
        f.setTime(2000);
        f.registry().upsert(primary(2000));
        f.registry().upsert(refusal(1000));
        f.assertBlock(false);
        await f.restart(compact);
        // Redelivery of the same already-superseded event must remain harmless.
        f.registry().upsert(refusal(1000));
        f.assertBlock(false);
      }),
  );

  it("a delayed reactive event remains superseded after the primary display TTL expires", () =>
    fixture(async (f) => {
      f.registry().upsert(primary(0));
      f.setTime(1000);
      f.registry().upsert(refusal(1000));
      f.setTime(2000);
      f.registry().upsert(primary(2000));
      await f.restart(true);
      f.setTime(6 * 60_000);
      expect(
        f
          .registry()
          .read()
          .snapshots.find((item) => item.source === "claude_oauth_usage")?.freshness,
      ).toBe("stale");
      f.registry().upsert(refusal(1500));
      f.assertBlock(false);
    }));

  it("an in-flight primary started before the refusal cannot clear it", () =>
    fixture(async (f) => {
      f.registry().upsert(primary(0));
      f.setTime(2000);
      f.registry().upsert(refusal(2000));
      f.setTime(3000);
      f.registry().upsert(primary(1000));
      f.assertBlock(true);
      await f.restart(true);
      f.assertBlock(true);
    }));

  it.each([{ constraints: [] }, { constraints: [windowOf({ used_ratio: null })] }])(
    "recognized empty/unknown primary evidence clears only the generic refusal ($constraints)",
    ({ constraints }) =>
      fixture(async (f) => {
        f.registry().upsert(refusal(0));
        f.setTime(1000);
        f.registry().upsert(primary(1000, constraints));
        f.assertBlock(false);
        await f.restart(true);
        f.assertBlock(false);
        expect(
          f
            .registry()
            .read()
            .snapshots.find((item) => item.source === "claude_oauth_usage")?.constraints,
        ).toEqual(constraints);
      }),
  );

  it("retains independent model/window and credential-route restrictions", () =>
    fixture(async (f) => {
      const scoped = refusal(0, [
        windowOf({
          id: "cooldown:fable_weekly",
          applies_to_models: ["fable"],
          used_ratio: null,
          cooldown_until: at(3_600_000),
        }),
      ]);
      f.registry().upsert(scoped);
      f.registry().upsert({
        ...refusal(0),
        subject: { ...subject, credential_route: "managed_api_key" },
      });
      f.setTime(1000);
      f.registry().upsert(primary(1000));
      f.assertBlock(false, "opus");
      f.assertBlock(true, "fable");
      f.assertBlock(true, "opus", "managed_api_key");
      await f.restart(true);
      f.assertBlock(false, "opus");
      f.assertBlock(true, "fable");
      f.assertBlock(true, "opus", "managed_api_key");
    }));

  it("a new model-specific limit does not preserve the old generic ban for another model", () =>
    fixture(async (f) => {
      f.registry().upsert(refusal(0));
      f.setTime(1000);
      f.registry().upsert(
        primary(1000, [
          windowOf({ id: "fable_weekly", applies_to_models: ["fable"], used_ratio: 1 }),
        ]),
      );
      f.assertBlock(false, "opus");
      f.assertBlock(true, "fable");
      await f.restart(true);
      f.assertBlock(false, "opus");
      f.assertBlock(true, "fable");
    }));

  it("unknown usage cannot cancel an identified window, while measured replacement can", () =>
    fixture(async (f) => {
      const scoped = windowOf({
        id: "cooldown:fable_weekly",
        applies_to_models: ["fable"],
        used_ratio: null,
        cooldown_until: at(3_600_000),
      });
      f.registry().upsert(refusal(0, [scoped]));
      f.setTime(1000);
      f.registry().upsert(
        primary(1000, [
          windowOf({ id: "fable_weekly", applies_to_models: ["fable"], used_ratio: null }),
        ]),
      );
      f.assertBlock(true, "fable");
      f.setTime(2000);
      f.registry().upsert(
        primary(2000, [
          windowOf({ id: "fable_weekly", applies_to_models: ["fable"], used_ratio: 0.2 }),
        ]),
      );
      f.assertBlock(false, "fable");
      await f.restart(true);
      f.assertBlock(false, "fable");
      f.setTime(3000);
      f.registry().upsert(
        primary(3000, [
          windowOf({ id: "fable_weekly", applies_to_models: ["fable"], used_ratio: 1 }),
        ]),
      );
      f.assertBlock(true, "fable");
      f.assertBlock(false, "opus");
    }));

  it("malformed or explicitly stale primary evidence never retires a generic refusal", () =>
    fixture(async (f) => {
      f.registry().upsert(refusal(0));
      f.setTime(1000);
      expect(() =>
        f.registry().upsert({ ...primary(1000), constraints: null } as unknown as QuotaSnapshot),
      ).toThrow();
      f.assertBlock(true);
      f.registry().upsert({ ...primary(1000), freshness: "stale" });
      f.assertBlock(true);
      await f.restart(true);
      f.assertBlock(true);
      f.setTime(2000);
      f.registry().upsert(primary(2000));
      f.assertBlock(false);
    }));
});
