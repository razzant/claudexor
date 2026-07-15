import { z } from "zod";

/** Machine-readable RFC-9457-style control-plane error details. */
export const ControlProblem = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    fieldErrors: z.record(z.string(), z.array(z.string())).default({}),
    requiredActions: z.array(z.string().min(1)).default([]),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    context: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("Typed route-specific recovery context; never a duplicate error message."),
  })
  .strict();
export type ControlProblem = z.infer<typeof ControlProblem>;
