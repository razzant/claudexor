/**
 * Per-harness ACCOUNTS AUTHORITY projection (INV-135): the native "CLI login"
 * pseudo-row state and the server-computed Active identity, built ONCE on the
 * server so no surface (CLI, macOS) re-derives the accounts symmetry.
 * Native-login detection reads the cached doctor status (a `native_session`
 * source reported available); a probe failure is an honest "not detected",
 * never a thrown listing.
 */
import type { ControlHarnessAccounts } from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import { buildGateway, buildRegistry } from "./registry.js";

export async function harnessAccountsProjection(
  repoRoot: string,
): Promise<ControlHarnessAccounts[]> {
  const cfg = loadConfig(repoRoot).global;
  const harnessIds = [...buildRegistry({ includeFakes: false }).keys()].sort();
  const nativeDetected = new Map<string, boolean>();
  try {
    const statuses = await buildGateway({ includeFakes: false }).statusAll(
      { cwd: repoRoot, fresh: false },
      harnessIds,
    );
    for (const s of statuses) {
      nativeDetected.set(
        s.id,
        s.authSources.some(
          (src) => src.source === "native_session" && src.availability === "available",
        ),
      );
    }
  } catch {
    // Doctor probe unavailable: every harness reports "native not detected"
    // rather than failing the whole accounts listing.
  }
  return harnessIds.map((harnessId): ControlHarnessAccounts => {
    const h = cfg.harnesses[harnessId];
    const activeProfileId = h?.active_profile_id ?? null;
    const nativeEnabled = h?.native_credentials_enabled ?? true;
    return {
      harness_id: harnessId,
      active_profile_id: activeProfileId,
      native_credentials_enabled: nativeEnabled,
      native_login_detected: nativeDetected.get(harnessId) ?? false,
      active_identity: activeIdentity(
        cfg.credential_profiles,
        harnessId,
        activeProfileId,
        nativeEnabled,
      ),
    };
  });
}

function activeIdentity(
  profiles: ReadonlyArray<{ harness_id: string; profile_id: string; enabled: boolean }>,
  harnessId: string,
  activeProfileId: string | null,
  nativeEnabled: boolean,
): ControlHarnessAccounts["active_identity"] {
  if (activeProfileId !== null) {
    const match = profiles.find(
      (p) => p.harness_id === harnessId && p.profile_id === activeProfileId,
    );
    if (!match)
      return { kind: "none", reason: `active account "${activeProfileId}" is not registered` };
    if (!match.enabled)
      return { kind: "none", reason: `active account "${activeProfileId}" is disabled` };
    return { kind: "profile", profileId: activeProfileId };
  }
  if (nativeEnabled) return { kind: "native" };
  return { kind: "none", reason: "no Active account and the CLI login is disabled" };
}
