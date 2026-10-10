import { z } from "zod/v3";

const DISCLOSURE_DESCRIPTION =
  "Transient device-code disclosure overlaid at read time from the runner sidecar; never part of the journaled job.";

/** Keep the setup overlay invariant declarative so Zod and generated draft-07
 * enforce the same two strict branches; custom refinements cannot do that.
 *
 * Eligibility is the job's LIFECYCLE, not its vendor: every managed login
 * writes the same disclosure sidecar, and a terminal-mode claude/cursor login
 * discloses its captured `oauth_url` through it. `job` already constrains
 * `harness` to the managed set, so naming one vendor here only rejected
 * payloads the producer really emits. */
export function setupDeviceCodeProjectionEnvelope<
  Job extends z.ZodTypeAny,
  Shape extends z.ZodRawShape & { job: z.ZodTypeAny },
  ActiveState extends z.ZodTypeAny,
  Disclosure extends z.ZodTypeAny,
>(shape: Shape, job: Job, activeState: ActiveState, disclosure: Disclosure) {
  const eligibleJob = job.and(
    z
      .object({
        action: z.literal("login"),
        state: activeState,
        phase: z.literal("awaiting_user"),
      })
      .passthrough(),
  );
  return z.union([
    z.object({ ...shape, deviceCode: z.never().optional() }).strict(),
    z
      .object({
        ...shape,
        job: eligibleJob,
        deviceCode: disclosure.describe(DISCLOSURE_DESCRIPTION),
      })
      .strict(),
  ]);
}
