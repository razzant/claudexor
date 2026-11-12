import {
  DOCTOR_TTL_MS,
  SharedRead,
  observeHarnessProgram,
  onProgramObservationChange,
  waitForRead,
  type HarnessAdapter,
} from "@claudexor/core";
import type { CredentialGeneration } from "@claudexor/daemon";
import { CredentialProfileStatus, type CredentialProfile } from "@claudexor/schema";
import { startModelPreparation } from "@claudexor/util";

const scopeOf = (harnessId: string, profileId: string) => `${harnessId}\0${profileId}`;

/** Admission-grade raw observations, separate from accountObservations display
 * projections. Quota, revocation, policy and selection never enter this owner. */
export class ModelLoginReadiness {
  private readonly reads = new SharedRead<CredentialProfileStatus>();
  private readonly positives = new Map<
    string,
    { key: string; at: number; status: CredentialProfileStatus }
  >();
  private readonly unsubscribe: () => void;
  private readonly programUnsubscribe: () => void;

  constructor(private readonly credentials: CredentialGeneration) {
    // A program change ends only that harness's probes and positives.
    this.programUnsubscribe = onProgramObservationChange((harness) =>
      this.invalidate((scope) => !harness || scope.startsWith(`${harness}\0`)),
    );
    this.unsubscribe = credentials.onChange((subject) =>
      this.invalidate(
        (scope) => !subject || scope === scopeOf(subject.harnessId, subject.profileId),
      ),
    );
  }

  prune(profiles: readonly CredentialProfile[]): void {
    const live = new Set(profiles.map((row) => scopeOf(row.harness_id, row.profile_id)));
    for (const scope of this.positives.keys()) if (!live.has(scope)) this.positives.delete(scope);
  }

  private invalidate(matches: (scope: string) => boolean = () => true): void {
    this.reads.invalidate(matches);
    for (const scope of this.positives.keys()) if (matches(scope)) this.positives.delete(scope);
  }

  close(): void {
    this.programUnsubscribe();
    this.unsubscribe();
    this.invalidate();
  }

  async probe(
    profile: CredentialProfile,
    adapter: HarnessAdapter,
    signal: AbortSignal,
  ): Promise<CredentialProfileStatus> {
    signal.throwIfAborted();
    const finish = startModelPreparation();
    const scope = scopeOf(profile.harness_id, profile.profile_id);
    const identity = async () => {
      const generation = this.credentials.generation(profile.harness_id, profile.profile_id);
      const [files, program] = await Promise.all([
        adapter.credentialProfileIdentity?.(profile) ?? null,
        observeHarnessProgram(adapter.program),
      ]);
      return Number.isFinite(generation) &&
        generation === this.credentials.generation(profile.harness_id, profile.profile_id) &&
        files !== null &&
        program.program?.path &&
        program.program.version
        ? JSON.stringify([profile, generation, files, program.key])
        : null;
    };
    const key = await waitForRead(identity(), signal);
    const hit = this.positives.get(scope);
    const age = hit ? Date.now() - hit.at : -1;
    if (key !== null && hit?.key === key && age >= 0 && age < DOCTOR_TTL_MS) {
      finish("loginReady");
      return structuredClone(hit.status);
    }
    this.positives.delete(scope);
    const result = await this.reads
      .read(scope, key, signal, async (physicalSignal) => {
        const startedAt = Date.now();
        const status = CredentialProfileStatus.parse(
          await adapter.probeCredentialProfile!(profile, physicalSignal),
        );
        physicalSignal.throwIfAborted();
        if (status.profile_id !== profile.profile_id || status.harness_id !== profile.harness_id)
          throw new Error("Login probe returned another profile");
        // A login or program change during the probe still answers this probe;
        // only an answer under one unchanged identity is retained for reuse.
        const unchanged = key !== null && (await identity()) === key;
        physicalSignal.throwIfAborted();
        const observedAt = Date.parse(status.last_verified_at ?? "");
        if (
          unchanged &&
          status.availability === "available" &&
          status.verification === "passed" &&
          status.stale !== true &&
          Number.isFinite(observedAt) &&
          observedAt <= Date.now()
        ) {
          this.positives.set(scope, {
            key,
            at: Math.min(startedAt, observedAt),
            status: structuredClone(status),
          });
        }
        return status;
      })
      .finally(() => finish("loginProbe"));
    signal.throwIfAborted();
    return structuredClone(result);
  }
}
