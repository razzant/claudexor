import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DeferredMessageCall,
  DeferredMessageMutation,
  RunProcessScopeOutcome,
  isTerminalLifecycle,
  DeferredMessageProjection,
  type CapturedRunStart,
  type DeferredMessageHold,
  type DeferredMessageReceipt,
  type DeferredMessageStopReport,
} from "@claudexor/schema";
import {
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import { commandStoreForId, type CommandBackend } from "./command-authority.js";
import { admitCommandRequest } from "./command-rpc.js";
import { assertDeferredOperator, type DeferredMessageOwner } from "./deferred-message-owner.js";
import type { JobRecord } from "./job-record.js";

export interface DeferredStartPreparation {
  capture(
    predecessor: JobRecord,
    input: Extract<DeferredMessageMutation, { action: "create" }>,
  ): Promise<CapturedRunStart>;
  validate(request: CapturedRunStart): Promise<void>;
}

/** Event-driven composition with the daemon's existing queue. The in-flight
 * map coalesces explicit mutations/settlement events, never polls or retries a
 * held request. SQL remains the sole owner of state and acceptance. */
export class DeferredMessages {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly changed = new Set<string>();
  private readonly waiting = new Set<string>();
  /** Drafts a Stop fenced in this daemon, also when their hold was not saved. */
  private readonly stopped = new Set<string>();
  private closing = false;
  constructor(
    private readonly deps: {
      commands: CommandBackend;
      preparation: () => DeferredStartPreparation | undefined;
      active: (id: string) => boolean;
      stopped: (id: string) => boolean;
      publish: (record: JobRecord) => void;
      custody?: (record: JobRecord) => DeferredMessageHold | null;
    },
  ) {}

  async mutate(raw: unknown): Promise<DeferredMessageReceipt> {
    assertOperatorCaller(raw);
    const { request, idempotencyKey } = DeferredMessageCall.parse(raw);
    const target = request.action === "create" ? request.predecessorId : request.draftId;
    const owner = this.owner(target);
    const prior = owner.replay(request, idempotencyKey);
    if (prior) return prior;
    if (this.closing) throw problem("daemon_stopping", "daemon is stopping", 503);
    let captured: CapturedRunStart | undefined;
    if (request.action === "create") {
      owner.assertCreatable(target);
      // Resolve aliases compactly, then hydrate only this addressed accepted
      // body. Collection summaries deliberately omit execution preferences.
      const predecessorId = this.record(target).id;
      const predecessor = commandStoreForId(this.deps.commands, predecessorId)?.get(predecessorId);
      if (!predecessor) throw problem("predecessor_unknown", "no served accepted command", 404);
      assertDeferredOperator(false, predecessor.params);
      try {
        captured = await this.preparation().capture(predecessor, request);
      } catch (error) {
        const raced = owner.replay(request, idempotencyKey);
        if (raced) return raced;
        throw error;
      }
    }
    // Replays and revision checks are repeated by the synchronous owner after
    // async capture. There is no caller-supplied captured payload.
    if (this.closing) throw problem("daemon_stopping", "daemon is stopping", 503);
    let receipt: DeferredMessageReceipt;
    try {
      receipt = owner.mutate(request, idempotencyKey, captured);
    } catch (error) {
      const committed =
        (error as { committed?: boolean })?.committed && owner.replay(request, idempotencyKey);
      if (!committed) throw error;
      receipt = committed;
    }
    if (receipt.draft.state === "waiting") {
      this.waiting.add(receipt.draft.draftId);
      await this.evaluate(receipt.draft.draftId);
    } else {
      this.waiting.delete(receipt.draft.draftId);
      this.stopped.delete(receipt.draft.draftId);
    }
    return {
      appliedRevision: receipt.appliedRevision,
      draft: DeferredMessageProjection.strip().parse(this.read(receipt.draft.draftId)),
    };
  }

  read(id: string, caller?: unknown) {
    assertOperatorCaller(caller);
    return this.owner(id).get(id);
  }
  projection(predecessor: string, caller?: unknown): DeferredMessageProjection | null {
    assertOperatorCaller(caller);
    return this.deps.commands.deferredFor?.(predecessor)?.latest(predecessor) ?? null;
  }
  async settled(predecessor: string): Promise<void> {
    const reservation = this.deps.commands.deferredFor?.(predecessor)?.reservation(predecessor);
    if (reservation?.state === "waiting") {
      this.waiting.add(reservation.draftId);
      await this.evaluate(reservation.draftId);
    }
  }
  /** Stop holds a waiting draft whatever the predecessor's lifecycle. Fence,
   * hold and report are one synchronous step, and promotion rechecks the fence
   * and the row inside its acceptance mutation: the draft is held here, was
   * already dispatched, or stays fenced when its hold cannot be saved. Every
   * Stop, the daemon cancel included, retries a hold that is not saved yet. */
  stop(predecessor: string, caller?: unknown): DeferredMessageStopReport {
    assertOperatorCaller(caller);
    const owner = this.deps.commands.deferredFor?.(predecessor);
    const draft = owner?.reservation(predecessor);
    if (draft?.state === "waiting") {
      this.stopped.add(draft.draftId);
      try {
        owner!.hold(draft.draftId, { code: "stop_requested" });
      } catch (error) {
        // A post-commit notification failure leaves the hold saved.
        if (!(error as { committed?: boolean })?.committed) throw holdNotSaved(draft, error);
      }
    }
    const latest = owner?.latest(predecessor) ?? null;
    if (draft && latest?.draftId === draft.draftId && latest.state !== "waiting")
      this.stopped.delete(draft.draftId);
    return { held: draft?.state === "waiting" && latest?.state === "held", draft: latest };
  }
  /** The closing fence is set first. Holds that cannot be saved are returned
   * for the shutdown report and never stop the remaining holds or the abort. */
  shutdown(): unknown[] {
    this.closing = true;
    const unsaved: unknown[] = [];
    for (const id of this.waiting)
      try {
        this.deps.commands.deferredFor?.(id)?.hold(id, { code: "shutdown" });
      } catch (error) {
        // The store failure stays inspectable for a store-recovery shutdown.
        if (!(error as { committed?: boolean })?.committed)
          unsaved.push(new AggregateError([error], holdNotSavedMessage("Shutdown", id, error)));
      }
    return unsaved;
  }
  async drained(): Promise<void> {
    await Promise.all([...this.flights.values()]);
  }

  private evaluate(id: string): Promise<void> {
    const flight = this.flights.get(id);
    if (flight) {
      this.changed.add(id);
      return flight;
    }
    const work = (async () => {
      do {
        this.changed.delete(id);
        await this.evaluateRevision(id);
      } while (this.changed.delete(id));
    })().finally(() => {
      this.flights.delete(id);
      if (this.deps.commands.deferredFor?.(id)?.get(id)?.state !== "waiting") {
        this.waiting.delete(id);
        this.stopped.delete(id);
      }
    });
    this.flights.set(id, work);
    return work;
  }
  private async evaluateRevision(id: string): Promise<void> {
    const owner = this.deps.commands.deferredFor?.(id);
    const draft = owner?.get(id);
    if (!owner || draft?.state !== "waiting") return;
    const predecessor = this.record(draft.predecessorJobId);
    if (this.deps.active(predecessor.id) || !isTerminalLifecycle(predecessor.state)) return;
    const hold = owner.outcomeHold(id) ?? this.fence(predecessor, id);
    if (hold) {
      owner.hold(id, hold);
      return;
    }
    const request = owner.request(id);
    try {
      await this.preparation().validate(request);
    } catch (error) {
      const current = owner.get(id);
      if (current?.revision === draft.revision && current.state === "waiting")
        owner.hold(id, admissionHold(error));
      return;
    }
    try {
      const accepted = owner.promote(
        id,
        draft.revision,
        request,
        () => this.fence(this.record(predecessor.id), id),
        (start, draftId) => {
          admitCommandRequest(this.deps.commands, start, undefined, undefined, draftId);
        },
      );
      if (accepted.record && !accepted.reused) this.deps.publish(accepted.record);
    } catch (error) {
      // A notification may fail AFTER acceptance+freeze. Recover that same
      // handle and publish it to the current queue; never accept again.
      const committed = owner.get(id);
      if (committed?.state === "dispatched" && committed.successorJobId) {
        this.deps.publish(this.record(committed.successorJobId));
        return;
      }
      if ((error as { code?: unknown })?.code === "draft_revision_conflict") return;
      if (owner.get(id)?.state === "waiting") owner.hold(id, admissionHold(error));
      else throw error;
    }
  }
  private fence(record: JobRecord, draftId: string): DeferredMessageHold | null {
    if (this.closing) return { code: "shutdown" };
    if (this.deps.stopped(record.id) || this.stopped.has(draftId))
      return { code: "stop_requested" };
    if (this.deps.active(record.id)) return { code: "settlement_unknown" };
    return (this.deps.custody ?? processCustodyHold)(record);
  }
  private owner(id: string): DeferredMessageOwner {
    const owner = this.deps.commands.deferredFor?.(id);
    if (!owner)
      throw problem("draft_target_unknown", "no served deferred message or predecessor", 404);
    return owner;
  }
  private record(id: string): JobRecord {
    const record = this.deps.commands.queries.select({ ids: [id] })[0];
    if (!record) throw problem("predecessor_unknown", "no served daemon-owned command", 404);
    return record;
  }
  private preparation(): DeferredStartPreparation {
    const preparation = this.deps.preparation();
    if (!preparation)
      throw problem(
        "deferred_preparation_unavailable",
        "canonical run-start preparation is unavailable",
        503,
      );
    return preparation;
  }
}

function processCustodyHold(record: JobRecord): DeferredMessageHold | null {
  if (!record.runDir) return { code: "settlement_unknown" };
  try {
    const scope = RunProcessScopeOutcome.parse(
      parseYaml(readFileSync(join(record.runDir, "final/process_scope.yaml"), "utf8")),
    );
    if (
      scope.settled &&
      !scope.incomplete &&
      scope.survivors.length === 0 &&
      scope.unreadable.length === 0
    )
      return null;
  } catch {
    /* absent/unreadable custody is unknown, never clean */
  }
  return { code: "settlement_unknown" };
}
function problem(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status, retryable: false });
}
function holdNotSavedMessage(by: "Stop" | "Shutdown", draftId: string, error: unknown) {
  return `${by} could not save the hold of next message ${draftId} (${safeProblemMessage(error)}). It is not sent: this daemon keeps it fenced, and a restart holds it.`;
}
function holdNotSaved(draft: DeferredMessageProjection, error: unknown) {
  return Object.assign(new Error(holdNotSavedMessage("Stop", draft.draftId, error)), {
    code: "next_message_hold_failed",
    status: 503,
    retryable: true,
    context: { deferredMessage: draft },
    requiredActions: ["Retry the Stop to record the hold."],
  });
}
function assertOperatorCaller(raw: unknown): void {
  const caller = raw as Record<string, unknown> | null;
  assertDeferredOperator(
    caller?.beltContext === true ||
      caller?.delegatedFromRunId != null ||
      caller?.operation === "delegated-run",
  );
}
function admissionHold(error: unknown): DeferredMessageHold {
  const e = error as Record<string, unknown> | null;
  return {
    code: "admission_refused",
    problem: {
      message: safeProblemMessage(error),
      code: typeof e?.code === "string" ? e.code : null,
      retryable: typeof e?.retryable === "boolean" ? e.retryable : false,
      context: safeProblemContext(e?.context),
      required_actions: safeProblemRequiredActions(e?.requiredActions),
    },
  };
}
