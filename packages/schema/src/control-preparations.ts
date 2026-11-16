import { z } from "zod/v3";

/**
 * Held preparation maintenance (#694): an explicit inspection of the
 * preparation resources Claudexor keeps after a stop whose end was not proven,
 * or after a crash (an isolated thread's record, an envelope base, an object
 * store's staging directory), and release of one on proof, a saved cleanup
 * basis, or operator confirmation. Ordinary GC, Retry and purge never confirm anything.
 */

export const HeldPreparationKind = z
  .enum(["thread", "envelope", "staging"])
  .describe(
    "thread: an isolated thread's preparation record (its worktree, registration and branch); envelope: an isolated envelope base; staging: an object-store staging directory.",
  );
export type HeldPreparationKind = z.infer<typeof HeldPreparationKind>;

export const PreparationReleaseBasis = z
  .enum(["machine_proven", "operator_confirmed", "saved_cleanup"])
  .describe(
    "machine_proven: a read proved that what the preparation started has ended; operator_confirmed: the operator's recorded confirmation released it (not a proof); saved_cleanup: this generation's ordinary cleanup or handover basis permitted release after fresh checks, without a new confirmation or machine proof.",
  );
export type PreparationReleaseBasis = z.infer<typeof PreparationReleaseBasis>;

export const PreparationWriterObservation = z
  .object({
    pid: z.number().int(),
    outcome: z
      .enum(["plausible_original", "born_after_hold", "missing", "unknown"])
      .describe(
        "One read of the recorded writer's pid (no birth was recorded for it): plausible_original refuses; born_after_hold and missing take that pid off as an authority; unknown proves nothing.",
      ),
    birth: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const HeldPreparation = z
  .object({
    selector: z.string().describe("Opaque server-issued address of this resource."),
    digest: z.string().describe("SHA-256 of the record's exact bytes at this inspection."),
    kind: HeldPreparationKind,
    path: z.string().describe("The held resource (tree, base or staging directory)."),
    record: z.string().describe("The record file that holds it."),
    root: z.string().describe("The known root it was found under."),
    thread_id: z.string().nullable(),
    since: z
      .string()
      .nullable()
      .describe("When its stop was recorded, else when the preparation began."),
    stop: z
      .object({ reason: z.string(), groups: z.array(z.number().int()) })
      .nullable()
      .describe("The stop's facts as recorded (history, not a measurement); null after a crash."),
    read: z
      .object({
        status: z.enum(["quiet", "held"]),
        reasons: z.array(z.string()),
        unproven: z.string().nullable(),
      })
      .describe(
        "This inspection's own read of what the preparation started (a read releases nothing).",
      ),
    release: z
      .enum(["machine", "operator_confirmation", "saved_cleanup", "refused"])
      .describe(
        "What permits release: machine (the read proves the end), operator_confirmation (the operator's statement is needed or already recorded), saved_cleanup (this generation's saved ordinary cleanup or handover basis; no new confirmation or proof), refused (blocked). Release checks again.",
      ),
    refusal: z.string().nullable(),
    operator_release: z
      .object({ confirmed_at: z.string() })
      .nullable()
      .describe("An earlier confirmation of this same record, whose cleanup is to be continued."),
    cleanup_error: z.string().nullable(),
    on_release: z.string().describe("What a release removes and what it keeps."),
  })
  .strict();
export type HeldPreparation = z.infer<typeof HeldPreparation>;

export const ControlHeldPreparations = z
  .object({
    preparations: z.array(HeldPreparation),
    roots: z
      .number()
      .int()
      .describe("Known roots searched (thread, envelope and store namespaces)."),
    confirmation: z.string().describe("What confirming a release states."),
    errors: z.array(z.string()).describe("Directories that could not be read."),
  })
  .strict()
  .describe("Held preparation resources under the daemon's known roots, purged threads included.");
export type ControlHeldPreparations = z.infer<typeof ControlHeldPreparations>;

export const ControlPreparationReleaseRequest = z
  .object({
    selector: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    confirm_processes_ended: z
      .literal(true)
      .describe(
        "The operator checked that the stopped preparation's processes and their children have ended; recorded as a release basis only when proof or a saved basis does not already permit release.",
      ),
  })
  .strict()
  .describe(
    "Release one held preparation resource, recording operator confirmation only if needed.",
  );
export type ControlPreparationReleaseRequest = z.infer<typeof ControlPreparationReleaseRequest>;

export const ControlPreparationReleaseReceipt = z
  .object({
    selector: z.string(),
    kind: HeldPreparationKind,
    path: z.string(),
    outcome: z
      .enum([
        "released",
        "completed",
        "cleanup_failed",
        "refused",
        "stale",
        "not_held",
        "basis_not_recorded",
      ])
      .describe(
        "released/completed: its release ran (completed: a finished checkout kept as made); cleanup_failed: it ran and a step failed, any saved basis stays for retry; refused: nothing was released; stale: inspect again; not_held: nothing held there (not a proof of an earlier release); basis_not_recorded: the confirmation could not be saved, nothing was released.",
      ),
    operation_id: z
      .string()
      .describe(
        "The durable delivery command (`delivery.preparation_release`) recorded before any effect, holding this receipt; a repeat with the same Idempotency-Key answers from it.",
      ),
    replayed: z
      .boolean()
      .describe("This is the recorded receipt of an earlier request with the same key."),
    generation: z
      .string()
      .nullable()
      .describe("The record's generation the request acted on (null when none was read)."),
    stop: z
      .object({ reason: z.string(), groups: z.array(z.number().int()), at: z.string() })
      .nullable()
      .describe("The stop the record named (history, not a measurement); null after a crash."),
    confirmed_at: z
      .string()
      .nullable()
      .describe(
        "The operator confirmation the record carried after this request (new or continued); null when none was needed or recorded.",
      ),
    basis: PreparationReleaseBasis.nullable(),
    continued: z.boolean().describe("An earlier confirmation of the same record was continued."),
    reasons: z.array(z.string()),
    cleanup_error: z.string().nullable(),
    writer: PreparationWriterObservation.nullable(),
    remains: z.string().describe("What stays after this operation."),
    note: z.string(),
  })
  .strict();
export type ControlPreparationReleaseReceipt = z.infer<typeof ControlPreparationReleaseReceipt>;
