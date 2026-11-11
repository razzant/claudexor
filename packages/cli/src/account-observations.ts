import { observeHarnessProgram, assertSameProgram, type ProgramObservation } from "@claudexor/core";
import type { HarnessProgram } from "@claudexor/schema";
import { globalConfigPath } from "@claudexor/config";
import type { CredentialAccountProbeReceipt, HarnessAdapter } from "@claudexor/core";
import { probeCredentialProfileStatus } from "@claudexor/orchestrator";
import {
  AccountIdentity as AccountIdentitySchema,
  CredentialProfileStatus as ProfileStatusSchema,
  type CredentialProfile,
} from "@claudexor/schema";
import { claudeAccountIdentity } from "@claudexor/harness-claude";
import { codexAccountIdentity } from "@claudexor/harness-codex";
import { registerStatusProjection, STATUS_PROJECTION_TTL_MS } from "./status-projection-cache.js";

interface Observation<T> {
  value: T;
  at: number;
}
interface Entry {
  sequence: number;
  fingerprint: string;
  promise: Promise<Observation<unknown>>;
  pending: boolean;
}

/** Display acquisition is cold-once, including failure. TTL ages evidence; it
 * never schedules another vendor call. Credential invalidation and explicit
 * Refresh discard it. Run admission does not read this display cache. */
class AccountObservations {
  private entries = new Map<string, Entry>();
  private generation = 0;
  private harnessGenerations = new Map<string, number>();
  private sequence = 0;

  constructor() {
    registerStatusProjection(this);
  }

  invalidate(): void {
    this.entries.clear();
    this.generation += 1;
    this.harnessGenerations.clear();
  }

  generationFor(harnessId: string): string {
    return `${this.generation}:${this.harnessGenerations.get(harnessId) ?? 0}`;
  }

  startObservation(): number {
    return ++this.sequence;
  }

  /** One harness's observations only (e.g. after its CLI was replaced). */
  invalidateHarness(harnessId: string): void {
    this.harnessGenerations.set(harnessId, (this.harnessGenerations.get(harnessId) ?? 0) + 1);
    for (const key of this.entries.keys())
      if (key.split("\0")[2] === harnessId) this.entries.delete(key);
  }

  invalidateCatalogs(): void {
    for (const key of this.entries.keys())
      if (key.split("\0")[1] !== "profile") this.entries.delete(key);
  }

  observeProfile(
    profile: CredentialProfile,
    receipt: CredentialAccountProbeReceipt,
    generation: string,
    program?: ProgramObservation,
    sequence = this.startObservation(),
  ): void {
    if (generation !== this.generationFor(profile.harness_id)) return;
    const key = [globalConfigPath(), "profile", profile.harness_id, profile.profile_id].join("\0");
    // The display acquisition already receives this same adapter response.
    const current = this.entries.get(key);
    if (current?.pending || (current && current.sequence > sequence)) return;
    const status = ProfileStatusSchema.safeParse(receipt.status);
    if (
      !status.success ||
      status.data.profile_id !== profile.profile_id ||
      status.data.harness_id !== profile.harness_id
    )
      return;
    this.entries.set(key, {
      sequence,
      fingerprint: JSON.stringify([profile, program?.key ?? "no-program"]),
      pending: false,
      promise: Promise.resolve({ value: { ...receipt, status: status.data }, at: Date.now() }),
    });
  }

  async read<T>(
    kind: string,
    profile: CredentialProfile,
    acquire: () => Promise<T>,
    fresh = false,
    program?: HarnessProgram,
  ): Promise<Observation<T>> {
    const key = [globalConfigPath(), kind, profile.harness_id, profile.profile_id].join("\0");
    const generation = this.generationFor(profile.harness_id);
    const sequence = this.startObservation();
    const observed = await observeHarnessProgram(program);
    if (generation !== this.generationFor(profile.harness_id))
      throw new Error("Account changed during program observation; read it again");
    const fingerprint = JSON.stringify([profile, observed.key]);
    const current = this.entries.get(key);
    // A delayed --version answer must not displace a later acquisition. A
    // later read of the same identity already satisfies this caller's refresh.
    if (current && current.sequence > sequence) {
      if (current.fingerprint !== fingerprint)
        throw new Error("A newer program observation superseded this account read");
      return current.promise as Promise<Observation<T>>;
    }
    if (
      current?.fingerprint === fingerprint &&
      (!program || observed.program?.version != null) &&
      (!fresh || current.pending)
    )
      return current.promise as Promise<Observation<T>>;
    const entry: Entry = {
      sequence,
      fingerprint,
      pending: true,
      promise: Promise.resolve(null as never),
    };
    entry.promise = Promise.resolve()
      .then(acquire)
      .then(async (value) => {
        assertSameProgram(observed, await observeHarnessProgram(program));
        if (this.entries.get(key) !== entry)
          throw new Error("Account observation changed during acquisition; refresh again");
        return { value, at: Date.now() };
      })
      .finally(() => {
        entry.pending = false;
      });
    this.entries.set(key, entry);
    return entry.promise as Promise<Observation<T>>;
  }
}

export const accountObservations = new AccountObservations();

/** Non-secret identity from this binding's owned store, never an ambient login. */
export function profileAccountIdentity(profile: CredentialProfile) {
  if (!profile.isolation_locator) return null;
  if (profile.harness_id === "codex") return codexAccountIdentity(profile.isolation_locator);
  if (profile.harness_id === "claude") return claudeAccountIdentity(profile.isolation_locator);
  return null;
}

/** One acquisition shared by profile hydration and account-catalog display. */
export async function displayAccountObservation(
  profile: CredentialProfile,
  adapter?: HarnessAdapter,
  fresh = false,
): Promise<CredentialAccountProbeReceipt> {
  const observed = await accountObservations.read(
    "profile",
    profile,
    async () => {
      let identity = profileAccountIdentity(profile);
      const status = await probeCredentialProfileStatus(
        profile,
        adapter?.probeCredentialAccount
          ? async (candidate) => {
              const receipt = await adapter.probeCredentialAccount!(candidate);
              if (
                receipt.status.profile_id !== candidate.profile_id ||
                receipt.status.harness_id !== candidate.harness_id
              )
                throw new Error("Account probe returned a different profile");
              identity =
                receipt.identity === null ? null : AccountIdentitySchema.parse(receipt.identity);
              return receipt.status;
            }
          : adapter?.probeCredentialProfile?.bind(adapter),
      );
      return { status, identity };
    },
    fresh,
    adapter?.program,
  );
  const age = Math.max(0, Date.now() - observed.at);
  if (age <= STATUS_PROJECTION_TTL_MS) return observed.value;
  return {
    ...observed.value,
    status: {
      ...observed.value.status,
      // Retain what the probe observed. Display age does not revoke that fact
      // or decide whether the binding may make its first catalog read. Actual
      // run admission performs its own probe outside this display cache.
      detail:
        `Last checked ${new Date(observed.at).toISOString()}; refresh to verify current readiness. ${observed.value.status.detail ?? ""}`.trim(),
    },
  };
}

/** Existing necessary probes feed the same display owner; observing a run
 * never starts an extra probe. Credential or harness changes reject late receipts. */
export function retainAccountProbeObservations(adapter: HarnessAdapter): HarnessAdapter {
  const profileProbe = adapter.probeCredentialProfile?.bind(adapter);
  const accountProbe = adapter.probeCredentialAccount?.bind(adapter);
  return {
    ...adapter,
    ...(adapter.program
      ? {
          discover: async () => {
            const program = await observeHarnessProgram(adapter.program);
            const manifest = await adapter.discover();
            assertSameProgram(program, await observeHarnessProgram(adapter.program));
            return { ...manifest, sourceProgram: program.program };
          },
        }
      : {}),
    ...(profileProbe
      ? {
          probeCredentialProfile: async (
            ...args: Parameters<NonNullable<HarnessAdapter["probeCredentialProfile"]>>
          ) => {
            const generation = accountObservations.generationFor(args[0].harness_id);
            const sequence = accountObservations.startObservation();
            const program = adapter.program
              ? await observeHarnessProgram(adapter.program)
              : undefined;
            const status = await profileProbe(...args);
            if (program) assertSameProgram(program, await observeHarnessProgram(adapter.program));
            accountObservations.observeProfile(
              args[0],
              { status, identity: profileAccountIdentity(args[0]) },
              generation,
              program,
              sequence,
            );
            return status;
          },
        }
      : {}),
    ...(accountProbe
      ? {
          probeCredentialAccount: async (
            ...args: Parameters<NonNullable<HarnessAdapter["probeCredentialAccount"]>>
          ) => {
            const generation = accountObservations.generationFor(args[0].harness_id);
            const sequence = accountObservations.startObservation();
            const program = adapter.program
              ? await observeHarnessProgram(adapter.program)
              : undefined;
            const receipt = await accountProbe(...args);
            if (program) assertSameProgram(program, await observeHarnessProgram(adapter.program));
            accountObservations.observeProfile(args[0], receipt, generation, program, sequence);
            return receipt;
          },
        }
      : {}),
  };
}
