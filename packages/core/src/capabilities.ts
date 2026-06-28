import type { HarnessCapabilityProfile } from "@claudexor/schema";

export function needsScopedHomeKeychainBridge(profile: HarnessCapabilityProfile): boolean {
  return (
    profile.isolation.supported_containment.includes("scoped_home_keychain_bridge") &&
    profile.auth.credential_transports.some((t) => t.kind === "os_keychain" && t.relocatable_by.includes("HOME"))
  );
}

export function readonlyMechanism(profile: HarnessCapabilityProfile): string {
  return profile.access_control.readonly_mechanism;
}
