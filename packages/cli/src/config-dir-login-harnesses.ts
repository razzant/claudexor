/**
 * ONE owner for the "this harness supports isolated config-dir/HOME login
 * profiles" fact (INV-122; roast A4, bounded derivation). Its three consumer
 * sites — profile registration (`profile-registration.ts`), the CLI
 * profile-login gate and that gate's canonical login-dir resolution
 * (`credential-commands.ts`) — all read THIS module instead of each
 * hand-maintaining a copy. Membership means: the vendor's native subscription
 * login can be relocated into a Claudexor-owned profile dir
 * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / the cursor and agy profile HOMEs).
 *
 * NOT a consumer, deliberately: the profile-deletion 409 fence
 * (`setup-job-support.ts` `activeProfileLoginJob`) asks a different question —
 * "does this harness have daemon-managed setup jobs at all" — and derives from
 * `ControlHarnessSetupHarness.options` — the same members today, but a
 * different question, and nothing keeps the two lists equal.
 */
import { canonicalAgyProfileHome } from "@claudexor/harness-agy";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import { canonicalCursorProfileHome } from "@claudexor/harness-cursor";
import { canonicalGrokProfileHome } from "@claudexor/harness-grok";

export const CONFIG_DIR_LOGIN_HARNESSES = ["claude", "codex", "cursor", "agy", "grok"] as const;
export type ConfigDirLoginHarness = (typeof CONFIG_DIR_LOGIN_HARNESSES)[number];

export function isConfigDirLoginHarness(value: string): value is ConfigDirLoginHarness {
  return (CONFIG_DIR_LOGIN_HARNESSES as readonly string[]).includes(value);
}

/** Human list for error messages ("claude, codex, cursor, agy"). */
export function configDirLoginHarnessList(): string {
  return CONFIG_DIR_LOGIN_HARNESSES.join(", ");
}

/**
 * Each member's own canonical login-dir resolver — the SAME one its harness
 * package uses for runs and doctor probes, so a login can never address a
 * different directory than the verification that follows it. A hand-written
 * `claude ? … : agy ? … : cursor` ladder at a call site is exactly the
 * fall-through this module exists to prevent: a new member silently inherits
 * the last branch's store.
 */
const CANONICAL_PROFILE_LOGIN_DIR: Record<ConfigDirLoginHarness, (locator: string) => string> = {
  claude: canonicalProfileConfigDir,
  codex: canonicalCodexProfileHome,
  cursor: canonicalCursorProfileHome,
  agy: canonicalAgyProfileHome,
  grok: canonicalGrokProfileHome,
};

export function canonicalProfileLoginDir(harness: ConfigDirLoginHarness, locator: string): string {
  return CANONICAL_PROFILE_LOGIN_DIR[harness](locator);
}
