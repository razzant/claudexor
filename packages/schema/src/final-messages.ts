import { z } from "zod/v3";
import { Id } from "./primitives.js";

/**
 * #307: every final message a harness typed during one run, in event order,
 * derived once when the run's terminal is prepared. The primary output, the
 * structured WorkReport and every other result keep their own owners; this
 * document only makes each recorded final discoverable with its own event.
 */
export const FINAL_MESSAGES_PATH = "final/final-messages.jsonl";

export const FinalMessagesState = z
  .enum(["complete", "partial"])
  .describe(
    "complete: every record of the run's event log up to the source high-water mark was readable; partial: at least one record before the run's terminal could not be read, so a final may be missing.",
  );
export type FinalMessagesState = z.infer<typeof FinalMessagesState>;

const FinalMessagesCount = z
  .number()
  .int()
  .nonnegative()
  .describe("Number of final-message records after the header line.");

const ThroughEventSeq = z
  .number()
  .int()
  .nonnegative()
  .describe(
    "Inclusive seq of the last readable run event read before the run's first terminal; 0 when the checked log held no readable event.",
  );

/** First line of the document: what it covers, never an outcome. */
export const FinalMessagesHeader = z
  .object({
    schemaVersion: z.literal(1),
    runId: Id.describe("Run whose event log the records come from."),
    state: FinalMessagesState,
    count: FinalMessagesCount,
    throughEventSeq: ThroughEventSeq,
  })
  .strict()
  .describe(
    "Header line of final/final-messages.jsonl (UTF-8, every line LF-terminated). Each following line is one complete run event exactly as the run's event log serializes it: a harness message its adapter typed final, neither a fragment nor a buffered snapshot, in event order with its own attempt, session and native identity.",
  );
export type FinalMessagesHeader = z.infer<typeof FinalMessagesHeader>;

/** Where the document is and which exact bytes it holds; recorded once on the run's terminal. */
export const FinalMessagesPointer = z
  .object({
    path: z
      .literal(FINAL_MESSAGES_PATH)
      .describe("Run-relative artifact path; fetch it through the run artifact route."),
    state: FinalMessagesState,
    count: FinalMessagesCount,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("Exact size of the served document, header and final LF included."),
    sha256: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .describe("sha256 of exactly the served bytes, written sha256:<hex>."),
    throughEventSeq: ThroughEventSeq,
  })
  .strict()
  .describe("Address and exact size and digest of a run's saved final-messages document.");
export type FinalMessagesPointer = z.infer<typeof FinalMessagesPointer>;

export const FinalMessagesUnavailableReason = z
  .enum(["source_unreadable", "publication_failed", "artifact_unavailable"])
  .describe(
    "source_unreadable: the run's event log had no readable event when its terminal was prepared; publication_failed: the document could not be saved; artifact_unavailable: the saved document cannot be read with its recorded size and digest.",
  );
export type FinalMessagesUnavailableReason = z.infer<typeof FinalMessagesUnavailableReason>;

/** A settled gap: no bytes are confirmed, so no address, count or digest is claimed. */
export const FinalMessagesUnavailable = z
  .object({
    state: z.literal("unavailable"),
    reason: FinalMessagesUnavailableReason,
  })
  .strict()
  .describe("A run's final messages that no confirmed document holds, with the typed reason.");
export type FinalMessagesUnavailable = z.infer<typeof FinalMessagesUnavailable>;

/** What a run's terminal settled about its final-messages document. */
export const FinalMessagesOutcome = z
  .discriminatedUnion("state", [FinalMessagesPointer, FinalMessagesUnavailable])
  .describe(
    "The saved final-message document's address or a typed gap. An explicit result read returns null when the outcome is unknown, including older runs and runs awaiting their terminal.",
  );
export type FinalMessagesOutcome = z.infer<typeof FinalMessagesOutcome>;
