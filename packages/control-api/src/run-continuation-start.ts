/**
 * `continueFrom` on POST /v2/runs (INTERFACES §1): the HTTP half of the run
 * chain. The daemon's enqueue RPC owns the atomic one-successor claim; this
 * module resolves what a continuation inherits BEFORE ordinary request
 * defaults fill it, and answers the same admission verdict with its typed
 * context (the chain `head`), preserved by the daemon socket as well.
 */
import {
  continuationPredecessor,
  continuationRefusal,
  continuationRefusalError,
  continuedRunOf,
  assertDeferredReservation,
} from "@claudexor/schema";
import { paramsRecord, type DaemonFacadeClient } from "./run-record.js";

/** What a continuation needs to find its carrier and workspace: the work's
 * kind, project and execution tree, harness and model, plus the native
 * prompt-cache lifetime the predecessor's sessions were started under. Nothing
 * else is inherited implicitly. Either explicit key replaces its whole related
 * group. */
const INHERITED_GROUPS = [
  ["mode"],
  ["scope"],
  ["execution"],
  ["harnesses", "primaryHarness"],
  ["model", "models"],
  ["promptCacheTtl"],
] as const;
/** The same groups as one key list, for reads that disclose inherited values. */
export const CONTINUATION_INHERITED_KEYS: readonly string[] = INHERITED_GROUPS.flat();

/**
 * Fill the omitted inheritable keys of a raw `continueFrom` body from the
 * predecessor's accepted request, and name the predecessor by its run id
 * (a job id is accepted too). Runs on the RAW body, before the request schema
 * injects defaults — an omitted scope must not become "no project". An
 * unknown predecessor is left untouched: admission refuses it typed.
 */
export async function resolveContinuationBody(
  daemon: Pick<DaemonFacadeClient, "list">,
  body: unknown,
): Promise<unknown> {
  return (await readContinuationBody(daemon, body)).body;
}

/**
 * The same resolution, also saying whether it recovered what an accepted create inherited.
 * `unrecovered` is a `continueFrom` no retained record answers to: the body stays raw,
 * while any continuation accepted from it carried that predecessor's keys. Admission never
 * accepts a successor of a run-less predecessor, so for one still retained raw is canonical.
 */
export async function readContinuationBody(
  daemon: Pick<DaemonFacadeClient, "list">,
  body: unknown,
): Promise<{ body: unknown; unrecovered: string | null }> {
  if (body && typeof body === "object" && "continueModelInherited" in body) {
    throw Object.assign(new Error("continueModelInherited is server-owned"), { status: 400 });
  }
  const from = continuedRunOf(body);
  if (from === null || !body || typeof body !== "object" || Array.isArray(body))
    return { body, unrecovered: null };
  const predecessor = continuationPredecessor(from, await daemon.list({ id: from }));
  if (!predecessor?.runId) return { body, unrecovered: predecessor ? null : from };
  return {
    body: inheritContinuationBody(predecessor, body as Record<string, unknown>),
    unrecovered: null,
  };
}

/** Internal capture can inherit a queued handle without granting public
 * admission. The ordinary continuation refusal still rejects live work. */
export function inheritContinuationBody(
  predecessor: { id: string; runId?: string; params?: unknown },
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const inherited = paramsRecord(predecessor);
  const resolved: Record<string, unknown> = {
    ...raw,
    continueFrom: predecessor.runId ?? predecessor.id,
  };
  for (const group of INHERITED_GROUPS) {
    if (group.some((key) => key in raw)) continue;
    for (const key of group) {
      if (inherited[key] !== undefined) resolved[key] = inherited[key];
    }
  }
  // Preserve caller intent through durable request normalization and settings defaults.
  resolved["continueModelInherited"] = !("model" in raw || "models" in raw);
  return resolved;
}

/** Throw the typed admission refusal (with its context) for a continuation
 * that may not start now; ordinary requests pass untouched. */
export async function assertContinuationAdmissible(
  daemon: Pick<DaemonFacadeClient, "list" | "deferredMessageProjection">,
  request: unknown,
): Promise<void> {
  const from = continuedRunOf(request);
  if (from === null) return;
  assertDeferredReservation(await daemon.deferredMessageProjection?.(from));
  const refusal = continuationRefusal(request, await daemon.list({ continuationChainOf: from }));
  if (refusal) throw continuationRefusalError(refusal);
}
