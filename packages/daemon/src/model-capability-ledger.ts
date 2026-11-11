import { createHash } from "node:crypto";
import type {
  ControlModelCatalogResponse,
  ControlProblem,
  ModelCapabilityMark,
  ModelCallRequest,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { CredentialGeneration } from "./credential-generation.js";

/** Ordering evidence only, retained in memory for one daemon lifetime. */
export const MODEL_CAPABILITY_TTL_MS = 4 * 60 * 60_000;
const MAX_ENTRIES = 512;

export interface CapabilityBinding {
  harnessId: string;
  profileId: string;
  model: string;
  fingerprint: string | null;
  generation: number;
  revision: number;
  order: number;
}
interface CatalogIdentity {
  signature: string;
  generation: number;
  revision: number;
  observedAt: string;
}
interface Contribution {
  reason: string;
  since: string;
  confirmed: boolean;
}
interface Row {
  binding: CapabilityBinding;
  contributions: Map<string, Contribution>;
  /** First refusal of this episode; renewals and probes keep it, clearing ends the episode. */
  startedAt: string;
  expiresAt: number;
  probe: { operationId: string; order: number } | null;
}
export interface CapabilityAttempt {
  binding: CapabilityBinding;
  problem: ControlProblem;
  digest: string;
  expiresAt: number;
  claimedBy?: string;
}

function subject(harnessId: string, profileId: string): string {
  return JSON.stringify([harnessId, profileId]);
}
function key(binding: Pick<CapabilityBinding, "harnessId" | "profileId" | "model">): string {
  return JSON.stringify([binding.harnessId, binding.profileId, binding.model]);
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
function modelRetryDigest(request: ModelCallRequest): string {
  const { account: _account, retryOfOperationId: _retry, ...generation } = request;
  return hash(generation);
}

/** Catalog fingerprints are invalidation tokens, NEVER cached admission. Every
 * selection still reads a fresh per-account catalog. Producer-bound contributions
 * let a successful differential confirm only its own evidence. */
export class ModelCapabilityLedger {
  private catalogs = new Map<string, CatalogIdentity>();
  private rows = new Map<string, Row>();
  private attempts = new Map<string, CapabilityAttempt>();
  private successes = new Map<string, number>();
  private sequence = 0;
  constructor(
    readonly credentials = new CredentialGeneration(),
    private readonly now: () => number = Date.now,
  ) {}

  observeCatalog(
    harnessId: string,
    catalog: ControlModelCatalogResponse,
    generation: number,
  ): void {
    if (this.credentials.generation(harnessId, catalog.credentialProfileId) !== generation) return;
    const id = subject(harnessId, catalog.credentialProfileId);
    const old = this.catalogs.get(id);
    if (old && old.generation === generation && old.observedAt > catalog.observedAt) return;
    const signature = hash([
      catalog.accountFingerprint,
      catalog.capabilityFingerprint,
      catalog.clientVersion,
      catalog.clientVersionSource,
      [...catalog.models].sort((a, b) => a.id.localeCompare(b.id)),
    ]);
    if (old?.signature === signature && old.generation === generation) {
      old.observedAt = catalog.observedAt;
      return;
    }
    this.catalogs.set(id, {
      signature,
      generation,
      revision: ++this.sequence,
      observedAt: catalog.observedAt,
    });
    this.prune();
    this.bound(this.catalogs);
  }

  bind(harnessId: string, catalog: ControlModelCatalogResponse, model: string): CapabilityBinding {
    return {
      harnessId,
      profileId: catalog.credentialProfileId,
      model,
      fingerprint: catalog.accountFingerprint,
      generation:
        this.catalogs.get(subject(harnessId, catalog.credentialProfileId))?.generation ??
        Number.NaN,
      revision: this.catalogs.get(subject(harnessId, catalog.credentialProfileId))?.revision ?? -1,
      order: ++this.sequence,
    };
  }

  current(binding: CapabilityBinding): boolean {
    return (
      this.credentials.generation(binding.harnessId, binding.profileId) === binding.generation &&
      this.catalogs.get(subject(binding.harnessId, binding.profileId))?.revision ===
        binding.revision
    );
  }

  /**
   * Positive evidence that the account or its catalog changed. A login holding
   * the credential mutation window makes the generation unknown; unknown is not
   * a change, so work proceeds while the ledger neither records nor forgets.
   */
  changed(binding: CapabilityBinding): boolean {
    const generation = this.credentials.generation(binding.harnessId, binding.profileId);
    if (Number.isNaN(generation) || Number.isNaN(binding.generation)) return false;
    return !this.current(binding);
  }

  state(
    harnessId: string,
    profileId: string,
    model: string | null,
  ): ModelCapabilityMark["state"] | null {
    this.prune();
    const row = model === null ? undefined : this.rows.get(key({ harnessId, profileId, model }));
    return row ? this.rowState(row) : null;
  }

  private rowState(row: Row): ModelCapabilityMark["state"] {
    if (row.probe) return "probing";
    if (row.expiresAt <= this.now()) return "probe_due";
    return [...row.contributions.values()].some((c) => c.confirmed) ? "confirmed" : "provisional";
  }

  /** Atomic, before invoke. Only one concurrent operation may take an expired
   * mark's probe. Other candidates remain available; no inference is retried. */
  reserve(binding: CapabilityBinding, operationId: string): boolean {
    this.prune();
    const row = this.rows.get(key(binding));
    if (!row) return true;
    if (row.probe) return row.probe.operationId === operationId;
    if (row.expiresAt <= this.now()) row.probe = { operationId, order: binding.order };
    return true;
  }

  release(binding: CapabilityBinding, operationId: string): void {
    const row = this.rows.get(key(binding));
    if (row?.probe?.operationId !== operationId) return;
    row.probe = null;
    // Unknown/cancelled outcomes do not prove service. Bound another probe's
    // cadence rather than immediately replaying an uncertain request.
    row.expiresAt = this.now() + MODEL_CAPABILITY_TTL_MS;
  }

  refuse(
    binding: CapabilityBinding,
    operationId: string,
    problem: ControlProblem,
    request: ModelCallRequest,
  ): void {
    if (!this.current(binding) || (this.successes.get(key(binding)) ?? -1) > binding.order) return;
    this.prune();
    const row = this.rows.get(key(binding)) ?? {
      binding,
      contributions: new Map(),
      startedAt: new Date(this.now()).toISOString(),
      expiresAt: 0,
      probe: null,
    };
    if (binding.order > row.binding.order) row.binding = binding;
    row.contributions.set(operationId, {
      reason: redactSecrets(String(problem.context.providerReason ?? problem.message)).slice(
        0,
        1024,
      ),
      since: new Date(this.now()).toISOString(),
      confirmed: false,
    });
    this.bound(row.contributions);
    row.expiresAt = this.now() + MODEL_CAPABILITY_TTL_MS;
    if (row.probe && row.probe.order <= binding.order) row.probe = null;
    this.rows.set(key(binding), row);
    this.attempts.set(operationId, {
      binding,
      problem,
      digest: modelRetryDigest(request),
      expiresAt: row.expiresAt,
    });
    this.bound(this.rows);
    this.bound(this.attempts);
  }

  /** An unrecognized pre-generation refusal grants the host's one correlated
   * retry without claiming a capability gap: no row exists until the differential
   * proves the account at fault (settleRetry "confirmed"). */
  offer(
    binding: CapabilityBinding,
    operationId: string,
    problem: ControlProblem,
    request: ModelCallRequest,
  ): void {
    if (!this.current(binding)) return;
    this.prune();
    this.attempts.set(operationId, {
      binding,
      problem,
      digest: modelRetryDigest(request),
      expiresAt: this.now() + MODEL_CAPABILITY_TTL_MS,
    });
    this.bound(this.attempts);
  }

  served(binding: CapabilityBinding): void {
    if (!this.current(binding)) return;
    this.successes.set(
      key(binding),
      Math.max(this.successes.get(key(binding)) ?? -1, binding.order),
    );
    this.bound(this.successes);
    const row = this.rows.get(key(binding));
    if (row && row.binding.order <= binding.order) this.rows.delete(key(binding));
  }

  /** A newer selection of this account served this model: older evidence is stale. */
  servedAfter(binding: CapabilityBinding): boolean {
    return (this.successes.get(key(binding)) ?? -1) > binding.order;
  }

  claimRetry(request: ModelCallRequest, operationId: string): CapabilityAttempt | null {
    if (!request.retryOfOperationId) return null;
    this.prune();
    const attempt = this.attempts.get(request.retryOfOperationId);
    if (
      request.account.mode !== "auto" ||
      !attempt ||
      this.changed(attempt.binding) ||
      attempt.claimedBy ||
      attempt.problem.context.retryOnOtherAccount !== true ||
      attempt.digest !== modelRetryDigest(request)
    ) {
      throw Object.assign(
        new Error(
          "Capability retry requires an unused, current auto refusal and the same generation request. Keep the original refusal; do not repeat this retry without correlation.",
        ),
        { code: "model_retry_invalid", retryable: false },
      );
    }
    attempt.claimedBy = operationId;
    return attempt;
  }

  settleRetry(parentId: string, outcome: "confirmed" | "equivalent_refusal"): void {
    // Equivalent refusals leave the first contribution provisional. The retry
    // contributes its own refusal through refuse(), under its own binding.
    if (outcome === "equivalent_refusal") return;
    const attempt = this.attempts.get(parentId);
    if (!attempt || !this.current(attempt.binding)) return;
    const row = this.rows.get(key(attempt.binding));
    const contribution = row?.contributions.get(parentId);
    if (row && contribution) {
      contribution.confirmed = true;
      return;
    }
    // An unrecognized refusal that another account then served is now proven
    // to be this account's: it becomes an ordinary, confirmed temporary mark.
    if (
      row ||
      attempt.problem.context.capabilityKind !== "unclassified" ||
      (this.successes.get(key(attempt.binding)) ?? -1) > attempt.binding.order
    )
      return;
    const since = new Date(this.now()).toISOString();
    this.rows.set(key(attempt.binding), {
      binding: attempt.binding,
      contributions: new Map([
        [
          parentId,
          {
            reason: redactSecrets(
              String(attempt.problem.context.providerReason ?? attempt.problem.message),
            ).slice(0, 1024),
            since,
            confirmed: true,
          },
        ],
      ]),
      startedAt: since,
      expiresAt: this.now() + MODEL_CAPABILITY_TTL_MS,
      probe: null,
    });
    this.bound(this.rows);
  }

  live(): ModelCapabilityMark[] {
    this.prune();
    return [...this.rows.values()].map((row) => {
      const entries = [...row.contributions.values()];
      return {
        harness_id: row.binding.harnessId,
        profile_id: row.binding.profileId,
        requested_model: row.binding.model,
        account_fingerprint: row.binding.fingerprint,
        provider_reason: entries.at(-1)!.reason,
        observed_at: row.startedAt,
        expires_at: new Date(row.expiresAt).toISOString(),
        state: this.rowState(row),
      };
    });
  }

  private prune(): void {
    for (const [id, row] of this.rows) if (this.changed(row.binding)) this.rows.delete(id);
    for (const [id, attempt] of this.attempts)
      if (this.changed(attempt.binding) || attempt.expiresAt <= this.now())
        this.attempts.delete(id);
  }
  private bound<T>(map: Map<string, T>): void {
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
  }
}
