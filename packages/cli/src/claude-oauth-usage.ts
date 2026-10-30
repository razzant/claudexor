import { parseClaudeOauthUsage } from "./claude-oauth-codec.js";
export { parseClaudeOauthUsage } from "./claude-oauth-codec.js";
import { randomUUID } from "node:crypto";
import {
  readClaudeOauthCredential,
  readClaudeOauthOrganization,
  taggedRefreshFailure,
  type ClaudeOauthCredential,
} from "./claude-oauth-credential.js";
import { loadConfig } from "@claudexor/config";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import {
  canonicalProfileConfigDir,
  detectClaudeVersion,
  CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED,
  claudeNativeEnv,
  claudeOauthAccessTokenIsFresh,
  defaultNativeClaudeConfigDir,
  refreshClaudeNativeAuth,
} from "@claudexor/harness-claude";
import {
  emptyResourceFacet,
  type AccountResourceObservation,
  type QuotaAbsence,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";
import { noProjectRepoRoot, sha256 } from "@claudexor/util";
import { fetchClaudeOauthUsage } from "./claude-oauth-fetch.js";
import { readAccountsMigrationFile } from "./accounts-unified-migration.js";
import {
  emitQuotaDiagnostic,
  unknownQuotaScopeReason,
  type QuotaDiagnosticSink,
  type QuotaRefreshDiagnostic,
} from "./quota-refresh-diagnostics.js";

import { claudeResourceHeaders } from "./claude-resource-transport.js";
import { observeClaudeAccountResources } from "./claude-resource-source.js";

const SOURCE = "claude_oauth_usage" as const;

/** Full subscription inventory from oauth/usage, independent of passive stream
 * windows. Access material from claude-oauth-credential stays transient for one
 * serial refresh cycle. Claude Code owns renewal and persistence; diagnostics contain only
 * expiry/presence and physical operation receipts, never credentials. */

/** A vendor rejection remembered per PRESENTED token (INV-146: the token's
 * hash, never the token; process memory only; never persisted or logged).
 * Re-presenting a proven rejection needlessly uses endpoint capacity. Usage
 * reads have returned one-hour Retry-After pauses, whose vendor-lane floor
 * also delays healthy siblings; that is not a measured global request budget.
 * So a
 * background cycle re-states the typed `auth_revoked` absence for a
 * remembered token WITHOUT an HTTP request — the same doctrine as the codex
 * source's logged-out precheck — until the token bytes change (any re-login,
 * daemon-side or external), a daemon-side credential change clears the
 * memory (`forgetClaudeOauthRejections`), an explicit foreground refresh
 * re-asks, or the safety TTL below elapses (bounds a spurious vendor 401) —
 * and then ONE remembered token is re-verified per cycle, never all at once:
 * N dead tokens expiring together must not become an N-request burst, the
 * very storm the memory exists to prevent. The memory is bounded by recent
 * rejection churn: each cycle releases the oldest expired entry whether or
 * not its token is still presented, so an entry lives at most the TTL plus
 * one cycle per older expired sibling. */
const REVOKED_TOKEN_REPROBE_MS = 6 * 60 * 60_000;
const rejectedTokens = new Map<string, number>();
/** Bumped by every forget: a cycle that started before a credential change
 * must not restore a rejection it observed with the pre-change credentials
 * (the same fence the registry's credential generation gives its own writes). */
let rejectionEpoch = 0;

/** Daemon-side credential change (login/logout/profile mutation): every
 * remembered rejection is re-verified on the next cycle. Fail-open by
 * contract — over-clearing costs at most one probe. */
export function forgetClaudeOauthRejections(): void {
  rejectedTokens.clear();
  rejectionEpoch += 1;
}

/** Release the OLDEST expired entry (age past the TTL, or a negative age
 * after a wall-clock step) so its token is re-verified this cycle; younger
 * expired siblings wait for a later cycle. */
function releaseExpiredRejection(nowMs: number): void {
  let oldest: [string, number] | null = null;
  for (const entry of rejectedTokens) {
    const age = nowMs - entry[1];
    if (age < REVOKED_TOKEN_REPROBE_MS && age >= 0) continue;
    if (oldest === null || entry[1] < oldest[1]) oldest = entry;
  }
  if (oldest !== null) rejectedTokens.delete(oldest[0]);
}

const VENDOR_REFRESH_REQUIRED_DETAIL =
  "OAuth access token freshness is unknown; Claude Code did not expose a refreshable expiry for quota reading";
const VENDOR_REFRESH_FAILED_DETAIL =
  "Claude Code's automatic OAuth refresh did not publish a fresh access token before quota reading";

/** Expiry and refresh-token PRESENCE are the only refresh metadata retained.
 * The refresh token itself never leaves the vendor credential body (INV-146). */
function needsVendorRefresh(credential: ClaudeOauthCredential, observedAt: Date): boolean {
  return (
    credential.hasRefreshToken &&
    credential.expiresAtMs !== null &&
    !claudeOauthAccessTokenIsFresh(credential.expiresAtMs, observedAt.getTime())
  );
}

export type ClaudeOauthCredentialRefresher = (
  configDir: string,
  platform: NodeJS.Platform,
  readCredential: typeof readClaudeOauthCredential,
  diagnostic?: NonNullable<Parameters<typeof refreshClaudeNativeAuth>[2]>["diagnostic"],
) => Promise<ClaudeOauthCredential | null>;

/** Keep refresh-token custody and store writes inside Claude Code. Claudexor
 * wakes the vendor's prompt-free MCP server, observes expiry metadata, then
 * re-reads the access token only after the vendor has published fresh state. */
async function refreshCredentialDefault(
  configDir: string,
  platform: NodeJS.Platform,
  readCredential: typeof readClaudeOauthCredential,
  diagnostic?: NonNullable<Parameters<typeof refreshClaudeNativeAuth>[2]>["diagnostic"],
): Promise<ClaudeOauthCredential | null> {
  const refreshed = await refreshClaudeNativeAuth(
    claudeNativeEnv(undefined, configDir),
    async () => (await readCredential(configDir, platform))?.expiresAtMs ?? null,
    { diagnostic },
  );
  if (!refreshed) throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
  const credential = await readCredential(configDir, platform);
  if (credential === null || !claudeOauthAccessTokenIsFresh(credential.expiresAtMs)) {
    throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
  }
  return credential;
}

export interface ClaudeOauthUsageDeps {
  readCredential: typeof readClaudeOauthCredential;
  refreshCredential: ClaudeOauthCredentialRefresher;
  fetchUsage: (accessToken: string) => Promise<unknown>;
  fetchRefill: (accessToken: string) => Promise<unknown>;
  fetchPrepaid: (accessToken: string, organization: string) => Promise<unknown>;
  readOrganization: typeof readClaudeOauthOrganization;
  now: () => Date;
  platform: NodeJS.Platform;
  diagnostic: QuotaDiagnosticSink;
}

function claudeOauthAbsence(
  subjectId: string | null,
  reason: QuotaAbsence["reason"],
  detail: string,
  observedAt: Date,
): QuotaAbsence {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    reason,
    detail,
    observed_at: observedAt.toISOString(),
  };
}

/** One subject per logged-in config dir: the default native dir (subject null)
 * plus every enabled claude config_dir_login profile (subject = profile_id).
 * The PRIMARY claude source (release cut V11a) — it owns the claude subject
 * universe, so every candidate resolves to a snapshot OR a typed absence:
 * a null credential is not_logged_in (on macOS the keychain read cannot tell
 * a missing item from an unavailable keychain, so its detail states both; off
 * macOS a missing credential file IS the vendor's logged-out state), a store
 * read fault is the tagged reason it carries, an expired refreshable token is
 * automatically refreshed by Claude Code without inference, and a fetch
 * refusal is refresh_failed unless a known-fresh credential is explicitly rejected.
 * A remembered rejection is re-stated without re-presenting the token on
 * background cycles (see `rejectedTokens`); a foreground cycle re-asks unless
 * its poll floor remains active.
 * Absence is stated, never inferred. */
export async function refreshClaudeOauthUsageQuota(
  deps: Partial<ClaudeOauthUsageDeps> = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  let nativeVersion: Promise<string | null> | undefined;
  const readNativeVersion = () => (nativeVersion ??= detectClaudeVersion());
  const readCredential = deps.readCredential ?? readClaudeOauthCredential;
  const refreshCredential = deps.refreshCredential ?? refreshCredentialDefault;
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  // Rejections observed by THIS cycle count only if no credential change
  // intervened; one expired memory is released for re-verification per cycle.
  const epoch = rejectionEpoch;
  const operationId = randomUUID();
  const report = (
    profileId: string | null,
    record: Pick<QuotaRefreshDiagnostic, "stage" | "outcome"> & Partial<QuotaRefreshDiagnostic>,
  ) => {
    if (!deps.diagnostic) return;
    emitQuotaDiagnostic(deps.diagnostic, {
      ...record,
      operationId,
      source: SOURCE,
      profileId,
      at: now().toISOString(),
      foreground: cycle?.foreground === true,
      credentialEpoch: epoch,
      current: epoch === rejectionEpoch,
    });
  };
  releaseExpiredRejection(now().getTime());
  const notLoggedInDetail =
    platform === "darwin"
      ? "no OAuth credential in the keychain item (no login, or the keychain tool is unavailable)"
      : "no vendor credential file in the config dir (not logged in)";
  // The retired null subject must not resurrect on refresh: a MIGRATED
  // harness's former default store IS its auto-registered row, which the
  // profile loop below covers — a null duplicate would re-create the retired
  // subject every cycle and double-probe one credential (mirrors
  // quotaSubjectUniverseFromConfig's use of the migration record).
  const candidates: Array<{ subjectId: string | null; configDir: string }> =
    !cycle?.target && readAccountsMigrationFile()["claude"] === undefined
      ? [{ subjectId: null, configDir: defaultNativeClaudeConfigDir() }]
      : [];
  for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
    if (
      profile.harness_id !== "claude" ||
      (cycle?.target
        ? cycle.target.harness !== "claude" || cycle.target.profile_id !== profile.profile_id
        : !profile.enabled)
    )
      continue;
    if (profile.credential_kind !== "config_dir_login" || !profile.isolation_locator) continue;
    try {
      candidates.push({
        subjectId: profile.profile_id,
        configDir: canonicalProfileConfigDir(profile.isolation_locator),
      });
    } catch {
      /* a mis-registered locator is a doctor problem, not a quota crash */
    }
  }
  const snapshots: QuotaSnapshot[] = [];
  const resources: AccountResourceObservation[] = [];
  const absences: QuotaAbsence[] = [];
  // Read all current identities before the serial HTTP pass so token-identical
  // aliases inherit a saved floor regardless of profile order after restart.
  const prepared: Array<{
    candidate: (typeof candidates)[number];
    credential: ClaudeOauthCredential;
  }> = [];
  for (const candidate of candidates) {
    let credential: ClaudeOauthCredential | null;
    try {
      credential = await readCredential(candidate.configDir, platform);
    } catch (error) {
      const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
      report(candidate.subjectId, {
        stage: "credential_read",
        outcome: "failed",
        reason: tagged ?? "refresh_failed",
      });
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          tagged ?? "refresh_failed",
          error instanceof Error ? error.message : String(error),
          now(),
        ),
      );
      continue;
    }
    if (!credential) {
      report(candidate.subjectId, {
        stage: "credential_read",
        outcome: "skipped",
        reason: "credential_absent_or_unreadable",
      });
      absences.push(
        claudeOauthAbsence(candidate.subjectId, "not_logged_in", notLoggedInDetail, now()),
      );
      continue;
    }
    prepared.push({ candidate, credential });
  }
  const subjectOf = (subjectId: string | null): QuotaSubject => ({
    harness: "claude",
    credential_route: "vendor_native",
    subject_id: subjectId,
    plan_label: null,
  });
  const bindCredentials = () =>
    cycle?.pacing?.bindCredentials(
      prepared.map(({ candidate, credential }) => ({
        subject: subjectOf(candidate.subjectId),
        credentialHash: sha256(credential.accessToken),
      })),
    );
  bindCredentials();
  const throttledTokens = new Set<string>();
  const skipPacedCredential = (subject: QuotaSubject, credential: ClaudeOauthCredential) => {
    const pacedUntil = cycle?.pacing?.cooldownUntil(subject, now().getTime());
    if (pacedUntil !== null && pacedUntil !== undefined) {
      report(subject.subject_id, {
        stage: "poll",
        outcome: "skipped",
        reason: "subject_rate_limited",
      });
      absences.push(
        claudeOauthAbsence(
          subject.subject_id,
          "poll_paced",
          `quota poll paused by rate-limit cooldown until ${new Date(pacedUntil).toISOString()}`,
          now(),
        ),
      );
      return true;
    }
    if (throttledTokens.has(sha256(credential.accessToken))) {
      report(subject.subject_id, {
        stage: "poll",
        outcome: "skipped",
        reason: "same_token_rate_limited",
      });
      absences.push(
        claudeOauthAbsence(
          subject.subject_id,
          "probe_skipped_rate_limited",
          "this token's oauth/usage probe hit the rate limit earlier in this cycle",
          now(),
        ),
      );
      return true;
    }
    return false;
  };
  for (const item of prepared) {
    const { candidate } = item;
    let { credential } = item;
    const subject = subjectOf(candidate.subjectId);
    if (skipPacedCredential(subject, credential)) continue;
    // Retain the existing snapshot and its observation time when another
    // account's retry caused this background lane cycle. All current aliases
    // were bound above, and poll floors have already been honored.
    if (cycle?.shouldRefresh?.(subject) === false) {
      report(candidate.subjectId, {
        stage: "poll",
        outcome: "skipped",
        reason: "primary_evidence_not_due",
      });
      continue;
    }
    let beforeRequest = now();
    if (needsVendorRefresh(credential, beforeRequest)) {
      const previousExpiresAtMs = credential.expiresAtMs;
      let nativeResult: QuotaRefreshDiagnostic["native"];
      report(candidate.subjectId, {
        stage: "native_refresh",
        outcome: "started",
        previousExpiresAtMs,
        hasRefreshToken: credential.hasRefreshToken,
      });
      const originalCredentialStillValid =
        credential.expiresAtMs !== null && credential.expiresAtMs > beforeRequest.getTime();
      try {
        const refreshed = await refreshCredential(
          candidate.configDir,
          platform,
          readCredential,
          (native) => {
            nativeResult = native;
          },
        );
        if (
          refreshed === null ||
          !claudeOauthAccessTokenIsFresh(refreshed.expiresAtMs, now().getTime())
        ) {
          throw taggedRefreshFailure(VENDOR_REFRESH_FAILED_DETAIL);
        }
        credential = refreshed;
        item.credential = refreshed;
        bindCredentials();
        report(candidate.subjectId, {
          stage: "native_refresh",
          outcome: "succeeded",
          reason: "fresh_expiry_observed_writer_unknown",
          previousExpiresAtMs,
          expiresAtMs: credential.expiresAtMs,
          native: nativeResult,
        });
        beforeRequest = now();
        // Refresh may have joined a token alias whose poll floor is already active.
        if (skipPacedCredential(subject, credential)) continue;
      } catch (error) {
        report(candidate.subjectId, {
          stage: "native_refresh",
          outcome: "failed",
          reason:
            (error as { code?: string })?.code === CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED
              ? "termination_unconfirmed"
              : "fresh_expiry_not_observed",
          previousExpiresAtMs,
          native: nativeResult,
        });
        // The five-minute wake is proactive. If Claude Code cannot refresh yet
        // but the presented access token is still unexpired, use that proven
        // token for this bounded request rather than hiding an available quota.
        const terminationUnconfirmed =
          (error as { code?: unknown })?.code === CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED;
        if (originalCredentialStillValid && !terminationUnconfirmed) {
          beforeRequest = now();
        } else {
          absences.push(
            claudeOauthAbsence(
              candidate.subjectId,
              "refresh_failed",
              error instanceof Error ? error.message : VENDOR_REFRESH_FAILED_DETAIL,
              now(),
            ),
          );
          continue;
        }
      }
    }
    const tokenKey = sha256(credential.accessToken);
    const rejectedAt = rejectedTokens.get(tokenKey);
    if (rejectedAt !== undefined && !cycle?.foreground) {
      report(candidate.subjectId, {
        stage: "poll",
        outcome: "skipped",
        reason: "presented_token_already_rejected",
      });
      // The SAME observation re-stated: its instant is the vendor's real
      // rejection time, not this cycle's clock (stable projection signature,
      // honest "revoked at" for downstream readers).
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          "auth_revoked",
          `oauth/usage rejected this token at ${new Date(rejectedAt).toISOString()}; not re-asked until the token changes, a login or profile change, an explicit refresh, or ${REVOKED_TOKEN_REPROBE_MS / 3_600_000} h elapse (then one remembered token is re-verified per cycle)`,
          new Date(rejectedAt),
        ),
      );
      continue;
    }
    let httpStatus: number | undefined;
    const fetchUsage =
      deps.fetchUsage ??
      (async (token: string) =>
        fetchClaudeOauthUsage(
          token,
          (status) => {
            httpStatus = status;
          },
          await claudeResourceHeaders(token, await readNativeVersion()),
        ));
    try {
      report(candidate.subjectId, {
        stage: "usage_http",
        outcome: "started",
        expiresAtMs: credential.expiresAtMs,
        hasRefreshToken: credential.hasRefreshToken,
      });
      const requestStartedAt = now();
      const usage = await fetchUsage(credential.accessToken);
      rejectedTokens.delete(tokenKey);
      if (candidate.subjectId !== null) {
        resources.push(
          await observeClaudeAccountResources({
            usage,
            profileId: candidate.subjectId,
            configDir: candidate.configDir,
            accessToken: credential.accessToken,
            requestStartedAt,
            deps,
            cycle,
            now,
            onRateLimited: () => throttledTokens.add(tokenKey),
            readNativeVersion,
          }),
        );
      }

      const unknown: string[] = [];
      const snapshot = parseClaudeOauthUsage(
        usage,
        candidate.subjectId,
        credential.subscriptionType,
        requestStartedAt,
        (window) => unknown.push(unknownQuotaScopeReason(window)),
      );
      // An unnamed scoped limit stays observed evidence here, never an
      // account-wide window, including when no known window made a snapshot.
      report(candidate.subjectId, {
        stage: "usage_http",
        outcome: snapshot ? "succeeded" : "failed",
        httpStatus,
        reason: [snapshot ? "windows_observed" : "no_parseable_windows", ...unknown].join("; "),
      });
      if (snapshot) snapshots.push(snapshot);
      else
        // BACKLOG Q-a (v3.0.3 S8): an HTTP 200 whose body parses to no quota
        // windows must yield a typed absence, never silent nothing — the
        // registry needs the observation to back off instead of re-polling.
        absences.push(
          claudeOauthAbsence(
            candidate.subjectId,
            "refresh_failed",
            unknown.length > 0
              ? "oauth/usage returned HTTP 200 with only windows of unknown model scope (not account-wide limits)"
              : "oauth/usage returned HTTP 200 without parseable quota windows",
            now(),
          ),
        );
    } catch (error) {
      // The fetch path carries typed reasons for a rejected presented token
      // (auth_revoked) and a throttled poll (rate_limited, with the vendor's
      // Retry-After floor when known). A refreshable credential whose freshness
      // cannot be proven at rejection time waits for Claude Code's vendor-owned
      // refresh instead of condemning the row. Anything untagged stays an
      // undiagnosed refresh failure.
      const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
      const retryAfterMs = (error as { retryAfterMs?: number | null })?.retryAfterMs;
      const observedAt = now();
      report(candidate.subjectId, {
        stage: "usage_http",
        outcome: "failed",
        httpStatus,
        reason: tagged ?? "refresh_failed",
        retryAfterMs,
      });
      const rejectedWithoutFreshnessProof =
        tagged === "auth_revoked" &&
        credential.hasRefreshToken &&
        (credential.expiresAtMs === null || needsVendorRefresh(credential, observedAt));
      // Only a PROVEN rejection is remembered: an unproven one waits for the
      // vendor-owned token refresh and is re-presented once that happened.
      if (tagged === "auth_revoked" && !rejectedWithoutFreshnessProof && epoch === rejectionEpoch) {
        rejectedTokens.set(tokenKey, observedAt.getTime());
      }
      absences.push({
        ...claudeOauthAbsence(
          candidate.subjectId,
          rejectedWithoutFreshnessProof ? "refresh_failed" : (tagged ?? "refresh_failed"),
          rejectedWithoutFreshnessProof
            ? VENDOR_REFRESH_REQUIRED_DETAIL
            : error instanceof Error
              ? error.message
              : String(error),
          observedAt,
        ),
        ...(typeof retryAfterMs === "number" && retryAfterMs >= 0
          ? { retry_after_ms: Math.round(retryAfterMs) }
          : {}),
      });
      // A 429 establishes only this credential's poll floor. Continue the
      // existing serial sweep for unrelated accounts; identical tokens share it.
      if (tagged === "rate_limited") {
        throttledTokens.add(tokenKey);
        cycle?.pacing?.noteRateLimited(subject, observedAt.getTime(), retryAfterMs ?? null);
      }
    }
  }
  for (const absence of absences) {
    const id = absence.subject.subject_id;
    if (id === null || resources.some((row) => row.target.profile_id === id)) continue;
    const failed = {
      ...emptyResourceFacet(),
      last_attempt_at: now().toISOString(),
      last_error: absence.reason,
    };
    resources.push({
      target: { harness: "claude", profile_id: id },
      spending: failed,
      resets: failed,
      ...(cycle?.foreground ? { balances: failed } : {}),
    });
  }
  return { snapshots, absences, resources };
}
