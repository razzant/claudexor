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
 * The oldest agy in which file edits still ask under a `strict` tool
 * permission with accept-edits (1.5.7 release notes). Before it the mode a
 * workspace_write run passes could approve edits a strict profile asks about,
 * so such a profile, or one whose settings cannot be read, is not run on an
 * older or undetermined version. From it a strict profile is admitted, but its
 * edits still ask, which a headless run cannot answer. A workspace_write run
 * sends session-only settings only from this version: here they can carry a
 * read grant the profile could not save; the terminal request needs 1.5.8.
 */
export const AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION = "1.5.7";

/**
 * The oldest agy whose headless `workspace_write` (`--mode accept-edits`) run
 * requests the terminal sandbox through session-only `--settings`
 * (session-policy.ts); an older or undetermined version still edits files,
 * without the request. It is the first release with every fact the request
 * relies on: `--settings` itself (1.4.10, above); `proceed-in-sandbox` asking
 * like `request-review` where the sandbox cannot run (vendor sandbox page,
 * from 1.4.4); file edits still asking under `strict` (1.5.7, above); and the
 * 1.5.8 security fix in the sandbox's network proxy, with its fix for headless
 * runs that ignored Gemini Enterprise admin controls (1.5.8 release notes).
 * Before it a saved permission for every shell command could override those
 * controls, so such a profile, or one whose settings cannot be checked, is not
 * run on an older or undetermined version (session-policy.ts).
 * For the live macOS edit-and-test check and its scope, see the Antigravity
 * section of docs/INTEGRATIONS.md.
 */
export const AGY_WORKSPACE_WRITE_MIN_CLI_VERSION = "1.5.8";

/** The version token of `--version` output, with its prerelease tag when it has one. */
export function extractAgySemver(raw: string | null): string | null {
  return raw?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
}

/** `installed` against the release `minimum`; null when `installed` is not a
 * version. A prerelease precedes its own release and follows every earlier one. */
export function isAgyVersionAtLeast(installed: string | null, minimum: string): boolean | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(installed ?? "");
  const floor = /^(\d+)\.(\d+)\.(\d+)$/.exec(minimum);
  if (!match || !floor) return null;
  const order =
    Number(match[1]) - Number(floor[1]) ||
    Number(match[2]) - Number(floor[2]) ||
    Number(match[3]) - Number(floor[3]);
  return order > 0 || (order === 0 && !match[4]);
}

/** What a workspace_write run may rely on from the agy it launches; every fact
 * is false when the version is older or undetermined. */
export type AgyWorkspaceWriteCli = {
  installed: string | null;
  determined: boolean;
  /** File edits still ask under a profile's `strict` with accept-edits (1.5.7);
   * also the floor for any workspace_write session file. */
  strictKept: boolean;
  /** The terminal sandbox request through session-only `--settings`, and
   * headless runs that apply Gemini Enterprise admin controls (1.5.8). */
  terminal: boolean;
};

export function agyWorkspaceWriteCliFacts(installed: string | null): AgyWorkspaceWriteCli {
  const at = (minimum: string) => isAgyVersionAtLeast(installed, minimum);
  return {
    installed,
    determined: at(AGY_WORKSPACE_WRITE_MIN_CLI_VERSION) !== null,
    strictKept: at(AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION) === true,
    terminal: at(AGY_WORKSPACE_WRITE_MIN_CLI_VERSION) === true,
  };
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

/** The doctor's statement of the workspace_write minimums for an installed version. */
export function agyWorkspaceWriteDoctorCheck(installed: string | null): {
  id: "workspace_write_min_version";
  status: "pass" | "fail" | "skip";
  detail: string;
} {
  const strictKept = isAgyVersionAtLeast(installed, AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION);
  return versionDoctorCheck(
    "workspace_write_min_version",
    `workspace_write runs ask for agy's terminal sandbox for shell commands only on agy ${AGY_WORKSPACE_WRITE_MIN_CLI_VERSION} or newer, and only when each of the profile's two terminal settings is unset or already holds the requested value; the adapter adds no command, write or network permission of its own. They admit a profile set to strict only on agy ${AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION} or newer, where file edits still ask under strict, and one that saved command(*) or always-proceed, or whose settings cannot be checked, only on agy ${AGY_WORKSPACE_WRITE_MIN_CLI_VERSION} or newer, where headless runs apply Gemini Enterprise admin controls; full runs do not depend on either`,
    installed,
    AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
    `installed ${installed} runs workspace_write without that request: file edits follow accept-edits within the profile's settings, and a shell command agy would ask about is denied without asking, which can end a headless turn; Claudexor refuses ${strictKept === false ? "a strict profile, " : ""}a profile that saved command(*) or always-proceed, or one whose settings cannot be checked, before anything is sent; update agy`,
  );
}
