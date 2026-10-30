/**
 * Run-start normalization (single owner): both entry paths — the HTTP control
 * API and the daemon socket runner — MUST use these so scope/secret/
 * absolute-root acceptance can never drift between surfaces. Split from
 * daemon-server.ts (INV-124 ratchet).
 */
import { mkdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
  ControlRunStartRequest,
  PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS,
  RecordedControlRunStartRequest,
  RETIRED_EXTERNAL_SANDBOX_FULL,
  runAccessStrategyViolation,
  runAuxiliaryWritableRootsViolation,
  runExecutionWorkspaceRootAllowed,
  runExecutionWorkspaceViolation,
  runStartStrategyViolations,
  taskGroupLaunchMetadata,
} from "@claudexor/schema";
import {
  noProjectRepoRoot,
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import {
  assertAuxiliaryWritableRootSpelling,
  auxiliaryWritableRootDirectory,
} from "@claudexor/workspace";
import type { DaemonFacadeClient } from "./daemon-server.js";
import { assertContinuationAdmissible, resolveContinuationBody } from "./run-continuation-start.js";
import { prepareRunStart } from "./run-start-preparation.js";
import { requireTaskGroupStoreIdentity } from "./run-start-receipt.js";
export {
  acceptedTaskGroupReceipt,
  requireTaskGroupStoreIdentity,
  unboundRunStartResponse,
} from "./run-start-receipt.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export function validateAbsoluteRepoRoot(repoRoot: string): string | null {
  return isAbsolute(repoRoot) ? null : "project root must be an absolute path";
}

/**
 * The one admission rule for a user-supplied project root. Run start and
 * read-only root-scoped projections must accept and echo the same spelling.
 */
export function normalizeExistingProjectRoot(requestedRoot: string): string {
  const repoRoot = requestedRoot.trim();
  const absoluteRepoError = validateAbsoluteRepoRoot(repoRoot);
  if (absoluteRepoError) throw Object.assign(new Error(absoluteRepoError), { status: 400 });
  try {
    if (statSync(repoRoot).isDirectory()) return repoRoot;
  } catch {
    // Project-root admission projects every missing/broken/raced path through
    // the same typed 400 below. statSync intentionally follows a directory
    // symlink while the returned request spelling remains unchanged.
  }
  throw Object.assign(new Error(`project root does not exist or is not a directory: ${repoRoot}`), {
    status: 400,
  });
}

function executionWorkspaceError(message: string, code: string): Error {
  return Object.assign(new Error(message), {
    status: 400,
    code,
    retryable: false,
    requiredActions: [
      "Provide execution.workspaceRoot as an absolute existing directory for this delegated live run.",
    ],
  });
}

function assertAbsoluteExecutionWorkspace(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) {
    throw executionWorkspaceError(
      "execution.workspaceRoot must be an absolute path",
      "execution_workspace_invalid",
    );
  }
  return workspaceRoot;
}

/** Validate the one-shot execution tree without respelling it. */
export function normalizeExistingExecutionWorkspace(workspaceRoot: string): string {
  assertAbsoluteExecutionWorkspace(workspaceRoot);
  try {
    if (statSync(workspaceRoot).isDirectory()) return workspaceRoot;
  } catch {
    // Project and execution roots intentionally share existence semantics.
  }
  throw executionWorkspaceError(
    `execution.workspaceRoot does not exist or is not a directory: ${workspaceRoot}`,
    "execution_workspace_invalid",
  );
}

export interface RunStartNormalizationOptions {
  /**
   * A delegated thread turn records its bound execution root before its
   * durable turn and command exist; the root's current existence is a mutable
   * fact the daemon job revalidates, so a missing copy becomes a durable,
   * retryable refusal on the turn instead of a lost HTTP-only 400.
   */
  deferExecutionWorkspaceAvailability?: boolean;
}

export function normalizeRunStart(
  parsed: ControlRunStartRequest,
  options: RunStartNormalizationOptions = {},
): ControlRunStartRequest {
  taskGroupLaunchMetadata(parsed);
  const mode = parsed.mode ?? "agent";
  // Empty chat is never a silent no-op (Bible): reject a blank prompt at the
  // engine boundary. Fail loud (400) rather than enqueue a doomed run that
  // produces nothing. A continuation is the exception: its work order is the
  // predecessor's, so the caller's continuation text may be empty.
  if (parsed.prompt.trim().length === 0 && !parsed.continueFrom) {
    throw Object.assign(new Error("prompt must not be empty"), { status: 400 });
  }
  // The shared mode/strategy coherence owner (D11) refuses every strategy flag
  // on a mode it does not belong to (e.g. `delegate` on a non-agent mode),
  // rather than accepting a silent no-op knob (INV-023).
  const strategyViolations = runStartStrategyViolations(parsed);
  if (strategyViolations.length > 0) {
    throw Object.assign(new Error(strategyViolations.join("; ")), { status: 400 });
  }
  // An explicit readonly request cannot ask the engine to run write-backed
  // convergence or gate controls. Config-default access is resolved by the
  // shared preflight; this early branch covers every public ingress before enqueue.
  const accessStrategyViolation =
    parsed.access === "readonly" ? runAccessStrategyViolation(parsed, "readonly") : null;
  if (accessStrategyViolation) {
    throw Object.assign(new Error(accessStrategyViolation.message), {
      status: 400,
      code: accessStrategyViolation.code,
      retryable: accessStrategyViolation.retryable,
      requiredActions: [...accessStrategyViolation.requiredActions],
    });
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
  const workspaceRoot = parsed.execution?.workspaceRoot;
  if (workspaceRoot !== undefined && !runExecutionWorkspaceRootAllowed({ ...parsed, mode })) {
    throw executionWorkspaceError(
      "execution.workspaceRoot is supported only for project-scoped delegated runs: an agent with execution.isolation='live' or directory execution, or a read-only ask/plan",
      "execution_workspace_invalid",
    );
  }
  const normalizedWorkspaceRoot =
    workspaceRoot === undefined
      ? undefined
      : options.deferExecutionWorkspaceAvailability === true
        ? assertAbsoluteExecutionWorkspace(workspaceRoot)
        : normalizeExistingExecutionWorkspace(workspaceRoot);
  // An omitted Agent access profile inherits the project trust default, which
  // this filesystem-only normalizer does not own. The project-aware preflight
  // resolves that default and applies the same shared requirement below; only
  // an explicitly mutating request can be decided at this boundary.
  // The same split decides auxiliary roots: mode and an explicit access here,
  // the configured default in the preflight; engine admission canonicalizes.
  const workspaceViolation =
    (parsed.access === undefined ? null : runExecutionWorkspaceViolation(parsed, parsed.access)) ??
    runAuxiliaryWritableRootsViolation({ ...parsed, mode }, parsed.access);
  if (workspaceViolation) {
    throw Object.assign(new Error(workspaceViolation.message), {
      status: 400,
      code: workspaceViolation.code,
      retryable: workspaceViolation.retryable,
      requiredActions: [...workspaceViolation.requiredActions],
    });
  }
  for (const root of parsed.execution?.auxiliaryWritableRoots ?? []) {
    if (options.deferExecutionWorkspaceAvailability === true)
      assertAuxiliaryWritableRootSpelling(root);
    else auxiliaryWritableRootDirectory(root);
  }
  if (parsed.scope.kind === "project") {
    // Existence is the only filesystem precondition here: a NON-GIT folder is
    // fine — write modes initialize the git boundary themselves (announced via
    // the project.git.initialized run event; implausible roots — the user home
    // or a filesystem root — are refused there with a typed error, INV-075).
    const repoRoot = normalizeExistingProjectRoot(parsed.scope.root);
    return {
      ...parsed,
      execution: {
        ...parsed.execution,
        ...(normalizedWorkspaceRoot === undefined
          ? {}
          : { workspaceRoot: normalizedWorkspaceRoot }),
      },
      scope: {
        kind: "project",
        root: repoRoot,
        context: parsed.scope.context ?? "auto",
        // Rebuilt field-by-field: an omitted key here would silently drop the
        // caller's one-shot declaration and register the root after all.
        ephemeral: parsed.scope.ephemeral,
      },
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
export function normalizeRunStartRequest(
  raw: unknown,
  options: RunStartNormalizationOptions = {},
): ControlRunStartRequest {
  return normalizeRunStart(ControlRunStartRequest.parse(raw ?? {}), options);
}

/** Reconstruct the request projection used by the pre-retirement command
 * writer without applying current admission or filesystem checks. This exists
 * only so an exact idempotency replay can recover an already-accepted handle;
 * it is never passed to enqueue. */
function recordedRunStartReplayProjection(
  parsed: RecordedControlRunStartRequest,
): RecordedControlRunStartRequest {
  if (parsed.scope.kind !== "project") return parsed;
  return {
    ...parsed,
    scope: {
      kind: "project",
      root: parsed.scope.root.trim(),
      context: parsed.scope.context ?? "auto",
      ephemeral: parsed.scope.ephemeral,
    },
  };
}

function retiredAccessProfileError(): Error {
  return Object.assign(
    new Error(
      "external_sandbox_full is retired; choose workspace_write, or explicitly trust the repository and choose full",
    ),
    {
      status: 409,
      code: "retired_access_profile",
      retryable: false,
      requiredActions: [
        "Choose workspace_write, or explicitly trust the repository and choose full.",
      ],
    },
  );
}

/**
 * The daemon's typed refusal for an unregistered project root, or null. It
 * crosses the daemon socket with code/status/retryable only, so the one
 * remedy is restored here; a caller-facing answer is a 404 the caller fixes
 * by registering the root (or declaring scope.ephemeral), never a retry.
 */
function projectNotRegisteredError(error: unknown): Error | null {
  if (!(error instanceof Error)) return null;
  const typed = error as Error & { code?: unknown; status?: unknown; requiredActions?: unknown };
  if (typed.code !== "project_not_registered") return null;
  const actions = Array.isArray(typed.requiredActions) ? typed.requiredActions : [];
  return Object.assign(typed, {
    status: typeof typed.status === "number" ? typed.status : 404,
    retryable: false,
    requiredActions: actions.length > 0 ? actions : [...PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS],
  });
}

/** Keep only existing problem fields, never raw exception stacks or causes. */
function lookupProblemEvidence(error: unknown): Record<string, unknown> {
  const source = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    message: safeProblemMessage(error),
    ...(typeof source["code"] === "string" ? { code: source["code"] } : {}),
    ...(typeof source["status"] === "number" ? { status: source["status"] } : {}),
    ...(typeof source["retryable"] === "boolean" ? { retryable: source["retryable"] } : {}),
    requiredActions: safeProblemRequiredActions(source["requiredActions"]),
    context: safeProblemContext(source["context"]),
  };
}

export interface RunCreateRouteContext {
  daemon: DaemonFacadeClient;
  readBody(req: IncomingMessage): Promise<unknown>;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
  json(res: ServerResponse, status: number, body: unknown): void;
  respondToAcceptedJob(res: ServerResponse, jobId: string): Promise<void>;
  storeId?: () => string | undefined;
  validateResources?: (refs: NonNullable<ControlRunStartRequest["attachments"]>) => Promise<void>;
  preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
}

/**
 * Preserve a concurrently accepted idempotent command when mutable preflight
 * fails after the first durable lookup missed it. The second lookup is a
 * single race-closing probe, not polling. Only a successful miss preserves
 * the preflight refusal; an unreadable durable index leaves custody unknown
 * and asks the caller to replay the same idempotency key. Only the daemon's
 * canonical key/project refusals establish a definite refusal of THIS body;
 * a conflict may still refer to an earlier accepted command under that key.
 */
export async function findAcceptedAroundPreflight<T>(
  findAccepted: () => Promise<T | null | undefined>,
  preflight: () => Promise<void>,
): Promise<T | null> {
  const lookup = async (
    stage: "lookup_before_preflight" | "lookup_after_preflight",
    preflightError?: unknown,
  ): Promise<T | null | undefined> => {
    try {
      return await findAccepted();
    } catch (error) {
      const unregistered = projectNotRegisteredError(error);
      if (unregistered) throw unregistered;
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "idempotency_conflict" || error.code === "invalid_idempotency_key")
      ) {
        // CommandStore supplies code/status but no retryable property; expose
        // the definite refusal explicitly without changing other lookup errors.
        throw Object.assign(error, { retryable: false });
      }
      throw Object.assign(
        new Error(
          "idempotency status is temporarily unavailable; retry the same operation with the same Idempotency-Key",
          { cause: error },
        ),
        {
          status: 503,
          code: "idempotency_status_unavailable",
          retryable: true,
          requiredActions: ["Retry the same operation with the same Idempotency-Key."],
          context: safeProblemContext({
            stage,
            cause: lookupProblemEvidence(error),
            ...(stage === "lookup_after_preflight"
              ? { preflight: lookupProblemEvidence(preflightError) }
              : {}),
          }),
        },
      );
    }
  };
  const prior = await lookup("lookup_before_preflight");
  if (prior) return prior;
  try {
    await preflight();
  } catch (preflightError) {
    const raced = await lookup("lookup_after_preflight", preflightError);
    if (raced) return raced;
    throw preflightError;
  }
  return null;
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
  let recorded: RecordedControlRunStartRequest;
  try {
    idempotencyKey = requiredIdempotencyKey(req);
    const body = await resolveContinuationBody(ctx.daemon, await ctx.readBody(req));
    recorded = recordedRunStartReplayProjection(RecordedControlRunStartRequest.parse(body));
  } catch (error) {
    return ctx.requestError(res, error);
  }
  let params: ControlRunStartRequest | undefined;
  // Replay precedes active-schema retirement, filesystem validation, and
  // mutable capability/resource preflight. Once an older daemon durably
  // accepted this exact key+historical request, an upgrade must return that
  // handle instead of abandoning an outcome whose original POST was unknown.
  // The second probe closes the race where acceptance lands while current
  // admission is refusing the request. A miss on both probes is the only
  // authority to emit the retired-profile refusal.
  try {
    const prior = await findAcceptedAroundPreflight(
      () =>
        ctx.daemon.findAccepted?.(recorded, {
          idempotencyKey,
          clientId: "control-api",
          idempotencyRequest: recorded,
        }) ?? Promise.resolve(null),
      async () => {
        if (recorded.access === RETIRED_EXTERNAL_SANDBOX_FULL) {
          throw retiredAccessProfileError();
        }
        await assertContinuationAdmissible(ctx.daemon, recorded);
        params = await prepareRunStart(recorded, ctx);
      },
    );
    if (prior) return ctx.respondToAcceptedJob(res, prior.id);
  } catch (error) {
    return ctx.requestError(res, error);
  }
  if (!params) {
    return ctx.requestError(
      res,
      Object.assign(new Error("run-start admission did not produce an active request"), {
        status: 500,
      }),
    );
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
  if (params.planRef) {
    // The frozen-plan reference is the tamper fence's INPUT: the orchestrator
    // trusts its sha256 by construction (INV-081), so a client-supplied
    // planRef would let a loopback caller point the plan brief at an
    // arbitrary file with a self-consistent hash. Only the daemon-internal
    // turn pipeline may mint one.
    return ctx.json(res, 400, {
      error:
        "planRef is not accepted on POST /runs; the frozen-plan reference is server-owned and minted by POST /threads/:id/turns at implement time",
    });
  }
  if (params.retryOf) {
    return ctx.json(res, 400, {
      error: "retryOf is server-owned; use POST /runs/:id/retry for Exact Retry",
    });
  }
  if (params.parentRunId || params.delegatedFromRunId) {
    return ctx.json(res, 400, {
      error:
        "parentRunId and delegatedFromRunId are server-owned lineage; Delegate children are created only by the scoped belt",
    });
  }
  let job: { id: string };
  try {
    requireTaskGroupStoreIdentity(params, ctx.storeId);
    job = await ctx.daemon.enqueue(params, {
      idempotencyKey,
      clientId: "control-api",
      idempotencyRequest: params,
    });
  } catch (error) {
    // A root unregistered between the lookup and enqueue answers the same
    // typed refusal as the lookup; every typed enqueue error keeps its facts.
    return ctx.requestError(res, projectNotRegisteredError(error) ?? error, 500);
  }
  try {
    return await ctx.respondToAcceptedJob(res, job.id);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "store_identity_unavailable"
    )
      return ctx.requestError(res, error, 500);
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

/**
 * An OPTIONAL Idempotency-Key: `undefined` when the client sent none, the
 * validated value when present. Unlike `requiredIdempotencyKey` an absent header
 * is NOT a 400 — it selects legacy non-idempotent behavior for operations whose
 * key is optional (the current installed macOS app sends no key). A present but
 * malformed key still fails loudly (a key the client believed it sent must not
 * silently degrade to non-idempotent).
 */
export function optionalIdempotencyKey(req: IncomingMessage): string | undefined {
  const header = req.headers["idempotency-key"];
  if (header === undefined) return undefined;
  if (Array.isArray(header) || typeof header !== "string" || !header.trim()) {
    throw Object.assign(new Error("Idempotency-Key, when present, must be a non-empty value"), {
      code: "invalid_idempotency_key",
      status: 400,
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
