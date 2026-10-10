import { z } from "zod/v3";
import { Id } from "./primitives.js";
import { LiveInputCapability } from "./harness-interaction.js";

/**
 * Upper bound of one live message, in UTF-16 code units: zod's `.max` counts
 * the JS string length, so a message of astral-plane characters reaches the
 * bound at half as many visible characters. Stated in the request description.
 */
export const LIVE_MESSAGE_MAX_UTF16_UNITS = 65_536;

/** Body of `POST /v2/runs/:id/messages`. */
export const ControlRunMessageRequest = z
  .object({
    text: z
      .string()
      .min(1)
      .max(LIVE_MESSAGE_MAX_UTF16_UNITS)
      .describe(
        "The message to place into the run's active attempt. 1..65536 UTF-16 code units (the JS string length, not bytes or visible characters); an over-long body is a 400, never truncated. Secret-like values are refused (inline_secret_rejected) like every prompt ingress.",
      ),
    expectedAttemptId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Target attempt id. Required when the run has several live attempts (race n>1): without it the daemon answers rejected/multi_attempt. A mismatch with the live attempt answers not_active/attempt_mismatch.",
      ),
  })
  .strict()
  .describe(
    "Live message into a running run. Send with an Idempotency-Key (the message id): a replay under the same key returns the recorded receipt without a second delivery.",
  );
export type ControlRunMessageRequest = z.infer<typeof ControlRunMessageRequest>;

/**
 * Typed outcome of one live-message submission. `accepted` is true on the wire
 * ONLY for `delivered` and `accepted`.
 *
 * - `accepted`: the harness's documented acceptance boundary was observed
 *   (Codex: `turn/steer` returned `{turnId}`); consumption is unproved.
 * - `delivered`: a correlated native consumption event was observed (Codex:
 *   the `userMessage` echo whose `clientId` equals the message id); obedience
 *   is unproved.
 * - `rejected`: an explicit refusal of THIS submission (a vendor RPC refusal
 *   on a still-active turn, a caller error such as `multi_attempt`, or the
 *   daemon could not persist admission).
 * - `not_active`: no eligible target existed before dispatch (no live
 *   attempt, terminal run, turn gap, attempt mismatch, pending interaction).
 * - `unsupported`: the harness/transport/run scope has no live-input channel
 *   (adapter lacks `message`, profile `none`, thread-bound run, legacy exec
 *   path).
 * - `delivery_unknown`: the message MAY have landed (transport loss,
 *   malformed reply, timeout, receipt-save failure). `accepted:false` here
 *   never means "safe to resend under a new key".
 */
export const LiveMessageOutcome = z
  .enum(["delivered", "accepted", "rejected", "not_active", "unsupported", "delivery_unknown"])
  .describe(
    "delivered = native consumption observed; accepted = native acceptance boundary observed (consumption unproved); rejected = explicit refusal of this submission; not_active = no eligible target before dispatch; unsupported = no live-input channel for this harness/transport/run scope; delivery_unknown = the message may have landed (never a safe-to-resend signal).",
  );
export type LiveMessageOutcome = z.infer<typeof LiveMessageOutcome>;

/** Typed reason beside a non-`delivered` outcome, filled from adapter/registry state only (INV-049). */
export const LiveMessageReason = z
  .enum([
    "no_active_turn",
    "run_terminal",
    "attempt_mismatch",
    "no_live_session",
    "multi_attempt",
    "thread_bound",
    "interaction_pending",
    "rpc_refused",
    "admission_persist_failed",
    "transport_lost",
    "response_timeout",
  ])
  .describe(
    "Why the outcome is not delivered: no_active_turn (the harness has no active native turn), run_terminal, attempt_mismatch (expectedAttemptId is not the live attempt), no_live_session (no registered live attempt, no adapter channel, or no native session yet), multi_attempt (several live attempts and no expectedAttemptId), thread_bound (thread turns are not steerable in v1), interaction_pending (a question is open; the message was not sent), rpc_refused (the vendor refused the steer on a still-active turn), admission_persist_failed (the daemon could not journal admission; nothing was sent), transport_lost, response_timeout.",
  );
export type LiveMessageReason = z.infer<typeof LiveMessageReason>;

/** Receipt of `POST /v2/runs/:id/messages`. EVERY typed outcome is HTTP 200. */
export const ControlRunMessageResponse = z
  .object({
    accepted: z
      .boolean()
      .describe("True only for outcome delivered or accepted; false for every other outcome."),
    outcome: LiveMessageOutcome,
    reason: LiveMessageReason.optional(),
    runId: Id.describe("Run the message was addressed to."),
    messageId: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "The submission's identity: the Idempotency-Key verbatim. Replaying it returns this receipt again; a new message needs a new key.",
      ),
    attemptId: z
      .string()
      .optional()
      .describe("Live attempt the message targeted, when one was selected."),
    harnessId: z.string().optional().describe("Harness of the targeted attempt."),
    liveInput: LiveInputCapability.optional().describe(
      "The targeted harness's declared live-input channel (its capability profile), when an attempt was selected.",
    ),
    nativeTurnId: z
      .string()
      .optional()
      .describe("Native turn id the harness reported on acceptance (Codex turn/steer result)."),
    message: z.string().optional().describe("Human-readable detail."),
  })
  .strict()
  .describe(
    "Receipt of a live message into a running run; every typed outcome answers HTTP 200 (unlike the answer/control routes), so read `outcome`, not the status code.",
  );
export type ControlRunMessageResponse = z.infer<typeof ControlRunMessageResponse>;

/** Input of the daemon's in-process `sendRunMessage` service (the route's call). */
export interface LiveMessageInput {
  runId: string;
  text: string;
  expectedAttemptId?: string;
  /** The Idempotency-Key verbatim; correlates native echoes and journal rows. */
  messageId: string;
}

/** What the daemon registry (and, 1:1, the adapter) answers for one submission. */
export type LiveMessageDelivery = Pick<
  ControlRunMessageResponse,
  "outcome" | "reason" | "attemptId" | "harnessId" | "liveInput" | "nativeTurnId" | "message"
>;

/**
 * Result of `HarnessAdapter.message(sessionId, {messageId, text})`: the
 * adapter's typed verdict, passed through the registry unchanged (including
 * `delivery_unknown`). Reasons come from adapter state, never from prose.
 */
export type LiveMessageAdapterResult = Pick<
  LiveMessageDelivery,
  "outcome" | "reason" | "nativeTurnId"
>;
