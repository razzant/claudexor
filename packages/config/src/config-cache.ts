import { readFileSync, statSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import type { ResolvedConfig } from "@claudexor/schema";

const parsedConfigs = new Map<string, { key: string; config: ResolvedConfig }>();

/**
 * Per-request config cache behind `loadConfigCached`. It parses again only
 * when a resolved source path, a source file's identity (device, inode, size,
 * mtime, ctime, taken before parsing) or a CLAUDEXOR_* environment value
 * changed; each call still returns a private copy. Unreadable sources and
 * failed parses are never cached, so they behave exactly like `loadConfig`.
 */
export function cachedLoad(
  repoRoot: string,
  paths: readonly string[],
  load: () => ResolvedConfig,
): ResolvedConfig {
  let key: string;
  let present: string[];
  try {
    const stats = paths.map((path) => statSync(path, { bigint: true, throwIfNoEntry: false }));
    present = paths.filter((_, i) => (stats[i]?.size ?? 0n) > 0n);
    key = JSON.stringify([
      paths.map((path, i) => {
        const s = stats[i];
        return [path, s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null];
      }),
      Object.entries(process.env)
        .filter(([name]) => name.startsWith("CLAUDEXOR_"))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);
  } catch {
    return load();
  }
  const cached = parsedConfigs.get(repoRoot);
  if (cached?.key === key) return structuredClone(cached.config);
  const config = load();
  // A non-empty source that loaded nothing either holds no YAML value or was unreadable (the
  // reader turns EMFILE/EACCES into "absent"); caching the latter would freeze defaults under
  // an unchanged identity, so only a source that really reads as no value stays cacheable.
  if (present.some((path) => !config.sources.includes(path) && !holdsNoYamlValue(path)))
    return config;
  if (parsedConfigs.size >= 16) parsedConfigs.clear();
  parsedConfigs.set(repoRoot, { key, config: structuredClone(config) });
  return config;
}

/** Does this file read successfully as no YAML value (blank, comments only, `null`)? */
function holdsNoYamlValue(path: string): boolean {
  try {
    return yamlParse(readFileSync(path, "utf8")) == null;
  } catch {
    return false;
  }
}
