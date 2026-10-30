/** POST /v2/threads: thread creation over the daemon's idempotent thread store. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ControlThreadCreateRequest,
  isEphemeralRunScope,
  threadCreateWorkspaceViolation,
} from "@claudexor/schema";
import type { DaemonControlApiOptions } from "./daemon-server.js";
import { normalizeExistingProjectRoot, requiredIdempotencyKey } from "./run-start.js";
import { projectThread } from "./thread-projection.js";

export interface ThreadCreateRouteCtx {
  services: DaemonControlApiOptions["services"];
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

function threadWorkspaceInvalid(message: string): Error {
  return Object.assign(new Error(message), {
    status: 400,
    code: "thread_workspace_invalid",
    retryable: false,
    requiredActions: [
      "Create a delegated thread with a project scope and workspaceRoot naming an absolute existing directory the caller owns.",
    ],
  });
}

/** The delegated binding's one existence rule; the spelling is kept as sent. */
function normalizeExistingThreadWorkspaceRoot(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) throw threadWorkspaceInvalid("workspaceRoot must be absolute");
  try {
    if (statSync(workspaceRoot).isDirectory()) return workspaceRoot;
  } catch {
    // Missing, broken and raced paths all project to the same typed refusal.
  }
  throw threadWorkspaceInvalid(
    `workspaceRoot does not exist or is not a directory: ${workspaceRoot}`,
  );
}

/**
 * Immutable shape rules run first; an exact accepted replay is then answered
 * before ANY mutable filesystem admission, so a creation whose project or
 * caller-owned workspace later disappeared still returns its original thread.
 */
export async function handleThreadCreate(
  ctx: ThreadCreateRouteCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const svc = ctx.services?.createThread;
  if (!svc) return ctx.json(res, 501, { error: "threads are not supported by this engine build" });
  try {
    const body = await ctx.readBody(req);
    const parsed = ControlThreadCreateRequest.parse(body);
    const idempotencyKey = requiredIdempotencyKey(req);
    const shapeError = threadCreateWorkspaceViolation(parsed);
    if (shapeError) throw threadWorkspaceInvalid(shapeError);
    const idempotency = { key: idempotencyKey, client: "control-api", request: parsed };
    // Carried explicitly through the SAME predicate the run route and the
    // partition router use: dropping it here would register a root the wire
    // contract promises never to register.
    const ephemeral = isEphemeralRunScope(parsed.scope);
    const prior = await ctx.services?.findThreadCreation?.({
      repoRoot: parsed.scope.kind === "project" ? parsed.scope.root.trim() : null,
      ephemeral,
      idempotency,
    });
    if (prior) return ctx.json(res, 200, projectThread(prior, false));
    const repoRoot =
      parsed.scope.kind === "project" ? normalizeExistingProjectRoot(parsed.scope.root) : null;
    const thread = await svc({
      title: parsed.title,
      folder: parsed.folder,
      repoRoot,
      ephemeral,
      mode: parsed.mode,
      workspace: parsed.workspace,
      ...(parsed.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: normalizeExistingThreadWorkspaceRoot(parsed.workspaceRoot) }),
      authPreference: parsed.authPreference,
      credentialProfileId: parsed.credentialProfileId ?? null,
      access: parsed.access,
      primaryHarness: parsed.primaryHarness ?? null,
      eligibleHarnesses: parsed.eligibleHarnesses,
      idempotency,
    });
    return ctx.json(res, 200, projectThread(thread, false));
  } catch (err) {
    return ctx.requestError(res, err);
  }
}
