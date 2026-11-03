/**
 * ONE owner for what a control-API credential mutation invalidates: the
 * doctor/status projections, the quota registry's absence pacing, and — per
 * subject — the A7 unusable-credential ledger. The per-subject half of the
 * ledger's clearing contract lives HERE (profile enable/disable/create/remove
 * and secret set/delete each void exactly the verdicts about the credential
 * they touched), while the whole-ledger clear stays with the login
 * lifecycle: claudexord's setup jobs, including Cursor profile login, at each
 * opening/closing transition. Direct Claude/AGY profile login retains its
 * documented observation gap. Clearing is
 * fail-open by contract: over-clearing costs at most one attempt rediscovering
 * a refusal. The model-substitution and pre-progress refusal ledgers clear at
 * the same sites; a secret names their subjects through the registry rows
 * whose `secret_ref` it is (an `oauth_token` row is a subscription account).
 * Every one of these clears moves the store graph's credential generation
 * FIRST and only then deletes that graph's durable last-served facts for the
 * same scope; a failed delete is logged by the graph and never skips the
 * remaining invalidations. The one exception is a mutation that keeps the row's
 * binding (the Enabled toggle): it voids the same verdicts and moves the same
 * generation, but the binding's last-served facts stay. The Cursor status cache
 * and the Claude model picker cache are dropped with the Claude auth-status LKG;
 * all three are this process's caches, so a change another process makes
 * (the direct profile login above) is not observed here.
 */
import { loadConfig } from "@claudexor/config";
import { invalidateDoctorCache } from "@claudexor/core";
import { clearClaudeAuthStatusCache, clearClaudeModelProbeCache } from "@claudexor/harness-claude";
import { clearCursorStatusCache } from "@claudexor/harness-cursor";
import type { AccountEvidence, QuotaRegistry } from "@claudexor/daemon";
import type { AuthReadinessService } from "@claudexor/gateway";
import { noProjectRepoRoot } from "@claudexor/util";
import { forgetClaudeOauthRejections } from "./claude-oauth-usage.js";
import { invalidateStatusProjections } from "./status-projection-cache.js";

/** The credential a control-API mutation touched: one registered profile
 * (`keepsBinding`: its kind, locator, secret name and creation are unchanged),
 * or a secret name whose subjects are resolved through the registry. */
export type CredentialMutationSubject =
  { harnessId: string; profileId: string; keepsBinding?: boolean } | { secretName: string };

export function bustCredentialStatusCaches(
  quotaRegistry: () => QuotaRegistry,
  accounts: AccountEvidence,
  subject?: CredentialMutationSubject,
): void {
  // Auth-status keeps a short process-local LKG only to survive a transient
  // probe transport error. Any explicit credential mutation must invalidate it
  // before status/probe consumers can observe the changed store.
  clearClaudeAuthStatusCache();
  // The Claude picker is cached per profile scope, whose key a login, logout or
  // new secret keeps while changing the account behind it (#572).
  clearClaudeModelProbeCache();
  // Cursor reuses a recent positive status answer; a mutation must re-ask.
  clearCursorStatusCache();
  // The quota poller's remembered vendor rejections are credential state too:
  // a login or profile change makes every remembered token worth re-asking.
  forgetClaudeOauthRejections();
  invalidateDoctorCache();
  invalidateStatusProjections();
  if (subject && "harnessId" in subject) {
    const { harnessId, profileId, keepsBinding } = subject;
    accounts.unusable.clearSubject(harnessId, profileId, keepsBinding);
    accounts.substitutions.clearSubject(harnessId, profileId);
    accounts.refusals.clearSubject(harnessId, profileId, keepsBinding);
  } else if (subject) {
    // A secret names its subjects indirectly: profiles whose secret_ref IS this
    // name, and — for a bare managed name — the engine-default slot of whichever
    // harness reads it (adapter knowledge the daemon does not duplicate).
    for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
      if (profile.secret_ref !== subject.secretName) continue;
      accounts.unusable.clearSubject(profile.harness_id, profile.profile_id);
      accounts.substitutions.clearSubject(profile.harness_id, profile.profile_id);
      // Moves the row's credential generation too: a try bound to the old
      // secret neither records nor clears a mark or service fact about the new one (#363).
      accounts.refusals.clearSubject(profile.harness_id, profile.profile_id);
    }
    if (!subject.secretName.includes(":")) accounts.unusable.clearDefaultSubjects();
  }
  // Last: the quota registry read can fail while its global generation awaits
  // recovery, so it must not skip the invalidations above.
  quotaRegistry().noteCredentialChange();
}

/** Clear the process-wide observations after a daemon-observed login lifecycle.
 * The in-memory ledgers and generations move before the potentially failing
 * quota registry read. */
export function bustGlobalCredentialStatusCaches(
  quotaRegistry: () => QuotaRegistry,
  accounts: AccountEvidence,
): void {
  accounts.unusable.noteCredentialChange();
  accounts.substitutions.noteCredentialChange();
  accounts.refusals.noteCredentialChange();
  bustCredentialStatusCaches(quotaRegistry, accounts);
}

/** A setup job's credential-mutation window opened or closed (#363): the
 * native login may have changed the credential, whatever its exit — the
 * process-wide observations plus that harness's auth-readiness projection. */
export function bustLoginCredentialState(
  quotaRegistry: () => QuotaRegistry,
  accounts: AccountEvidence,
  authReadiness: Pick<AuthReadinessService, "invalidate">,
  harness: string,
): void {
  authReadiness.invalidate(harness);
  bustGlobalCredentialStatusCaches(quotaRegistry, accounts);
}
