import type { EffortHint, HarnessRunSpec } from "@claudexor/schema";
import {
  asObject,
  codexAppServerThreadParams,
  CodexServerRequestRefusal,
  type JsonObject,
} from "./app-server-protocol.js";
import { codexAppServerApprovalParams } from "./sandbox.js";

/** thread/start, or thread/resume of the bound native session, under legacy thread params. */
export function codexAppServerThreadRequest(
  spec: HarnessRunSpec,
  effort: EffortHint | null | undefined,
): [string, JsonObject] {
  const params = codexAppServerThreadParams(spec, effort);
  return spec.resume_session_id
    ? ["thread/resume", { ...params, threadId: spec.resume_session_id }]
    : ["thread/start", params];
}

/**
 * The turn policy that applies a run's explicit auxiliary writable roots.
 *
 * LIVE-VERIFIED (codex-cli 0.162.1: real exec_command writes under Seatbelt,
 * local scripted Responses provider, a fresh app-server per resume): writable
 * roots in thread start/resume config become the thread's persisted runtime
 * workspace roots, which no later turn can revoke, while a turn/start
 * `sandboxPolicy` grant covers that turn (and later turns of the same
 * process) and does not survive a fresh-process resume. Grants therefore ride
 * ONLY this policy and the thread params stay unchanged, so a later run whose
 * spec carries no roots is back on the native defaults with nothing to clear.
 * The echoed policy keeps its network/temp fields and native writable roots.
 */
export function codexTurnSandboxPolicy(
  spec: HarnessRunSpec,
  threadSandbox: unknown,
): JsonObject | undefined {
  // An embedder's unparsed spec may omit the field: omission is no grant.
  const roots = spec.auxiliary_writable_roots ?? [];
  if (roots.length === 0) return undefined;
  const echo = asObject(threadSandbox);
  if (spec.access !== "workspace_write" || echo?.["type"] !== "workspaceWrite")
    throw new CodexServerRequestRefusal(
      "codex_auxiliary_roots_unavailable",
      `auxiliary writable roots need Codex's workspaceWrite sandbox, but ${spec.access} access started a ${String(echo?.["type"] ?? "missing")} sandbox`,
    );
  const native = Array.isArray(echo["writableRoots"])
    ? echo["writableRoots"].filter((root): root is string => typeof root === "string")
    : [];
  return { ...echo, writableRoots: [...new Set([...native, ...roots])] };
}

/** Approval params of every turn/start, plus the run's auxiliary turn policy when present. */
export function codexTurnParams(spec: HarnessRunSpec, sandboxPolicy?: JsonObject): JsonObject {
  return { ...codexAppServerApprovalParams(spec), ...(sandboxPolicy ? { sandboxPolicy } : {}) };
}
