import { z } from "zod/v3";
import { Id } from "./primitives.js";

/**
 * Run continuation contract ("continue from the break point"): the serializable
 * DATA shapes shared by the in-run continuation ladder, the `continueFrom` run
 * chain and the thread store's projection. Split out of `harness.ts` for the
 * reason the complexity ratchet exists (INV-124); re-exported through
 * `index.ts`, so every consumer imports it from `@claudexor/schema`.
 *
 * Vocabulary: a CARRIER is how done work reaches the next vendor process; a
 * CAUSE is the typed reason the previous process stopped (copied from the
 * terminal, never inferred from prose); a CAPSULE is the durable per-attempt
 * record of the native vendor session and the concrete file that holds it.
 */

/** Why the previous process stopped. Typed terminal facts only (INV-049). */
export const ResumableCause = z
  .enum([
    "vendor_limit",
    "pool_exhausted",
    "pinned_limit",
    "transport",
    "context_exhausted",
    "wall_clock",
    "cancelled",
    "host_restart",
    "input_required",
    "other",
  ])
  .describe(
    "Typed reason the previous process stopped: a vendor limit (next account eligible), the whole pool spent, a pinned account's limit, a transport death (crash, timeout, watchdog), context exhaustion, the wall-clock deadline, a cancel, a daemon/host restart, a model that asked for input, or another typed cause.",
  );
export type ResumableCause = z.infer<typeof ResumableCause>;

/** How done work reaches the next vendor process. */
export const ContinuityCarrier = z
  .enum(["native", "native_moved", "packet", "fresh"])
  .describe(
    "Carrier of a continued try: native (the vendor's own session, same account), native_moved (the session file made visible in the next account's store, then resumed there), packet (a fresh session re-grounded by an evidence index), or fresh (nothing to carry — a replay of the original prompt).",
  );
export type ContinuityCarrier = z.infer<typeof ContinuityCarrier>;

/** The carriers a stopped run can still be continued with (never `fresh`). */
export const ResumableCarrier = z
  .enum(["native", "native_moved", "packet"])
  .describe("A continuity representation still available for a stopped run.");
export type ResumableCarrier = z.infer<typeof ResumableCarrier>;

/** Quality of the typed vendor-limit evidence that ended the work. */
export const LimitEvidence = z
  .enum(["window", "unspecified"])
  .describe(
    "window: the vendor named the spent window (a reset instant or a constraint id); unspecified: a typed limit without a window — a bare backoff frame is transport, not a limit.",
  );
export type LimitEvidence = z.infer<typeof LimitEvidence>;

export const ContinuityIdentityCheck = z
  .enum([
    "matched_before_effects",
    "mismatch_before_effects",
    "mismatch_after_possible_effects",
    "not_applicable",
  ])
  .describe(
    "Whether the resumed vendor session was the one requested, judged at the earliest handshake (codex thread/resume before turn/start; claude system/init): matched, mismatch caught before the child could act, mismatch caught after it may have acted, or not applicable (no resume was requested, or a harness without the continuity capability answered with another session id, which is recorded as before).",
  );
export type ContinuityIdentityCheck = z.infer<typeof ContinuityIdentityCheck>;

export const ContinuityInputDelivery = z
  .enum(["confirmed", "uncertain", "not_applicable"])
  .describe(
    "Whether the predecessor's last input (its turn prompt or an admitted steering message) is known to be in the vendor history: confirmed, uncertain (carried in the notice as a reference to reconcile, never replayed blindly), or not applicable.",
  );
export type ContinuityInputDelivery = z.infer<typeof ContinuityInputDelivery>;

/**
 * ONE durable record per attempt of the native vendor session: written by the
 * orchestrator when `started` reports a native session id (every try, every
 * envelope kind, standalone runs included), re-located after the try settles
 * (the history file can be written after `started`). The holder is the
 * concrete file `locate` found — a session has one holder at a time; a move
 * copies it into the next account's store and retires the source.
 */
export const SessionCapsule = z
  .object({
    harness: Id.describe("Harness that owns the session."),
    nativeSessionId: z.string().min(1).describe("The vendor's own session/thread id."),
    holderProfileId: Id.nullable().describe(
      "Credential profile whose store currently holds the session; null = the harness default store.",
    ),
    file: z
      .string()
      .nullable()
      .describe("Absolute path of the located history file (the holder); null until located."),
    mtimeMs: z
      .number()
      .nullable()
      .describe(
        "Modification time of the located file (newest wins on a tie); null until located.",
      ),
    sidecars: z
      .array(z.string())
      .default([])
      .describe(
        "Absolute paths of sibling state a move must carry (claude `<sid>/` tool-results and subagents; codex rollout parts).",
      ),
    cwd: z.string().describe("Working directory the session was created under."),
    requestedModel: z
      .string()
      .nullable()
      .describe("The model the spec requested; null = the harness default."),
  })
  .strict()
  .describe("Durable per-attempt record of the native vendor session and its holder file.");
export type SessionCapsule = z.infer<typeof SessionCapsule>;

/**
 * Terminal block of a run whose WORK is unfinished and can be continued:
 * present on non-success lifecycles and on `succeeded` runs whose work state
 * is `needs_input`/`incomplete`. Decided by the work outcome, never by the
 * lifecycle word alone. `resetsAt` comes only from a vendor window signal.
 */
export const RunResumable = z
  .object({
    cause: ResumableCause,
    resetsAt: z
      .string()
      .nullable()
      .describe(
        "When the spent vendor window reopens, only from a vendor signal; never fabricated.",
      ),
    limitWindow: z
      .string()
      .nullable()
      .describe(
        "The vendor's own name for the spent window (e.g. five_hour, seven_day_opus), when known.",
      ),
    limitEvidence: LimitEvidence.nullable(),
    carriers: z
      .array(ResumableCarrier)
      .describe(
        "Continuity representations still available (NOT quota readiness; readiness is described by the limit facts).",
      ),
    limitCode: z
      .string()
      .nullable()
      .describe("The typed vendor limit code that ended the work, when any."),
    session: z
      .object({
        harness: Id,
        nativeSessionId: z.string().min(1),
        holderProfileId: Id.nullable(),
      })
      .nullable()
      .describe("The native session a continuation can resume, when one exists."),
    workspace: z
      .object({
        kind: z.enum(["in_place", "retained_envelope", "none"]),
        root: z.string().nullable(),
      })
      .describe("Where the stopped work's tree is: the live root, a retained envelope, or gone."),
  })
  .strict()
  .describe(
    "Terminal facts of a stopped run that can be continued: cause, limit evidence, available carriers, the native session and the workspace.",
  );
export type RunResumable = z.infer<typeof RunResumable>;

/** Per-try receipt of a continued try (event `run.continuity`). */
export const RunContinuityReceipt = z
  .object({
    tryIndex: z
      .number()
      .int()
      .nonnegative()
      .describe("Native try within the attempt; joins the receipt to its try."),
    attemptId: Id,
    carrier: ContinuityCarrier,
    cause: ResumableCause,
    from: z.object({
      runId: Id,
      attemptId: Id,
      profileId: Id.nullable(),
    }),
    to: z.object({ profileId: Id.nullable() }),
    workspace: z
      .enum(["same_root", "different_root"])
      .describe("Whether the continued try runs in the predecessor's execution root."),
    memory: z
      .enum(["full", "partial", "unknown"])
      .describe(
        "Its own fact: a native resume carries the whole history (full); a packet re-brief is partial; a native resume that lost history (e.g. a rejected compacted item) is partial/unknown.",
      ),
    instructions: z
      .enum(["as_sent", "vendor_snapshot"])
      .describe(
        "as_sent: the successor's instructions equal the predecessor's; vendor_snapshot: they differ, and the vendor may resend its recorded system prompt instead (claude records it on the first request).",
      ),
    reingestedTokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Input + cache-creation tokens of the first resumed request, when known."),
    observedModel: z
      .string()
      .nullable()
      .describe("THIS try's attested model (never borrowed from another try)."),
    modelMismatch: z.boolean().nullable(),
    identityCheck: ContinuityIdentityCheck,
    inputDelivery: ContinuityInputDelivery,
  })
  .strict()
  .describe("Receipt of one continued try: carrier, cause, accounts, memory, model attestation.");
export type RunContinuityReceipt = z.infer<typeof RunContinuityReceipt>;
