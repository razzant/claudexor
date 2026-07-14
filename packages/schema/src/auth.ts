import { z } from "zod";
import { Id } from "./primitives.js";

const AuthTimestamp = z.string().datetime({ offset: true });
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/** What credential behavior the caller asked Claudexor to enforce. */
export const AuthRequest = z
  .enum(["subscription", "api_key", "auto"])
  .describe(
    "Requested credential behavior: exact subscription, exact managed API key, or policy-governed auto selection.",
  );
export type AuthRequest = z.infer<typeof AuthRequest>;

/** The concrete credential transport selected for one real harness execution. */
export const CredentialRoute = z
  .enum(["vendor_native", "managed_api_key", "local"])
  .describe(
    "Effective credential route: vendor-owned native session, Claudexor-managed API key, or credential-free local execution.",
  );
export type CredentialRoute = z.infer<typeof CredentialRoute>;

export const AuthAvailability = z.enum(["available", "unavailable", "unknown"]);
export type AuthAvailability = z.infer<typeof AuthAvailability>;

export const AuthVerification = z.enum(["passed", "failed", "not_run"]);
export type AuthVerification = z.infer<typeof AuthVerification>;

export const AuthSourceKind = z
  .enum([
    "native_session",
    "oauth_token_env",
    "api_key_env",
    "api_key_flag",
    "provider_auth_file",
    "none",
  ])
  .describe("Concrete credential source used or probed by a harness.");
export type AuthSourceKind = z.infer<typeof AuthSourceKind>;

export const AuthSourceReadiness = z
  .object({
    source: AuthSourceKind,
    availability: AuthAvailability,
    verification: AuthVerification,
    detail: z.string().optional().describe("Redacted human-readable source evidence."),
  })
  .strict()
  .describe("Doctor-backed readiness for one exact credential source.");
export type AuthSourceReadiness = z.infer<typeof AuthSourceReadiness>;

/**
 * Exact point-in-time readiness request for one harness credential source.
 * The harness id is carried by the route/service input, so the body cannot
 * disagree with the selected adapter. A refresh always bypasses readiness
 * caches; there is intentionally no staged `fresh` knob.
 */
export const ControlAuthReadinessRefreshRequest = z
  .object({
    authRequest: AuthRequest,
    source: AuthSourceKind,
  })
  .strict()
  .describe(
    "Request to refresh one exact harness authentication source without probing unrelated routes.",
  );
export type ControlAuthReadinessRefreshRequest = z.infer<typeof ControlAuthReadinessRefreshRequest>;

/**
 * Source-scoped readiness must remain separate from the aggregate harness
 * catalog: it proves only the requested source and must not overwrite other
 * sources, intents, model truth, or aggregate health.
 */
export const ControlAuthReadinessRefreshResponse = z
  .object({
    harnessId: Id,
    authRequest: AuthRequest,
    requestedSource: AuthSourceKind,
    observedAt: AuthTimestamp,
    readiness: AuthSourceReadiness,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.readiness.source !== value.requestedSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readiness", "source"],
        message: "auth readiness response source must match the exact requested source",
      });
    }
  })
  .describe("Point-in-time readiness evidence for one exact harness credential source.");
export type ControlAuthReadinessRefreshResponse = z.infer<
  typeof ControlAuthReadinessRefreshResponse
>;

/** Billing truth is deliberately independent from credential transport. */
export const BillingKnowledge = z
  .enum(["proven_zero", "subscription_entitlement", "metered", "unknown"])
  .describe(
    "What is actually known about incremental billing; a native credential route alone never proves entitlement or zero cost.",
  );
export type BillingKnowledge = z.infer<typeof BillingKnowledge>;

export const CostKnowledge = z
  .enum(["exact", "estimated", "unknown"])
  .describe("Quality of incremental-cash cost evidence for an operation.");
export type CostKnowledge = z.infer<typeof CostKnowledge>;

export const AuthCapabilitySelectionReason = z.enum([
  "exact_requested_route",
  "adapter_unavailable",
  "request_mismatch",
  "route_missing",
  "route_mismatch",
  "source_missing",
  "source_mismatch",
  "harness_error",
  "adapter_error",
  "missing_completion",
  "response_mismatch",
  "scratch_mutated",
  "protocol_violation",
  "adapter_identity_mismatch",
  "cancelled",
]);
export type AuthCapabilitySelectionReason = z.infer<typeof AuthCapabilitySelectionReason>;

/** Persisted and shown before a setup flow is allowed to spend a real model turn. */
export const AuthSmokeDisclosure = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(1),
    harness: Id,
    requested: AuthRequest,
    requiredRoute: CredentialRoute,
    requiredSource: AuthSourceKind,
    networkScope: z.literal("selected_harness_only"),
    billingKnowledge: BillingKnowledge,
    incrementalCostKnowledge: CostKnowledge,
    mayConsumeQuota: z.boolean(),
    generatedAt: AuthTimestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requiredRoute === "vendor_native") {
      if (
        value.billingKnowledge !== "unknown" ||
        value.incrementalCostKnowledge !== "unknown" ||
        !value.mayConsumeQuota
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "a vendor-native smoke must disclose unknown billing/cost and possible quota consumption",
        });
      }
    }
  })
  .describe(
    "Pre-execution disclosure for the exact same-harness capability smoke required by auth setup.",
  );
export type AuthSmokeDisclosure = z.infer<typeof AuthSmokeDisclosure>;

/**
 * Immutable, redacted proof that the selected adapter completed a real
 * same-harness round trip on the exact requested credential route. Model text
 * is never stored: responseDigest binds the receipt to the nonce response.
 */
export const AuthCapabilityStreamEvidence = z
  .object({
    startedEvents: z.number().int().nonnegative(),
    completedEvents: z.number().int().nonnegative(),
    errorEvents: z.number().int().nonnegative(),
    unexpectedToolEvents: z.number().int().nonnegative(),
    interactionEvents: z.number().int().nonnegative(),
    sessionMismatchEvents: z.number().int().nonnegative(),
    eventsAfterCompleted: z.number().int().nonnegative(),
    aborted: z.boolean(),
  })
  .strict();
export type AuthCapabilityStreamEvidence = z.infer<typeof AuthCapabilityStreamEvidence>;

export const AuthCapabilityReceipt = z
  .object({
    receiptId: Id,
    attemptId: Id,
    harness: Id,
    requested: AuthRequest,
    requiredRoute: CredentialRoute,
    requiredSource: AuthSourceKind,
    effective: CredentialRoute.nullable(),
    effectiveSource: AuthSourceKind.nullable(),
    selectionReason: AuthCapabilitySelectionReason,
    availability: AuthAvailability,
    verification: AuthVerification,
    billingKnowledge: BillingKnowledge,
    costKnowledge: CostKnowledge,
    costUsd: z.number().nonnegative().optional(),
    startedAt: AuthTimestamp,
    completedAt: AuthTimestamp,
    challengeDigest: Sha256Hex,
    requestDigest: Sha256Hex,
    responseDigest: Sha256Hex,
    streamDigest: Sha256Hex,
    scratchBeforeDigest: Sha256Hex,
    scratchAfterDigest: Sha256Hex,
    stream: AuthCapabilityStreamEvidence,
    evidenceRefs: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.verification === "passed") {
      if (value.availability !== "available") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["availability"],
          message: "passed verification requires available credentials",
        });
      }
      if (value.effective !== value.requiredRoute) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effective"],
          message: "passed verification requires the exact requested credential route",
        });
      }
      if (value.effectiveSource !== value.requiredSource) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["effectiveSource"],
          message: "passed verification requires the exact requested credential source",
        });
      }
      if (value.selectionReason !== "exact_requested_route") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selectionReason"],
          message: "passed verification requires exact_requested_route evidence",
        });
      }
      if (value.responseDigest !== value.challengeDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseDigest"],
          message: "passed verification response must match the persisted challenge digest",
        });
      }
      if (
        value.stream.startedEvents !== 1 ||
        value.stream.completedEvents !== 1 ||
        value.stream.errorEvents !== 0 ||
        value.stream.unexpectedToolEvents !== 0 ||
        value.stream.sessionMismatchEvents !== 0 ||
        value.stream.interactionEvents !== 0 ||
        value.stream.eventsAfterCompleted !== 0 ||
        value.stream.aborted
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stream"],
          message: "passed verification requires one clean started/completed stream",
        });
      }
      if (value.scratchBeforeDigest !== value.scratchAfterDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scratchAfterDigest"],
          message: "passed verification requires an unchanged external scratch tree",
        });
      }
    }
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "receipt completion cannot precede its start",
      });
    }
    if (
      value.requiredRoute === "vendor_native" &&
      (value.billingKnowledge !== "unknown" || value.costKnowledge !== "unknown")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "vendor-native route evidence alone cannot prove billing or incremental cash cost",
      });
    }
    if (value.costKnowledge === "unknown" && value.costUsd !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costUsd"],
        message: "unknown cost must not fabricate a USD value",
      });
    }
    if (value.costKnowledge !== "unknown" && value.costUsd === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["costUsd"],
        message: "known or estimated cost requires a USD value",
      });
    }
  })
  .describe("Immutable result of one exact-route same-harness capability smoke.");
export type AuthCapabilityReceipt = z.infer<typeof AuthCapabilityReceipt>;

const AuthCapabilityBindingShape = {
  attemptId: Id,
  challengeDigest: Sha256Hex,
  requestDigest: Sha256Hex,
  disclosure: AuthSmokeDisclosure,
};

export const AuthCapabilityBinding = z.object(AuthCapabilityBindingShape).strict();
export type AuthCapabilityBinding = z.infer<typeof AuthCapabilityBinding>;

export const AuthCapabilityLifecycle = z
  .discriminatedUnion("state", [
    z.object({ ...AuthCapabilityBindingShape, state: z.literal("disclosed") }).strict(),
    z
      .object({
        ...AuthCapabilityBindingShape,
        state: z.literal("running"),
        startedAt: AuthTimestamp,
      })
      .strict(),
    z
      .object({
        ...AuthCapabilityBindingShape,
        state: z.literal("completed"),
        startedAt: AuthTimestamp,
        completedAt: AuthTimestamp,
        receipt: AuthCapabilityReceipt,
      })
      .strict(),
    z
      .object({
        ...AuthCapabilityBindingShape,
        state: z.literal("interrupted_unknown"),
        startedAt: AuthTimestamp,
        interruptedAt: AuthTimestamp,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      "startedAt" in value &&
      Date.parse(value.startedAt) < Date.parse(value.disclosure.generatedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "capability smoke cannot start before its disclosure",
      });
    }
    if (value.state === "completed") {
      if (
        value.receipt.attemptId !== value.attemptId ||
        value.receipt.challengeDigest !== value.challengeDigest ||
        value.receipt.requestDigest !== value.requestDigest ||
        value.receipt.startedAt !== value.startedAt ||
        value.receipt.completedAt !== value.completedAt
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receipt"],
          message: "completed lifecycle receipt must match its durable binding and timestamps",
        });
      }
    }
  })
  .describe(
    "Single durable auth-smoke lifecycle: disclosed, running, completed, or interrupted_unknown.",
  );
export type AuthCapabilityLifecycle = z.infer<typeof AuthCapabilityLifecycle>;
