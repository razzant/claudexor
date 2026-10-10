export type JournalRecoveryLocation =
  { kind: "byte"; byteOffset: number } | { kind: "cursor"; epoch: string; seq: number };

export type JournalRecoveryState =
  | { status: "ready"; discardedTailBytes: number }
  | {
      status: "recovery_required";
      location: JournalRecoveryLocation;
      reason: string;
      discardedTailBytes: number;
    };
export class JournalRecoveryRequiredError extends Error {
  readonly code: string = "journal_recovery_required";
  readonly status = 503;
  readonly retryable = false;
  readonly requiredActions = ["inspect_recovery", "export_recovery", "quarantine_partition"];
  readonly evidenceRefs: string[] = [];
  readonly recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>;

  constructor(recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>) {
    const safe = Object.freeze({ ...recovery, location: Object.freeze({ ...recovery.location }) });
    const where =
      safe.location.kind === "byte"
        ? `byte ${safe.location.byteOffset}`
        : `cursor ${safe.location.epoch}:${safe.location.seq}`;
    super(`journal partition requires recovery at ${where}: ${safe.reason}`);
    this.name = "JournalRecoveryRequiredError";
    this.recovery = safe;
  }
}

export function journalRecoveryAt(
  byteOffset: number,
  reason: string,
): Extract<JournalRecoveryState, { status: "recovery_required" }> {
  return {
    status: "recovery_required",
    location: { kind: "byte", byteOffset },
    reason,
    discardedTailBytes: 0,
  };
}

export class JournalAppendUncertainError extends JournalRecoveryRequiredError {
  override readonly code = "journal_append_uncertain";

  constructor(
    recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>,
    options?: ErrorOptions,
  ) {
    super(recovery);
    this.name = "JournalAppendUncertainError";
    if (options?.cause !== undefined)
      Object.defineProperty(this, "cause", { value: options.cause });
  }
}
