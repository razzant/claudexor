// Single shared collector / asset-authority for the repo download+star metrics
// (D-15 reuse-lock; audit A-6). BOTH consumers import the pure logic here so
// there is exactly ONE definition of "what a download is":
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
// ASSET POLICY (the "one authority" the audit demanded): the honest
// installs/downloads count is the app-installer allowlist — the signed DMG/ZIP
// a human downloads to install the app. Everything else a GitHub release
// carries (the `.spdx.json` SBOM, `runtime-manifest.json`, the lowercase
// `claudexor-runtime-*.tar.gz` engine closure, `SHA256SUMS`, `*.sha256`
// checksums, `REVIEW_ATTESTATION.json`) is tooling, not an install, and would
// overcount humans. `release stats` additionally surfaces the raw all-asset
// total as an explicitly-labelled diagnostic, but the app-installer figure is
// the number both surfaces agree on and the README badge reports.

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
// GitHub stargazers authority
// ---------------------------------------------------------------------------

/**
 * Extract `stargazers_count` from the repo API payload, or null when the field
 * is absent/malformed (never a fabricated zero — callers surface the failure).
 */
export function extractStargazers(repo: unknown): number | null {
  if (typeof repo !== "object" || repo === null) return null;
  const stars = (repo as { stargazers_count?: unknown }).stargazers_count;
  return typeof stars === "number" ? stars : null;
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
// npm downloads authority: lifetime seed + idempotent daily deltas + gap repair
// ---------------------------------------------------------------------------

/** One day of the npm range payload (`downloads: [{ day, downloads }]`). */
export interface NpmDailyPoint {
  day?: string;
  downloads?: number;
}

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

/**
 * Sum npm daily downloads for days strictly after `afterDate` through `through`
 * inclusive. This is the daily-delta engine: extending a cumulative total by
 * only the untallied tail, so a same-day rerun (afterDate = the prior row's
 * date) never double-counts and a missed cron day is recovered (gap repair)
 * without recomputing lifetime from scratch.
 */
export function sumNpmDeltaAfter(
  daily: readonly NpmDailyPoint[] | null | undefined,
  afterDate: string,
  through: string,
): number {
  let sum = 0;
  for (const point of daily ?? []) {
    if (typeof point?.day !== "string") continue;
    if (point.day > afterDate && point.day <= through) {
      sum += typeof point.downloads === "number" ? point.downloads : 0;
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------
// CSV ledger authority (the metrics ledger; idempotent upsert + prior baseline)
// ---------------------------------------------------------------------------

export const CSV_HEADER = "date,star_total,npm_total,gh_app_downloads,combined";

export interface MetricsRow {
  date: string;
  star_total: number;
  npm_total: number;
  gh_app_downloads: number;
  combined: number;
}

export function parseCsv(text: string): { header: string; rows: MetricsRow[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { header: CSV_HEADER, rows: [] };
  const header = lines[0];
  const rows = lines.slice(1).map((line) => {
    const [date, star_total, npm_total, gh_app_downloads, combined] = line.split(",");
    return {
      date,
      star_total: Number(star_total),
      npm_total: Number(npm_total),
      gh_app_downloads: Number(gh_app_downloads),
      combined: Number(combined),
    };
  });
  return { header, rows };
}

export function serializeCsv(rows: readonly MetricsRow[]): string {
  const body = rows
    .map((r) => [r.date, r.star_total, r.npm_total, r.gh_app_downloads, r.combined].join(","))
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

/**
 * The last row whose date is strictly before `date` (the cumulative baseline a
 * same-day rerun rewinds to before re-summing the tail delta). Null when the
 * ledger has no earlier day — the signal to SEED from the npm lifetime point.
 */
export function priorRowBefore(rows: readonly MetricsRow[], date: string): MetricsRow | null {
  let prior: MetricsRow | null = null;
  for (const r of rows) {
    if (r.date < date) prior = r;
  }
  return prior;
}

export function formatThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
