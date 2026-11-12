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

const scopeOf = (profile: Pick<CredentialProfile, "harness_id" | "profile_id">) =>
  JSON.stringify([profile.harness_id, profile.profile_id]);

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
    this.programUnsubscribe = onProgramObservationChange(() => this.invalidate());
    this.unsubscribe = credentials.onChange((subject) =>
      this.invalidate(
        subject
          ? scopeOf({ harness_id: subject.harnessId, profile_id: subject.profileId })
          : undefined,
      ),
    );
  }

  prune(profiles: readonly CredentialProfile[]): void {
    const live = new Set(profiles.map(scopeOf));
    for (const scope of this.positives.keys()) if (!live.has(scope)) this.invalidate(scope);
  }

  private invalidate(scope?: string): void {
    this.reads.invalidate(scope);
    if (scope === undefined) this.positives.clear();
    else this.positives.delete(scope);
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
    const scope = scopeOf(profile);
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
    if (key !== null && hit?.key === key && age >= 0 && age < DOCTOR_TTL_MS)
      return structuredClone(hit.status);
    this.positives.delete(scope);
    const result = await this.reads.read(scope, key, signal, async (physicalSignal) => {
      const startedAt = Date.now();
      const status = CredentialProfileStatus.parse(
        await adapter.probeCredentialProfile!(profile, physicalSignal),
      );
      physicalSignal.throwIfAborted();
      if (status.profile_id !== profile.profile_id || status.harness_id !== profile.harness_id)
        throw new Error("Login probe returned another profile");
      const after = await identity();
      physicalSignal.throwIfAborted();
      if (key !== null && after !== key)
        throw Object.assign(new Error("Login identity changed during the probe"), {
          code: "auth_changed",
        });
      const observedAt = Date.parse(status.last_verified_at ?? "");
      if (
        key !== null &&
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
    });
    signal.throwIfAborted();
    return structuredClone(result);
  }
}
