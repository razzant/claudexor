import { readdir } from "node:fs/promises";

export type DataRootMode = "default" | "override";

/**
 * Exact top-level names the engine (or its documented operator surface) owns
 * in BOTH data-root modes. The default root retains these legacy top-level
 * names from pre-generation layouts; an explicit override is itself the
 * complete active root and owns the same direct names. Everything else is
 * foreign debris. Dotfiles are treated as config/service files and omitted.
 */
const COMMON_ROOT_OWNED_ENTRIES = new Set([
  // current engine + documented operator dirs
  "node",
  "profiles",
  "runtime",
  "cache",
  "dogfood",
  "keys",
  "release-authority",
  "planning",
  "remote",
  // legacy engine generations kept as the archive (owner decision, v3.0.0)
  "daemon",
  "projects",
  "native",
  "runs",
  "trust",
  "telemetry",
  // config files
  "config.yaml",
]);
/**
 * Mode-specific owned names. The default root owns the archived v2 generation
 * and active v3 generation. An explicit CLAUDEXOR_CONFIG_DIR override is the
 * complete active tree: it owns direct secrets/plugins/quota/workspaces but no
 * generation children. v1-era data was unversioned directly under the default
 * root, so neither mode owns a `v1` child.
 */
const ROOT_OWNED_ENTRIES_BY_MODE: Record<DataRootMode, ReadonlySet<string>> = {
  default: new Set([...COMMON_ROOT_OWNED_ENTRIES, "v2", "v3"]),
  override: new Set([
    ...COMMON_ROOT_OWNED_ENTRIES,
    "secrets.json",
    "plugins",
    "quota",
    "workspaces",
    // Explicitly ephemeral one-shot runs and their envelopes (#503).
    "one-shot",
  ]),
};
/** Owned names the engine expects as plain FILES; every other owned name is a directory. */
const ENGINE_OWNED_FILE_ENTRIES = new Set(["config.yaml", "secrets.json"]);

/**
 * Names of top-level data-root entries the engine does not own (the full
 * sorted list — advisory disclosure, never a deletion surface), classified
 * against the owned set for the injected root mode. An entry whose NAME the
 * engine owns but whose on-disk kind is wrong — a symbolic link of any owned
 * name (dirents are read WITHOUT following links), a non-directory where the
 * engine expects a directory, or a non-file where it expects a plain file —
 * is reported as `<name> (unexpected-kind)`. Throws on an unreadable root —
 * the caller degrades that to an errors[] entry and an ABSENT field, never a
 * misleading empty list and never a failed pass.
 */
export async function scanDataRootUnrecognized(
  dataRoot: string,
  mode: DataRootMode,
): Promise<string[]> {
  const owned = ROOT_OWNED_ENTRIES_BY_MODE[mode];
  const report: string[] = [];
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (!owned.has(name)) {
      report.push(name);
      continue;
    }
    const kindOk =
      !entry.isSymbolicLink() &&
      (ENGINE_OWNED_FILE_ENTRIES.has(name) ? entry.isFile() : entry.isDirectory());
    if (!kindOk) report.push(`${name} (unexpected-kind)`);
  }
  return report.sort();
}
