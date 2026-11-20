// Single shared collector / asset-authority for repository download metrics
// (D-15 reuse-lock; audit A-6). BOTH consumers import the pure logic here so
// there is exactly ONE definition of the GitHub release-asset totals:
//
//   - the CLI `claudexor release stats` (packages/cli/src/release.ts), and
//   - the daily metrics workflow script (scripts/update-repo-metrics.mjs),
//     which imports this file directly under Node's native TypeScript type
//     stripping (the workflow runs plain `node`, no build step — see
//     .github/workflows/repo-metrics.yml and .node-version).
//
// Because the script imports this module unbuilt, every export MUST use only
// erasable syntax (types/interfaces only — no enums, no namespaces, no
// parameter properties) and depend on nothing outside the Node stdlib.
//
// ASSET POLICY (the "one authority" the audit demanded): `release stats`
// exposes both the DMG/ZIP app-installer subtotal and the raw sum across every
// uploaded release asset. The README total-downloads badge deliberately uses
// that raw sum; it is a download-event counter, not an installation counter.

/** A single GitHub release asset as returned by the releases API (subset). */
export interface ReleaseAsset {
  name?: string;
  download_count?: number;
}

/** A single GitHub release as returned by the releases API (subset). */
export interface ReleaseSummary {
  assets?: ReleaseAsset[];
}

/** One release asset's contribution to the totals, tagged by policy. */
export interface AssetDownloadCount {
  name: string;
  downloads: number;
  /** True when this asset counts as an app install under the allowlist. */
  appInstaller: boolean;
}

/** The GitHub release-asset download breakdown under the ONE asset policy. */
export interface ReleaseAssetTotals {
  /** Allowlisted app-installer downloads — the honest install count. */
  appInstallerDownloads: number;
  /** Raw sum across ALL assets (installers + tooling) — diagnostic only. */
  rawTotalDownloads: number;
  /** Per-asset breakdown, each tagged with whether it is an app installer. */
  perAsset: AssetDownloadCount[];
}

// ---------------------------------------------------------------------------
// Asset authority (the drift the audit caught: two collectors, two allowlists)
// ---------------------------------------------------------------------------

/**
 * The ONE app-installer allowlist: the signed `Claudexor-<version>.dmg` / `.zip`
 * a human downloads to install the app. Case-sensitive on the `Claudexor-`
 * prefix so the lowercase `claudexor-runtime-*.tar.gz` engine closure is
 * excluded. No path separators are allowed in the matched name.
 */
export function isAppInstallerAsset(name: unknown): name is string {
  return typeof name === "string" && /^Claudexor-[^/]*\.(?:dmg|zip)$/.test(name);
}

/**
 * Fold a list of releases into the asset totals under the one policy. Missing
 * or malformed asset entries contribute zero rather than throwing, so a partial
 * API payload degrades gracefully instead of poisoning the whole count.
 */
export function computeReleaseAssetTotals(
  releases: readonly ReleaseSummary[] | null | undefined,
): ReleaseAssetTotals {
  const perAssetMap = new Map<string, { downloads: number; appInstaller: boolean }>();
  let appInstallerDownloads = 0;
  let rawTotalDownloads = 0;
  for (const release of releases ?? []) {
    for (const asset of release?.assets ?? []) {
      const count = typeof asset?.download_count === "number" ? asset.download_count : 0;
      const name = typeof asset?.name === "string" ? asset.name : "(unnamed)";
      const appInstaller = isAppInstallerAsset(asset?.name);
      rawTotalDownloads += count;
      if (appInstaller) appInstallerDownloads += count;
      const existing = perAssetMap.get(name);
      perAssetMap.set(name, {
        downloads: (existing?.downloads ?? 0) + count,
        appInstaller: existing?.appInstaller ?? appInstaller,
      });
    }
  }
  const perAsset = [...perAssetMap.entries()]
    .map(([name, v]) => ({ name, downloads: v.downloads, appInstaller: v.appInstaller }))
    .sort((a, b) => b.downloads - a.downloads);
  return { appInstallerDownloads, rawTotalDownloads, perAsset };
}

/** Convenience: the honest app-installer download sum for a release list. */
export function sumAppInstallerDownloads(
  releases: readonly ReleaseSummary[] | null | undefined,
): number {
  return computeReleaseAssetTotals(releases).appInstallerDownloads;
}

// ---------------------------------------------------------------------------
// Pagination authority (releases API is paged 100/response)
// ---------------------------------------------------------------------------

/**
 * Whether the releases pager should fetch another page after `batch`. Stops on a
 * non-array, an empty page, or a short (< pageSize) page — the last page.
 */
export function hasMoreReleasePages(batch: unknown, pageSize = 100): boolean {
  return Array.isArray(batch) && batch.length >= pageSize;
}

// ---------------------------------------------------------------------------
// npm downloads authority: current cumulative counts from complete daily ranges
// ---------------------------------------------------------------------------

/** UTC day string (YYYY-MM-DD) so cron time zone never splits a run in two. */
export function utcDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD day string by whole days in UTC. */
export function addDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** npm can revise any closed day; build one prefix sum from freshly validated ranges. */
export async function fetchNpmTotals(
  pkg: string, first: string, through: string,
  readRange: (from: string, to: string) => Promise<{
    package?: string; start?: string; end?: string;
    downloads?: {day: string; downloads: number}[];
  }>,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  let sum = 0;
  for (let from = first; from <= through;) {
    const limit = addDaysUtc(from, 364);
    const to = limit < through ? limit : through;
    const range = await readRange(from, to);
    if (range?.package !== pkg || range.start !== from || range.end !== to || !Array.isArray(range.downloads)) {
      throw new Error(`npm returned an incomplete or mismatched range for ${pkg} ${from}:${to}`);
    }
    const counts = new Map<string, number>();
    for (const point of range.downloads) {
      if (!point || point.day < from || point.day > to || counts.has(point.day) ||
          !Number.isSafeInteger(point.downloads) || point.downloads < 0) {
        throw new Error(`invalid or duplicate npm daily point in ${from}:${to}`);
      }
      counts.set(point.day, point.downloads);
    }
    for (let day = from; day <= to; day = addDaysUtc(day, 1)) {
      const n = counts.get(day);
      if (n === undefined) throw new Error(`npm range is missing ${day}`);
      sum += n;
      if (!Number.isSafeInteger(sum)) throw new Error("invalid cumulative npm count");
      totals.set(day, sum);
      counts.delete(day);
    }
    if (counts.size) throw new Error(`npm range contains unexpected dates in ${from}:${to}`);
    from = addDaysUtc(to, 1);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// CSV ledger authority (idempotent upsert + closed-day npm watermark)
// ---------------------------------------------------------------------------

export const CSV_HEADER = "date,npm_through,npm_total,github_release_downloads,total_downloads";

export interface MetricsRow {
  date: string;
  /** Last fully closed UTC npm day included in `npm_total`. */
  npm_through: string;
  npm_total: number;
  /** Raw cumulative count across every uploaded GitHub release asset. */
  github_release_downloads: number;
  total_downloads: number;
}

export function parseCsv(text: string): { header: string; rows: MetricsRow[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { header: CSV_HEADER, rows: [] };
  const header = lines[0];
  if (header !== CSV_HEADER) {
    throw new Error(`repo metrics CSV header mismatch: expected ${CSV_HEADER}`);
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const rows = lines.slice(1).map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 5) {
      throw new Error(`repo metrics CSV row ${index + 2} must have 5 columns`);
    }
    const [date, npm_through, npmRaw, githubRaw, totalRaw] = fields;
    const npm_total = Number(npmRaw);
    const github_release_downloads = Number(githubRaw);
    const total_downloads = Number(totalRaw);
    if (!datePattern.test(date) || !datePattern.test(npm_through)) {
      throw new Error(`repo metrics CSV row ${index + 2} has an invalid UTC date`);
    }
    if (
      !Number.isSafeInteger(npm_total) ||
      npm_total < 0 ||
      !Number.isSafeInteger(github_release_downloads) ||
      github_release_downloads < 0 ||
      !Number.isSafeInteger(total_downloads) ||
      total_downloads !== npm_total + github_release_downloads
    ) {
      throw new Error(`repo metrics CSV row ${index + 2} has invalid download totals`);
    }
    return { date, npm_through, npm_total, github_release_downloads, total_downloads };
  });
  return { header, rows };
}

export function serializeCsv(rows: readonly MetricsRow[]): string {
  const body = rows
    .map((r) =>
      [r.date, r.npm_through, r.npm_total, r.github_release_downloads, r.total_downloads].join(","),
    )
    .join("\n");
  return body.length > 0 ? `${CSV_HEADER}\n${body}\n` : `${CSV_HEADER}\n`;
}

/**
 * Insert or replace the row for its date, keeping the ledger sorted by date.
 * Idempotent: re-running the same day updates that day's row, never duplicates.
 */
export function upsertRow(rows: readonly MetricsRow[], row: MetricsRow): MetricsRow[] {
  const next = rows.filter((r) => r.date !== row.date);
  next.push(row);
  next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return next;
}

/** Refresh today's live GitHub observation, but preserve every earlier GitHub snapshot. */
export function reconcileMetrics(
  existing: readonly MetricsRow[], today: string, githubDownloads: number, npmTotals: ReadonlyMap<string, number>,
): MetricsRow[] {
  const snapshot = { date: today, npm_through: addDaysUtc(today, -1),
    github_release_downloads: githubDownloads, npm_total: 0, total_downloads: 0 };
  return upsertRow(existing, snapshot).map((row) => {
    const npm_total = npmTotals.get(row.npm_through);
    if (npm_total === undefined) throw new Error(`no complete npm history through ${row.npm_through}`);
    return { ...row, npm_total, total_downloads: npm_total + row.github_release_downloads };
  });
}

export function formatThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
