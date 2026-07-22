/**
 * Run-start normalization (single owner): both entry paths — the HTTP control
 * API and the daemon socket runner — MUST use these so scope/secret/
 * absolute-root acceptance can never drift between surfaces. Split from
 * daemon-server.ts (INV-124 ratchet).
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
  ControlQueuedRunInfo,
  ControlRunStartRequest,
  runStartStrategyViolations,
} from "@claudexor/schema";
import { assertNoInlineSecretValues, noProjectRepoRoot } from "@claudexor/util";
import type { DaemonFacadeClient, DaemonRunRecord } from "./daemon-server.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export function validateAbsoluteRepoRoot(repoRoot: string): string | null {
  return isAbsolute(repoRoot) ? null : "project root must be an absolute path";
}

export function normalizeRunStart(parsed: ControlRunStartRequest): ControlRunStartRequest {
  const mode = parsed.mode ?? "agent";
  // Empty chat is never a silent no-op (Bible): reject a blank prompt at the
  // engine boundary. Fail loud (400) rather than enqueue a doomed run that
  // produces nothing.
  if (parsed.prompt.trim().length === 0) {
    throw Object.assign(new Error("prompt must not be empty"), { status: 400 });
  }
  // The shared mode/strategy coherence owner (D11) refuses every strategy flag
  // on a mode it does not belong to (e.g. `delegate` on a non-agent mode),
  // rather than accepting a silent no-op knob (INV-023).
  const strategyViolations = runStartStrategyViolations(parsed);
  if (strategyViolations.length > 0) {
    throw Object.assign(new Error(strategyViolations.join("; ")), { status: 400 });
  }
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
  validateResources?: (refs: NonNullable<ControlRunStartRequest["attachments"]>) => Promise<void>;
  preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
}

export function unboundRunStartResponse(
  rec: DaemonRunRecord,
  terminal: boolean,
): { status: number; body: Record<string, unknown> } {
  // errorStatus is served verbatim only inside the failure range; anything
  // else (absent, or a non-4xx/5xx value from a defective writer) must not
  // turn a terminal failure body into a 2xx/3xx response.
  const errorStatus =
    typeof rec.errorStatus === "number" &&
    Number.isInteger(rec.errorStatus) &&
    rec.errorStatus >= 400 &&
    rec.errorStatus <= 599
      ? rec.errorStatus
      : 500;
  return {
    status: terminal ? errorStatus : 202,
    body: {
      ...ControlQueuedRunInfo.parse({ jobId: rec.id, state: rec.state, error: rec.error }),
      ...(rec.errorCode ? { code: rec.errorCode } : {}),
      ...(terminal ? { retryable: false } : {}),
    },
  };
}

/** POST /v2/runs: validates, deduplicates, durably enqueues, then returns its handle.
 *
 * D10: POST /runs is the ONE-SHOT, THREAD-LESS run surface. A thread turn is
 * ALWAYS created through POST /threads/:id/turns (that route owns scope
 * resolution, turn lineage, and the continuation packet). `threadId` here is
 * therefore refused alongside the other server-owned lineage keys — routing a
 * turn past the turn pipeline would skip continuity entirely. */
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
  if (params.threadId) {
    return ctx.json(res, 400, {
      error:
        "threadId is not accepted on POST /runs; continue a thread via POST /threads/:id/turns (the turn pipeline owns scope + continuity)",
    });
  }
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
  let job: { id: string };
  try {
    job = await ctx.daemon.enqueue(params, {
      idempotencyKey,
      clientId: "control-api",
      idempotencyRequest: params,
    });
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status: number }).status)
        : 500;
    return ctx.json(res, status, {
      error: error instanceof Error ? error.message : "enqueue failed",
    });
  }
  try {
    return await ctx.respondToAcceptedJob(res, job.id);
  } catch (error) {
    return ctx.json(res, 500, {
      error: `job ${job.id} was accepted but its start could not be observed: ${error instanceof Error ? error.message : String(error)}`,
      jobId: job.id,
    });
  }
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
