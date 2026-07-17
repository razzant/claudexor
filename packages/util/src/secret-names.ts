/**
 * The single owner of the managed secret NAME grammar (names are secret REFS,
 * never values). It lives in the dependency-free util package so the schema
 * (CredentialProfile.secret_ref), the secret store, the CLI/HTTP surfaces,
 * and every harness adapter validate against exactly one grammar; the secrets
 * package re-exports it for its historical importers.
 */

/**
 * The single allowlist of managed secret names (previously duplicated in
 * the CLI and the control API, and BOTH were missing `claude_oauth` — the
 * claude adapter reads it, so it must be settable). Adding a name here makes
 * it settable via CLI and HTTP alike.
 */
export const MANAGED_SECRET_NAMES = [
  "openai",
  "anthropic",
  "claude_oauth",
  "openrouter",
  "cursor",
  "opencode",
  "raw",
] as const;

/**
 * Managed names accept an optional per-profile namespace suffix (INV-135):
 * `<base>` (the engine-default slot) or `<base>:<profile>` where base stays in
 * the allowlist and profile is a bounded slug. One grammar for CLI, HTTP, and
 * adapters — a profile's secret_ref is exactly such a name.
 */
const PROFILE_SUFFIX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isManagedSecretName(name: string): boolean {
  const sep = name.indexOf(":");
  const base = sep === -1 ? name : name.slice(0, sep);
  if (!(MANAGED_SECRET_NAMES as readonly string[]).includes(base)) return false;
  return sep === -1 || PROFILE_SUFFIX.test(name.slice(sep + 1));
}

/**
 * The managed base of a NAMESPACED profile secret_ref, or null when the ref
 * is malformed OR bare (release wave round-15 #5): a profile's ref must carry
 * its own `<base>:<profile>` namespace — a bare engine-default slot (e.g.
 * "anthropic") would silently alias the default credential, and profiles are
 * ADDITIVE identities. Adapters compare the returned base against their own
 * provider slot so a key stored for one provider is never sent to another.
 */
export function namespacedSecretRefBase(ref: string | null | undefined): string | null {
  if (!ref || !isManagedSecretName(ref)) return null;
  const sep = ref.indexOf(":");
  return sep === -1 ? null : ref.slice(0, sep);
}
