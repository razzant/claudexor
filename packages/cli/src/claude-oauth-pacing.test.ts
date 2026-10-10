import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaSubject } from "@claudexor/schema";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { quotaPacerFileStore } from "../../daemon/src/quota-poll-pacer.js";
import { accountsMigrationFilePath } from "./accounts-unified-migration.js";
import { forgetClaudeOauthRejections, refreshClaudeOauthUsageQuota } from "./claude-oauth-usage.js";

const usage = { five_hour: { utilization: 20, resets_at: null } };
const subjectOf = (id: string): QuotaSubject => ({
  harness: "claude",
  credential_route: "vendor_native",
  subject_id: id,
  plan_label: null,
});
const credential = (token: string) => ({
  accessToken: token,
  subscriptionType: "max",
  expiresAtMs: null,
  hasRefreshToken: false,
});
afterEach(() => {
  vi.unstubAllGlobals();
  forgetClaudeOauthRejections();
});

describe("Claude production HTTP classifier", () => {
  it.each([
    [401, "auth_revoked", 1],
    [403, "refresh_failed", 2],
    [429, "rate_limited", 2],
    [500, "refresh_failed", 2],
  ] as const)(
    "HTTP %s has reason %s without inventing credential-rejection memory",
    async (status, reason, calls) => {
      const fetcher = vi.fn(
        async () =>
          new Response('{"error":{"type":"permission_error"}}', {
            status,
            headers: { "retry-after": "120" },
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const deps = { readCredential: async () => credential("fake-http-token") };
      const first = await refreshClaudeOauthUsageQuota(deps);
      expect(first.absences?.[0]?.reason).toBe(reason);
      expect(first.absences?.[0]?.retry_after_ms).toBe(status === 429 ? 120_000 : undefined);
      await refreshClaudeOauthUsageQuota(deps);
      expect(fetcher).toHaveBeenCalledTimes(calls);
    },
  );
  it.each(["transport", "malformed"])("%s failure stays recoverable", async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === "transport") throw new TypeError("network failed");
      return new Response("{", { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const deps = { readCredential: async () => credential("fake-http-token") };
    expect((await refreshClaudeOauthUsageQuota(deps)).absences?.[0]?.reason).toBe("refresh_failed");
    fetcher.mockImplementation(async () => new Response(JSON.stringify(usage), { status: 200 }));
    expect((await refreshClaudeOauthUsageQuota(deps)).snapshots).toHaveLength(1);
  });
});

describe("Claude subject poll pacing through the source and registry", () => {
  it("continues A200/B429/C200; aliases share the floor across refresh, restart and reorder", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-subject-pacing-")));
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    try {
      mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
      writeFileSync(
        accountsMigrationFilePath(),
        JSON.stringify({
          claude: {
            phase: "completed",
            row_id: "A",
            legacy_aliases: [null],
            locator: join(dir, "A"),
            backup_ref: null,
          },
        }),
      );
      let ids = ["A", "B", "C", "alias"];
      const config = () =>
        updateGlobalConfig((current) => ({
          ...current,
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
      config();
      let nowMs = Date.parse("2026-10-04T10:00:00Z");
      const calls: string[] = [];
      const source = {
        vendor: "claude",
        refresh: (cycle?: Parameters<typeof refreshClaudeOauthUsageQuota>[1]) =>
          refreshClaudeOauthUsageQuota(
            {
              readCredential: async (path) =>
                credential(path.endsWith("/alias") ? "B" : path.split("/").at(-1)!),
              fetchUsage: async (token) => {
                calls.push(token);
                if (token === "B")
                  throw Object.assign(new Error("oauth/usage responded 429"), {
                    quotaAbsenceReason: "rate_limited",
                    retryAfterMs: 30 * 60_000,
                  });
                return usage;
              },
              now: () => new Date(nowMs),
            },
            cycle,
          ),
      };
      const createRegistry = () =>
        new QuotaRegistry(
          journal,
          [source],
          () => new Date(nowMs),
          () => ids.map(subjectOf),
          quotaPacerFileStore(dir),
        );
      let registry = createRegistry();
      const first = await registry.refresh();
      expect(calls).toEqual(["A", "B", "C"]);
      expect(first.snapshots.map((item) => item.subject.subject_id)).toEqual(["A", "C"]);
      expect(first.absences.map((item) => [item.subject.subject_id, item.reason])).toEqual([
        ["B", "rate_limited"],
        ["alias", "poll_paced"],
      ]);
      expect(first.refresh_skipped?.map((item) => item.subject?.subject_id)).toEqual(["alias"]);
      nowMs += 60_000;
      await expect(registry.pollStale()).resolves.toBe(false);
      expect(calls).toHaveLength(3);
      const next = await registry.refresh();
      expect(calls).toEqual(["A", "B", "C", "A", "C"]);
      expect(next.refresh_skipped?.map((item) => item.subject?.subject_id)).toEqual(["B", "alias"]);
      // Restart and reorder place the alias before the original 429 row.
      ids = ["alias", "A", "C", "B"];
      config();
      registry = createRegistry();
      registry.noteCredentialChange();
      await registry.refresh();
      expect(calls.slice(-2)).toEqual(["A", "C"]);
      expect(calls.filter((token) => token === "B")).toHaveLength(1);
      const saved = readFileSync(join(dir, "quota-pacer-state.json"), "utf8");
      expect(saved).not.toContain("sha256:");
      expect(JSON.parse(saved).vendors).toEqual({});
      nowMs += 29 * 60_000;
      await registry.refresh();
      expect(calls.filter((token) => token === "B")).toHaveLength(2);
      expect(
        journal
          .records()
          .filter((record) => record.type === "quota.snapshot.upserted")
          .every((record) => !JSON.stringify(record.payload).includes("rate_limited")),
      ).toBe(true);
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains a version-1 whole-vendor floor only until its recorded deadline", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-legacy-pacing-")));
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    let nowMs = Date.parse("2026-10-04T10:00:00Z");
    const until = nowMs + 3_600_000;
    writeFileSync(
      join(dir, "quota-pacer-state.json"),
      JSON.stringify({
        version: 1,
        vendors: { claude: { not_before: new Date(until).toISOString() } },
      }),
    );
    const refresh = vi.fn(async () => ({ snapshots: [], absences: [] }));
    try {
      const registry = new QuotaRegistry(
        journal,
        [{ vendor: "claude", refresh }],
        () => new Date(nowMs),
        () => [subjectOf("A"), subjectOf("B")],
        quotaPacerFileStore(dir),
      );
      expect((await registry.refresh()).refresh_skipped).toEqual([
        { vendor: "claude", not_before: new Date(until).toISOString() },
      ]);
      expect(refresh).not.toHaveBeenCalled();
      registry.noteCredentialChange();
      await registry.refresh();
      expect(refresh).not.toHaveBeenCalled();
      nowMs = until;
      await registry.refresh();
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
