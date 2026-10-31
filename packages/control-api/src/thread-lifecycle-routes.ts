import { runDeliverableOf } from "./run-object-delivery.js";
import { readCommandIds } from "./command-reads.js";
import type { CommandListQuery } from "@claudexor/schema";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlThread,
  ControlThreadApplyRequest,
  ControlThreadApplyResponse,
} from "@claudexor/schema";
import type { DaemonControlApiOptions, DaemonRunRecord } from "./daemon-server.js";
import { projectThread } from "./thread-projection.js";
import type { ThreadTurnRouteCtx } from "./thread-turn-routes.js";
import type { verifyAndDeliver } from "@claudexor/delivery";
import {
  chainThreadMutation,
  findActiveMutatingThreadRun,
  findActiveThreadRun,
} from "./thread-mutation.js";

export interface ThreadLifecycleRouteCtx {
  turnCtx: ThreadTurnRouteCtx;
  services: DaemonControlApiOptions["services"];
  listRuns(query: CommandListQuery): Promise<DaemonRunRecord[]>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
  requiredIdempotencyKey(req: IncomingMessage): string;
  runIdempotentDelivery<T>(input: {
    params: unknown;
    key: string;
    operation: string;
    request: unknown;
    work: () => Promise<T>;
  }): Promise<T>;
  readPatch(record: DaemonRunRecord): string | null;
  applyGateError(record: DaemonRunRecord, patch: string, projectRoot: string): string | null;
  appendAudit(record: DaemonRunRecord, type: string, payload: Record<string, unknown>): void;
  gateSpecs(record: DaemonRunRecord): NonNullable<Parameters<typeof verifyAndDeliver>[3]>;
}

/**
 * `requiresIdle` refuses with 409 `thread_busy` while ANY turn of the thread is
 * queued or running. Only purge sets it: purge deletes the lane homes a live
 * ask/plan turn runs in. Trash and restore delete nothing (a trashed thread
 * already refuses edits and new turns), so they gain no busy refusal.
 */
async function lifecycle(
  ctx: ThreadLifecycleRouteCtx,
  threadId: string,
  service: ((id: string) => Promise<unknown>) | undefined,
  requiresIdle: boolean,
  res: ServerResponse,
): Promise<void> {
  if (!service) {
    ctx.json(res, 501, { error: "thread lifecycle is not supported by this build" });
    return;
  }
  await chainThreadMutation(ctx.turnCtx.threadTurnChains, threadId, async () => {
    try {
      const active = requiresIdle
        ? findActiveThreadRun(await ctx.listRuns({ threadId, activeOnly: true }), threadId)
        : undefined;
      if (active) {
        throw Object.assign(
          new Error(
            `thread ${threadId} has an active turn (${active.state}); purge it once no turn is queued or running`,
          ),
          { status: 409, code: "thread_busy" },
        );
      }
      ctx.json(res, 200, ControlThread.parse(projectThread(await service(threadId), false)));
    } catch (error) {
      ctx.requestError(res, error);
    }
  });
}

/** Own the thread trash/restore/purge/apply write routes outside the server shell. */
export async function handleThreadLifecycleRoutes(
  ctx: ThreadLifecycleRouteCtx,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const threadTrashMatch = /^\/threads\/([^/]+)\/trash$/.exec(path);
  if (method === "POST" && threadTrashMatch) {
    await lifecycle(
      ctx,
      decodeURIComponent(threadTrashMatch[1] as string),
      ctx.services?.trashThread,
      false,
      res,
    );
    return true;
  }
  const threadRestoreMatch = /^\/threads\/([^/]+)\/restore$/.exec(path);
  if (method === "POST" && threadRestoreMatch) {
    await lifecycle(
      ctx,
      decodeURIComponent(threadRestoreMatch[1] as string),
      ctx.services?.restoreThread,
      false,
      res,
    );
    return true;
  }
  const threadPurgeMatch = /^\/threads\/([^/]+)\/purge$/.exec(path);
  if (method === "POST" && threadPurgeMatch) {
    await lifecycle(
      ctx,
      decodeURIComponent(threadPurgeMatch[1] as string),
      ctx.services?.purgeThread,
      true,
      res,
    );
    return true;
  }

  const threadApplyMatch = /^\/threads\/([^/]+)\/apply$/.exec(path);
  if (!(method === "POST" && threadApplyMatch)) return false;
  const detail = ctx.services?.threadDetail;
  const apply = ctx.services?.applyThread;
  if (!detail || !apply) {
    ctx.json(res, 501, { error: "threads are not supported by this engine build" });
    return true;
  }
  const threadId = decodeURIComponent(threadApplyMatch[1] as string);
  let idempotencyKey: string;
  try {
    idempotencyKey = ctx.requiredIdempotencyKey(req);
  } catch (error) {
    ctx.requestError(res, error);
    return true;
  }
  await chainThreadMutation(ctx.turnCtx.threadTurnChains, threadId, async () => {
    try {
      const body = ControlThreadApplyRequest.parse(await ctx.readBody(req));
      const snapshot = await detail(threadId);
      const thread = snapshot.thread as {
        repo?: { root?: string } | null;
        run_ids?: string[];
        workspace?: { mode?: string; delivered_through_run_id?: string | null };
      };
      // A caller-owned workspace is never delivered to the project: refuse
      // before any run is gated as if it were a managed thread worktree.
      if (thread.workspace?.mode === "delegated") {
        throw Object.assign(
          new Error(
            "a delegated thread executes in a caller-owned workspace; Claudexor never applies it to the project",
          ),
          { status: 400, code: "thread_workspace_caller_owned" },
        );
      }
      const activeRecords = await ctx.listRuns({ activeOnly: true });
      const active = findActiveMutatingThreadRun(activeRecords, threadId);
      if (active) {
        throw Object.assign(
          new Error(`thread ${threadId} has an active mutating turn (${active.state})`),
          { status: 409, code: "thread_busy" },
        );
      }
      const runIds = thread.run_ids ?? [];
      const delivered = thread.workspace?.delivered_through_run_id ?? null;
      const deliveredIndex = delivered ? runIds.indexOf(delivered) : -1;
      if (delivered && deliveredIndex < 0) {
        throw Object.assign(
          new Error(`thread ${threadId} has an invalid delivered-run watermark`),
          {
            status: 409,
            code: "thread_lineage_invalid",
          },
        );
      }
      const records = await readCommandIds(
        { list: ctx.listRuns },
        runIds.slice(deliveredIndex + 1),
      );
      const byRun = new Map(records.map((record) => [record.runId ?? record.id, record]));
      const gates: NonNullable<Parameters<typeof verifyAndDeliver>[3]> = [];
      for (const runId of runIds.slice(deliveredIndex + 1)) {
        const record = byRun.get(runId);
        if (!record) {
          throw Object.assign(new Error(`thread run ${runId} is no longer in the daemon history`), {
            status: 409,
            code: "thread_run_unverifiable",
          });
        }
        // An object result (#535) is evidence by its trees; its view may be absent.
        const delivery = runDeliverableOf(record);
        if (delivery === null) {
          throw Object.assign(new Error(`thread run ${runId} is missing required patch evidence`), {
            status: 409,
            code: "thread_run_unverifiable",
          });
        }
        const { patch, deliverable } = delivery;
        const changed =
          typeof deliverable === "string"
            ? patch.trim().length > 0
            : deliverable.result.base_tree !== deliverable.result.candidate_tree;
        if (!changed) {
          if (record.state === "succeeded") continue;
          throw Object.assign(new Error(`thread run ${runId} is ${record.state}`), {
            status: 409,
            code: "thread_run_unverified",
          });
        }
        const projectRoot = thread.repo?.root;
        if (!projectRoot) {
          throw Object.assign(new Error(`thread ${threadId} has no project root`), {
            status: 409,
            code: "thread_project_missing",
          });
        }
        const gateError = ctx.applyGateError(record, patch, projectRoot);
        if (gateError) {
          ctx.appendAudit(record, "control.rejected", {
            control: "thread_apply",
            thread_id: threadId,
            reason: gateError,
          });
          throw Object.assign(new Error(`thread run ${runId} is not verified: ${gateError}`), {
            status: 409,
            code: "thread_run_unverified",
          });
        }
        gates.push(...ctx.gateSpecs(record));
      }
      const response = await ctx.runIdempotentDelivery({
        params: { threadId },
        key: idempotencyKey,
        operation: "thread.apply",
        request: {
          threadId,
          body,
          runIds,
          deliveredThroughRunId: delivered,
        },
        work: async () =>
          ControlThreadApplyResponse.parse(
            await apply(threadId, {
              mode: body.mode,
              branch: body.branch,
              message: body.message,
              gates,
            }),
          ),
      });
      ctx.json(res, 200, response);
    } catch (error) {
      ctx.requestError(res, error);
    }
  });
  return true;
}
