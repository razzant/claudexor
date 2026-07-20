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
import type { ControlHarnessAccounts, QuotaSnapshot } from "@claudexor/schema";
import { loadConfig } from "@claudexor/config";
import { nextUpIdentity } from "@claudexor/orchestrator";
import { buildGateway, buildRegistry } from "./registry.js";

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
