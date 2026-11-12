import { randomUUID } from "node:crypto";
import { loadConfigCached } from "@claudexor/config";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import {
  KEY_ALLOWANCE_SOURCE,
  instanceKeyCredentials,
  parseKeyAllowance,
  readKeyAllowance,
  type KeyCredential,
} from "@claudexor/harness-raw-api";
import {
  AccountResourceObservation,
  emptyResourceFacet,
  type CredentialProfile,
  type QuotaSubject,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { openRouterInstance } from "./registry.js";
import {
  emitQuotaDiagnostic,
  type QuotaDiagnosticSink,
  type QuotaRefreshDiagnostic,
} from "./quota-refresh-diagnostics.js";

/** The keys an OpenRouter request can send now: the default key first, then
 * each enabled registered API-key account. Publication binds rows to these. */
export function openRouterKeyCredentials(
  profiles: readonly CredentialProfile[] = loadConfigCached(noProjectRepoRoot()).global
    .credential_profiles,
): KeyCredential[] {
  return instanceKeyCredentials(openRouterInstance(), profiles);
}

const sameCredential = (a: KeyCredential, b: KeyCredential) =>
  a.fingerprint === b.fingerprint &&
  a.target.harness === b.target.harness &&
  a.target.profile_id === b.target.profile_id;

/** Explicit-refresh resource source for OpenRouter keys: one free key read per
 * key, never a generation, quota window or routing input. Each observation is
 * bound to the key it was read with; a key replaced during its read
 * contributes nothing. */
export async function refreshOpenRouterKeyAllowance(
  options: {
    credentials?: () => KeyCredential[];
    request?: typeof readKeyAllowance;
    now?: () => Date;
    diagnostic?: QuotaDiagnosticSink;
  } = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  const credentials = options.credentials ?? (() => openRouterKeyCredentials());
  const request = options.request ?? readKeyAllowance;
  const now = options.now ?? (() => new Date());
  const resources: AccountResourceObservation[] = [];
  for (const credential of credentials()) {
    const { target } = credential;
    if (
      cycle?.target &&
      (cycle.target.harness !== target.harness || cycle.target.profile_id !== target.profile_id)
    )
      continue;
    const subject: QuotaSubject = {
      harness: target.harness,
      credential_route: "managed_api_key",
      subject_id: target.profile_id,
      plan_label: null,
    };
    if (
      cycle?.shouldRefresh?.(subject) === false ||
      cycle?.pacing?.cooldownUntil(subject, now().getTime()) != null
    )
      continue;
    const operationId = randomUUID();
    const diagnostic = (
      outcome: QuotaRefreshDiagnostic["outcome"],
      at: Date,
      detail: Partial<QuotaRefreshDiagnostic> = {},
    ) =>
      emitQuotaDiagnostic(options.diagnostic, {
        operationId,
        source: KEY_ALLOWANCE_SOURCE,
        profileId: target.profile_id,
        foreground: cycle?.foreground ?? false,
        credentialEpoch: null,
        current: null,
        stage: "usage_http",
        at: at.toISOString(),
        outcome,
        ...detail,
      });
    diagnostic("started", now());
    const read = await request(openRouterInstance().baseUrl, credential.key);
    const at = now();
    if (!credentials().some((current) => sameCredential(current, credential))) {
      diagnostic("skipped", at, { reason: "credential_changed" });
      continue;
    }
    if (read.ok) {
      const observation = parseKeyAllowance(read.body, target, credential.fingerprint, at);
      const reason = observation.spending?.last_error ?? null;
      diagnostic(reason ? "failed" : "succeeded", at, reason ? { reason } : {});
      resources.push(observation);
      continue;
    }
    diagnostic("failed", at, {
      reason: read.reason,
      ...(read.httpStatus === null ? {} : { httpStatus: read.httpStatus }),
      retryAfterMs: read.retryAfterMs,
    });
    if (read.httpStatus === 429)
      cycle?.pacing?.noteRateLimited(subject, at.getTime(), read.retryAfterMs);
    // A failed read keeps this key's last successful figures, marked stale.
    resources.push(
      AccountResourceObservation.parse({
        target,
        credential_fingerprint: credential.fingerprint,
        spending: {
          ...emptyResourceFacet(),
          last_attempt_at: at.toISOString(),
          last_error: read.httpStatus === null ? read.reason : `${read.reason}_${read.httpStatus}`,
        },
      }),
    );
  }
  return { snapshots: [], resources };
}
