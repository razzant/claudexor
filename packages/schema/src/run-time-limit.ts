import { z } from "zod/v3";

export const TimeLimitMode = z.enum(["soft", "hard"]);
export type TimeLimitMode = z.infer<typeof TimeLimitMode>;
const Seconds = z.number().int().positive().max(604_800);
const Revision = z.number().int().nonnegative();

/** Legacy explicit maxSeconds remains hard; ordinary runs have no deadline.
 * The start request also fixes the timer's initial mode: timeLimitMode, else
 * hard with maxSeconds, else soft (a run the user did not time-limit). */
export const RunTimeLimitStart = z.object({
  maxSeconds: Seconds.optional().describe(
    "Wall-clock limit for the whole run (seconds, max seven days). Omission disables the clock. Explicit limits cancel by default; soft mode warns and continues.",
  ),
  timeLimitMode: TimeLimitMode.optional().describe(
    "Initial timer mode: soft warns and continues; hard cancels. Omission is hard with maxSeconds and soft without it.",
  ),
});

export const RunTimeLimitRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z
    .object({
      action: z.literal("set"),
      seconds: Seconds,
      // Omission keeps the timer's current mode: a new deadline never silently
      // turns a hard limit soft, nor a soft one hard.
      mode: TimeLimitMode.optional(),
      expectedRevision: Revision,
    })
    .strict(),
  z.object({ action: z.literal("extend"), seconds: Seconds, expectedRevision: Revision }).strict(),
  z.object({ action: z.literal("disable"), expectedRevision: Revision }).strict(),
]);
export type RunTimeLimitRequest = z.infer<typeof RunTimeLimitRequest>;

export const RunTimeLimitSnapshot = z
  .object({
    revision: Revision,
    mode: TimeLimitMode,
    state: z.enum(["disabled", "armed", "reached", "closed"]),
    deadlineAt: z.string().datetime().nullable(),
    reachedAt: z.string().datetime().nullable(),
  })
  .strict();
export type RunTimeLimitSnapshot = z.infer<typeof RunTimeLimitSnapshot>;
