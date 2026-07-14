import { z } from "zod";
import { Id } from "./primitives.js";

export const GateStatus = z
  .enum(["passed", "failed", "skipped", "timed_out"])
  .describe("Outcome of a deterministic gate: passed, failed, skipped, or timed_out.");
export type GateStatus = z.infer<typeof GateStatus>;

/** Result of a deterministic gate (build/test/lint/etc). Decided by exit code, not text. */
export const GateResult = z
  .object({
    id: Id.describe("Gate id."),
    command: z.string().describe("Command the gate ran."),
    exit_code: z
      .number()
      .int()
      .nullable()
      .describe("Process exit code; null when the gate never ran to completion."),
    status: GateStatus,
    duration_ms: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("How long the gate took, in milliseconds."),
    required: z.boolean().default(true).describe("Whether the gate must pass (vs advisory)."),
    stdout_tail: z
      .string()
      .nullable()
      .default(null)
      .describe("Tail of the gate's stdout, for diagnostics."),
    stderr_tail: z
      .string()
      .nullable()
      .default(null)
      .describe("Tail of the gate's stderr, for diagnostics."),
    output_truncated: z
      .boolean()
      .default(false)
      .describe("True when the stored output tails were truncated."),
  })
  .describe(
    "Result of a deterministic gate (build/test/lint/etc), decided by exit code, not text.",
  );
export type GateResult = z.infer<typeof GateResult>;
