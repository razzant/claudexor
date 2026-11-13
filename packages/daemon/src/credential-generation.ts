import {
  credentialMutationWindowOpen,
  type CredentialExecutionBinding,
  type CredentialExecutionSubject,
} from "@claudexor/core";

/** The registered rows a credential change voided (null = every row). */
export type CredentialInvalidation = { harnessId: string; profileId: string } | null;

/** Extracted from the pre-progress ledger: one managed lifecycle for all observations. */
export class CredentialGeneration {
  private changes = 0;
  private everyAccountChangedAt = 0;
  private defaultChangedAt = 0;
  private accountChangedAt = new Map<string, number>();
  private dispatchOrder = 0;
  private retired = false;
  private readonly listeners = new Set<(scope: CredentialInvalidation) => void>();

  /** Raw reads stop immediately when their credential epoch ends. Only rows
   * whose generation moved are told; the default subject has no row reader. */
  onChange(listener: (scope: CredentialInvalidation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(scope: CredentialInvalidation): void {
    for (const listener of this.listeners) listener(scope);
  }

  constructor(
    private readonly mutating: (harnessId: string) => boolean = credentialMutationWindowOpen,
    /** Durable facts about registered rows that the same change voids. Called
     * after the generation moved, so a failing hook can never leave a stale
     * binding current. */
    private readonly onInvalidated: (scope: CredentialInvalidation) => void = () => {},
  ) {}

  generation(harnessId: string, profileId: string | null): number {
    if (this.retired || this.mutating(harnessId)) return Number.NaN;
    return Math.max(
      this.everyAccountChangedAt,
      profileId === null ? this.defaultChangedAt : 0,
      this.accountChangedAt.get(key(harnessId, profileId)) ?? 0,
    );
  }

  bind(
    subject: CredentialExecutionSubject,
    startedAt = new Date().toISOString(),
  ): CredentialExecutionBinding {
    return {
      subject,
      generation: this.generation(subject.harnessId, subject.profileId),
      order: ++this.dispatchOrder,
      startedAt,
    };
  }

  current(binding: CredentialExecutionBinding): boolean {
    return (
      this.generation(binding.subject.harnessId, binding.subject.profileId) === binding.generation
    );
  }

  /** The owning store closed: no binding is current any more, so a late
   * outcome of a run from the closed graph neither records nor clears. */
  retire(): void {
    this.retired = true;
    this.changed(null);
    this.listeners.clear();
  }

  noteCredentialChange(): void {
    this.accountChangedAt.clear();
    this.everyAccountChangedAt = ++this.changes;
    this.changed(null);
    this.invalidated(null);
  }

  /** A change that keeps the row's binding (its Enabled toggle) still moves the
   * generation, so no try bound before it records or clears anything after it,
   * but leaves that binding's durable facts. */
  clearSubject(harnessId: string, profileId: string | null, keepsBinding = false): void {
    this.accountChangedAt.set(key(harnessId, profileId), ++this.changes);
    // Readers and durable facts exist only for registered rows, never the default subject.
    if (profileId !== null) this.changed({ harnessId, profileId });
    if (profileId !== null && !keepsBinding) this.invalidated({ harnessId, profileId });
  }

  clearDefaultSubjects(): void {
    this.defaultChangedAt = ++this.changes;
  }

  private invalidated(scope: CredentialInvalidation): void {
    // A retired generation's store is closed; its facts died with the graph.
    if (!this.retired) this.onInvalidated(scope);
  }
}

function key(harnessId: string, profileId: string | null): string {
  return `${harnessId}\0${profileId ?? "\u0001"}`;
}
