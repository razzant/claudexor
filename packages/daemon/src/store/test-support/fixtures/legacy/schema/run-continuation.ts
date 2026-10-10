import { z } from "zod/v3";
import { Id } from "./primitives.js";
import { ResumableCause } from "./run-continuity.js";
import { WorkspaceEnvelope } from "./workspace.js";

/**
 * The `continueFrom` run chain: a run started with `continueFrom: <runId>`
 * continues a terminal predecessor's work. These are the shapes the chain adds
 * beside the shared continuity contract in `run-continuity.ts`: the caller's
 * carrier preference, the durable custody record that keeps a stopped run's
 * isolated envelope until an explicit disposition, and its run-status
 * projection (disk use is visible).
 */

/** The caller's carrier preference on `continueFrom`. */
export const ContinueCarrierPreference = z
  .enum(["auto", "packet"])
  .describe(
    "auto: the best carrier the engine can prove (native session, moved session, then the evidence index); packet: a fresh session re-briefed by the evidence index (the caller's choice for a derailed session).",
  );
export type ContinueCarrierPreference = z.infer<typeof ContinueCarrierPreference>;

/**
 * Custody of an isolated envelope, one file in the envelope base. `live`: the
 * holder run's attempt is using it (written at creation, so a crash leaves the
 * envelope attributable). `retained`: the holder run stopped with unfinished
 * work and the envelope (tree + scoped home, auth material removed) is kept
 * until its successor adopts it or the run is discarded. Nothing removes a
 * retained envelope automatically.
 */
export const EnvelopeCustody = z
  .object({
    version: z.literal(1),
    state: z.enum(["live", "retained"]),
    holder_run_id: Id.describe("Run that holds the envelope."),
    holder_run_dir: z.string().min(1).describe("Absolute run directory of the holder."),
    envelope: WorkspaceEnvelope.describe("The envelope exactly as created (adoption reuses it)."),
    cause: ResumableCause.nullable().describe("Why the holder stopped; null while live."),
    retained_at: z.string().nullable().describe("When custody became retained; null while live."),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Disk use measured when retained (the kept envelope is not written to); null while live or unmeasured.",
      ),
  })
  .strict()
  .describe("Durable custody record of an isolated envelope (live or retained for continuation).");
export type EnvelopeCustody = z.infer<typeof EnvelopeCustody>;

/** Run-status projection of a retained envelope. */
export const ControlRetainedEnvelope = z
  .object({
    root: z.string().describe("Absolute path of the kept working tree."),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Disk use of the kept envelope (tree + scoped home); null when not measured."),
    retainedAt: z.string().describe("When the envelope was kept."),
    cause: ResumableCause.nullable().describe("Why the run stopped, when recorded."),
  })
  .strict()
  .describe(
    "An isolated envelope kept for continuation: continue it with continueFrom, or release it with the discard decision.",
  );
export type ControlRetainedEnvelope = z.infer<typeof ControlRetainedEnvelope>;

/** Daemon-resolved predecessor references, newest first, persisted before run announcement. */
export const ContinuationSources = z.array(
  z.object({
    runId: Id,
    runDir: z.string().min(1),
    state: z.string(),
    scopeRoot: z.string().min(1).optional(),
  }),
);
export type ContinuationSources = z.infer<typeof ContinuationSources>;
