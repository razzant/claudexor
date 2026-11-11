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
 * run without a model, 8 Nov 2026 UTC). Full and workspace_write runs do not pass it.
 */
export const AGY_READONLY_MIN_CLI_VERSION = "1.4.10";

/** The doctor's statement of the readonly minimum for an installed version
 * (`null`: the version is unknown, and nothing is claimed about it). */
export function agyReadonlyDoctorCheck(installed: string | null): {
  id: "readonly_min_version";
  status: "pass" | "fail" | "skip";
  detail: string;
} {
  const need = `readonly runs need agy ${AGY_READONLY_MIN_CLI_VERSION} or newer for session-only settings; full and workspace_write runs do not`;
  const parts = installed?.split(".").map(Number);
  const min = AGY_READONLY_MIN_CLI_VERSION.split(".").map(Number);
  if (!parts || parts.length !== 3 || parts.some((n) => !Number.isInteger(n)))
    return {
      id: "readonly_min_version",
      status: "skip",
      detail: `${need} (installed version unknown)`,
    };
  const order = parts[0]! - min[0]! || parts[1]! - min[1]! || parts[2]! - min[2]!;
  return order >= 0
    ? { id: "readonly_min_version", status: "pass", detail: `${need} (installed ${installed})` }
    : {
        id: "readonly_min_version",
        status: "fail",
        detail: `${need}: installed ${installed} stops readonly runs before the model; update agy`,
      };
}
