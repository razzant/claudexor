import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaSubject } from "@claudexor/schema";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { accountsMigrationFilePath } from "./accounts-unified-migration.js";
import { forgetClaudeOauthRejections, refreshClaudeOauthUsageQuota } from "./claude-oauth-usage.js";

const START = Date.parse("2026-10-04T10:00:00Z");
const subjectOf = (id: string): QuotaSubject => ({
  harness: "claude",
  credential_route: "vendor_native",
  subject_id: id,
  plan_label: null,
});

async function fixture(
  initialIds: string[],
  body: (f: {
    registry: QuotaRegistry;
    calls: Array<{ id: string; tick: number }>;
    tick: (value: number) => void;
    configure: (ids: string[]) => void;
    holdLimited: (promise: Promise<void>) => void;
    resetAt: (tick: number | null) => void;
  }) => Promise<void>,
): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-quota-cadence-")));
  const previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = dir;
  const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
  try {
    mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
    writeFileSync(
      accountsMigrationFilePath(),
      JSON.stringify({
        claude: {
          phase: "completed",
          row_id: "healthy",
          legacy_aliases: [null],
          locator: join(dir, "healthy"),
          backup_ref: null,
        },
      }),
    );
    let ids = initialIds;
    const configure = (next: string[]) => {
      ids = next;
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: ids.map((id) => ({
          profile_id: id,
          harness_id: "claude",
          display_name: id,
          credential_kind: "config_dir_login",
          isolation_locator: join(dir, id),
          secret_ref: null,
          enabled: true,
          created_at: null,
        })),
      }));
    };
    configure(ids);
    let tick = 0;
    let nextReset: number | null = null;
    let hold = Promise.resolve();
    const calls: Array<{ id: string; tick: number }> = [];
    const registry = new QuotaRegistry(
      journal,
      [
        {
          vendor: "claude",
          refresh: (cycle) =>
            refreshClaudeOauthUsageQuota(
              {
                readCredential: async (path) => ({
                  accessToken: path.endsWith("/alias") ? "limited" : path.split("/").at(-1)!,
                  subscriptionType: "max",
                  expiresAtMs: null,
                  hasRefreshToken: false,
                }),
                fetchUsage: async (id) => {
                  calls.push({ id, tick });
                  if (id === "limited") {
                    await hold;
                    throw Object.assign(new Error("oauth/usage responded429"), {
                      quotaAbsenceReason: "rate_limited",
                      retryAfterMs: null,
                    });
                  }
                  return {
                    five_hour: {
                      utilization: 20,
                      resets_at:
                        nextReset === null
                          ? null
                          : new Date(START + nextReset * 60_000).toISOString(),
                    },
                  };
                },
                now: () => new Date(START + tick * 60_000),
                platform: "linux",
              },
              cycle,
            ),
        },
      ],
      () => new Date(START + tick * 60_000),
      () => ids.map(subjectOf),
    );
    await body({
      registry,
      calls,
      tick: (value) => {
        tick = value;
      },
      configure,
      holdLimited: (promise) => {
        hold = promise;
      },
      resetAt: (value) => {
        nextReset = value;
      },
    });
  } finally {
    journal.close();
    forgetClaudeOauthRejections();
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Claude source per-subject background demand", () => {
  it("headerless429 does not increase healthy HTTP frequency or refresh skipped evidence timestamps", async () => {
    const cadence = async (ids: string[]) => {
      const healthy: number[] = [];
      await fixture(ids, async ({ registry, calls, tick }) => {
        for (let minute = 0; minute < 50; minute += 1) {
          tick(minute);
          await registry.pollStale();
          const snapshot = registry
            .read()
            .snapshots.find((item) => item.subject.subject_id === "healthy");
          expect(snapshot?.freshness, `tick${minute}`).toBe("fresh");
          if (minute === 1) expect(snapshot?.observed_at).toBe(new Date(START).toISOString());
        }
        healthy.push(...calls.filter((call) => call.id === "healthy").map((call) => call.tick));
        if (ids.length > 1)
          expect(calls.filter((call) => call.id === "limited").map((call) => call.tick)).toEqual([
            0, 1, 3, 7, 15, 30, 45,
          ]);
      });
      return healthy;
    };
    const control = await cadence(["healthy"]);
    expect(control).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48]);
    expect(await cadence(["healthy", "limited", "alias"])).toEqual(control);
  });

  it("foreground joining a limited-account poll still re-probes healthy evidence while respecting the renewed floor", async () => {
    await fixture(
      ["healthy", "limited", "alias"],
      async ({ registry, calls, tick, holdLimited }) => {
        await registry.pollStale();
        tick(1);
        let release!: () => void;
        holdLimited(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        const background = registry.pollStale();
        for (
          let turn = 0;
          turn < 30 && calls.filter((call) => call.id === "limited").length < 2;
          turn += 1
        )
          await new Promise<void>((resolve) => setImmediate(resolve));
        expect(calls.filter((call) => call.id === "limited")).toHaveLength(2);
        expect(calls.filter((call) => call.id === "healthy")).toHaveLength(1);
        const foreground = registry.refresh();
        release();
        await background;
        const response = await foreground;
        expect(calls.filter((call) => call.id === "healthy").map((call) => call.tick)).toEqual([
          0, 1,
        ]);
        expect(calls.filter((call) => call.id === "limited")).toHaveLength(2);
        expect(response.refresh_skipped?.map((row) => row.subject?.subject_id)).toEqual([
          "limited",
          "alias",
        ]);
      },
    );
  });

  it("new account demand leaves fresh siblings alone and binds newly discovered token aliases before probing", async () => {
    await fixture(["healthy", "limited"], async ({ registry, calls, tick, configure }) => {
      await registry.pollStale();
      tick(1);
      await registry.pollStale();
      tick(2);
      configure(["alias", "healthy", "limited", "new"]);
      registry.noteCredentialChange();
      await registry.pollStale();
      expect(calls.filter((call) => call.id === "healthy")).toHaveLength(1);
      expect(calls.filter((call) => call.id === "limited")).toHaveLength(2);
      expect(calls.filter((call) => call.id === "new").map((call) => call.tick)).toEqual([2]);
      expect(
        registry.read().absences.find((row) => row.subject.subject_id === "alias")?.reason,
      ).toBe("poll_paced");
    });
  });

  it("renews a healthy subject at its vendor reset despite skipping it during sibling retries", async () => {
    await fixture(["healthy", "limited"], async ({ registry, calls, tick, resetAt }) => {
      resetAt(2);
      await registry.pollStale();
      tick(1);
      await registry.pollStale();
      tick(2);
      resetAt(20);
      await registry.pollStale();
      expect(calls.filter((call) => call.id === "healthy").map((call) => call.tick)).toEqual([
        0, 1, 2,
      ]);
      expect(
        registry.read().snapshots.find((item) => item.subject.subject_id === "healthy")?.freshness,
      ).toBe("fresh");
    });
  });
});
