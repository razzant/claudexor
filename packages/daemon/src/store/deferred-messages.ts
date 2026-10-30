import {
  CapturedRunStart,
  DeferredMessageMutation,
  DeferredMessageDetail,
  DeferredMessageProjection,
  DeferredMessageHold,
  continuationRefusal,
  continuationRefusalError,
  deferredMessageHold,
  isTerminalLifecycle,
  type DeferredMessageReceipt,
  type ResourceAttachmentRef,
} from "@claudexor/schema";
import {
  hashJson,
  newId,
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import { validateCommandKey } from "../command-store.js";
import type { JobRecord } from "../job-record.js";
import { assertDeferredOperator, type DeferredMessageOwner } from "../deferred-message-owner.js";
import { recoveredTerminalFacts } from "../terminal-authority.js";
import type { BlobFiles } from "./blob-files.js";
import type { SqlCommandStore } from "./commands.js";
import { SqlEventLedger, collectReleasedBodies } from "./event-store.js";
import { requireServedGeneration } from "./generations.js";
import { bindIdempotencyInTx, lookupIdempotency } from "./idempotency.js";
import { runMutation, type MutationContext } from "./mutation.js";
import type { PartitionGeneration } from "./partitions.js";
import { storedTerminal } from "./run-events.js";
import type { EngineStore } from "./store.js";
import {
  deferredMessageDetail,
  deferredMessageProjection,
  type DeferredMessageRow as DraftRow,
} from "./deferred-message-rows.js";

type Content = Pick<DeferredMessageDetail, "prompt" | "attachments" | "capturedStart">;

export function deferredConflict(code: string, message: string, context: object = {}): Error {
  return Object.assign(new Error(message), { code, status: 409, retryable: false, context });
}

/** Minimal partition-scoped owner. It owns no timer, runner or retry authority.
 * Every mutable decision linearizes on the same SQL writer as commands. */
export class SqlDeferredMessages implements DeferredMessageOwner {
  private readonly events: SqlEventLedger;
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    readonly generation: Pick<PartitionGeneration, "pid" | "name" | "epoch">,
    private readonly commands: SqlCommandStore,
    private readonly validateRefs: (refs: ResourceAttachmentRef[]) => void = (refs) => {
      if (refs.length) throw new Error("ordinary resource admission is unavailable");
    },
    private readonly assertCurrentRoute: (request: CapturedRunStart) => void = (request) => {
      if (request.scope.kind === "project")
        throw deferredConflict(
          "project_routing_unavailable",
          "canonical project routing is unavailable",
        );
    },
  ) {
    this.events = new SqlEventLedger(store, blobs, generation);
  }

  get(id: string): DeferredMessageDetail | null {
    const row = this.row(id);
    if (!row) return null;
    return deferredMessageDetail(this.store, this.blobs, row);
  }

  reservation(predecessor: string): DeferredMessageProjection | null {
    const id = this.predecessorId(predecessor);
    if (!id) return null;
    const row = this.store
      .prepare(
        `SELECT * FROM deferred_message WHERE pid=?
      AND predecessor_job_id=? AND state IN ('waiting','held')`,
      )
      .get(this.generation.pid, id) as DraftRow | undefined;
    return row ? this.project(row) : null;
  }
  latest(predecessor: string): DeferredMessageProjection | null {
    const id = this.predecessorId(predecessor);
    if (!id) return null;
    const row = this.store
      .prepare(
        "SELECT * FROM deferred_message WHERE pid=? AND predecessor_job_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(this.generation.pid, id) as DraftRow | undefined;
    return row ? this.project(row) : null;
  }
  outcomeHold(id: string): DeferredMessageHold | null {
    return this.terminalHold(this.requirePredecessor(this.requireRow(id).predecessor_job_id));
  }
  assertCreatable(predecessor: string): void {
    const record = this.requirePredecessor(predecessor);
    assertDeferredOperator(false, record.params);
    this.assertTarget(record);
  }

  /** Key lookup precedes current state, CAS, resource admission and captures.
   * The binding stores only the applied revision; current handles are addressed. */
  replay(input: DeferredMessageMutation, key: string): DeferredMessageReceipt | null {
    const digests = this.digests(input, key);
    const binding = lookupIdempotency(
      this.store,
      { owner: "deferred_message", pid: this.generation.pid, keyDigest: digests.keyDigest },
      digests.requestDigest,
    );
    if (!binding) return null;
    const row = this.row(binding.targetId);
    if (!row) throw new Error("deferred message idempotency binding is dangling");
    const applied = binding.result as { revision: number };
    return { appliedRevision: applied.revision, draft: this.project(row) };
  }

  mutate(
    raw: DeferredMessageMutation,
    key: string,
    capturedStart?: CapturedRunStart,
  ): DeferredMessageReceipt {
    const input = DeferredMessageMutation.parse(raw);
    const replay = this.replay(input, key);
    if (replay) return replay;
    const previous = input.action === "create" ? null : this.requireRow(input.draftId);
    const predecessor =
      input.action === "create"
        ? this.requirePredecessor(input.predecessorId)
        : this.requirePredecessor(previous!.predecessor_job_id);
    if (input.action !== "clear") assertDeferredOperator(false, predecessor.params);
    if (input.action === "create") this.assertTarget(predecessor);
    else this.assertEditable(previous!, input.expectedRevision);
    if (input.action !== "clear") this.validateRefs(input.attachments);
    const captured =
      input.action === "clear"
        ? null
        : input.action === "create"
          ? CapturedRunStart.parse(capturedStart)
          : this.get(previous!.id)!.capturedStart;
    if (input.action === "create" && !capturedStart)
      throw new Error("creation requires canonical captured controls");
    if (input.action === "create") {
      for (const field of [
        "threadId",
        "turnId",
        "planRunId",
        "planRef",
        "retryOf",
        "parentRunId",
        "delegatedFromRunId",
      ] as const)
        if (captured?.[field] !== undefined)
          throw deferredConflict(
            "draft_controls_invalid",
            "captured controls cannot introduce thread, plan, retry or delegation authority",
          );
      const refusal = continuationRefusal({ ...captured, continueFrom: predecessor.id }, [
        { ...predecessor, state: "succeeded", runId: predecessor.runId ?? predecessor.id },
      ]);
      if (refusal) throw continuationRefusalError(refusal);
    }
    const id = previous?.id ?? newId("draft");
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision))
      throw deferredConflict("draft_revision_exhausted", "draft revision is exhausted");
    const body =
      input.action === "clear"
        ? null
        : this.blobs.prepareBody(
            Buffer.from(
              JSON.stringify({
                prompt: input.prompt,
                attachments: input.attachments,
                capturedStart: CapturedRunStart.parse({
                  ...captured,
                  prompt: "",
                  attachments: [],
                }),
              } satisfies Content),
            ),
          );
    const next: DraftRow = {
      id,
      pid: this.generation.pid,
      predecessor_job_id: predecessor.id,
      revision,
      state: input.action === "clear" ? "cleared" : (previous?.state ?? "waiting"),
      body_sha: body?.sha256 ?? null,
      hold: previous?.hold ?? null,
      successor_job_id: null,
      dispatched_revision: null,
      created_at: previous?.created_at ?? this.store.now().toISOString(),
    };
    const event = this.events.prepare("deferred_message.changed", { draftId: id, revision });
    const digests = this.digests(input, key);
    runMutation(this.store, (tx) => {
      requireServedGeneration(tx, this.generation.pid);
      // No await occurred since lookup/preparation; keep the recheck explicit.
      if (input.action === "create") this.assertTarget(this.requirePredecessor(predecessor.id));
      else this.assertEditable(this.requireRow(id), input.expectedRevision);
      if (body) this.blobs.insertRow(body);
      this.write(tx, next);
      bindIdempotencyInTx(tx, {
        owner: "deferred_message",
        pid: this.generation.pid,
        ...digests,
        operation: "deferred_message.mutate",
        targetId: id,
        createdAt: next.created_at,
        result: { revision },
      });
      this.events.appendInTx(tx, event);
      tx.changes.blobChanged(previous?.body_sha, body?.sha256);
    });
    if (previous?.body_sha) collectReleasedBodies(this.store, this.blobs, [previous.body_sha]);
    return { appliedRevision: revision, draft: this.project(next) };
  }

  /** A one-shot ordinary command request for async preparation. */
  request(id: string): CapturedRunStart {
    const draft = this.get(id);
    if (!draft?.capturedStart) throw deferredConflict("draft_cleared", "draft was cleared");
    const predecessor = this.requirePredecessor(draft.predecessorJobId);
    return CapturedRunStart.parse({
      ...draft.capturedStart,
      prompt: draft.prompt,
      attachments: draft.attachments,
      continueFrom: predecessor.runId ?? predecessor.id,
    });
  }

  /** Async preparation finishes before this call. Rechecks and acceptance plus
   * freeze are ONE synchronous mutation; publish the returned job only after it.
   * A post-COMMIT notification error is deliberately allowed to escape: recovery
   * reads this same dispatched handle instead of accepting another command. */
  promote(
    id: string,
    expectedRevision: number,
    preparedStart: CapturedRunStart,
    fence: () => DeferredMessageHold | null,
    admit: (request: CapturedRunStart, draftId: string) => void,
  ): { draft: DeferredMessageProjection; record: JobRecord | null; reused: boolean } {
    const row = this.requireRow(id);
    if (row.state === "dispatched") return this.dispatched(row);
    this.assertRevision(row, expectedRevision);
    if (row.state !== "waiting") return { draft: this.project(row), record: null, reused: false };
    const request = this.request(id);
    // Preparation can validate but never widen or silently reroute the capsule.
    if (hashJson(request) !== hashJson(CapturedRunStart.parse(preparedStart)))
      throw deferredConflict(
        "draft_controls_changed",
        "prepared execution controls differ from the captured draft",
      );
    const acceptance = this.commands.prepareAcceptance({
      id: newId("job"),
      params: request,
      clientId: "deferred-message",
      operation: "run.create",
      idempotencyKey: `deferred:${id}`,
      idempotencyParams: { draftId: id, revision: expectedRevision },
    });
    const event = this.events.prepare("deferred_message.changed", {
      draftId: id,
      revision: expectedRevision,
    });
    return runMutation(this.store, (tx) => {
      const current = this.requireRow(id);
      if (current.state === "dispatched") return this.dispatched(current);
      // Accepted-command replay is authoritative before mutable/CAS admission.
      const replay = this.commands.find(acceptance.input);
      if (replay)
        throw new Error("deferred acceptance exists without its atomic dispatched receipt");
      requireServedGeneration(tx, this.generation.pid);
      this.assertRevision(current, expectedRevision);
      if (current.state !== "waiting")
        return { draft: this.project(current), record: null, reused: false };
      const predecessor = this.requirePredecessor(current.predecessor_job_id);
      const stopped = fence();
      if (!stopped && !isTerminalLifecycle(predecessor.state))
        return { draft: this.project(current), record: null, reused: false };
      let hold = stopped ?? this.terminalHold(predecessor);
      if (!hold) {
        try {
          assertDeferredOperator(false, predecessor.params);
          this.assertReservation(current);
          this.validateRefs(request.attachments ?? []);
          // This synchronous canonical read runs on the same SQL connection
          // and transaction as acceptance/freeze; it starts no nested mutation.
          this.assertCurrentRoute(request);
          admit(request, id);
        } catch (error) {
          hold = admissionHold(error);
        }
      }
      if (hold) {
        const held = {
          ...current,
          state: "held" as const,
          hold: Buffer.from(JSON.stringify(hold)),
        };
        this.write(tx, held);
        this.events.appendInTx(tx, event);
        return { draft: this.project(held), record: null, reused: false };
      }
      const accepted = this.commands.acceptInTx(tx, acceptance);
      const dispatched = {
        ...current,
        state: "dispatched" as const,
        successor_job_id: accepted.record.id,
        dispatched_revision: current.revision,
      };
      this.write(tx, dispatched);
      this.events.appendInTx(tx, event);
      return { draft: this.project(dispatched), record: accepted.record, reused: accepted.reused };
    });
  }

  hold(id: string, reason: DeferredMessageHold): void {
    const row = this.requireRow(id);
    if (row.state !== "waiting") return;
    const event = this.events.prepare("deferred_message.changed", {
      draftId: id,
      revision: row.revision,
    });
    runMutation(this.store, (tx) => {
      const current = this.requireRow(id);
      if (current.state !== "waiting") return;
      this.write(tx, {
        ...current,
        state: "held",
        hold: Buffer.from(JSON.stringify(DeferredMessageHold.parse(reason))),
      });
      this.events.appendInTx(tx, event);
    });
  }

  recoverAfterStartup(): void {
    const rows = this.store
      .prepare(
        "SELECT id FROM deferred_message WHERE pid=? AND state IN ('waiting','held') AND state='waiting'",
      )
      .all(this.generation.pid) as Array<{ id: string }>;
    for (const row of rows) this.hold(row.id, { code: "restart_requires_controller" });
  }

  private terminalHold(record: JobRecord): DeferredMessageHold | null {
    let facts: unknown = null;
    try {
      const terminal = record.runId
        ? storedTerminal(this.store, record.runId, this.generation.pid)
        : null;
      if (terminal) facts = recoveredTerminalFacts(record, terminal).facts;
    } catch {
      /* missing/contradictory authority holds; existing result stays addressed */
    }
    return deferredMessageHold(record.state, facts, { runId: record.runId, taskId: record.taskId });
  }
  /** Compact job/run alias resolution. Slot reads stop here; only callers that
   * use the predecessor's params, state or result hydrate the command. */
  private predecessorId(alias: string): string | undefined {
    const row = this.store
      .prepare("SELECT id FROM command WHERE pid=? AND (id=? OR run_id=?)")
      .get(this.generation.pid, alias, alias) as { id: string } | undefined;
    return row?.id;
  }
  private requirePredecessor(alias: string): JobRecord {
    const id = this.predecessorId(alias);
    const record = id ? this.commands.get(id) : undefined;
    if (!record)
      throw Object.assign(new Error("no retained daemon-owned predecessor"), {
        code: "predecessor_unknown",
        status: 404,
        retryable: false,
      });
    return record;
  }
  private assertTarget(record: JobRecord): void {
    const params = record.params as Record<string, unknown>;
    if (params?.threadId)
      throw Object.assign(new Error("Use claudexor_thread_turn for a persistent thread"), {
        code: "use_thread_turn",
        status: 400,
        retryable: false,
      });
    const kind = this.store
      .prepare("SELECT kind FROM command WHERE id=? AND pid=?")
      .get(record.id, this.generation.pid) as { kind: string };
    const mode = params?.mode ?? "agent";
    if (kind.kind !== "product" || (mode !== "agent" && mode !== "ask"))
      throw Object.assign(
        new Error("only one-shot Agent and Ask predecessors support a deferred message"),
        {
          code: "continue_from_unsupported",
          status: 400,
          retryable: false,
        },
      );
    const refusal = continuationRefusal({ ...params, continueFrom: record.id }, [
      { ...record, state: "succeeded", runId: record.runId ?? record.id },
    ]);
    if (refusal) throw continuationRefusalError(refusal);
    if (this.reservation(record.id))
      throw deferredConflict("continuation_reserved", "predecessor next message is reserved");
    const successor = this.store
      .prepare(
        `SELECT id FROM command WHERE pid=? AND continue_from IN (?,?)
      AND (run_id IS NOT NULL OR state IN ('queued','running')) LIMIT 1`,
      )
      .get(this.generation.pid, record.id, record.runId ?? record.id);
    if (successor)
      throw deferredConflict("continuation_superseded", "predecessor already has a successor");
  }
  private assertReservation(row: DraftRow): void {
    if (this.reservation(row.predecessor_job_id)?.draftId !== row.id)
      throw deferredConflict(
        "continuation_reserved",
        "the exact draft no longer owns the successor claim",
      );
  }
  private assertRevision(row: DraftRow, revision: number): void {
    if (row.revision !== revision)
      throw deferredConflict(
        "draft_revision_conflict",
        "draft revision changed",
        this.project(row),
      );
  }
  private assertEditable(row: DraftRow, revision: number): void {
    this.assertRevision(row, revision);
    if (row.state !== "waiting" && row.state !== "held")
      throw deferredConflict("draft_not_editable", `draft is ${row.state}`, this.project(row));
  }
  private dispatched(row: DraftRow) {
    const record = row.successor_job_id ? this.commands.get(row.successor_job_id) : undefined;
    if (!record) throw new Error("dispatched draft lost its retained successor");
    return { draft: this.project(row), record, reused: true };
  }
  private row(id: string): DraftRow | undefined {
    return this.store
      .prepare("SELECT * FROM deferred_message WHERE id=? AND pid=?")
      .get(id, this.generation.pid) as DraftRow | undefined;
  }
  private requireRow(id: string): DraftRow {
    const row = this.row(id);
    if (!row)
      throw Object.assign(new Error("no such deferred message"), {
        code: "draft_unknown",
        status: 404,
      });
    return row;
  }
  private project(row: DraftRow): DeferredMessageProjection {
    return deferredMessageProjection(this.store, row);
  }
  private digests(input: DeferredMessageMutation, key: string) {
    validateCommandKey(key);
    return {
      keyDigest: hashJson({
        partition: this.generation.name,
        operation: "deferred_message.mutate",
        key,
      }),
      requestDigest: hashJson(input),
    };
  }
  private write(tx: MutationContext, row: DraftRow): void {
    tx.prepare(
      `INSERT INTO deferred_message(id,pid,predecessor_job_id,revision,state,body_sha,hold,
      successor_job_id,dispatched_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,
      body_sha=excluded.body_sha,hold=excluded.hold,successor_job_id=excluded.successor_job_id,
      dispatched_revision=excluded.dispatched_revision`,
    ).run(
      row.id,
      row.pid,
      row.predecessor_job_id,
      row.revision,
      row.state,
      row.body_sha,
      row.hold,
      row.successor_job_id,
      row.dispatched_revision,
      row.created_at,
    );
  }
}

function admissionHold(error: unknown): DeferredMessageHold {
  // Preserve existing typed admission guidance, sanitized by the normal problem owner.
  const e = error as {
    code?: string;
    retryable?: boolean;
    requiredActions?: string[];
    context?: unknown;
  };
  return {
    code: "admission_refused",
    problem: {
      code: typeof e?.code === "string" ? e.code : null,
      message: safeProblemMessage(error),
      retryable: typeof e?.retryable === "boolean" ? e.retryable : false,
      required_actions: safeProblemRequiredActions(e?.requiredActions),
      context: safeProblemContext(e?.context),
    },
  };
}
