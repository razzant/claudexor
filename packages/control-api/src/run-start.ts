/**
 * Run-start normalization (single owner): both entry paths — the HTTP control
 * API and the daemon socket runner — MUST use these so scope/secret/
 * absolute-root acceptance can never drift between surfaces. Split from
 * daemon-server.ts (INV-124 ratchet).
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { ControlRunStartRequest } from "@claudexor/schema";
import { assertNoInlineSecretValues, noProjectRepoRoot } from "@claudexor/util";
import type { DaemonFacadeClient } from "./daemon-server.js";
import { recordTurnEnqueueFailure } from "./thread-turn-routes.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export function validateAbsoluteRepoRoot(repoRoot: string): string | null {
  return isAbsolute(repoRoot) ? null : "project root must be an absolute path";
}

export function normalizeRunStart(parsed: ControlRunStartRequest): ControlRunStartRequest {
  const specPath = parsed.specPath?.trim();
  const mode = parsed.mode ?? "agent";
  // Empty chat is never a silent no-op (Bible): reject a blank prompt at the
  // engine boundary unless a frozen spec FILE (specPath) supplies the intent.
  // A bare specId does not load spec content at enqueue time, so it is not a
  // valid substitute for the prompt. Fail loud (400) rather than enqueue a
  // doomed run that produces nothing.
  if (parsed.prompt.trim().length === 0 && !specPath) {
    throw Object.assign(
      new Error("prompt must not be empty (provide a prompt or a frozen specPath)"),
      { status: 400 },
    );
  }
  // maxToolCalls caps the orchestrate EXECUTOR's plan steps; accepting it on
  // any other mode would create a silent no-op knob (INV-023).
  if (parsed.maxToolCalls !== undefined && mode !== "orchestrate") {
    throw Object.assign(
      new Error(
        "maxToolCalls only applies to mode=orchestrate (it caps the executor's plan steps)",
      ),
      { status: 400 },
    );
  }
  if (specPath && specPath !== parsed.specPath) parsed = { ...parsed, specPath };
  // Validate BEFORE enqueue (ARCHITECTURE §5): a contradictory web policy must
  // 400 here, not persist a doomed job for the orchestrator to reject later.
  if (parsed.web && parsed.externalContextPolicy && parsed.web !== parsed.externalContextPolicy) {
    throw Object.assign(
      new Error(
        `contradictory web policy: web='${parsed.web}' vs externalContextPolicy='${parsed.externalContextPolicy}' (pass one, or equal values)`,
      ),
      { status: 400 },
    );
  }
  // Live (in-place) isolation runs the harness directly in the execution tree
  // (the live project for an in-place thread, or the thread's worktree for an
  // isolated thread; also CLI convergence --in-place). It is an agent-only
  // concept — read-only modes have nothing to mutate; accepting it elsewhere
  // would silently run an envelope while claiming live semantics.
  if (parsed.execution?.isolation === "live" && mode !== "agent") {
    throw Object.assign(
      new Error(`execution.isolation='live' is only supported for agent runs, not '${mode}'`),
      { status: 400 },
    );
  }
  if (parsed.scope.kind === "project") {
    const repoRoot = parsed.scope.root.trim();
    const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
    if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
    // Existence is the only filesystem precondition here: a NON-GIT folder is
    // fine — write modes initialize the git boundary themselves (announced via
    // the project.git.initialized run event).
    if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
      throw Object.assign(
        new Error(`project root does not exist or is not a directory: ${repoRoot}`),
        { status: 400 },
      );
    }
    return {
      ...parsed,
      scope: { kind: "project", root: repoRoot, context: parsed.scope.context ?? "auto" },
    };
  }
  if (mode === "ask") {
    mkdirSync(NO_PROJECT_ROOT, { recursive: true, mode: 0o700 });
    return parsed;
  }
  throw Object.assign(new Error(`project scope is required for mode '${mode}'`), { status: 400 });
}

/**
 * Single owner of run-start normalization. Both entry paths (HTTP control API
 * and the daemon socket runner) MUST use this so scope/secret/absolute-root
 * acceptance can never drift between surfaces.
 */
export function normalizeRunStartRequest(raw: unknown): ControlRunStartRequest {
  assertNoInlineSecretValues(raw);
  return normalizeRunStart(ControlRunStartRequest.parse(raw ?? {}));
}

export interface RunCreateRouteContext {
  daemon: DaemonFacadeClient;
  readBody(req: IncomingMessage): Promise<unknown>;
  requestError(res: ServerResponse, error: unknown): void;
  json(res: ServerResponse, status: number, body: unknown): void;
  respondToAcceptedJob(res: ServerResponse, jobId: string): Promise<void>;
  createThreadTurn?: (
    id: string,
    prompt: string,
    options: {
      parentRunId?: string | null;
      planRunId?: string | null;
      attachments?: ControlRunStartRequest["attachments"];
      idempotency?: { key: string; client: string; request: unknown };
    },
  ) => Promise<unknown>;
  threadDetail?: (id: string) => Promise<unknown>;
  setTurnEnqueueError?: (
    turnId: string,
    message: string,
    code: string | null,
    retryable?: boolean,
  ) => void;
  chainThreadMutation?: (threadId: string, work: () => Promise<void>) => Promise<void>;
  validateResources?: (refs: NonNullable<ControlRunStartRequest["attachments"]>) => Promise<void>;
  preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
}

/** POST /v2/runs: validates, deduplicates, durably enqueues, then returns its handle. */
export async function handleRunCreate(
  ctx: RunCreateRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let idempotencyKey: string;
  let params: ControlRunStartRequest;
  try {
    idempotencyKey = requiredIdempotencyKey(req);
    const body = await ctx.readBody(req);
    assertNoInlineSecretValues(body);
    params = normalizeRunStart(ControlRunStartRequest.parse(body));
    await ctx.validateResources?.(params.attachments ?? []);
    await ctx.preflightRunRequirements?.(params);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  try {
    const prior = await ctx.daemon.findAccepted?.(params, {
      idempotencyKey,
      clientId: "control-api",
    });
    if (prior) return ctx.respondToAcceptedJob(res, prior.id);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  const directThreadId = params.threadId || null;
  if (params.turnId) {
    return ctx.json(res, 400, {
      error: "turnId is not accepted on POST /runs; create the turn via POST /threads/:id/turns",
    });
  }
  if (params.planRunId) {
    return ctx.json(res, 400, {
      error:
        "planRunId is not accepted on POST /runs; use POST /threads/:id/turns (the turn pipeline implements the plan)",
    });
  }
  if (params.retryOf) {
    return ctx.json(res, 400, {
      error: "retryOf is server-owned; use POST /runs/:id/retry for Exact Retry",
    });
  }
  const submit = async (): Promise<void> => {
    let enqueueParams: ControlRunStartRequest & { turnId?: string } = params;
    if (directThreadId && ctx.createThreadTurn) {
      if (ctx.threadDetail) {
        try {
          await ctx.threadDetail(directThreadId);
        } catch (error) {
          const status =
            error && typeof error === "object" && "status" in error
              ? Number((error as { status: number }).status)
              : 404;
          return ctx.json(res, status, {
            error: error instanceof Error ? error.message : `no such thread: ${directThreadId}`,
          });
        }
      }
      const turn = (await ctx.createThreadTurn(directThreadId, params.prompt, {
        parentRunId: params.parentRunId ?? null,
        planRunId: params.planRunId ?? null,
        attachments: params.attachments,
        idempotency: {
          key: idempotencyKey,
          client: "control-api",
          request: params,
        },
      })) as { id: string };
      const { attachments: _attachments, ...rest } = params;
      enqueueParams = { ...rest, turnId: turn.id };
    }
    const preCreatedTurnId = enqueueParams.turnId;
    let job: { id: string };
    try {
      job = await ctx.daemon.enqueue(enqueueParams, {
        idempotencyKey,
        clientId: "control-api",
        idempotencyRequest: params,
      });
    } catch (error) {
      recordTurnEnqueueFailure(ctx.setTurnEnqueueError, preCreatedTurnId, error);
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: number }).status)
          : 500;
      return ctx.json(res, status, {
        error: error instanceof Error ? error.message : "enqueue failed",
        ...(preCreatedTurnId ? { turnId: preCreatedTurnId, retryable: false } : {}),
      });
    }
    try {
      return await ctx.respondToAcceptedJob(res, job.id);
    } catch (error) {
      return ctx.json(res, 500, {
        error: `job ${job.id} was accepted but its start could not be observed: ${error instanceof Error ? error.message : String(error)}`,
        jobId: job.id,
        ...(preCreatedTurnId ? { turnId: preCreatedTurnId } : {}),
      });
    }
  };
  return directThreadId && ctx.chainThreadMutation
    ? ctx.chainThreadMutation(directThreadId, submit)
    : submit();
}

export function requiredIdempotencyKey(req: IncomingMessage): string {
  const header = req.headers["idempotency-key"];
  if (Array.isArray(header) || typeof header !== "string" || !header.trim()) {
    throw Object.assign(new Error("Idempotency-Key is required"), {
      code: "idempotency_key_required",
      status: 400,
      fieldErrors: { "Idempotency-Key": ["required for create operations"] },
    });
  }
  const value = header.trim();
  if (value.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
  return value;
}
