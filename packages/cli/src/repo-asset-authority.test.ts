import { describe, expect, it } from "vitest";

import {
  isAppInstallerAsset,
  computeReleaseAssetTotals,
  sumAppInstallerDownloads,
  hasMoreReleasePages,
  utcDate,
  addDaysUtc,
  fetchNpmTotals,
  reconcileMetrics,
  parseCsv,
  serializeCsv,
  upsertRow,
  formatThousands,
  type MetricsRow,
} from "./repo-asset-authority.js";

// Parity tests for the single shared collector / asset-authority (D-15
// reuse-lock, audit A-6). This module is the one definition consumed by BOTH
// the CLI `release stats` and scripts/update-repo-metrics.mjs, so the behaviors
// the audit named are pinned here once: allowlisting, source-failure handling,
// pagination, revised npm history, persisted-state validation, and same-day
// idempotency.

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

describe("npm history reconciliation", () => {
  const pkg = "claudexor";
  const first = "2026-07-10";
  const next = "2026-07-11";
  const daily = [
    { day: first, downloads: 20 },
    { day: next, downloads: 0 },
  ];
  const response = { package: pkg, start: first, end: next, downloads: daily };

  it("accepts backward and forward revisions and genuine zeros without changing historical GitHub", async () => {
    const totals = await fetchNpmTotals(pkg, first, next, async () => response);
    const input = parseCsv(
      "date,npm_through,npm_total,github_release_downloads,total_downloads\n" +
        "2026-07-11,2026-07-10,10,7,17\n2026-07-12,2026-07-11,30,12,42\n",
    ).rows;
    const result = reconcileMetrics(input, "2026-07-12", 13, totals);
    expect(result.map((r) => [r.npm_total, r.github_release_downloads, r.total_downloads])).toEqual(
      [
        [20, 7, 27],
        [20, 13, 33],
      ],
    );
    expect(reconcileMetrics(result, "2026-07-12", 13, totals)).toEqual(result);
    expect(() =>
      reconcileMetrics([], "2026-07-12", 13, new Map([[next, Number.MAX_SAFE_INTEGER]])),
    ).toThrow("invalid download total");
    expect(() => reconcileMetrics(input, "2026-07-13", 13, totals)).toThrow(
      "no complete npm history",
    );
  });

  it("requests contiguous bounded chunks and carries the total over leap day", async () => {
    const calls: string[][] = [];
    const totals = await fetchNpmTotals(pkg, "2027-03-01", "2028-03-01", async (start, end) => {
      calls.push([start, end]);
      const downloads = [];
      for (let day = start; day <= end; day = addDaysUtc(day, 1))
        downloads.push({ day, downloads: 1 });
      return { package: pkg, start, end, downloads };
    });
    expect(calls).toEqual([
      ["2027-03-01", "2028-02-28"],
      ["2028-02-29", "2028-03-01"],
    ]);
    expect(totals.get("2028-03-01")).toBe(367);
  });

  it("refuses incomplete, duplicated or malformed responses instead of silently counting zero", async () => {
    for (const bad of [
      { package: "other" },
      { start: next },
      { end: first },
      { downloads: [daily[1]] },
      { downloads: [daily[0], daily[0]] },
      { downloads: [...daily, { day: "2026-07-12", downloads: 0 }] },
      { downloads: [daily[0], { day: next, downloads: -1 }] },
      { downloads: [daily[0], { day: next, downloads: 1.5 }] },
    ]) {
      await expect(
        fetchNpmTotals(pkg, first, next, async () => ({ ...response, ...bad })),
      ).rejects.toThrow();
    }
    await expect(
      fetchNpmTotals(pkg, first, next, async () => {
        throw new Error("source unavailable");
      }),
    ).rejects.toThrow("source unavailable");
  });

  it("addDaysUtc / utcDate stay on UTC day boundaries", () => {
    expect(addDaysUtc("2026-07-22", 1)).toBe("2026-07-23");
    expect(addDaysUtc("2026-07-01", -1)).toBe("2026-06-30");
    expect(utcDate(new Date("2026-07-23T23:59:00Z"))).toBe("2026-07-23");
  });
});

describe("CSV ledger same-day idempotency", () => {
  it("upserts a day's row in place and keeps the ledger sorted", () => {
    let rows: MetricsRow[] = [];
    rows = upsertRow(rows, {
      date: "2026-07-23",
      npm_through: "2026-07-22",
      npm_total: 2,
      github_release_downloads: 3,
      total_downloads: 5,
    });
    rows = upsertRow(rows, {
      date: "2026-07-23",
      npm_through: "2026-07-22",
      npm_total: 2,
      github_release_downloads: 9,
      total_downloads: 11,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].github_release_downloads).toBe(9);
    rows = upsertRow(rows, {
      date: "2026-07-22",
      npm_through: "2026-07-21",
      npm_total: 0,
      github_release_downloads: 0,
      total_downloads: 0,
    });
    expect(rows[0].date).toBe("2026-07-22");
  });

  it("round-trips through serialize/parse", () => {
    const rows: MetricsRow[] = [
      {
        date: "2026-07-22",
        npm_through: "2026-07-21",
        npm_total: 800,
        github_release_downloads: 300,
        total_downloads: 1100,
      },
      {
        date: "2026-07-23",
        npm_through: "2026-07-22",
        npm_total: 1250,
        github_release_downloads: 700,
        total_downloads: 1950,
      },
    ];
    const once = serializeCsv(rows);
    const twice = serializeCsv(parseCsv(once).rows);
    expect(once).toBe(twice);
    expect(
      once.startsWith("date,npm_through,npm_total,github_release_downloads,total_downloads\n"),
    ).toBe(true);
  });

  it("rejects stale, malformed, or arithmetically inconsistent state", () => {
    expect(() => parseCsv("date,npm_total\n2026-07-23,1250\n")).toThrow("header mismatch");
    expect(() =>
      parseCsv(
        "date,npm_through,npm_total,github_release_downloads,total_downloads\n" +
          "2026-07-23,2026-07-22,1250,700,9999\n",
      ),
    ).toThrow("invalid download totals");
  });
});

describe("formatting", () => {
  it("adds thousands separators", () => {
    expect(formatThousands(1660)).toBe("1,660");
    expect(formatThousands(226)).toBe("226");
    expect(formatThousands(1234567)).toBe("1,234,567");
  });
});
