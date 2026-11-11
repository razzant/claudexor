import { loadConfig } from "@claudexor/config";
import { GlobalConfig, RunDefaultsSnapshot, type ResolvedConfig } from "@claudexor/schema";

export function captureRunDefaults(config: ResolvedConfig): RunDefaultsSnapshot {
  return RunDefaultsSnapshot.parse({
    harnesses: config.global.harnesses,
    eligibleHarnesses: config.global.routing.eligible_harnesses,
    primaryHarness: config.global.routing.primary_harness,
    authPreference: config.global.routing.auth_preference,
  });
}

/** Preferences are frozen; current tool permissions, account bindings, enabled
 * flags, trust, quotas and policy remain authoritative. */
export function executionRunConfig(root: string, snapshot?: RunDefaultsSnapshot): ResolvedConfig {
  const config = loadConfig(root);
  if (!snapshot) return config;
  // Retained accepted bodies may predate the preference-only boundary. Parse
  // an execution view so old permission lists cannot override current policy;
  // never rewrite the accepted snapshot itself.
  const defaults = RunDefaultsSnapshot.parse(snapshot);
  const harnesses = { ...config.global.harnesses };
  const empty = RunDefaultsSnapshot.shape.harnesses.valueSchema.parse({});
  // Parse through the existing settings schema to retain its defaults, then
  // remove any execution defaults added after this run was captured. A section
  // removed from Settings since capture reads as its current defaults.
  for (const id of new Set([...Object.keys(harnesses), ...Object.keys(defaults.harnesses)])) {
    const frozen = defaults.harnesses[id] ?? empty;
    harnesses[id] = {
      ...(harnesses[id] ?? GlobalConfig.shape.harnesses.removeDefault().valueSchema.parse({})),
      ...frozen,
    };
  }
  return {
    ...config,
    global: {
      ...config.global,
      harnesses,
      routing: {
        ...config.global.routing,
        eligible_harnesses: defaults.eligibleHarnesses,
        primary_harness: defaults.primaryHarness,
        auth_preference: defaults.authPreference,
      },
    },
  };
}
