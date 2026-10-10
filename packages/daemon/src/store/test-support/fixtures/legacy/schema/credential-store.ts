/**
 * Which harnesses have a DEFAULT credential store — a place a vendor login
 * lands when no named account is selected.
 *
 * Under the unified account model this set is the LEGACY-migration surface,
 * not a routing privilege: claude and codex keep their Claudexor-owned native
 * dirs (the startup migration registers a detected login there as an ordinary
 * `<harness>-default` row; bytes never move). Cursor answers FALSE (owner
 * decision D-U3): the host Keychain login is never read again, so cursor has
 * no default store — every cursor login lands in an isolated file-store row.
 * agy answers false too: the Antigravity CLI takes its whole config root from
 * `$HOME` and exposes no config-dir variable, so adopting a default store
 * would mean adopting the operator's real home directory as a credential
 * store (owner decision Л-4). A harness that answers false can only sign in
 * INTO a named account row.
 */
export function harnessHasDefaultCredentialStore(harness: string): boolean {
  return harness !== "agy" && harness !== "cursor";
}

/**
 * Which harnesses support the `claudexor auth login <harness>` BOOTSTRAP
 * sugar (unified account model): the login lands in an auto-created
 * `<harness>-default` row — claude/codex on their Claudexor-owned native dir,
 * cursor on an isolated file-store dir. The bootstrap row has no routing
 * privilege; it is an ordinary pool row. agy stays named-only (Л-4).
 */
export function harnessSupportsBootstrapLogin(harness: string): boolean {
  return harness !== "agy";
}
