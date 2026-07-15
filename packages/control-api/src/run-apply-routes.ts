import type { IncomingMessage, ServerResponse } from "node:http";
import { checkPatch, verifyAndDeliver } from "@claudexor/delivery";
import {
  ControlApplyCheckRequest,
  ControlApplyCheckResponse,
  ControlApplyRequest,
  ControlDeliveryResponse,
  type FinalVerifyRecord,
} from "@claudexor/schema";
import { assertNoInlineSecretValues, containsSecretLikeToken, sha256 } from "@claudexor/util";
import type { DaemonRunRecord } from "./daemon-server.js";
import { requiredIdempotencyKey, validateAbsoluteRepoRoot } from "./run-start.js";

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
      });
    }
    throw Object.assign(
      new Error(
        command.state === "interrupted_unknown"
          ? "delivery outcome is unknown after daemon restart; inspect before retrying"
          : "delivery with this Idempotency-Key is already in progress",
      ),
      {
        status: 409,
        code:
          command.state === "interrupted_unknown"
            ? "delivery_interrupted_unknown"
            : "delivery_in_progress",
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
    // restart recovery reports interrupted_unknown and no caller re-applies it.
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
      assertNoInlineSecretValues(raw);
      const body = ControlApplyCheckRequest.parse(raw);
      const patch = ctx.readPatch(record);
      if (patch === null)
        throw Object.assign(new Error("no patch artifact for this run"), { status: 404 });
      if (containsSecretLikeToken(patch))
        throw Object.assign(new Error("patch contains secret-like token; refusing apply check"), {
          status: 409,
        });
      const root = ctx.targetRoot(body.target, record);
      if (!root)
        throw Object.assign(new Error("project root is required for apply check"), { status: 400 });
      const rootError = validateAbsoluteRepoRoot(root);
      if (rootError) throw Object.assign(new Error(rootError), { status: 400 });
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
    assertNoInlineSecretValues(raw);
    const body = ControlApplyRequest.parse(raw);
    const patch = ctx.readPatch(record);
    if (patch === null)
      throw Object.assign(new Error("no patch artifact for this run"), { status: 404 });
    if (containsSecretLikeToken(patch))
      throw Object.assign(new Error("patch contains secret-like token; refusing apply"), {
        status: 409,
      });
    const root = ctx.targetRoot(body.target, record);
    if (!root)
      throw Object.assign(new Error("project root is required for apply"), { status: 400 });
    const rootError = validateAbsoluteRepoRoot(root);
    if (rootError) throw Object.assign(new Error(rootError), { status: 400 });
    const delivered = await ctx.chainMutation(record, () =>
      runIdempotentDelivery(ctx.services, {
        params: record.params,
        key,
        operation: "run.apply",
        request: {
          runId: record.runId ?? record.id,
          body,
          patchSha256: sha256(patch),
          repoRoot: root,
        },
        work: () =>
          verifyAndDeliver(
            root,
            patch,
            { mode: body.mode, branch: body.branch, message: body.message },
            ctx.gateSpecs(record),
            (freshVerify) => ctx.gateError(record, patch, root, freshVerify),
          ),
      }),
    );
    if (delivered.refused)
      throw Object.assign(new Error(delivered.detail ?? "delivery refused"), { status: 409 });
    if (!delivered.applied && delivered.detail?.includes("refusing")) {
      ctx.appendAudit(record, "control.rejected", { control: "apply", reason: delivered.detail });
    }
    ctx.json(res, 200, ControlDeliveryResponse.parse(delivered));
  } catch (error) {
    ctx.requestError(res, error);
  }
  return true;
}
