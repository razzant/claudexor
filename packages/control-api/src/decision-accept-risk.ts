import type { ServerResponse } from "node:http";
import { ControlRunDecisionResponse } from "@claudexor/schema";
import { nowIso, sha256 } from "@claudexor/util";
import type { ControlOperatorDecisionRecord, DaemonRunRecord } from "./run-record.js";
import { runGitResult } from "./run-exact-patch.js";

export type RiskDecisionBody = {
  action: "accept_risk" | "override_needs_human";
  findingIds: string[];
  acceptedRisks: string[];
};

interface RiskDecisionServices {
  findOperatorDecisionByIdempotency?: (
    runId: string,
    params: unknown,
    idempotency: { key: string; client: string; request: unknown },
  ) => ControlOperatorDecisionRecord | null;
  recordOperatorDecision?: (
    runId: string,
    params: unknown,
    decision: ControlOperatorDecisionRecord,
    idempotency?: { key: string; client: string; request: unknown },
  ) => { record: ControlOperatorDecisionRecord; reused: boolean };
}

export interface AcceptRiskDecisionContext {
  services?: RiskDecisionServices;
  chainMutation<T>(record: DaemonRunRecord, work: () => Promise<T>): Promise<T>;
  workStateVeto(record: DaemonRunRecord): "needs_input" | "incomplete" | null;
  needsDecision(record: DaemonRunRecord): boolean;
  readPatch(record: DaemonRunRecord): string | null;
  writeProjection(record: DaemonRunRecord, decision: ControlOperatorDecisionRecord): void;
  appendAudit(record: DaemonRunRecord, payload: Record<string, unknown>): void;
  json(response: ServerResponse, status: number, body: unknown): void;
}

/** Journal-first accept-risk/override route with replay before mutable gates. */
export function acceptRiskDecision(
  ctx: AcceptRiskDecisionContext,
  rec: DaemonRunRecord,
  body: RiskDecisionBody,
  idempotencyKey: string,
  res: ServerResponse,
): Promise<void> {
  const idempotency = {
    key: idempotencyKey,
    client: "control-api",
    request: { runId: rec.runId ?? rec.id, body },
  };
  const respond = () =>
    ctx.json(
      res,
      200,
      ControlRunDecisionResponse.parse({
        accepted: true,
        status: "applied",
        message: `${body.action} recorded for this exact patch; Apply is now available and will run a fresh final check before changing the project`,
      }),
    );

  const runId = rec.runId ?? rec.id;
  // A completed journal decision is the immutable response authority. Probe it
  // before the thread's current idle gate so later work cannot turn a same-key
  // replay into a new 409. The second probe inside the chain closes the miss /
  // concurrent-record race.
  if (ctx.services?.findOperatorDecisionByIdempotency?.(runId, rec.params, idempotency)) {
    respond();
    return Promise.resolve();
  }

  return ctx.chainMutation(rec, async () => {
    if (ctx.services?.findOperatorDecisionByIdempotency?.(runId, rec.params, idempotency)) {
      return respond();
    }
    const workVeto = ctx.workStateVeto(rec);
    if (workVeto) {
      return ctx.json(res, 409, {
        error:
          workVeto === "needs_input"
            ? "run reported it needs more input; a risk override cannot supply the missing input — re-run with the input (rerun_with_feedback)"
            : "run reported the work is incomplete; a risk override cannot finish it — re-run until it completes (rerun_with_feedback)",
        code: "work_state_needs_input",
      });
    }
    if (!ctx.needsDecision(rec)) {
      return ctx.json(res, 409, {
        error:
          rec.state === "succeeded"
            ? "run does not need a decision; apply it directly if its review is clean (no risk override needed)"
            : `run is ${rec.state}; risk overrides only unblock needs-decision runs (use rerun_with_feedback instead)`,
      });
    }
    // An object result binds by its digest v1 (#535); its view may be absent.
    const resultDigest = runGitResult(rec)?.digest ?? null;
    const patch = resultDigest ? null : ctx.readPatch(rec);
    if (resultDigest === null && patch === null) {
      return ctx.json(res, 409, {
        error: "no patch artifact; there is nothing to unblock for apply",
      });
    }
    const record = ctx.services?.recordOperatorDecision;
    if (!record) {
      throw Object.assign(new Error("operator decisions are not supported by this engine build"), {
        status: 501,
      });
    }
    const recorded = record(
      runId,
      rec.params,
      {
        action: body.action,
        findingIds: body.findingIds,
        acceptedRisks: body.acceptedRisks,
        patchSha256: resultDigest ?? sha256(patch ?? ""),
        decidedAt: nowIso(),
      },
      idempotency,
    );
    if (!recorded.reused) {
      try {
        ctx.writeProjection(rec, recorded.record);
        ctx.appendAudit(rec, {
          decision: body.action,
          finding_ids: body.findingIds,
          accepted_risks: body.acceptedRisks,
        });
      } catch {
        // Journal authority remains queryable and replayable by Idempotency-Key.
      }
    }
    return respond();
  });
}
