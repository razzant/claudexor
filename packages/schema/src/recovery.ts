import { z } from "zod";

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: true });

export const JournalRecoveryLocation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("byte"), byteOffset: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("cursor"),
      epoch: z.string().min(1),
      seq: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const ControlJournalRecoveryState = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ready"), discardedTailBytes: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      status: z.literal("recovery_required"),
      location: JournalRecoveryLocation,
      reason: z.string().min(1),
      discardedTailBytes: z.number().int().nonnegative(),
    })
    .strict(),
]);

const JournalInspectionFields = {
  schemaVersion: z.literal(1),
  partition: z.literal("global"),
  generation: z.number().int().nonnegative(),
  status: z.enum(["ready", "recovery_required"]),
  recovery: ControlJournalRecoveryState,
  fingerprint: Sha256Hex,
  observedAt: Timestamp,
  evidenceRefs: z.array(z.string().min(1)).min(1),
} as const;

function requireMatchingRecoveryStatus(
  value: {
    status: "ready" | "recovery_required";
    recovery: { status: "ready" | "recovery_required" };
  },
  context: z.RefinementCtx,
): void {
  if (value.status !== value.recovery.status) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "inspection status must match recovery status",
    });
  }
}

export const ControlJournalInspection = z
  .object(JournalInspectionFields)
  .strict()
  .superRefine(requireMatchingRecoveryStatus);
export type ControlJournalInspection = z.infer<typeof ControlJournalInspection>;

export const ControlJournalValidation = z
  .object({
    ...JournalInspectionFields,
    projectionStatus: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.enum(["valid", "invalid"]),
          detail: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine(requireMatchingRecoveryStatus);
export type ControlJournalValidation = z.infer<typeof ControlJournalValidation>;

export const ControlJournalExportReceipt = z
  .object({
    schemaVersion: z.literal(1),
    exportId: z.string().min(1),
    partition: z.literal("global"),
    fingerprint: Sha256Hex,
    bundlePath: z.string().min(1),
    manifestSha256: Sha256Hex,
    createdAt: Timestamp,
  })
  .strict();
export type ControlJournalExportReceipt = z.infer<typeof ControlJournalExportReceipt>;

export const ControlJournalQuarantineRequest = z
  .object({
    expectedFingerprint: Sha256Hex,
    confirmation: z.literal("quarantine_and_start_fresh"),
  })
  .strict();
export type ControlJournalQuarantineRequest = z.infer<typeof ControlJournalQuarantineRequest>;

export const ControlJournalQuarantineReceipt = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    partition: z.literal("global"),
    previousFingerprint: Sha256Hex,
    quarantineArtifactId: z.string().min(1),
    quarantinePath: z.string().min(1),
    newEpoch: z.string().min(1),
    completedAt: Timestamp,
  })
  .strict();
export type ControlJournalQuarantineReceipt = z.infer<typeof ControlJournalQuarantineReceipt>;
