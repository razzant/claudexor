import { randomUUID } from "node:crypto";
import {
  ControlAccountResetRequest,
  ControlAccountResetResponse,
  type AccountTarget,
  type ControlAccountResourcesResponse,
} from "@claudexor/schema";
import type { CommandStorePort } from "./store-contracts.js";
import type { JobRecord } from "./server.js";

/** Host-private immutable target, stored before dispatch. No bearer material. */
export interface AccountResetBinding {
  harness: string;
  locator: string;
  fingerprint: string;
  program: string;
  grant_id: string | null;
  native_request_id: string;
}
type AcceptedReset = {
  kind: "account_reset";
  request: ControlAccountResetRequest;
  binding: AccountResetBinding;
};
export interface AccountResetDependencies {
  commands: () => CommandStorePort;
  resolve: (request: ControlAccountResetRequest) => Promise<AccountResetBinding>;
  verify: (binding: AccountResetBinding, target: AccountTarget) => Promise<void>;
  consume: (
    binding: AccountResetBinding,
  ) => Promise<Pick<ControlAccountResetResponse, "outcome" | "detail">>;
  invalidate: (target: AccountTarget) => void;
  refresh: (
    target: AccountTarget,
    mayHaveChanged: boolean,
  ) => Promise<ControlAccountResourcesResponse>;
  read?: () => ControlAccountResourcesResponse;
  now?: () => Date;
}

/** A direct durable command, like delivery. The HTTP handler owns in-flight
 * shutdown custody; no inference job, slot, scheduler or automatic replay. */
export class AccountResets {
  private readonly active = new Map<string, Promise<ControlAccountResetResponse>>();
  constructor(private readonly deps: AccountResetDependencies) {}
  private now() {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  async create(input: {
    request: ControlAccountResetRequest;
    idempotencyKey: string;
    clientId: string;
  }): Promise<ControlAccountResetResponse> {
    const request = ControlAccountResetRequest.parse(input.request);
    const store = this.deps.commands();
    const key = {
      ...input,
      params: request,
      operation: "account.reset",
      idempotencyParams: request,
    };
    // Resolve replay BEFORE mutable profile or offer lookup.
    let record = store.find(key);
    if (!record) {
      const binding = await this.deps.resolve(request);
      record = store.accept({
        ...key,
        id: `account-reset-${randomUUID()}`,
        params: { kind: "account_reset", request, binding } satisfies AcceptedReset,
      }).record;
    }
    const active = this.active.get(record.id);
    if (active) return active;
    const accepted = record.params as AcceptedReset;
    const prior = ControlAccountResetResponse.safeParse(record.result);
    if (prior.success && prior.data.state === "completed" && prior.data.outcome !== "unknown")
      return prior.data;
    const task = this.execute(record, accepted).finally(() => this.active.delete(record!.id));
    this.active.set(record.id, task);
    return task;
  }

  get(id: string): ControlAccountResetResponse {
    const record = this.deps.commands().get(id);
    if (!record || (record.params as Partial<AcceptedReset>)?.kind !== "account_reset")
      throw Object.assign(new Error("No such account reset"), {
        status: 404,
        code: "account_reset_not_found",
      });
    const result = ControlAccountResetResponse.safeParse(record.result);
    const receipt = result.success
      ? result.data
      : this.initial(record, (record.params as AcceptedReset).request);
    if (!this.active.has(id) && receipt.state === "running")
      return {
        ...receipt,
        state: "completed",
        completed_at: record.finishedAt ?? null,
        outcome: receipt.outcome === "pending" ? "unknown" : receipt.outcome,
        detail: receipt.detail ?? "operation_interrupted",
        readback: { state: "failed", attempted_at: null, detail: "operation_interrupted" },
      };
    return receipt;
  }

  private initial(
    record: JobRecord,
    request: ControlAccountResetRequest,
  ): ControlAccountResetResponse {
    return {
      id: record.id,
      request,
      state: "running",
      created_at: record.createdAt,
      completed_at: null,
      outcome: "pending",
      detail: null,
      readback: { state: "pending", attempted_at: null, detail: null },
      resources: null,
    };
  }
  private save(receipt: ControlAccountResetResponse) {
    this.deps.commands().update(receipt.id, {
      state: receipt.state === "completed" ? "succeeded" : "running",
      result: ControlAccountResetResponse.parse(receipt),
      ...(receipt.state === "completed" ? { finishedAt: receipt.completed_at! } : {}),
    });
  }
  private async execute(
    record: JobRecord,
    accepted: AcceptedReset,
  ): Promise<ControlAccountResetResponse> {
    const parsed = ControlAccountResetResponse.safeParse(record.result);
    let receipt = parsed.success ? parsed.data : this.initial(record, accepted.request);
    const wasDispatched = parsed.success;
    const needsDispatch =
      !wasDispatched ||
      ((receipt.outcome === "pending" || receipt.outcome === "unknown") &&
        accepted.binding.harness === "codex");
    if (needsDispatch) {
      await this.deps.verify(accepted.binding, accepted.request.target);
      receipt = { ...receipt, state: "running", completed_at: null, outcome: "pending" };
      this.save(receipt); // durable dispatch intent, before native I/O
      try {
        const outcome = await this.deps.consume(accepted.binding);
        receipt = { ...receipt, ...outcome };
      } catch {
        receipt = { ...receipt, outcome: "unknown", detail: "provider_outcome_unconfirmed" };
      }
      this.save(receipt); // provider outcome survives a readback crash
    } else if (receipt.outcome === "pending") {
      receipt = { ...receipt, outcome: "unknown", detail: "provider_outcome_unconfirmed" };
      this.save(receipt);
    }
    // Never promote Claude already_used or a subsequent quota change to own success.
    const mayHaveChanged =
      (needsDispatch || !parsed.success || parsed.data.state !== "completed") &&
      ["reset", "already_redeemed", "already_used", "unknown"].includes(receipt.outcome);
    if (mayHaveChanged) this.deps.invalidate(accepted.request.target);
    const attemptedAt = this.now();
    receipt = {
      ...receipt,
      state: "running",
      readback: { state: "pending", attempted_at: attemptedAt, detail: null },
    };
    this.save(receipt);
    try {
      const resources = await this.deps.refresh(accepted.request.target, mayHaveChanged);
      const { harness, profile_id } = accepted.request.target;
      const row = resources.resources.find(
        (row) => row.target.harness === harness && row.target.profile_id === profile_id,
      );
      const fresh =
        resources.snapshots.some(
          (snapshot) =>
            snapshot.subject.harness === harness &&
            snapshot.subject.subject_id === profile_id &&
            snapshot.freshness === "fresh" &&
            snapshot.observed_at >= attemptedAt,
        ) &&
        row?.resets.freshness === "fresh" &&
        row.resets.observed_at !== null &&
        row.resets.observed_at >= attemptedAt;
      receipt = {
        ...receipt,
        resources,
        readback: {
          state: fresh ? "fresh" : "failed",
          attempted_at: attemptedAt,
          detail: fresh ? null : "resources_not_fully_refreshed",
        },
      };
    } catch {
      receipt = {
        ...receipt,
        resources: this.deps.read?.() ?? receipt.resources,
        readback: {
          state: "failed",
          attempted_at: attemptedAt,
          detail: "resource_readback_failed",
        },
      };
    }
    receipt = { ...receipt, state: "completed", completed_at: this.now() };
    this.save(receipt);
    return receipt;
  }
}
