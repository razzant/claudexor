import type { AuthPreference } from "@claudexor/schema";

export type StrictAuthRoute = "subscription" | "api_key" | null;

/**
 * Runtime route selector with strict explicit preferences. Callback ordering is
 * intentional: auto is subscription-first and invokes the API-key route only
 * when subscription preparation fails; explicit routes never invoke fallback.
 */
export function selectStrictAuthRoute(
  preference: AuthPreference,
  trySubscription: () => boolean,
  tryApiKey: () => boolean,
): StrictAuthRoute {
  if (preference === "subscription") return trySubscription() ? "subscription" : null;
  if (preference === "api_key") return tryApiKey() ? "api_key" : null;
  if (trySubscription()) return "subscription";
  return tryApiKey() ? "api_key" : null;
}

export function shouldVerifyApiKey(input: {
  preference: AuthPreference;
  apiKeyAvailable: boolean;
  nativeReady: boolean;
}): boolean {
  if (!input.apiKeyAvailable || input.preference === "subscription") return false;
  return input.preference === "api_key" || !input.nativeReady;
}

export function selectedAuthReady(input: {
  preference: AuthPreference;
  nativeReady: boolean;
  apiKeyReady: boolean;
}): boolean {
  if (input.preference === "subscription") return input.nativeReady;
  if (input.preference === "api_key") return input.apiKeyReady;
  return input.nativeReady || input.apiKeyReady;
}

export function selectedAuthAvailable(input: {
  preference: AuthPreference;
  nativeAvailable: boolean;
  apiKeyAvailable: boolean;
}): boolean {
  if (input.preference === "subscription") return input.nativeAvailable;
  if (input.preference === "api_key") return input.apiKeyAvailable;
  return input.nativeAvailable || input.apiKeyAvailable;
}
