import { z } from "zod/v3";

/**
 * Server-enforced absolute run deadline (`run-deadline/1`).
 *
 * A remote controller (for example a laptop that keeps renewing permission)
 * gives the engine an absolute instant on the SERVER's clock. The engine
 * converts it once to its monotonic clock when it accepts the value, so a later
 * wall-clock step never moves the stop. The deadline holds from acceptance:
 * queued, preparing and running. A per-run warden process, independent of the
 * daemon, enforces it even while the daemon is down: `stopGraceSec` after `at`
 * no process of the run (its Delegate children included) remains.
 *
 * Additive to the legacy `maxSeconds` / `PATCH /v2/runs/:id/time-limit` clock,
 * which keeps its own semantics.
 */
export const RUN_DEADLINE_CAPABILITY = "run-deadline/1" as const;

/** Request header that opts a `POST /v2/handshake` into `capabilities`
 * (older same-major clients parse the handshake strictly). Value `1`. */
export const CONTROL_CAPABILITIES_HEADER = "x-claudexor-capabilities";

const StopGraceSec = z.number().int().min(1).max(30);
/** RFC3339 UTC (`Z`) on the server's wall clock. */
const DeadlineInstant = z
  .string()
  .datetime()
  .describe("Absolute instant on the server's wall clock, RFC3339 UTC (Z).");
const Revision = z.number().int().nonnegative();

export const RunDeadlineStart = z
  .object({ at: DeadlineInstant })
  .strict()
  .describe(
    "Server-enforced absolute deadline from acceptance: queued, preparing and running. An instant already past at acceptance is refused and nothing starts.",
  );
export type RunDeadlineStart = z.infer<typeof RunDeadlineStart>;

export const RunDeadlineSetRequest = z
  .object({ at: DeadlineInstant, expectedRevision: Revision })
  .strict()
  .describe(
    "Replace the run's own absolute deadline in any non-terminal state. A stale expectedRevision is a conflict; a terminal run refuses.",
  );
export type RunDeadlineSetRequest = z.infer<typeof RunDeadlineSetRequest>;

export const RunDeadlineState = z.enum(["armed", "expired", "closed"]);
export type RunDeadlineState = z.infer<typeof RunDeadlineState>;

export const RunDeadlineSnapshot = z
  .object({
    at: DeadlineInstant.describe(
      "The effective deadline the engine enforces: the run's own or, when earlier, its Delegate parent's current one.",
    ),
    revision: Revision.describe("Revision of the run's own deadline; a set must name it."),
    serverNow: z.string().datetime().describe("The server's wall clock when this answer was made."),
    state: RunDeadlineState.describe(
      "armed while the run is live; expired once the deadline ended it; closed after any other terminal.",
    ),
    stopGraceSec: StopGraceSec.describe(
      "Seconds after `at` by which every process of the run is gone.",
    ),
    inheritedFrom: z
      .string()
      .nullable()
      .describe("Job id of the Delegate parent whose deadline is the effective one, or null."),
  })
  .strict()
  .describe("A run's server-enforced deadline (run-deadline/1).");
export type RunDeadlineSnapshot = z.infer<typeof RunDeadlineSnapshot>;

export const ControlCapability = z
  .object({
    name: z.literal(RUN_DEADLINE_CAPABILITY),
    stopGraceSec: StopGraceSec,
  })
  .strict()
  .describe(
    "A capability this engine proves on this host; run-deadline/1 is absent where the stop invariant is not proven.",
  );
export type ControlCapability = z.infer<typeof ControlCapability>;
