export interface NameCheck {
  registry: string;
  available: boolean;
  detail: string;
}

async function head(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status;
  } catch (err) {
    return -1;
  }
}

/**
 * Naming gate: best-effort availability check across registries. A 404 means the
 * name appears free; 200 means taken; -1 means the check could not run.
 */
export async function checkName(name: string): Promise<NameCheck[]> {
  const lc = name.toLowerCase();
  const checks: NameCheck[] = [];

  const npm = await head(`https://registry.npmjs.org/${encodeURIComponent(lc)}`);
  checks.push({ registry: "npm", available: npm === 404, detail: status(npm) });

  const npmScoped = await head(`https://registry.npmjs.org/${encodeURIComponent("@" + lc + "/cli")}`);
  checks.push({ registry: "npm (@scope/cli)", available: npmScoped === 404, detail: status(npmScoped) });

  const pypi = await head(`https://pypi.org/pypi/${encodeURIComponent(lc)}/json`);
  checks.push({ registry: "pypi", available: pypi === 404, detail: status(pypi) });

  const crates = await head(`https://crates.io/api/v1/crates/${encodeURIComponent(lc)}`);
  checks.push({ registry: "crates.io", available: crates === 404, detail: status(crates) });

  const ghUser = await head(`https://github.com/${encodeURIComponent(lc)}`);
  checks.push({ registry: "github org/user", available: ghUser === 404, detail: status(ghUser) });

  return checks;
}

function status(code: number): string {
  if (code === -1) return "check failed (network)";
  if (code === 404) return "404 (free)";
  if (code === 200) return "200 (taken)";
  return `http ${code}`;
}
