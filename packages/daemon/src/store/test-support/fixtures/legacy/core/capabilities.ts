import {
  credentialTransportsForPlatform,
  type HarnessCapabilityProfile,
  type HarnessPlatform,
} from "../schema/index.js";

function supportedPlatform(platform: NodeJS.Platform): HarnessPlatform | null {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;
}

export function needsScopedHomeKeychainBridge(
  profile: HarnessCapabilityProfile,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const hostPlatform = supportedPlatform(platform);
  if (!hostPlatform) return false;
  return (
    profile.isolation.supported_containment.includes("scoped_home_keychain_bridge") &&
    credentialTransportsForPlatform(profile.auth, hostPlatform).some(
      (t) => t.kind === "os_keychain" && t.relocatable_by.includes("HOME"),
    )
  );
}

/**
 * Whether a harness owns a profile-local keychain rather than borrowing a
 * host keychain through the Claude-specific HOME bridge. This is deliberately
 * a separate capability: callers must not infer the private-keychain route
 * from the bridge containment flag.
 */
export function needsPrivatePerProfileKeychain(
  profile: HarnessCapabilityProfile,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const hostPlatform = supportedPlatform(platform);
  if (!hostPlatform) return false;
  return (
    profile.isolation.supported_containment.includes("private_per_profile_keychain") &&
    credentialTransportsForPlatform(profile.auth, hostPlatform).some(
      (transport) => transport.kind === "os_keychain" && transport.relocatable_by.includes("HOME"),
    )
  );
}
