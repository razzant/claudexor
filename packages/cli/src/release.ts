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

  const npmScoped = await head(`https://registry.npmjs.org/${encodeURIComponent("@" + lc + "/cli")}`);
  checks.push({ registry: "npm (@scope/cli)", availability: availability(npmScoped), detail: status(npmScoped) });

  const pypi = await head(`https://pypi.org/pypi/${encodeURIComponent(lc)}/json`);
  checks.push({ registry: "pypi", availability: availability(pypi), detail: status(pypi) });

  const crates = await head(`https://crates.io/api/v1/crates/${encodeURIComponent(lc)}`);
  checks.push({ registry: "crates.io", availability: availability(crates), detail: status(crates) });

  const ghUser = await head(`https://github.com/${encodeURIComponent(lc)}`);
  checks.push({ registry: "github org/user", availability: availability(ghUser), detail: status(ghUser) });

  return checks;
}

function availability(code: number): NameAvailability {
  if (code === 404) return "free";
  if (code === 200) return "taken";
  return "unknown";
}

function status(code: number): string {
  if (code === -1) return "check failed (network)";
  if (code === 404) return "404 (free)";
  if (code === 200) return "200 (taken)";
  if (code === 403) return "403 (forbidden — availability unknown)";
  return `http ${code} (unknown)`;
}
