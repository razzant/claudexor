import { ControlHarnessSetupHarness, harnessSupportsBootstrapLogin } from "@claudexor/schema";

/**
 * `claudexor auth login` signs in the harness's BOOTSTRAP account row
 * (unified account model): claude/codex on their Claudexor-owned native dir,
 * cursor on an isolated file-store row (owner decision D-U3 — the host
 * Keychain login is never read). agy and grok never belong here: their accounts
 * are named profiles, signed in with `claudexor profiles login <harness> <id>`.
 * Deriving both the gate and the usage text from one place keeps the
 * CLI from offering a command the daemon can only refuse.
 */
export function isKnownAuthLoginHarness(harness: string): boolean {
  return (
    ControlHarnessSetupHarness.safeParse(harness).success && harnessSupportsBootstrapLogin(harness)
  );
}

/** The harnesses `auth login` accepts, for its own usage strings. */
export function authLoginHarnessList(): string {
  return ControlHarnessSetupHarness.options.filter(harnessSupportsBootstrapLogin).join("|");
}
