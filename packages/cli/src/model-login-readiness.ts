import {
  DatedPositives,
  ReadInvalidated,
  SharedRead,
  observeHarnessProgram,
  onProgramObservationChange,
  waitForRead,
  type CredentialProfileProbeOptions,
  type HarnessAdapter,
  type ProgramObservation,
} from "@claudexor/core";
import type { CredentialGeneration } from "@claudexor/daemon";
import { CredentialProfileStatus, type CredentialProfile } from "@claudexor/schema";
import { startModelPreparation } from "@claudexor/util";

const scopeOf = (harnessId: string, profileId: string) => `${harnessId}\0${profileId}`;

/** Admission-grade raw observations, separate from accountObservations display
 * projections, shared by raw-model selection and run start. Quota, revocation,
 * policy and selection never enter this owner. */
export class ModelLoginReadiness {
  private readonly reads = new SharedRead<CredentialProfileStatus>();
  private readonly positives = new DatedPositives<CredentialProfileStatus>();
  private readonly unsubscribe: () => void;
  private readonly programUnsubscribe: () => void;
  private closed = false;

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
    this.positives.drop((scope) => !live.has(scope));
  }

  private invalidate(matches: (scope: string) => boolean = () => true): void {
    this.reads.invalidate(matches);
    this.positives.drop(matches);
  }

  /** Run start's login probe for one adapter, under the rule raw-model selection
   * uses (INV-135, owner decision 2026-11-18): the same owner, key and positives.
   * An adapter that versions no login files can never reuse one: it keeps its own
   * probe, without this owner's program observation. */
  runStartProbe(adapter: HarnessAdapter): NonNullable<HarnessAdapter["probeCredentialProfile"]> {
    if (!adapter.credentialProfileIdentity) return adapter.probeCredentialProfile!.bind(adapter);
    const unbounded = new AbortController().signal;
    return (profile, signal = unbounded, options) =>
      this.probe(profile, adapter, signal, { options });
  }

  close(): void {
    this.closed = true;
    this.programUnsubscribe();
    this.unsubscribe();
    this.invalidate();
  }

  /** `observed` may be one program observation shared by a selection's profiles;
   * the check after a physical probe and a retry always observe again. A pin's
   * physical probe keeps its own wait and never joins an ordinary one. */
  async probe(
    profile: CredentialProfile,
    adapter: HarnessAdapter,
    signal: AbortSignal,
    {
      observed,
      options,
      reuse = true,
      retry = true,
    }: {
      observed?: Promise<ProgramObservation>;
      options?: CredentialProfileProbeOptions;
      reuse?: boolean;
      retry?: boolean;
    } = {},
  ): Promise<CredentialProfileStatus> {
    signal.throwIfAborted();
    const finish = startModelPreparation();
    const scope = scopeOf(profile.harness_id, profile.profile_id);
    const identity = async (current = observeHarnessProgram(adapter.program)) => {
      const generation = this.credentials.generation(profile.harness_id, profile.profile_id);
      const [files, program] = await Promise.all([
        adapter.credentialProfileIdentity?.(profile) ?? null,
        current,
      ]);
      return Number.isFinite(generation) &&
        generation === this.credentials.generation(profile.harness_id, profile.profile_id) &&
        files !== null &&
        program.program?.path &&
        program.program.version
        ? JSON.stringify([profile, generation, files, program.key])
        : null;
    };
    const key = await waitForRead(identity(observed), signal);
    const hit = this.positives.get(scope, key, reuse);
    if (hit) {
      finish("loginReady");
      return hit;
    }
    const joinKey = key !== null && options?.pinned ? `${key}\0pinned` : key;
    const result = await this.reads
      .read(scope, joinKey, signal, async (physicalSignal) => {
        const publish = this.positives.observe(scope);
        const startedAt = Date.now();
        try {
          const status = CredentialProfileStatus.parse(
            await adapter.probeCredentialProfile!(profile, physicalSignal, options),
          );
          physicalSignal.throwIfAborted();
          if (status.profile_id !== profile.profile_id || status.harness_id !== profile.harness_id)
            throw new Error("Login probe returned another profile");
          // A login or program change during the probe still answers this probe;
          // only an answer under one unchanged identity is retained for reuse.
          const unchanged = key !== null && (await identity()) === key;
          physicalSignal.throwIfAborted();
          const observedAt = Date.parse(status.last_verified_at ?? "");
          const positive =
            status.availability === "available" &&
            status.verification === "passed" &&
            status.stale !== true &&
            Number.isFinite(observedAt) &&
            observedAt <= Date.now();
          // A refused, unknown or stale answer is evidence against the remembered
          // login; an older success answering later cannot restore it.
          if (!positive) publish();
          else if (unchanged) publish({ key, at: Math.min(startedAt, observedAt), value: status });
          return status;
        } catch (error) {
          // A probe that failed, not one its waiters left or a change ended, is too.
          if (!physicalSignal.aborted) publish();
          throw error;
        }
      })
      .finally(() => finish("loginProbe"))
      .catch((error: unknown) => {
        // A credential or program change, not this caller leaving, ended the
        // probe: ask once more under the new identity. Nothing aborted is kept.
        if (!retry || signal.aborted || this.closed || !(error instanceof ReadInvalidated))
          throw error;
        return this.probe(profile, adapter, signal, { options, reuse, retry: false });
      });
    signal.throwIfAborted();
    return structuredClone(result);
  }
}
