import { GROK_PROGRAM } from "./program.js";
import { join } from "node:path";
import { canonicalIsolationLocator, providerScrubEnv } from "@claudexor/core";
import type { CredentialProfile } from "@claudexor/schema";

type Env = Record<string, string | null | undefined>;
const MANAGED_ENV: Env = {
  ...GROK_PROGRAM.childUpdateEnv,
  GROK_CONFIG: null,
  GROK_CONFIG_PATH: null,
};

/** The guide documents OIDC and OAuth2 login settings by family; members not
 * named in the shared provider scrub are removed by prefix, from the engine
 * environment and from the run's own env. */
const LOGIN_SELECTOR_FAMILIES = ["GROK_OIDC_", "GROK_OAUTH2_"];
function loginSelectorScrub(...sources: Env[]): Env {
  const out: Env = {};
  for (const source of sources)
    for (const name of Object.keys(source))
      if (LOGIN_SELECTOR_FAMILIES.some((family) => name.startsWith(family))) out[name] = null;
  return out;
}

export const GROK_PROFILE_REQUIRED =
  "Grok has no default credential store; select a named profile (--profile <id>): " +
  "claudexor profiles add grok <id> and claudexor profiles login grok <id>";

export function canonicalGrokProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Grok HOME");
}

/** HOME and GROK_HOME must agree for login, models, and execution. The
 * profile HOME is also where Grok keeps its sessions, so one account's native
 * state is shared by every thread that runs on it. */
export function grokProfileEnv(locator: string, env: Env = {}): Env {
  if (!locator) throw new Error(GROK_PROFILE_REQUIRED);
  const home = canonicalGrokProfileHome(locator);
  return {
    ...env,
    ...providerScrubEnv(),
    ...loginSelectorScrub(process.env, env),
    ...MANAGED_ENV,
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: join(home, ".grok"),
  };
}

export function grokRouteEnv(profile?: CredentialProfile | null, env: Env = {}): Env {
  if (profile) {
    if (profile.harness_id !== "grok" || profile.credential_kind !== "config_dir_login")
      throw new Error(`credential profile "${profile.profile_id}": Grok requires config_dir_login`);
    return grokProfileEnv(profile.isolation_locator ?? "", env);
  }
  throw new Error(GROK_PROFILE_REQUIRED);
}
