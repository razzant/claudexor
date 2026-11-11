import { z } from "zod/v3";
import { GlobalConfig } from "./config.js";
import { ControlRunStartRequest, RecordedControlRunStartRequest } from "./control.js";
import { AuthPreference, NonBlankString } from "./primitives.js";

/** Execution preferences only. Tool permissions, enabled accounts/harnesses,
 * trust, quotas, capabilities and paid-fallback policy are read afresh. */
const HarnessDefaults = GlobalConfig.shape.harnesses
  .removeDefault()
  .valueSchema.pick({
    default_model: true,
    effort: true,
    max_turns: true,
    max_rounds: true,
    fallback_model: true,
    web: true,
    auth_preference: true,
  })
  .strip();
export const RunDefaultsSnapshot = z
  .object({
    harnesses: z.record(HarnessDefaults),
    eligibleHarnesses: z.array(NonBlankString),
    primaryHarness: NonBlankString.nullable(),
    authPreference: AuthPreference,
  })
  .strict();
export type RunDefaultsSnapshot = z.infer<typeof RunDefaultsSnapshot>;

/** Internal accepted-command carrier. Public run-start schemas deliberately
 * reject deferredDefaults; only engine owners can accept this payload. */
export const CapturedRunStart = ControlRunStartRequest.extend({
  deferredDefaults: RunDefaultsSnapshot.optional(),
}).strict();
export type CapturedRunStart = z.infer<typeof CapturedRunStart>;

/** Decode engine-owned accepted bodies, including historical access profiles.
 * This is never an active ingress schema. */
export const RecordedCapturedRunStart = RecordedControlRunStartRequest.extend({
  deferredDefaults: RunDefaultsSnapshot.optional(),
}).strict();

export function decodeAcceptedRunStart(raw: unknown) {
  const { deferredDefaults, ...request } = RecordedCapturedRunStart.parse(raw);
  return { request, deferredDefaults };
}
