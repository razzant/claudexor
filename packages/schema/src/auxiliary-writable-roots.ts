import { z } from "zod/v3";
import type { AccessProfile, ModeKind } from "./primitives.js";

/**
 * Exact caller-created service directories (download caches, outside-Git
 * scratch) an Agent lane may write besides its execution tree. The caller owns
 * them; the engine never creates, captures, applies, reverts, or deletes them.
 */
export const AuxiliaryWritableRootsRequest = z
  .array(z.string().min(1))
  .describe(
    "Exact existing absolute directories, created by the caller, that an Agent run with effective workspace_write may also write (service caches or scratch outside the execution tree). [] grants nothing extra; so does omission, except that a continueFrom successor omitting execution inherits its predecessor's whole execution group. Requires a lane whose capability_profile.access_control.auxiliary_writable_roots is true; the files are never part of the project result.",
  );

/** Canonical grant recorded by the engine after admission (realpath, deduplicated). */
export const AuxiliaryWritableRoots = z
  .array(z.string())
  .default([])
  .describe(
    "Canonical auxiliary writable directories granted to this run's writable Agent lanes; empty = no extra engine grant. Read-only lanes never receive them.",
  );

/** Manifest fact: the adapter applies auxiliary writable roots natively and revocably per turn. */
export const AuxiliaryWritableRootsCapability = z
  .boolean()
  .default(false)
  .describe(
    "The adapter applies HarnessRunSpec.auxiliary_writable_roots natively under workspace_write, and a later spec carrying none receives no earlier grant; false = such a lane refuses (explicit pool) or is filtered (auto pool).",
  );

export interface AuxiliaryWritableRootsViolation {
  code: "auxiliary_writable_roots_access_conflict";
  message: string;
  retryable: false;
  requiredActions: readonly [string];
}

/**
 * A non-empty grant exists only on an Agent run whose effective access is
 * workspace_write; every other mode or access level is a typed conflict, never
 * a silently changed access profile.
 */
export function runAuxiliaryWritableRootsViolation(
  value: { mode?: ModeKind; execution?: { auxiliaryWritableRoots?: readonly string[] } },
  effectiveAccess: AccessProfile | undefined,
): AuxiliaryWritableRootsViolation | null {
  if ((value.execution?.auxiliaryWritableRoots?.length ?? 0) === 0) return null;
  const mode = value.mode ?? "agent";
  if (mode === "agent" && (effectiveAccess === undefined || effectiveAccess === "workspace_write"))
    return null;
  return {
    code: "auxiliary_writable_roots_access_conflict",
    message: `execution.auxiliaryWritableRoots requires an Agent run with workspace_write access (mode '${mode}', access '${mode === "agent" ? effectiveAccess : "readonly"}')`,
    retryable: false,
    requiredActions: [
      "Use Agent with workspace_write, or clear the roots. For continueFrom, POST /v2/runs with a complete replacement execution group and auxiliaryWritableRoots: []; claudexor_run_continue cannot replace execution, so use HTTP or start a new run.",
    ],
  };
}
