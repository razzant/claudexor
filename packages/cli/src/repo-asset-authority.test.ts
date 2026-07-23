import { describe, expect, it } from "vitest";

import {
  isAppInstallerAsset,
  computeReleaseAssetTotals,
  sumAppInstallerDownloads,
  extractStargazers,
  hasMoreReleasePages,
  utcDate,
  addDaysUtc,
  sumNpmDeltaAfter,
  parseCsv,
  serializeCsv,
  upsertRow,
  priorRowBefore,
  formatThousands,
  type MetricsRow,
} from "./repo-asset-authority.js";

// Parity tests for the single shared collector / asset-authority (D-15
// reuse-lock, audit A-6). This module is the one definition consumed by BOTH
// the CLI `release stats` and scripts/update-repo-metrics.mjs, so the behaviors
// the audit named are pinned here once: allowlisting, source-failure handling,
// pagination, lifetime seed, daily deltas, and same-day idempotency.

describe("asset allowlisting (the one authority)", () => {
  it("accepts only the signed DMG/ZIP app installers", () => {
    expect(isAppInstallerAsset("Claudexor-3.0.4.dmg")).toBe(true);
    expect(isAppInstallerAsset("Claudexor-3.0.4.zip")).toBe(true);
    expect(isAppInstallerAsset("Claudexor-1.0.0-unsigned.dmg")).toBe(true);
  });

  it("excludes tooling that would overcount humans", () => {
    expect(isAppInstallerAsset("Claudexor-3.0.4.spdx.json")).toBe(false);
    expect(isAppInstallerAsset("claudexor-runtime-3.0.4.tar.gz")).toBe(false);
    expect(isAppInstallerAsset("runtime-manifest.json")).toBe(false);
    expect(isAppInstallerAsset("REVIEW_ATTESTATION.json")).toBe(false);
    expect(isAppInstallerAsset("SHA256SUMS")).toBe(false);
    expect(isAppInstallerAsset("Claudexor-1.0.0-unsigned.dmg.sha256")).toBe(false);
  });

  it("is case-sensitive on the prefix so the lowercase runtime closure is excluded", () => {
    expect(isAppInstallerAsset("claudexor-3.0.4.dmg")).toBe(false);
  });

  it("rejects non-string names without throwing", () => {
    expect(isAppInstallerAsset(undefined)).toBe(false);
    expect(isAppInstallerAsset(null)).toBe(false);
    expect(isAppInstallerAsset(42)).toBe(false);
  });

  it("sums app installers while tagging the raw breakdown", () => {
    const totals = computeReleaseAssetTotals([
      {
        assets: [
          { name: "Claudexor-3.0.4.dmg", download_count: 69 },
          { name: "Claudexor-3.0.4.zip", download_count: 42 },
          { name: "claudexor-runtime-3.0.4.tar.gz", download_count: 999 },
          { name: "SHA256SUMS", download_count: 4 },
        ],
      },
      { assets: [{ name: "Claudexor-3.0.3.dmg", download_count: 16 }] },
    ]);
    expect(totals.appInstallerDownloads).toBe(69 + 42 + 16);
    expect(totals.rawTotalDownloads).toBe(69 + 42 + 999 + 4 + 16);
    expect(
      sumAppInstallerDownloads([{ assets: [{ name: "Claudexor-3.0.4.dmg", download_count: 5 }] }]),
    ).toBe(5);
    const runtime = totals.perAsset.find((a) => a.name === "claudexor-runtime-3.0.4.tar.gz");
    expect(runtime).toEqual({
      name: "claudexor-runtime-3.0.4.tar.gz",
      downloads: 999,
      appInstaller: false,
    });
  });
});

describe("source-failure handling (never poison the count)", () => {
  it("treats null/empty release payloads as zero, not a throw", () => {
    expect(sumAppInstallerDownloads(null)).toBe(0);
    expect(sumAppInstallerDownloads(undefined)).toBe(0);
    expect(sumAppInstallerDownloads([])).toBe(0);
    expect(computeReleaseAssetTotals([{}, { assets: undefined }]).rawTotalDownloads).toBe(0);
  });

  it("skips malformed asset entries instead of counting NaN", () => {
    const totals = computeReleaseAssetTotals([
      {
        assets: [
          { name: "Claudexor-3.0.4.dmg", download_count: 10 },
          { name: "Claudexor-3.0.4.zip" },
          { download_count: 5 },
        ],
      },
    ]);
    expect(totals.appInstallerDownloads).toBe(10);
    expect(Number.isNaN(totals.rawTotalDownloads)).toBe(false);
    expect(totals.rawTotalDownloads).toBe(15);
  });

  it("returns null stars for a malformed repo payload rather than a fake zero", () => {
    expect(extractStargazers({ stargazers_count: 226 })).toBe(226);
    expect(extractStargazers({})).toBeNull();
    expect(extractStargazers(null)).toBeNull();
    expect(extractStargazers("nope")).toBeNull();
  });
});

describe("pagination", () => {
  it("continues only while a page is full", () => {
    expect(hasMoreReleasePages(new Array(100).fill({}))).toBe(true);
    expect(hasMoreReleasePages(new Array(42).fill({}))).toBe(false);
    expect(hasMoreReleasePages([])).toBe(false);
    expect(hasMoreReleasePages(null)).toBe(false);
    expect(hasMoreReleasePages("not-an-array")).toBe(false);
  });
});

describe("npm lifetime seed + daily deltas + gap repair", () => {
  it("sums only days strictly after the prior date through today (delta)", () => {
    const daily = [
      { day: "2026-07-21", downloads: 200 },
      { day: "2026-07-22", downloads: 100 },
      { day: "2026-07-23", downloads: 50 },
    ];
    // prior row is 2026-07-22, so only 07-23 (50) is new.
    expect(sumNpmDeltaAfter(daily, "2026-07-22", "2026-07-23")).toBe(50);
  });

  it("repairs a missed cron day by summing the whole gap tail", () => {
    const daily = [
      { day: "2026-07-21", downloads: 10 },
      { day: "2026-07-22", downloads: 20 },
      { day: "2026-07-23", downloads: 30 },
    ];
    // prior row is 2026-07-20 (a day was missed); recover 21+22+23 = 60.
    expect(sumNpmDeltaAfter(daily, "2026-07-20", "2026-07-23")).toBe(60);
  });

  it("ignores days at/after `through` and malformed points", () => {
    const daily = [
      { day: "2026-07-23", downloads: 5 },
      { day: "2026-07-24", downloads: 999 },
      { downloads: 7 },
      { day: "2026-07-23" },
    ];
    expect(sumNpmDeltaAfter(daily, "2026-07-22", "2026-07-23")).toBe(5);
    expect(sumNpmDeltaAfter(null, "2026-07-22", "2026-07-23")).toBe(0);
  });

  it("addDaysUtc / utcDate stay on UTC day boundaries", () => {
    expect(addDaysUtc("2026-07-22", 1)).toBe("2026-07-23");
    expect(addDaysUtc("2026-07-01", -1)).toBe("2026-06-30");
    expect(utcDate(new Date("2026-07-23T23:59:00Z"))).toBe("2026-07-23");
  });

  it("priorRowBefore is the seed signal: null when no earlier day exists", () => {
    const rows: MetricsRow[] = [
      { date: "2026-07-22", star_total: 1, npm_total: 100, gh_app_downloads: 3, combined: 103 },
      { date: "2026-07-23", star_total: 2, npm_total: 150, gh_app_downloads: 4, combined: 154 },
    ];
    expect(priorRowBefore(rows, "2026-07-23")?.date).toBe("2026-07-22");
    // Only today's row present => null => the collector SEEDS from the lifetime point.
    expect(priorRowBefore([rows[1]], "2026-07-23")).toBeNull();
    expect(priorRowBefore([], "2026-07-23")).toBeNull();
  });
});

describe("CSV ledger same-day idempotency", () => {
  it("upserts a day's row in place and keeps the ledger sorted", () => {
    let rows: MetricsRow[] = [];
    rows = upsertRow(rows, {
      date: "2026-07-23",
      star_total: 1,
      npm_total: 2,
      gh_app_downloads: 3,
      combined: 5,
    });
    rows = upsertRow(rows, {
      date: "2026-07-23",
      star_total: 9,
      npm_total: 2,
      gh_app_downloads: 3,
      combined: 5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].star_total).toBe(9);
    rows = upsertRow(rows, {
      date: "2026-07-22",
      star_total: 0,
      npm_total: 0,
      gh_app_downloads: 0,
      combined: 0,
    });
    expect(rows[0].date).toBe("2026-07-22");
  });

  it("round-trips through serialize/parse", () => {
    const rows: MetricsRow[] = [
      {
        date: "2026-07-22",
        star_total: 200,
        npm_total: 800,
        gh_app_downloads: 300,
        combined: 1100,
      },
      {
        date: "2026-07-23",
        star_total: 226,
        npm_total: 1250,
        gh_app_downloads: 410,
        combined: 1660,
      },
    ];
    const once = serializeCsv(rows);
    const twice = serializeCsv(parseCsv(once).rows);
    expect(once).toBe(twice);
    expect(once.startsWith("date,star_total,npm_total,gh_app_downloads,combined\n")).toBe(true);
  });
});

describe("formatting", () => {
  it("adds thousands separators", () => {
    expect(formatThousands(1660)).toBe("1,660");
    expect(formatThousands(226)).toBe("226");
    expect(formatThousands(1234567)).toBe("1,234,567");
  });
});
