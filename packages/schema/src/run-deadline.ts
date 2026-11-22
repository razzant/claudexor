import { z } from "zod/v3";

/**
 * Server-enforced absolute run deadline (`run-deadline/1`).
 *
 * A remote controller (for example a laptop that keeps renewing permission)
 * gives the engine an absolute instant on the SERVER's clock. The engine
 * converts it once, when it accepts it, to the host clock (CLOCK_BOOTTIME on
 * Linux: it counts suspend), so a later wall-clock step never moves the stop.
 * The deadline holds from acceptance: queued, preparing and running. Every job
 * with a deadline, its own or inherited, has one durable record from
 * acceptance; every answer is read from it. A per-run warden process,
 * independent of the daemon, enforces it even while the daemon is down:
 * `stopGraceSec` after `at` no process inside the run's boundary remains,
 * within the physical limits `stopGraceSec` names.
 *
 * Additive to the legacy `maxSeconds` / `PATCH /v2/runs/:id/time-limit` clock,
 * which keeps its own semantics and its `wall_clock_exceeded` reason.
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
    "Replace the run's own absolute deadline while that deadline is armed (queued, preparing or running, not yet reached or claimed). A stale expectedRevision is a conflict; a deadline that already won refuses (run_deadline_expired), so does a terminal run (run_deadline_closed).",
  );
export type RunDeadlineSetRequest = z.infer<typeof RunDeadlineSetRequest>;

export const RunDeadlineState = z
  .enum(["armed", "enforcing", "expired", "closed"])
  .describe(
    "Linear per run: armed while it is live and its deadline was neither reached nor claimed (the only state a set is accepted in); enforcing once its deadline won and the stop began; expired once the run's terminal followed its deadline; closed after any other terminal.",
  );
export type RunDeadlineState = z.infer<typeof RunDeadlineState>;

/** The warden's final report on the run's processes, once it has one. */
export const RunDeadlineEnforcement = z
  .object({
    outcome: z
      .enum(["confirmed", "unresolved"])
      .describe(
        "confirmed: the warden proved the run's boundary empty and left. unresolved: it stopped trying without that proof (an unclassifiable process, or a member that would not die); `detail` names why.",
      ),
    detail: z
      .string()
      .nullable()
      .describe("Why membership could not be established; null when confirmed."),
  })
  .strict();
export type RunDeadlineEnforcement = z.infer<typeof RunDeadlineEnforcement>;

const STOP_GRACE_LIMITS =
  "Physical limits outside it: a suspended host stops the run when it wakes; a task in uninterruptible kernel I/O (D state) dies once that I/O returns; on the marker boundary a process running as another user, or one that cleared its environment after leaving the recorded tree, is not found; work handed to another service (a container engine, an already running tmux server, systemd-run) is outside the boundary.";

export const RunDeadlineSnapshot = z
  .object({
    at: DeadlineInstant.describe(
      "The deadline the engine enforces: the run's own or, when earlier, its Delegate parent's current one; after the terminal, the one it ended under.",
    ),
    revision: Revision.describe("Revision of the run's own deadline; a set must name it."),
    serverNow: z.string().datetime().describe("The server's wall clock when this answer was made."),
    state: RunDeadlineState,
    stopGraceSec: StopGraceSec.describe(
      `Seconds after \`at\` by which every process inside the run's boundary is gone (see the capability's \`boundary\`). ${STOP_GRACE_LIMITS}`,
    ),
    inheritedFrom: z
      .string()
      .nullable()
      .describe(
        "Job id of the Delegate parent (or further ancestor) whose deadline is the effective one, or null.",
      ),
    successorOf: z
      .string()
      .nullable()
      .describe(
        "Job id of the predecessor whose deadline this continuation took at acceptance (it had none of its own, or an earlier live one capped it), or null.",
      ),
    enforcement: RunDeadlineEnforcement.nullable().describe(
      "The warden's final report on the run's processes; null while it has none.",
    ),
  })
  .strict()
  .describe(
    "A run's server-enforced deadline (run-deadline/1), read from its durable record. Neither inheritedFrom nor successorOf set: the run's own.",
  );
export type RunDeadlineSnapshot = z.infer<typeof RunDeadlineSnapshot>;

/** How a run's processes are delimited for its deadline. */
export const RunDeadlineBoundary = z
  .enum(["cgroup", "marker"])
  .describe(
    "cgroup: every run has its own delegated cgroup v2, killed whole (cgroup.kill), so setsid, double fork and a cleaned environment stay inside. marker: processes carrying the run's scope marker in their environment plus the process groups and descendants the daemon recorded for the run; a process that clears its environment after leaving the recorded tree is outside.",
  );
export type RunDeadlineBoundary = z.infer<typeof RunDeadlineBoundary>;

export const ControlCapability = z
  .object({
    name: z.literal(RUN_DEADLINE_CAPABILITY),
    stopGraceSec: StopGraceSec.describe(
      `Seconds after a run's deadline by which every process inside its boundary is gone. ${STOP_GRACE_LIMITS}`,
    ),
    boundary: RunDeadlineBoundary,
  })
  .strict()
  .describe(
    "A capability this engine proves on this host: run-deadline/1 is declared only on Linux, after the daemon checked which boundary it can enforce; macOS and Windows do not declare it, and refuse an explicit deadline (run_deadline_unsupported) before accepting anything.",
  );
export type ControlCapability = z.infer<typeof ControlCapability>;
