#!/usr/bin/env node
// Repo metrics collector (D-15). Dependency-free Node stdlib only.
//
// Appends a daily row {date, star_total, npm_total, gh_app_downloads, combined}
// to docs/assets/repo-metrics.csv and renders committed SVG charts + a shields
// endpoint badge. Runs from the daily repo-metrics workflow (or locally with a
// network + optional GITHUB_TOKEN).
//
// Honesty rules baked in here:
//   - The headline metric is "total downloads" = npm downloads + GitHub app
//     asset downloads (DMG/ZIP only). Runtime tarballs, SBOMs, manifests,
//     checksums and attestations are NOT app installs and are excluded.
//   - npm_total is SEEDED once from the package's lifetime point range (the
//     package is younger than the npm 18-month range cap), then extended by
//     idempotent daily deltas summed from the npm daily range since the last
//     recorded day. It is never recomputed from scratch, and a rerun on the
//     same day updates that day's row in place (no duplicate rows).
//   - gh_app_downloads is the current cumulative allowlist sum from the GitHub
//     releases API (that endpoint reports live cumulative counts).
//   - A source that fails is surfaced loudly; we never write a fabricated zero.
//
// Usage:
//   node scripts/update-repo-metrics.mjs          # fetch + write CSV/SVG/badge
//   node scripts/update-repo-metrics.mjs --check   # offline pure self-tests

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpsGet } from "node:https";

const REPO = "razzant/claudexor";
const NPM_PACKAGE = "claudexor";
// npm registry "created" time for the package; the lifetime point range starts
// here. GitHub v1.0.0 predates the first npm publish (v1.0.1) by a day; npm is
// the seed authority for the npm column.
const NPM_FIRST_PUBLISH = "2026-07-10";
const USER_AGENT = "claudexor-repo-metrics (+https://github.com/razzant/claudexor)";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const assetsDir = join(repoRoot, "docs", "assets");
const csvPath = join(assetsDir, "repo-metrics.csv");
const badgePath = join(assetsDir, "downloads-badge.json");

const CSV_HEADER = "date,star_total,npm_total,gh_app_downloads,combined";
const CHART_ACCENT = "#6366f1"; // brand-neutral indigo, identical in both themes

// ---------------------------------------------------------------------------
// Pure helpers (all self-tested under --check)
// ---------------------------------------------------------------------------

// App-install allowlist: only the signed DMG/ZIP the user actually downloads to
// install the app. Everything else a release carries (SBOM `.spdx.json`,
// `runtime-manifest.json`, the lowercase `claudexor-runtime-*.tar.gz` engine
// closure, `SHA256SUMS`, `*.sha256` checksums, `REVIEW_ATTESTATION.json`) is
// tooling, not an install, and would overcount humans.
export function isAppAsset(name) {
  return typeof name === "string" && /^Claudexor-[^/]*\.(?:dmg|zip)$/.test(name);
}

export function computeGhAppDownloads(releases) {
  let total = 0;
  for (const release of releases ?? []) {
    for (const asset of release.assets ?? []) {
      if (!isAppAsset(asset?.name)) continue;
      const count = typeof asset.download_count === "number" ? asset.download_count : 0;
      total += count;
    }
  }
  return total;
}

export function parseCsv(text) {
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

export function serializeCsv(rows) {
  const body = rows
    .map((r) => [r.date, r.star_total, r.npm_total, r.gh_app_downloads, r.combined].join(","))
    .join("\n");
  return body.length > 0 ? `${CSV_HEADER}\n${body}\n` : `${CSV_HEADER}\n`;
}

// Insert or replace the row for its date, keeping the ledger sorted by date.
// Idempotent: re-running the same day updates that day's row, never duplicates.
export function upsertRow(rows, row) {
  const next = rows.filter((r) => r.date !== row.date);
  next.push(row);
  next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return next;
}

// The last row whose date is strictly before `date` (the cumulative baseline a
// same-day rerun rewinds to before re-summing the tail delta).
export function priorRowBefore(rows, date) {
  let prior = null;
  for (const r of rows) {
    if (r.date < date) prior = r;
  }
  return prior;
}

export function formatThousands(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// UTC day strings so cron time zone can never split a run across two dates.
export function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Sum npm daily downloads for days strictly after `afterDate` through `through`
// inclusive. `daily` is the npm range payload's `downloads: [{day, downloads}]`.
export function sumNpmDeltaAfter(daily, afterDate, through) {
  let sum = 0;
  for (const point of daily ?? []) {
    if (point.day > afterDate && point.day <= through) {
      sum += typeof point.downloads === "number" ? point.downloads : 0;
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------
// SVG chart rendering (deterministic: identical CSV -> identical bytes)
// ---------------------------------------------------------------------------

const THEMES = {
  light: { text: "#3c4257", axis: "#c7cdd8", grid: "#eceef3", areaOpacity: "0.14" },
  dark: { text: "#c7cdd4", axis: "#3a4150", grid: "#242a35", areaOpacity: "0.20" },
};

function niceCeil(value) {
  if (value <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const steps = [1, 2, 2.5, 5, 10];
  for (const s of steps) {
    if (value <= s * pow) return s * pow;
  }
  return 10 * pow;
}

// Catmull-Rom -> cubic bezier for a smooth path through the points.
function smoothPath(points) {
  if (points.length === 1) {
    const [p] = points;
    return `M${p.x},${p.y}`;
  }
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(p2.x)},${round(p2.y)}`;
  }
  return d;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export function renderChart({ rows, valueKey, title, theme }) {
  const t = THEMES[theme];
  const W = 760;
  const H = 300;
  const padL = 64;
  const padR = 24;
  const padT = 46;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = rows.map((r) => r[valueKey]);
  const maxVal = niceCeil(Math.max(1, ...values));
  const n = rows.length;

  const xAt = (i) => (n === 1 ? padL + plotW / 2 : padL + (plotW * i) / (n - 1));
  const yAt = (v) => padT + plotH - (plotH * v) / maxVal;

  const points = rows.map((r, i) => ({ x: xAt(i), y: yAt(r[valueKey]) }));

  // Horizontal grid + Y ticks (0, 1/2, max).
  const yTicks = [0, maxVal / 2, maxVal];
  let grid = "";
  let yLabels = "";
  for (const v of yTicks) {
    const y = round(yAt(v));
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${t.grid}" stroke-width="1"/>`;
    yLabels += `<text x="${padL - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${t.text}">${formatThousands(v)}</text>`;
  }

  // X axis date labels: first and last (and a middle sample when room allows).
  const xIdx = n === 1 ? [0] : n <= 3 ? rows.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  let xLabels = "";
  for (const i of xIdx) {
    const label = rows[i].date.slice(5); // MM-DD
    const anchor = n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    xLabels += `<text x="${round(xAt(i))}" y="${H - padB + 20}" text-anchor="${anchor}" font-size="12" fill="${t.text}">${label}</text>`;
  }

  const baseY = round(yAt(0));
  const line = smoothPath(points);
  let area = "";
  if (n >= 2) {
    area = `<path d="${line} L${round(points[n - 1].x)},${baseY} L${round(points[0].x)},${baseY} Z" fill="${CHART_ACCENT}" fill-opacity="${t.areaOpacity}"/>`;
  } else {
    // Single seed point: soft baseline column so the chart reads intentionally.
    const px = round(points[0].x);
    area = `<line x1="${px}" y1="${round(points[0].y)}" x2="${px}" y2="${baseY}" stroke="${CHART_ACCENT}" stroke-opacity="${t.areaOpacity}" stroke-width="26" stroke-linecap="round"/>`;
  }

  const markers = points
    .map((p) => `<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${n === 1 ? 4 : 3}" fill="${CHART_ACCENT}"/>`)
    .join("");

  // Current value label near the last point.
  const last = points[n - 1];
  const lastVal = formatThousands(rows[n - 1][valueKey]);
  const labelAnchor = n === 1 ? "middle" : "end";
  const labelX = n === 1 ? round(last.x) : round(last.x);
  const valueLabel = `<text x="${labelX}" y="${round(last.y) - 12}" text-anchor="${labelAnchor}" font-size="13" font-weight="600" fill="${CHART_ACCENT}">${lastVal}</text>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="${title}">`,
    `<text x="${padL}" y="26" font-size="15" font-weight="600" fill="${t.text}">${title}</text>`,
    grid,
    `<line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="${t.axis}" stroke-width="1"/>`,
    area,
    n >= 2
      ? `<path d="${line}" fill="none" stroke="${CHART_ACCENT}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
      : "",
    markers,
    yLabels,
    xLabels,
    valueLabel,
    `</svg>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (url.includes("api.github.com") && process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    httpsGet(url, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`GET ${url} -> HTTP ${status}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`GET ${url} -> invalid JSON (${err.message})`));
        }
      });
    }).on("error", (err) => reject(new Error(`GET ${url} -> ${err.message}`)));
  });
}

async function fetchAllReleases() {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await fetchJson(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function fetchStars() {
  const repo = await fetchJson(`https://api.github.com/repos/${REPO}`);
  const stars = repo?.stargazers_count;
  if (typeof stars !== "number") throw new Error("repo API returned no stargazers_count");
  return stars;
}

async function fetchNpmRange(from, to) {
  const data = await fetchJson(`https://api.npmjs.org/downloads/range/${from}:${to}/${NPM_PACKAGE}`);
  if (!Array.isArray(data?.downloads)) throw new Error("npm range API returned no downloads array");
  return data.downloads;
}

async function fetchNpmLifetime(to) {
  const data = await fetchJson(
    `https://api.npmjs.org/downloads/point/${NPM_FIRST_PUBLISH}:${to}/${NPM_PACKAGE}`,
  );
  if (typeof data?.downloads !== "number") throw new Error("npm point API returned no downloads");
  return data.downloads;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const today = utcDate();

  const existing = existsSync(csvPath) ? parseCsv(readFileSync(csvPath, "utf8")).rows : [];
  const prior = priorRowBefore(existing, today);

  const stars = await fetchStars();
  const releases = await fetchAllReleases();
  const ghAppDownloads = computeGhAppDownloads(releases);

  let npmTotal;
  if (prior === null) {
    // First ever row (or only today's row exists): seed the lifetime value.
    npmTotal = await fetchNpmLifetime(today);
  } else {
    // Extend from the prior day's cumulative by the daily deltas since then.
    // Bounded gap repair: the range floors at the day after `prior`, so any
    // missed cron days are recovered without recomputing from scratch.
    const daily = await fetchNpmRange(addDaysUtc(prior.date, 1), today);
    npmTotal = prior.npm_total + sumNpmDeltaAfter(daily, prior.date, today);
  }

  const combined = npmTotal + ghAppDownloads;
  const row = {
    date: today,
    star_total: stars,
    npm_total: npmTotal,
    gh_app_downloads: ghAppDownloads,
    combined,
  };

  const rows = upsertRow(existing, row);

  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  writeFileSync(csvPath, serializeCsv(rows));

  const charts = [
    { key: "star_total", base: "star-history", title: "GitHub stars" },
    { key: "combined", base: "downloads", title: "Total downloads (npm + app)" },
  ];
  for (const c of charts) {
    for (const theme of ["light", "dark"]) {
      const svg = renderChart({ rows, valueKey: c.key, title: c.title, theme });
      writeFileSync(join(assetsDir, `${c.base}-${theme}.svg`), `${svg}\n`);
    }
  }

  const badge = {
    schemaVersion: 1,
    label: "total downloads",
    message: formatThousands(combined),
    color: "blue",
  };
  writeFileSync(badgePath, `${JSON.stringify(badge, null, 2)}\n`);

  console.log(
    `repo-metrics ${today}: stars=${stars} npm_total=${npmTotal} gh_app=${ghAppDownloads} combined=${combined}`,
  );
}

// ---------------------------------------------------------------------------
// Self-tests (--check): pure logic only, no network, no writes.
// ---------------------------------------------------------------------------

function runSelfTests() {
  let failures = 0;
  const ok = (cond, msg) => {
    if (!cond) {
      failures++;
      console.error(`FAIL: ${msg}`);
    }
  };

  // 1. Allowlist: real v3.0.4 asset names.
  ok(isAppAsset("Claudexor-3.0.4.dmg"), "dmg is an app asset");
  ok(isAppAsset("Claudexor-3.0.4.zip"), "zip is an app asset");
  ok(isAppAsset("Claudexor-1.0.0-unsigned.dmg"), "unsigned dmg is an app asset");
  ok(!isAppAsset("Claudexor-3.0.4.spdx.json"), "SBOM excluded");
  ok(!isAppAsset("claudexor-runtime-3.0.4.tar.gz"), "runtime tarball excluded");
  ok(!isAppAsset("runtime-manifest.json"), "runtime manifest excluded");
  ok(!isAppAsset("REVIEW_ATTESTATION.json"), "attestation excluded");
  ok(!isAppAsset("SHA256SUMS"), "checksums file excluded");
  ok(!isAppAsset("Claudexor-1.0.0-unsigned.dmg.sha256"), "per-asset checksum excluded");

  const gh = computeGhAppDownloads([
    { assets: [{ name: "Claudexor-3.0.4.dmg", download_count: 69 }, { name: "Claudexor-3.0.4.zip", download_count: 42 }, { name: "claudexor-runtime-3.0.4.tar.gz", download_count: 999 }, { name: "SHA256SUMS", download_count: 4 }] },
    { assets: [{ name: "Claudexor-3.0.3.dmg", download_count: 16 }, { name: "Claudexor-3.0.3.zip", download_count: 7 }] },
  ]);
  ok(gh === 69 + 42 + 16 + 7, `gh app sum excludes tooling (got ${gh})`);

  // 2. CSV idempotency: same day upsert -> one row, updated value.
  let rows = [];
  rows = upsertRow(rows, { date: "2026-07-23", star_total: 1, npm_total: 2, gh_app_downloads: 3, combined: 5 });
  rows = upsertRow(rows, { date: "2026-07-23", star_total: 9, npm_total: 2, gh_app_downloads: 3, combined: 5 });
  ok(rows.length === 1, "same-day rerun does not duplicate rows");
  ok(rows[0].star_total === 9, "same-day rerun updates the row in place");
  rows = upsertRow(rows, { date: "2026-07-22", star_total: 0, npm_total: 0, gh_app_downloads: 0, combined: 0 });
  ok(rows[0].date === "2026-07-22", "rows stay sorted by date");

  const round1 = serializeCsv(rows);
  const round2 = serializeCsv(parseCsv(round1).rows);
  ok(round1 === round2, "CSV serialize/parse round-trips");

  // 3. Delta / prior-row logic.
  const prior = priorRowBefore(rows, "2026-07-23");
  ok(prior && prior.date === "2026-07-22", "priorRowBefore skips the same-day row");
  const delta = sumNpmDeltaAfter(
    [{ day: "2026-07-22", downloads: 100 }, { day: "2026-07-23", downloads: 50 }],
    "2026-07-22",
    "2026-07-23",
  );
  ok(delta === 50, `delta sums only days after the prior date (got ${delta})`);

  // 4. SVG determinism.
  const demo = [
    { date: "2026-07-20", star_total: 200, npm_total: 800, gh_app_downloads: 300, combined: 1100 },
    { date: "2026-07-21", star_total: 210, npm_total: 1000, gh_app_downloads: 360, combined: 1360 },
    { date: "2026-07-22", star_total: 226, npm_total: 1250, gh_app_downloads: 410, combined: 1660 },
  ];
  const a = renderChart({ rows: demo, valueKey: "combined", title: "Total downloads", theme: "dark" });
  const b = renderChart({ rows: demo, valueKey: "combined", title: "Total downloads", theme: "dark" });
  ok(a === b, "SVG generation is deterministic");
  ok(a.startsWith("<svg"), "SVG output is an svg element");
  const single = renderChart({ rows: demo.slice(0, 1), valueKey: "combined", title: "T", theme: "light" });
  ok(single.includes("<svg"), "single-point chart renders without error");

  // 5. Formatting.
  ok(formatThousands(1660) === "1,660", "thousands separator");
  ok(formatThousands(226) === "226", "no separator under 1000");

  if (failures > 0) {
    console.error(`repo-metrics self-test: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("repo-metrics self-test: all checks passed");
}

const arg = process.argv[2];
if (arg === "--check") {
  runSelfTests();
} else {
  main().catch((err) => {
    console.error(`repo-metrics failed: ${err.message}`);
    process.exit(1);
  });
}
