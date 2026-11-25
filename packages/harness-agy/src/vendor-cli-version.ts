import type { VendorCliVersionStamp } from "@claudexor/util";

/**
 * The Antigravity version used to record model hints, fixtures and the
 * file-token-fallback proof. It is a provenance stamp, not an installed-version
 * requirement. Re-prove profile transport when changing its recorded evidence.
 * Darwin profile keychain preparation still precedes native execution; vendor
 * fallback remains vendor-owned recovery behavior (INV-067, INV-135).
 */
export const AGY_VENDOR_CLI_VERSION: VendorCliVersionStamp = "1.1.13";

/**
 * The oldest agy that accepts session-only `--settings`, which every readonly
 * run needs to deny commands and writes (#653). A separate fact from the
 * fixture and transport stamp above, which it does not requalify: official
 * 1.1.13 and the tested releases from 1.3.4 through 1.4.9 reject the flag while
 * parsing arguments; 1.4.10 through 1.5.3 accept it (official macOS binaries
 * run without a model, 8 Nov 2026 UTC). Full runs do not pass it.
 */
export const AGY_READONLY_MIN_CLI_VERSION = "1.4.10";

/**
 * The oldest agy that safely supports session-only `--settings` granting
 * `command(*)` in headless `workspace_write` (`--mode accept-edits`) runs while
 * preserving profile Deny/Ask rules and enterprise/admin policy overrides.
 */
export const AGY_WORKSPACE_WRITE_MIN_CLI_VERSION = "1.5.7";

/** Extract a version token from `--version` output, keeping prerelease tags so they do not satisfy release floors. */
export function extractAgySemver(raw: string | null): string | null {
  return raw?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

/** Parse a bare `X.Y.Z` semver string into numeric components, or null if unknown/prerelease. */
function parseSemverTriplet(version: string | null): [number, number, number] | null {
  if (!version) return null;
  const parts = version.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const nums = parts.map(Number);
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** Compare `installed` against `minimum`; null when `installed` is unknown. */
export function isAgyVersionAtLeast(installed: string | null, minimum: string): boolean | null {
  const actual = parseSemverTriplet(installed);
  const floor = parseSemverTriplet(minimum);
  if (!actual || !floor) return null;
  const order = actual[0] - floor[0] || actual[1] - floor[1] || actual[2] - floor[2];
  return order >= 0;
}

function versionDoctorCheck<Id extends string>(
  id: Id,
  need: string,
  installed: string | null,
  minimum: string,
  failImpact: string,
): { id: Id; status: "pass" | "fail" | "skip"; detail: string } {
  const meets = isAgyVersionAtLeast(installed, minimum);
  if (meets === null) return { id, status: "skip", detail: `${need} (installed version unknown)` };
  return meets
    ? { id, status: "pass", detail: `${need} (installed ${installed})` }
    : { id, status: "fail", detail: `${need}: ${failImpact}` };
}

/** The doctor's statement of the readonly minimum for an installed version
 * (`null`: the version is unknown, and nothing is claimed about it). */
export function agyReadonlyDoctorCheck(installed: string | null): {
  id: "readonly_min_version";
  status: "pass" | "fail" | "skip";
  detail: string;
} {
  return versionDoctorCheck(
    "readonly_min_version",
    `readonly runs need agy ${AGY_READONLY_MIN_CLI_VERSION} or newer for session-only settings; full runs do not`,
    installed,
    AGY_READONLY_MIN_CLI_VERSION,
    `installed ${installed} stops readonly runs before the model; update agy`,
  );
}

/** The doctor's statement of the workspace_write minimum for an installed version. */
export function agyWorkspaceWriteDoctorCheck(installed: string | null): {
  id: "workspace_write_min_version";
  status: "pass" | "fail" | "skip";
  detail: string;
} {
  return versionDoctorCheck(
    "workspace_write_min_version",
    `workspace_write runs need agy ${AGY_WORKSPACE_WRITE_MIN_CLI_VERSION} or newer for session-only settings; full runs do not`,
    installed,
    AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
    `installed ${installed} stops workspace_write runs before the model; update agy`,
  );
}
