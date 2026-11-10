import { z } from "zod/v3";
import { ControlProblem } from "./problem.js";
import { IsoTimestamp } from "./primitives.js";
import { SelectedHarnessProgram } from "./harness-program.js";

export const HarnessVendorVersion = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  .describe("One exact vendor version, never a range or a release fixture stamp.");

export const HarnessMaintenanceTarget = z
  .discriminatedUnion(
    "kind",
    [
      z.object({ kind: z.literal("latest") }).strict(),
      z.object({ kind: z.literal("version"), version: HarnessVendorVersion }).strict(),
    ],
    {
      errorMap: () => ({
        message:
          'Use target {kind:"latest"} or {kind:"version",version:"<exact>"}; previous and baseline are retired.',
      }),
    },
  )
  .describe(
    "latest runs the selected program's updater, or installs when missing; version uses the adapter's exact-version command. Retired previous/baseline targets must be sent as version with an explicit version.",
  );
export type HarnessMaintenanceTarget = z.infer<typeof HarnessMaintenanceTarget>;
const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("latest"), version: z.null() }).strict(),
  z.object({ kind: z.literal("version"), version: HarnessVendorVersion }).strict(),
]);
const Requester = z.object({ source: z.string(), requestId: z.string().nullable() }).strict();

export const HarnessNewestObservation = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_read"), source: z.string().nullable() }).strict(),
  z
    .object({
      status: z.literal("available"),
      source: z.string(),
      version: z.string(),
      observedAt: IsoTimestamp,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      source: z.string().nullable(),
      observedAt: IsoTimestamp,
      problem: ControlProblem,
    })
    .strict(),
]);
export type HarnessNewestObservation = z.infer<typeof HarnessNewestObservation>;

export const HarnessMaintenanceCommand = z
  .object({
    binary: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string()),
    script: z
      .object({ url: z.string(), size: z.number().int().positive(), sha256: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type HarnessMaintenanceCommand = z.infer<typeof HarnessMaintenanceCommand>;

/** Kept in the existing command record, including partial effects on cancellation. */
export const HarnessMaintenanceEvidence = z
  .object({
    phase: z.enum(["accepted", "preparing", "installing", "settled"]),
    target: Target,
    requester: Requester,
    installationHome: z.string().nullable(),
    commands: z.array(HarnessMaintenanceCommand),
    before: SelectedHarnessProgram.nullable(),
    after: SelectedHarnessProgram.nullable(),
    elsewhere: z
      .object({ before: SelectedHarnessProgram, after: SelectedHarnessProgram })
      .strict()
      .nullable(),
    activeRunsAtStart: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("A fact, never permission to proceed; null when the CLI has no daemon run census."),
    exitCode: z.number().int().nullable(),
    outcome: z.enum(["changed", "not_changed", "changed_elsewhere", "unknown"]),
    mutation: z.enum(["none", "applied", "unknown"]),
    termination: z.enum(["not_applicable", "confirmed", "unconfirmed"]),
    limitations: z.array(z.string()),
    progress: z
      .array(z.string())
      .max(40)
      .describe("Bounded, redacted vendor diagnostics, including advice when nothing changed."),
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
  .describe("A durable maintenance operation; acceptance is a handle, not completion.");
export type ControlHarnessMaintenanceOperation = z.infer<typeof ControlHarnessMaintenanceOperation>;

const Action = z.object({ available: z.boolean(), reason: z.string().nullable() }).strict();
export const HarnessMaintenanceEntry = z
  .object({
    harness: z.string(),
    selection: SelectedHarnessProgram,
    newest: HarnessNewestObservation,
    actions: z.object({ install: Action, update: Action, exactVersion: Action }).strict(),
    operation: ControlHarnessMaintenanceOperation.nullable(),
    observedAt: IsoTimestamp,
  })
  .strict();
export type HarnessMaintenanceEntry = z.infer<typeof HarnessMaintenanceEntry>;
export const ControlHarnessMaintenanceInventory = z
  .object({
    observedAt: IsoTimestamp,
    harnesses: z.array(HarnessMaintenanceEntry),
  })
  .strict();
export type ControlHarnessMaintenanceInventory = z.infer<typeof ControlHarnessMaintenanceInventory>;

export const ControlHarnessMaintenanceCreateRequest = z
  .object({
    harness: z.string().min(1).max(64),
    target: HarnessMaintenanceTarget,
  })
  .strict();
export type ControlHarnessMaintenanceCreateRequest = z.infer<
  typeof ControlHarnessMaintenanceCreateRequest
>;
export const HarnessMaintenanceParams = z
  .object({
    kind: z.literal("harness_maintenance"),
    harness: z.string().min(1).max(64),
    target: Target,
    requester: Requester,
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
