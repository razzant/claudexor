/**
 * The credential-mutation window, as process-local observers read it (#363).
 *
 * A native login may rewrite a harness's credential store from the moment the
 * daemon permits the vendor command through terminal verification. The
 * ONE owner of that fact is the daemon's durable setup lifecycle, which binds
 * its projection here at startup; this module stores nothing itself. While the
 * window is open for a harness, its reused status answers, its last-known-good
 * grace and its credential ledgers accept nothing: an answer read mid-login
 * describes a store in flux. (The aggregate doctor cache is only invalidated
 * when a window opens and closes: bypassing it would repeat paid API-key
 * smokes for as long as a window stays open.)
 *
 * Unbound — every process that is not the daemon, and tests — reads closed. A
 * bound source that throws (an unreadable setup journal, a lifecycle
 * generation being replaced) cannot prove the window closed, so it reads open.
 */

/** `harnessId` undefined asks whether ANY harness's window is open. */
export type CredentialMutationWindowSource = (harnessId?: string) => boolean;

let source: CredentialMutationWindowSource | null = null;

/** The daemon composition root binds (or, with null, unbinds) the lifecycle projection. */
export function bindCredentialMutationWindow(next: CredentialMutationWindowSource | null): void {
  source = next;
}

/** True while a login may be rewriting `harnessId`'s credential store, or when
 * the bound source cannot rule that out. */
export function credentialMutationWindowOpen(harnessId?: string): boolean {
  if (!source) return false;
  try {
    return source(harnessId);
  } catch {
    return true;
  }
}
