import { randomUUID } from "node:crypto";
import { loadConfigCached } from "@claudexor/config";
import {
  canonicalCursorProfileHome,
  readCursorDashboard,
  CursorDashboardError,
} from "@claudexor/harness-cursor";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import { emptyResourceFacet, type CredentialProfile, type QuotaSubject } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { parseCursorResources } from "./cursor-quota-parse.js";
import {
  emitQuotaDiagnostic,
  type QuotaDiagnosticSink,
  type QuotaRefreshDiagnostic,
} from "./quota-refresh-diagnostics.js";

/** Resource-only source registered with the existing quota refresh lifecycle.
 * No invented quota windows: observed monetary balances never decide routing. */
export async function refreshCursorQuota(
  options: {
    profiles?: readonly CredentialProfile[];
    request?: typeof readCursorDashboard;
    now?: () => Date;
    diagnostic?: QuotaDiagnosticSink;
  } = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  const resources: NonNullable<QuotaRefreshResult["resources"]> = [];
  const now = options.now ?? (() => new Date());
  const profiles =
    options.profiles ?? loadConfigCached(noProjectRepoRoot()).global.credential_profiles;
  for (const profile of profiles) {
    if (profile.harness_id !== "cursor" || profile.credential_kind !== "config_dir_login") continue;
    if (
      cycle?.target
        ? cycle.target.harness !== "cursor" || cycle.target.profile_id !== profile.profile_id
        : !profile.enabled
    )
      continue;
    const subject: QuotaSubject = {
      harness: "cursor",
      credential_route: "vendor_native",
      subject_id: profile.profile_id,
      plan_label: null,
    };
    if (
      cycle?.shouldRefresh?.(subject) === false ||
      cycle?.pacing?.cooldownUntil(subject, now().getTime()) != null
    )
      continue;
    const base = {
      operationId: randomUUID(),
      source: "cursor_dashboard",
      profileId: profile.profile_id,
      foreground: cycle?.foreground ?? false,
      credentialEpoch: null,
      current: null,
      stage: "usage_http" as const,
    };
    const diagnostic = (
      outcome: QuotaRefreshDiagnostic["outcome"],
      at: Date,
      detail: Partial<QuotaRefreshDiagnostic> = {},
    ) =>
      emitQuotaDiagnostic(options.diagnostic, {
        ...base,
        at: at.toISOString(),
        outcome,
        ...detail,
      });
    diagnostic("started", now());
    try {
      canonicalCursorProfileHome(profile.isolation_locator ?? "");
      const raw = await (options.request ?? readCursorDashboard)(profile);
      const at = now();
      diagnostic("succeeded", at);
      resources.push(parseCursorResources(raw, profile.profile_id, at));
    } catch (error) {
      // Retry-After is relative to receipt of the response, not dispatch. A slow
      // request must not consume the provider's entire cooldown before it starts.
      const at = now();
      const reason =
        error instanceof CursorDashboardError ? error.message : "cursor_dashboard_read_failed";
      diagnostic("failed", at, {
        reason,
        ...(error instanceof CursorDashboardError
          ? {
              ...(error.status === null ? {} : { httpStatus: error.status }),
              retryAfterMs: error.retryAfterMs,
            }
          : {}),
      });
      if (error instanceof CursorDashboardError && error.status === 429)
        cycle?.pacing?.noteRateLimited(subject, at.getTime(), error.retryAfterMs);
      // Keep existing successful values and their own clocks through the resource
      // merge owner. No arbitrary error text or credential is persisted.
      resources.push({
        target: { harness: "cursor", profile_id: profile.profile_id },
        balances: {
          ...emptyResourceFacet(),
          last_attempt_at: at.toISOString(),
          last_error: reason,
        },
        spending: {
          ...emptyResourceFacet(),
          last_attempt_at: at.toISOString(),
          last_error: reason,
        },
      });
    }
  }
  return { snapshots: [], resources };
}
