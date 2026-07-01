import { z } from "zod";
import { Id } from "./primitives.js";

export const GateStatus = z.enum(["passed", "failed", "skipped", "timed_out"]);
export type GateStatus = z.infer<typeof GateStatus>;

/** Result of a deterministic gate (build/test/lint/etc). Decided by exit code, not text. */
export const GateResult = z.object({
  id: Id,
  command: z.string(),
  exit_code: z.number().int().nullable(),
  status: GateStatus,
  duration_ms: z.number().int().nonnegative().default(0),
  required: z.boolean().default(true),
  stdout_tail: z.string().nullable().default(null),
  stderr_tail: z.string().nullable().default(null),
  output_truncated: z.boolean().default(false),
});
export type GateResult = z.infer<typeof GateResult>;
