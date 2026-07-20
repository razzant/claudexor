/**
 * Per-harness ACCOUNTS AUTHORITY projection (INV-135): the native "CLI login"
 * pseudo-row state and the informational `next_up` identity (who an UNPINNED
 * run would route to next), built ONCE on the server so no surface (CLI, macOS)
 * re-derives the accounts symmetry. Native-login detection reads the cached
 * doctor status (a `native_session` source reported available); a probe failure
 * is an honest "not detected", never a thrown listing. `next_up` is computed by
 * the routing owner (`nextUpIdentity`) from enabled profiles + native readiness
 * + quota, so it can never disagree with run-time admission.
 */
import type {
  AccountIdentity,
  ControlHarnessAccounts,
  CredentialProfile,
  CredentialProfileStatus,
  QuotaSnapshot,
} from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import { nextUpIdentity } from "@claudexor/orchestrator";
import { codexAccountIdentity, defaultNativeCodexHome } from "@claudexor/harness-codex";
import { claudeAccountIdentity, defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { buildGateway, buildRegistry } from "./registry.js";

/**
 * Non-secret {email, plan} of a harness's NATIVE/CLI login, read daemon-side
 * from the Claudexor-owned native store (never the ordinary vendor home). Only
 * the config_dir_login families (codex, claude) have a readable native store;
 * every other harness projects no native identity.
 */
function nativeAccountIdentity(harnessId: string): AccountIdentity | null {
  if (harnessId === "codex") return codexAccountIdentity(defaultNativeCodexHome());
  if (harnessId === "claude") return claudeAccountIdentity(defaultNativeClaudeConfigDir());
  return null;
}

/**
 * Non-secret {email, plan} of a config_dir_login PROFILE, read daemon-side from
 * the profile's OWN isolation-locator store (INV-067) — never the ordinary
 * vendor home. Secret-ref profiles (no isolation_locator) and non-config_dir
 * families project no identity.
 */
export function profileAccountIdentity(profile: CredentialProfile): AccountIdentity | null {
  if (!profile.isolation_locator) return null;
  if (profile.harness_id === "codex") return codexAccountIdentity(profile.isolation_locator);
  if (profile.harness_id === "claude") return claudeAccountIdentity(profile.isolation_locator);
  return null;
}

/**
 * Doctor readiness projection for one credential profile (INV-135) — the ONE
 * live probe the accounts response and the profile mutation receipts share.
 * Adapters without profile support report an honest unknown.
 */
export async function profileDoctorStatus(
  profile: CredentialProfile,
): Promise<CredentialProfileStatus> {
  const adapter = buildRegistry().get(profile.harness_id);
  return adapter?.probeCredentialProfile
    ? adapter.probeCredentialProfile(profile)
    : {
        profile_id: profile.profile_id,
        harness_id: profile.harness_id,
        availability: "unknown" as const,
        verification: "not_run" as const,
        detail: `harness "${profile.harness_id}" has no profile probe`,
        last_verified_at: null,
      };
}

export async function harnessAccountsProjection(
  repoRoot: string,
  quotaSnapshots: readonly QuotaSnapshot[] = [],
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
    const nativeEnabled = h?.native_credentials_enabled ?? true;
    return {
      harness_id: harnessId,
      native_credentials_enabled: nativeEnabled,
      native_login_detected: nativeDetected.get(harnessId) ?? false,
      identity: nativeAccountIdentity(harnessId),
      // The routing owner computes who an unpinned run routes to next — the
      // accounts projection never re-derives it (INV-135).
      next_up: nextUpIdentity({
        registry: cfg.credential_profiles,
        harnessId,
        policy: h?.profile_policy ?? {
          limit_action: "fail",
          rotation_eligible: [],
          headroom_threshold: 0.9,
        },
        snapshots: quotaSnapshots,
        nativeEnabled,
      }),
    };
  });
}
