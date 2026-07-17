import { z } from "zod";
import { AdapterStatus, ConformanceCheck, HarnessManifest } from "./harness.js";
import { AuthSourceReadiness } from "./auth.js";

/**
 * ONE display-ready readiness check (W4.7 sol #18): the daemon normalizes raw
 * doctor probes, auth-source readiness, and the configured-model verdict into
 * this typed list so every surface (Settings, Onboarding, AuthSheet) renders
 * the SAME rows — icon from `status`, name from `title`, evidence from
 * `detail` — and never parses strings or matches id substrings again. Raw
 * checks/reasons stay on the DTO for "copy raw" evidence.
 */
export const ReadinessCheckDto = z
  .object({
    id: z.string().describe("Stable machine id of the check (adapter probe id or auth source)."),
    kind: z
      .enum(["binary", "auth", "smoke", "model", "probe"])
      .describe(
        "What KIND of readiness this is: binary presence, credential source, isolated smoke, configured-model validity, or a generic capability probe.",
      ),
    title: z.string().describe("Human display name of the check."),
    status: z.enum(["pass", "fail", "skip"]).describe("Outcome; skip = not run / not applicable."),
    detail: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted human-readable evidence for the outcome."),
  })
  .describe("One display-ready readiness check row (daemon-normalized).");
export type ReadinessCheckDto = z.infer<typeof ReadinessCheckDto>;

export const HarnessStatusDto = z
  .object({
    id: z.string().describe("Harness id."),
    status: AdapterStatus,
    manifest: HarnessManifest.nullable()
      .optional()
      .describe("The harness's declared manifest, when available."),
    enabledIntents: z
      .array(z.string())
      .default([])
      .describe("Intents the gateway will route to this harness."),
    /** Intents this harness is ACTUALLY routable for right now: enabledIntents
     * gated by doctor readiness (a degraded/unauth'd harness routes nothing).
     * The SERVER-side availability truth — surfaces read this field and never
     * re-derive availability from status+intents business logic (Р8). */
    routableIntents: z
      .array(z.string())
      .default([])
      .describe(
        "Intents the harness is actually routable for right now (doctor-gated); the server-side availability truth surfaces must read instead of re-deriving.",
      ),
    disabledIntents: z.array(z.string()).default([]).describe("Intents the doctor disabled."),
    checks: z.array(ConformanceCheck).default([]).describe("Doctor probe results."),
    reasons: z
      .array(z.string())
      .default([])
      .describe("Human-readable reasons for degraded/unavailable status."),
    authSources: z
      .array(AuthSourceReadiness)
      .default([])
      .describe(
        "Doctor-backed readiness by authentication source; an empty array means readiness was not reported.",
      ),
    /** Daemon-normalized display list (W4.7): what surfaces RENDER. Derived
     * from checks + authSources + configuredModelCheck by one producer. */
    readiness: z
      .array(ReadinessCheckDto)
      .default([])
      .describe("Display-ready readiness checks, daemon-normalized from the raw evidence."),
    /** The user's configured per-harness default model, if any. */
    configuredModel: z
      .string()
      .nullable()
      .default(null)
      .describe("The user's configured per-harness default model, if any."),
    /** Strict truth-source check of `configuredModel`: null when no model
     * is configured; a rejection carries the actionable message so UIs render
     * the same honesty `claudexor doctor` prints. */
    configuredModelCheck: z
      .object({
        status: z
          .enum(["ok", "rejected"])
          .describe("Whether the configured model passes the strict truth-source check."),
        message: z
          .string()
          .nullable()
          .default(null)
          .describe("Actionable rejection message, when rejected."),
      })
      .nullable()
      .default(null)
      .describe("Strict truth-source check of configuredModel; null when no model is configured."),
  })
  .describe(
    "Doctor-backed status row for one harness: status, intents, checks, and configured-model validity.",
  );
export type HarnessStatusDto = z.infer<typeof HarnessStatusDto>;
