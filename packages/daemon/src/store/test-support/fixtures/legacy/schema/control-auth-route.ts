import { z } from "zod/v3";
import { AuthRouteReason, AuthSourceKind } from "./auth.js";
import { AuthMode } from "./budget.js";
import { AuthPreference } from "./primitives.js";

/** Control-surface projection of the engine-owned telemetry auth-route receipt. */
export const ControlAuthRoute = z.object({
  requested: AuthPreference,
  effective: AuthMode.nullable().default(null),
  source: AuthSourceKind.nullable().default(null),
  reason: AuthRouteReason,
  harnessId: z.string().nullable().default(null),
  attemptId: z.string().nullable().default(null),
  profileId: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Credential profile the deciding attempt ran under; null = engine-default credentials.",
    ),
  modelMismatch: z
    .object({ requested: z.string(), observed: z.string() })
    .nullable()
    .default(null)
    .describe("Requested-vs-observed model mismatch; null when none."),
});
