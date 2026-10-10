import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import type { QuotaSubject } from "@claudexor/schema";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { quotaPacerFileStore } from "../../daemon/src/quota-poll-pacer.js";
import { accountsMigrationFilePath } from "./accounts-unified-migration.js";
import {
  forgetClaudeOauthRejections,
  refreshClaudeOauthUsageQuota,
  type ClaudeOauthUsageDeps,
} from "./claude-oauth-usage.js";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";

const START = Date.parse("2026-10-04T10:00:00Z");
const FLOOR = START + 30 * 60_000;
const SHARED = "synthetic-shared";
const INDEPENDENT = "synthetic-independent";
const subjectOf = (id: string): QuotaSubject => ({
  harness: "claude",
  credential_route: "vendor_native",
  subject_id: id,
  plan_label: null,
});
const scenarios = [
  { name: "foreground same-cycle floor", mode: "foreground", persisted: false },
  { name: "foreground persisted floor", mode: "foreground", persisted: true },
  { name: "background persisted floor", mode: "background", persisted: true },
  { name: "background same-cycle floor", mode: "background", persisted: false },
  { name: "reverse-order control", mode: "foreground", persisted: false, reverse: true },
  { name: "independent token control", mode: "foreground", persisted: false, independent: true },
  {
    name: "persisted floor independent control",
    mode: "background",
    persisted: true,
    independent: true,
  },
  { name: "expired floor control", mode: "foreground", persisted: true, expired: true },
  { name: "standalone source fallback", mode: "standalone", persisted: false },
];

describe("Claude quota pacing after native credential refresh", () => {
  it.each(scenarios)("respects $name", async (scenario) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-refreshed-alias-")));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
    try {
      mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
      writeFileSync(
        accountsMigrationFilePath(),
        JSON.stringify({
          claude: {
            phase: "completed",
            row_id: "A",
            legacy_aliases: [null],
            locator: join(root, "A"),
            backup_ref: null,
          },
        }),
      );
      const ids = scenario.reverse ? ["A", "B"] : ["B", "A"];
      updateGlobalConfig((current) => ({
        ...current,
        credential_profiles: ids.map((id) => ({
          profile_id: id,
          harness_id: "claude",
          display_name: id,
          credential_kind: "config_dir_login",
          isolation_locator: join(root, id),
          secret_ref: null,
          enabled: true,
          created_at: null,
        })),
      }));
      const now = scenario.expired ? FLOOR + 1 : START;
      const store = quotaPacerFileStore(root);
      if (scenario.persisted) store.saveSubject!(subjectOf("B"), FLOOR);
      const diagnostics: QuotaRefreshDiagnostic[] = [];
      const refreshedToken = scenario.independent ? INDEPENDENT : SHARED;
      const refreshCredential = vi.fn(async () => ({
        accessToken: refreshedToken,
        subscriptionType: "max",
        hasRefreshToken: true,
        expiresAtMs: now + 3_600_000,
      }));
      const fetchUsage = vi.fn(async (token: string) => {
        if (!scenario.expired && token === SHARED)
          throw Object.assign(new Error("synthetic usage429"), {
            quotaAbsenceReason: "rate_limited",
            retryAfterMs: 30 * 60_000,
          });
        return { five_hour: { utilization: 20, resets_at: null } };
      });
      const deps: Partial<ClaudeOauthUsageDeps> = {
        readCredential: async (path) => ({
          accessToken: basename(path) === "A" ? "synthetic-expired" : SHARED,
          subscriptionType: "max",
          hasRefreshToken: true,
          expiresAtMs: basename(path) === "A" ? now - 1000 : now + 3_600_000,
        }),
        refreshCredential,
        fetchUsage,
        now: () => new Date(now),
        diagnostic: (event) => diagnostics.push(event),
      };
      const registry = new QuotaRegistry(
        journal,
        [{ vendor: "claude", refresh: (cycle) => refreshClaudeOauthUsageQuota(deps, cycle) }],
        () => new Date(now),
        () => ids.map(subjectOf),
        store,
      );
      const response =
        scenario.mode === "standalone"
          ? await refreshClaudeOauthUsageQuota(deps)
          : scenario.mode === "foreground"
            ? await registry.refresh()
            : (await registry.pollStale(), registry.read());
      const expectedStarts = scenario.expired
        ? ids
        : scenario.reverse
          ? ["A"]
          : [...(scenario.persisted ? [] : ["B"]), ...(scenario.independent ? ["A"] : [])];
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(fetchUsage.mock.calls.map(([token]) => token)).toEqual(
        expectedStarts.map((id) => (id === "A" ? refreshedToken : SHARED)),
      );
      // A skipped alias is a poll observation, never an invented physical HTTP attempt.
      expect(
        diagnostics
          .filter((event) => event.stage === "usage_http" && event.outcome === "started")
          .map((event) => event.profileId),
      ).toEqual(expectedStarts);
      const aEvents = diagnostics.filter((event) => event.profileId === "A");
      expect(aEvents.slice(0, 2).map(({ stage, outcome }) => [stage, outcome])).toEqual([
        ["native_refresh", "started"],
        ["native_refresh", "succeeded"],
      ]);
      const paused = ids.filter((id) => !expectedStarts.includes(id));
      const standalone = scenario.mode === "standalone";
      expect(
        response.absences
          ?.filter((row) => paused.includes(row.subject.subject_id!))
          .map((row) => [row.subject.subject_id, row.reason]),
      ).toEqual(paused.map((id) => [id, standalone ? "probe_skipped_rate_limited" : "poll_paced"]));
      for (const id of paused) {
        expect(diagnostics.filter((event) => event.profileId === id).at(-1)).toMatchObject({
          stage: "poll",
          outcome: "skipped",
          reason: standalone ? "same_token_rate_limited" : "subject_rate_limited",
        });
        if (!standalone) expect(store.loadSubject?.(subjectOf(id))).toBe(FLOOR);
      }
      expect(response.snapshots.map((row) => row.subject.subject_id)).toEqual(
        expectedStarts.filter((id) => scenario.expired || (id === "A" && scenario.independent)),
      );
      expect(JSON.stringify(diagnostics)).not.toContain("synthetic-");
    } finally {
      journal.close();
      forgetClaudeOauthRejections();
      if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
