import type { IncomingMessage, ServerResponse } from "node:http";
import {
  checkPatch,
  checkPatchReverse,
  checkResultOnTarget,
  verifyAndDeliver,
} from "@claudexor/delivery";
import {
  ControlApplyCheckRequest,
  ControlApplyCheckResponse,
  ControlApplyRequest,
  ControlDeliveryResponse,
  type FinalVerifyRecord,
  type GitDeliveryPair,
  type RunApplyState,
  type WorkspaceFilesManifest,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./daemon-server.js";
import { requiredIdempotencyKey, validateAbsoluteRepoRoot } from "./run-start.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import { deliveryRefusedError, markRunWriteLeft } from "./run-object-delivery.js";
import { runDeliverable } from "./run-exact-patch.js";
import { applyFilesResult, checkFilesResult } from "./files-apply-route.js";

export interface DeliveryCommandServices {
  beginDelivery?: (
    params: unknown,
    input: { key: string; client: string; operation: string; request: unknown },
  ) => Promise<{
    id: string;
    state: string;
    result?: unknown;
    error?: string;
    errorCode?: string;
    errorRequiredActions?: string[];
    errorContext?: Record<string, unknown>;
    reused: boolean;
  }>;
  completeDelivery?: (id: string, result: unknown) => Promise<void>;
  failDelivery?: (id: string, error: unknown) => Promise<void>;
}

export async function runIdempotentDelivery<T>(
  services: DeliveryCommandServices | undefined,
  input: {
    params: unknown;
    key: string;
    operation: string;
    request: unknown;
    work: () => Promise<T>;
  },
): Promise<T> {
  const begin = services?.beginDelivery;
  const complete = services?.completeDelivery;
  const fail = services?.failDelivery;
  if (!begin || !complete || !fail) {
    throw Object.assign(new Error("durable delivery authority is unavailable"), { status: 501 });
  }
  const command = await begin(input.params, {
    key: input.key,
    client: "control-api",
    operation: input.operation,
    request: input.request,
  });
  if (command.reused) {
    if (command.state === "succeeded") return command.result as T;
    if (command.state === "failed") {
      const receipt =
        command.result && typeof command.result === "object"
          ? (command.result as Record<string, unknown>)
          : {};
      throw Object.assign(new Error(command.error ?? "delivery failed"), {
        status: typeof receipt["status"] === "number" ? receipt["status"] : 409,
        code: command.errorCode ?? receipt["code"] ?? "delivery_failed",
        ...(command.errorRequiredActions?.length
          ? { requiredActions: command.errorRequiredActions }
          : {}),
        ...(command.errorContext ? { context: command.errorContext } : {}),
      });
    }
    throw Object.assign(
      new Error(
        command.state === "interrupted"
          ? "delivery outcome is unknown after daemon restart; inspect before retrying"
          : "delivery with this Idempotency-Key is already in progress",
      ),
      {
        status: 409,
        code: command.state === "interrupted" ? "delivery_interrupted" : "delivery_in_progress",
      },
    );
  }
  let result: T;
  try {
    result = await input.work();
  } catch (error) {
    await fail(command.id, error).catch(() => undefined);
    throw error;
  }
  try {
    await complete(command.id, result);
  } catch (error) {
    // The target may already be mutated. Keep the command non-terminal so
    // restart recovery reports interrupted and no caller re-applies it.
    throw Object.assign(
      new Error("delivery completed but its durable receipt could not be saved"),
      {
        status: 500,
        code: "delivery_receipt_unavailable",
        cause: error,
      },
    );
  }
  return result;
}

export interface RunApplyRouteContext {
  services?: DeliveryCommandServices;
  findRun(id: string): Promise<DaemonRunRecord | null>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
  readPatch(record: DaemonRunRecord): string | null;
  /** The run's deliverable (#535): an object result with its exact view, or a legacy patch. */
  readDeliverable(record: DaemonRunRecord): ReturnType<typeof runDeliverable>;
  /** Project root owning the run's object store (the run's original project). */
  projectRoot(record: DaemonRunRecord): string | null;
  targetRoot(
    target: ControlApplyCheckRequest["target"] | ControlApplyRequest["target"],
    record: DaemonRunRecord,
  ): string | null;
  gateError(
    record: DaemonRunRecord,
    patch: string,
    root: string,
    finalVerify?: FinalVerifyRecord,
  ): string | null;
  gateSpecs(record: DaemonRunRecord): NonNullable<Parameters<typeof verifyAndDeliver>[3]>;
  chainMutation<T>(record: DaemonRunRecord, work: () => Promise<T>): Promise<T>;
  appendAudit(record: DaemonRunRecord, type: string, payload: Record<string, unknown>): void;
  /** Persist applyState=applied on the run's delivery-state artifact after a
   * delivery reports applied=true (round-15 #2) — idempotent, best-effort. An
   * object delivery also anchors its actual pair, so it becomes revertable. */
  markApplied(
    record: DaemonRunRecord,
    delivered?: { deliveryPair?: GitDeliveryPair },
    root?: string,
  ): void | Promise<void>;
  markFilesApplied?(
    record: DaemonRunRecord,
    paths: string[],
    manifest: WorkspaceFilesManifest,
  ): void;
  /** The run's effective MUTABLE delivery/apply state (delivery_state overlay →
   * work_product snapshot) — the same authority that projects
   * summary.result.applyState. An already-delivered run answers apply/check as
   * a typed idempotent no-op instead of "patch does not apply" (#26). */
  deliveredApplyState(record: DaemonRunRecord): RunApplyState;
}

/** Own the generic manual run apply/check routes outside the daemon server shell. */
export async function handleRunApplyRoutes(
  ctx: RunApplyRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const checkMatch = /^\/runs\/([^/]+)\/apply\/check$/.exec(path);
  if (method === "POST" && checkMatch) {
    const record = await ctx.findRun(decodeURIComponent(checkMatch[1] as string));
    if (!record?.runDir) {
      ctx.json(res, 404, { error: "no such run" });
      return true;
    }
    try {
      const raw = await ctx.readBody(req);
      const body = ControlApplyCheckRequest.parse(raw);
      if (readFilesWorkProduct(record)) {
        const root = ctx.targetRoot(body.target, record);
        if (!root || validateAbsoluteRepoRoot(root))
          throw Object.assign(new Error("project root is required for apply check"), {
            status: 400,
          });
        ctx.json(res, 200, await checkFilesResult(ctx, record, root, body.paths));
        return true;
      }
      const delivery = ctx.readDeliverable(record);
      if (delivery === null)
        throw Object.assign(new Error("no patch artifact for this run"), { status: 404 });
      const { patch } = delivery;
      const root = ctx.targetRoot(body.target, record);
      if (!root)
        throw Object.assign(new Error("project root is required for apply check"), { status: 400 });
      const rootError = validateAbsoluteRepoRoot(root);
      if (rootError) throw Object.assign(new Error(rootError), { status: 400 });
      if (typeof delivery.deliverable !== "string") {
        // An object result checks by composing onto the current target (#535).
        const checked = await checkResultOnTarget(
          root,
          delivery.deliverable.result,
          ctx.projectRoot(record) ?? root,
        );
        const gateError = checked.alreadyApplied ? null : ctx.gateError(record, patch, root);
        if (gateError) throw Object.assign(new Error(gateError), { status: 409 });
        ctx.json(
          res,
          200,
          ControlApplyCheckResponse.parse({
            ok: checked.ok,
            code: checked.code,
            stderr: checked.stderr,
            ...(checked.alreadyApplied ? { alreadyApplied: true } : {}),
            ...(checked.refusal ? { refusal: checked.refusal } : {}),
          }),
        );
        return true;
      }
      // Idempotent replay (#26 dry-run): an already-delivered run cannot pass a
      // forward `git apply --check` (the tree is the postimage), which would
      // read as "patch does not apply". When the recorded delivery state says
      // the change is in place AND the reverse check confirms the tree is this
      // patch's exact postimage, report the safe already-applied no-op instead
      // of a false conflict. A diverged tree falls through to the honest gate.
      const applyState = ctx.deliveredApplyState(record);
      if (
        (applyState === "applied" || applyState === "applied_review_blocked") &&
        (await checkPatchReverse(root, patch)).ok
      ) {
        ctx.json(
          res,
          200,
          ControlApplyCheckResponse.parse({
            ok: true,
            code: 0,
            stderr: "already applied; idempotent no-op (no files would change)",
            alreadyApplied: true,
          }),
        );
        return true;
      }
      const gateError = ctx.gateError(record, patch, root);
      if (gateError) throw Object.assign(new Error(gateError), { status: 409 });
      ctx.json(res, 200, ControlApplyCheckResponse.parse(await checkPatch(root, patch)));
    } catch (error) {
      ctx.requestError(res, error);
    }
    return true;
  }

  const applyMatch = /^\/runs\/([^/]+)\/apply$/.exec(path);
  if (!(method === "POST" && applyMatch)) return false;
  const record = await ctx.findRun(decodeURIComponent(applyMatch[1] as string));
  if (!record?.runDir) {
    ctx.json(res, 404, { error: "no such run" });
    return true;
  }
  try {
    const key = requiredIdempotencyKey(req);
    const raw = await ctx.readBody(req);
    const body = ControlApplyRequest.parse(raw);
    if (readFilesWorkProduct(record)) {
      const root = ctx.targetRoot(body.target, record);
      if (!root || validateAbsoluteRepoRoot(root))
        throw Object.assign(new Error("project root is required for apply"), { status: 400 });
      ctx.json(res, 200, await applyFilesResult(ctx, record, body, key, root));
      return true;
    }
    const delivery = ctx.readDeliverable(record);
    if (delivery === null)
      throw Object.assign(new Error("no patch artifact for this run"), { status: 404 });
    const { patch } = delivery;
    const root = ctx.targetRoot(body.target, record);
    if (!root)
      throw Object.assign(new Error("project root is required for apply"), { status: 400 });
    const rootError = validateAbsoluteRepoRoot(root);
    if (rootError) throw Object.assign(new Error(rootError), { status: 400 });
    const delivered = await ctx.chainMutation(record, async () => {
      let fresh = false;
      const answer = await runIdempotentDelivery(ctx.services, {
        params: record.params,
        key,
        operation: "run.apply",
        request: {
          runId: record.runId ?? record.id,
          body,
          patchSha256: delivery.digest,
          repoRoot: root,
        },
        work: async () => {
          const delivered = await verifyAndDeliver(
            root,
            delivery.deliverable,
            {
              ...{ mode: body.mode, branch: body.branch, message: body.message },
              projectRoot: ctx.projectRoot(record) ?? root,
              owner: record.runDir,
            },
            ctx.gateSpecs(record),
            (freshVerify) => ctx.gateError(record, patch, root, freshVerify),
          );
          // Inside the durable command, as accept_clean_patch does: a refusal is
          // journaled failed, and a replay answers the journal without recording
          // the run's state again.
          const left = await markRunWriteLeft(record, delivered, root, patch);
          if (delivered.refused) throw deliveryRefusedError(delivered, "delivery_refused", left);
          fresh = true;
          return delivered;
        },
      });
      // A delivery records its state; a replay only converges a run whose first
      // mark was lost (round-15 #2: without it, retention keeps classifying the
      // delivered patch as actionable and preserves the run indefinitely). It
      // never records over a later decision, or over the anchor already recorded.
      if (answer.applied && (fresh || ctx.deliveredApplyState(record) === "not_applied"))
        await ctx.markApplied(record, answer, root);
      return answer;
    });
    if (!delivered.applied && delivered.detail?.includes("refusing")) {
      ctx.appendAudit(record, "control.rejected", { control: "apply", reason: delivered.detail });
    }
    // #26: type the coarse delivery disposition on the wire so a consumer reads
    // the outcome without parsing `detail` prose. `alreadyApplied` rides on the
    // receipt already; deliveryStatus is its enum projection.
    const deliveryStatus = delivered.refused
      ? "refused"
      : delivered.alreadyApplied
        ? "already_applied"
        : delivered.applied
          ? "applied"
          : undefined;
    ctx.json(
      res,
      200,
      ControlDeliveryResponse.parse({
        ...delivered,
        ...(deliveryStatus ? { deliveryStatus } : {}),
      }),
    );
  } catch (error) {
    ctx.requestError(res, error);
  }
  return true;
}
