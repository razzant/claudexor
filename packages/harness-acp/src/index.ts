export { COPILOT_PROGRAM } from "./program.js";
import type { HarnessAdapter } from "@claudexor/core";
import type { AcpEntry } from "./entry.js";
import { acpCapabilityProfile } from "./manifest.js";
import { acpRunner } from "./run.js";
import { acpProbes } from "./probes.js";
import { probeAcpProfile } from "./env.js";
export { copilot } from "./entry.js";

/** A vendor identity over the shared ACP v1 transport. */
export function createAcpAdapter(entry: AcpEntry): HarnessAdapter {
  const runner = acpRunner(entry);
  const profile = acpCapabilityProfile();
  return {
    nativeHomeLifetime: {
      status: "not_pruned",
      reason: "ACP supplies no vendor-independent native storage retirement contract.",
    },
    id: entry.id,
    program: entry.program,
    // Only an entry that declares levels has a separate effort knob to resolve.
    ...(entry.effortLevels.length ? { effortParameter: "--effort" } : {}),
    capabilityProfile: profile,
    ...acpProbes(entry, profile, runner),
    run: runner.run,
    cancel: runner.cancel,
    async probeCredentialProfile(credential) {
      return probeAcpProfile(entry, credential);
    },
  };
}
