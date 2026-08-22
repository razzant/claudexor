/**
 * ONE owner for what a control-API credential mutation invalidates: the
 * doctor/status projections, the quota registry's absence pacing, and — per
 * subject — the A7 unusable-credential ledger. The per-subject half of the
 * ledger's clearing contract lives HERE (profile enable/disable/create/remove
 * and secret set/delete each void exactly the verdicts about the credential
 * they touched), while the whole-ledger clear stays with claudexord's
 * login/logout lifecycle. Clearing is fail-open by contract: over-clearing
 * costs at most one attempt rediscovering a refusal.
 */
import { loadConfig } from "@claudexor/config";
import { invalidateDoctorCache } from "@claudexor/core";
import { clearClaudeAuthStatusCache } from "@claudexor/harness-claude";
import type { QuotaRegistry } from "@claudexor/daemon";
import { noProjectRepoRoot } from "@claudexor/util";
import { invalidateStatusProjections } from "./status-projection-cache.js";
import { credentialUnusableLedger } from "./run-orchestrator.js";

/** The credential a control-API mutation touched: one registered profile, or
 * a secret name whose subjects are resolved through the registry. */
export type CredentialMutationSubject =
  { harnessId: string; profileId: string } | { secretName: string };

export function bustCredentialStatusCaches(
  quotaRegistry: () => QuotaRegistry,
  subject?: CredentialMutationSubject,
): void {
  // Auth-status keeps a short process-local LKG only to survive a transient
  // probe transport error. Any explicit credential mutation must invalidate it
  // before status/probe consumers can observe the changed store.
  clearClaudeAuthStatusCache();
  invalidateDoctorCache();
  invalidateStatusProjections();
  quotaRegistry().noteCredentialChange();
  if (!subject) return;
  if ("harnessId" in subject) {
    credentialUnusableLedger.clearSubject(subject.harnessId, subject.profileId);
    return;
  }
  // A secret names its subjects indirectly: profiles whose secret_ref IS this
  // name, and — for a bare managed name — the engine-default slot of whichever
  // harness reads it (adapter knowledge the daemon does not duplicate).
  for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
    if (profile.secret_ref === subject.secretName)
      credentialUnusableLedger.clearSubject(profile.harness_id, profile.profile_id);
  }
  if (!subject.secretName.includes(":")) credentialUnusableLedger.clearDefaultSubjects();
}

/** Clear the process-wide observations after a daemon login/logout lifecycle. */
export function bustGlobalCredentialStatusCaches(quotaRegistry: () => QuotaRegistry): void {
  bustCredentialStatusCaches(quotaRegistry);
  credentialUnusableLedger.noteCredentialChange();
}
