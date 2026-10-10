import { z } from "zod/v3";
import { ControlProblem } from "./problem.js";
import { IsoTimestamp } from "./primitives.js";

/** One exact vendor registry version (no range, tag or `v` prefix). */
export const HarnessVendorVersion = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  .describe("One exact vendor version.");

export const HarnessMaintenanceTarget = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("latest") }).strict(),
    z.object({ kind: z.literal("version"), version: HarnessVendorVersion }).strict(),
    z.object({ kind: z.literal("previous") }).strict(),
    z.object({ kind: z.literal("baseline") }).strict(),
  ])
  .describe(
    "latest = the vendor's newest release; version = one exact version (up or down); previous = the proved version recorded before an earlier maintenance mutation; baseline = this release's tested pin.",
  );
export type HarnessMaintenanceTarget = z.infer<typeof HarnessMaintenanceTarget>;

const TargetKind = z.enum(["latest", "version", "previous", "baseline"]);
const SelectionKind = z
  .enum(["managed", "override", "path", "missing"])
  .describe(
    "managed = Claudexor's managed npm copy; override = the explicit CLAUDEXOR_<HARNESS>_BIN program; path = another copy found on the harness PATH; missing = nothing launchable.",
  );
const Mechanism = z
  .enum(["managed_npm", "vendor_updater", "vendor_script"])
  .describe(
    "managed_npm installs one exact registry version in place; vendor_updater runs the vendor's own `update` on its canonical launcher (latest only); vendor_script has no engine-run update.",
  );

export const HarnessMaintenanceEntry = z
  .object({
    harness: z.string(),
    mechanism: Mechanism,
    maintainable: z.boolean().describe("Whether the engine can run an operation for it now."),
    canCheckLatest: z
      .boolean()
      .describe(
        "Whether checkLatest can observe the newest release for this mechanism (npm registry); false for vendor updaters, whose Update still targets latest.",
      ),
    targets: z
      .array(TargetKind)
      .describe("Targets an operation may name; empty when not maintainable."),
    remedy: z.string().nullable().describe("Manual remedy when not maintainable."),
    selection: z
      .object({
        kind: SelectionKind,
        binary: z.string().nullable().describe("The program the harness resolves and runs."),
        version: z
          .string()
          .nullable()
          .describe("That selected program's own --version answer; never the managed copy's."),
        overrideEnv: z.string().nullable(),
      })
      .strict(),
    installed: z
      .object({
        version: z.string().nullable().describe("The managed npm copy's package version."),
        binary: z.string().nullable(),
        proved: z.boolean().describe("The managed launcher reported exactly that version."),
      })
      .strict(),
    releaseTested: z
      .object({
        version: z.string().nullable(),
        verification: z.enum(["release_verified", "deterministic_only"]).nullable(),
      })
      .strict()
      .describe("This release's tested pin: a separate fact, never the selected target."),
    available: z
      .object({ version: z.string(), observedAt: IsoTimestamp })
      .strict()
      .nullable()
      .describe("Last observed newest release; null = not checked (not 'up to date')."),
    availableProblem: ControlProblem.nullable(),
    previous: z
      .object({ version: z.string(), operationId: z.string() })
      .strict()
      .nullable()
      .describe("Proved earlier version from retained operation evidence; null when unknown."),
    operation: z
      .object({
        id: z.string(),
        state: z.string(),
        phase: z.string(),
        targetVersion: z.string().nullable(),
        finishedAt: IsoTimestamp.nullable(),
      })
      .strict()
      .nullable(),
    observedAt: IsoTimestamp,
  })
  .strict();
export type HarnessMaintenanceEntry = z.infer<typeof HarnessMaintenanceEntry>;

export const ControlHarnessMaintenanceInventory = z
  .object({ observedAt: IsoTimestamp, harnesses: z.array(HarnessMaintenanceEntry) })
  .strict()
  .describe("Response for GET /v2/maintenance/harnesses.");
export type ControlHarnessMaintenanceInventory = z.infer<typeof ControlHarnessMaintenanceInventory>;

export const ControlHarnessMaintenanceCreateRequest = z
  .object({ harness: z.string().min(1).max(64), target: HarnessMaintenanceTarget })
  .strict();
export type ControlHarnessMaintenanceCreateRequest = z.infer<
  typeof ControlHarnessMaintenanceCreateRequest
>;

/** Durable command params; `target.version` is bound at acceptance for
 * previous/baseline/version and stays null for latest until execution. */
export const HarnessMaintenanceParams = z
  .object({
    kind: z.literal("harness_maintenance"),
    harness: z.string().min(1).max(64),
    target: z.object({ kind: TargetKind, version: HarnessVendorVersion.nullable() }).strict(),
  })
  .strict();
export type HarnessMaintenanceParams = z.infer<typeof HarnessMaintenanceParams>;

export function isHarnessMaintenanceOperation(params: unknown): boolean {
  return (
    typeof params === "object" &&
    params !== null &&
    "kind" in params &&
    params.kind === "harness_maintenance"
  );
}

const Before = z
  .object({
    version: z.string().nullable(),
    binary: z.string().nullable(),
    selection: SelectionKind,
    proved: z.boolean(),
  })
  .strict();
const After = z
  .object({
    version: z.string().nullable(),
    binary: z.string().nullable(),
    selected: z.boolean().describe("The harness now resolves this program."),
    proved: z.boolean(),
  })
  .strict();

/** Evidence kept in the generic command record (JobRecord.result). */
export const HarnessMaintenanceEvidence = z
  .object({
    phase: z.enum(["accepted", "preparing", "installing", "settled"]),
    mechanism: Mechanism.nullable(),
    target: z.object({ kind: TargetKind, version: z.string().nullable() }).strict(),
    before: Before.nullable(),
    after: After.nullable(),
    mutation: z
      .enum(["none", "applied", "unknown"])
      .describe("Whether installed bytes could have changed."),
    termination: z.enum(["not_applicable", "confirmed", "unconfirmed"]),
    limitations: z.array(z.string()),
    progress: z.array(z.string()).max(40),
    problem: ControlProblem.nullable(),
  })
  .strict();
export type HarnessMaintenanceEvidence = z.infer<typeof HarnessMaintenanceEvidence>;

export const ControlHarnessMaintenanceOperation = HarnessMaintenanceEvidence.extend({
  id: z.string(),
  harness: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]),
  createdAt: IsoTimestamp,
  startedAt: IsoTimestamp.nullable(),
  finishedAt: IsoTimestamp.nullable(),
})
  .strict()
  .describe("A durable harness maintenance operation; 202 on create is a handle, not success.");
export type ControlHarnessMaintenanceOperation = z.infer<typeof ControlHarnessMaintenanceOperation>;
