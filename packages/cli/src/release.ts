import { CLAUDEXOR_VERSION } from "@claudexor/util";

export type NameAvailability = "free" | "taken" | "unknown";
export interface NameCheck {
  registry: string;
  availability: NameAvailability;
  detail: string;
}

async function head(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status;
  } catch {
    return -1;
  }
}

/**
 * Naming gate: best-effort availability check across registries. 404 means the
 * name appears free; 200 means taken; anything else (403 forbidden/rate-limit,
 * 5xx, network failure) is UNKNOWN — never reported as "taken", since a
 * non-404/200 response is not evidence the name is unavailable.
 */
export async function checkName(name: string): Promise<NameCheck[]> {
  const lc = name.toLowerCase();
  const checks: NameCheck[] = [];

  const npm = await head(`https://registry.npmjs.org/${encodeURIComponent(lc)}`);
  checks.push({ registry: "npm", availability: availability(npm), detail: status(npm) });

  const npmScoped = await head(
    `https://registry.npmjs.org/${encodeURIComponent("@" + lc + "/cli")}`,
  );
  checks.push({
    registry: "npm (@scope/cli)",
    availability: availability(npmScoped),
    detail: status(npmScoped),
  });

  const pypi = await head(`https://pypi.org/pypi/${encodeURIComponent(lc)}/json`);
  checks.push({ registry: "pypi", availability: availability(pypi), detail: status(pypi) });

  const crates = await head(`https://crates.io/api/v1/crates/${encodeURIComponent(lc)}`);
  checks.push({
    registry: "crates.io",
    availability: availability(crates),
    detail: status(crates),
  });

  const ghUser = await head(`https://github.com/${encodeURIComponent(lc)}`);
  checks.push({
    registry: "github org/user",
    availability: availability(ghUser),
    detail: status(ghUser),
  });

  return checks;
}

function availability(code: number): NameAvailability {
  if (code === 404) return "free";
  if (code === 200) return "taken";
  return "unknown";
}

// ---------------------------------------------------------------------------
// M7 engine-runtime update check + install counter (D22/D23)
//
// The GitHub-release asset `runtime-manifest.json` is the SAME manifest the
// macOS app's auto-updater reads. `claudexor release check` reports whether a
// newer engine runtime is published; npm users are told they update via npm
// (the app is the only surface that swaps the runtime closure in place).
// `claudexor release stats` is the owner-facing install counter — GitHub asset
// download_count + the npm downloads API, zero infra, NO telemetry, NO ping.
// Every network call is behind these user-invoked commands only.
// ---------------------------------------------------------------------------

/** github.com/<RELEASE_REPO> — the one release source of truth. */
export const RELEASE_REPO = "razzant/claudexor";
/** npm package name (the version SSOT ships as `claudexor` on npm). */
export const NPM_PACKAGE = "claudexor";

/** Injectable fetch so the commands are honestly testable with no live network
 * (tests pass a stub; production defaults to the global fetch). */
export type FetchLike = typeof fetch;

/** The runtime manifest published beside the closure tarball on each release. */
export interface RuntimeManifest {
  version: string;
  sha256: string;
  minAppVersion: string;
  signature: string | null;
  notes: string | null;
}

export interface RuntimeUpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  minAppVersion: string | null;
  notes: string | null;
  /** "github" when a manifest was read; "unavailable" on any failure (offline,
   * rate-limit, no release yet, malformed manifest) — never a false verdict. */
  source: "github" | "unavailable";
  detail: string;
}

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "claudexor-release-check",
  "X-GitHub-Api-Version": "2022-11-28",
};

function isSemver(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function parseRuntimeManifest(value: unknown): RuntimeManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isSemver(record.version)) return null;
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return null;
  if (!isSemver(record.minAppVersion)) return null;
  return {
    version: record.version,
    sha256: record.sha256,
    minAppVersion: record.minAppVersion,
    signature: typeof record.signature === "string" ? record.signature : null,
    notes: typeof record.notes === "string" ? record.notes : null,
  };
}

/**
 * Read the latest release's `runtime-manifest.json` and compare it to the
 * running engine version. Any failure degrades to `source: "unavailable"` with
 * an honest detail — this command never invents an update or a false "current".
 */
export async function checkRuntimeUpdate(opts?: {
  fetchImpl?: FetchLike;
  currentVersion?: string;
}): Promise<RuntimeUpdateCheck> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const currentVersion = opts?.currentVersion ?? CLAUDEXOR_VERSION;
  const unavailable = (detail: string): RuntimeUpdateCheck => ({
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    minAppVersion: null,
    notes: null,
    source: "unavailable",
    detail,
  });

  let manifestUrl: string;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: GH_HEADERS,
    });
    if (!res.ok) return unavailable(`GitHub releases API returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const asset = (body.assets ?? []).find((a) => a.name === "runtime-manifest.json");
    if (!asset?.browser_download_url) {
      return unavailable("latest release has no runtime-manifest.json asset yet");
    }
    manifestUrl = asset.browser_download_url;
  } catch (error) {
    return unavailable(`could not reach the GitHub releases API (${describeError(error)})`);
  }

  let manifest: RuntimeManifest | null;
  try {
    const res = await fetchImpl(manifestUrl, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
    });
    if (!res.ok) return unavailable(`runtime-manifest.json download returned HTTP ${res.status}`);
    manifest = parseRuntimeManifest(await res.json());
  } catch (error) {
    return unavailable(`could not download runtime-manifest.json (${describeError(error)})`);
  }
  if (!manifest) return unavailable("runtime-manifest.json is malformed");

  const updateAvailable =
    isSemver(currentVersion) && compareSemver(manifest.version, currentVersion) > 0;
  return {
    currentVersion,
    latestVersion: manifest.version,
    updateAvailable,
    minAppVersion: manifest.minAppVersion,
    notes: manifest.notes,
    source: "github",
    detail: updateAvailable
      ? `engine runtime ${manifest.version} is available (running ${currentVersion})`
      : `running engine runtime ${currentVersion} is current`,
  };
}

export interface AssetDownloads {
  name: string;
  downloads: number;
}

export interface InstallStats {
  github: {
    totalDownloads: number | null;
    perAsset: AssetDownloads[];
    releases: number | null;
    detail: string;
  };
  npm: {
    lastMonth: number | null;
    detail: string;
  };
}

/**
 * Owner-facing install counter (D23): GitHub asset download_count summed across
 * releases + the npm last-month downloads point. Read-only, no infra, no ping.
 * A failed source reports null + a reason — never a fabricated zero.
 */
export async function releaseStats(opts?: { fetchImpl?: FetchLike }): Promise<InstallStats> {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const github: InstallStats["github"] = {
    totalDownloads: null,
    perAsset: [],
    releases: null,
    detail: "",
  };
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`,
      {
        headers: GH_HEADERS,
      },
    );
    if (!res.ok) {
      github.detail = `GitHub releases API returned HTTP ${res.status}`;
    } else {
      const releases = (await res.json()) as {
        assets?: { name?: string; download_count?: number }[];
      }[];
      const perAsset = new Map<string, number>();
      let total = 0;
      for (const release of releases) {
        for (const asset of release.assets ?? []) {
          const count = typeof asset.download_count === "number" ? asset.download_count : 0;
          const name = typeof asset.name === "string" ? asset.name : "(unnamed)";
          perAsset.set(name, (perAsset.get(name) ?? 0) + count);
          total += count;
        }
      }
      github.totalDownloads = total;
      github.releases = releases.length;
      github.perAsset = [...perAsset.entries()]
        .map(([name, downloads]) => ({ name, downloads }))
        .sort((a, b) => b.downloads - a.downloads);
      github.detail = `${total} asset downloads across ${releases.length} releases`;
    }
  } catch (error) {
    github.detail = `could not reach the GitHub releases API (${describeError(error)})`;
  }

  const npm: InstallStats["npm"] = { lastMonth: null, detail: "" };
  try {
    const res = await fetchImpl(`https://api.npmjs.org/downloads/point/last-month/${NPM_PACKAGE}`, {
      headers: { "User-Agent": GH_HEADERS["User-Agent"] },
    });
    if (!res.ok) {
      npm.detail = `npm downloads API returned HTTP ${res.status}`;
    } else {
      const body = (await res.json()) as { downloads?: number };
      if (typeof body.downloads === "number") {
        npm.lastMonth = body.downloads;
        npm.detail = `${body.downloads} npm downloads in the last month`;
      } else {
        npm.detail = "npm downloads API returned no count";
      }
    }
  } catch (error) {
    npm.detail = `could not reach the npm downloads API (${describeError(error)})`;
  }

  return { github, npm };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function status(code: number): string {
  if (code === -1) return "check failed (network)";
  if (code === 404) return "404 (free)";
  if (code === 200) return "200 (taken)";
  if (code === 403) return "403 (forbidden — availability unknown)";
  return `http ${code} (unknown)`;
}
