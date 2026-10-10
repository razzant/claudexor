/**
 * Run-level view of retained envelopes: the pointer a holder run keeps to its
 * retained envelope, retention, adoption by a `continueFrom` successor, and
 * release (discard, apply, or the successor finishing). The custody record in
 * the envelope base is the authority (`envelope-custody.ts`); the run-dir
 * pointer is only its address, so a stale pointer reads as "nothing retained".
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  SessionCapsule,
  type EnvelopeCustody,
  type ResumableCause,
  type WorkspaceEnvelope,
} from "../schema/index.js";
import { nowIso } from "../util/index.js";
import {
  envelopeBaseOf,
  envelopeTreeChanged,
  liveEnvelopeCustody,
  readEnvelopeCustody,
  releaseEnvelopeCustody,
  retainEnvelopeCustody,
  stripRouteScopedAuth,
  writeEnvelopeCustody,
} from "./envelope-custody.js";
import { processStartTime } from "./envelope-recovery.js";
import { WorkspaceManager } from "./manager.js";

/** Run-dir pointer to the run's retained envelope (address only). */
export const RETAINED_ENVELOPE_POINTER = "final/retained-envelope.json";

function pointerPath(runDir: string): string {
  return join(runDir, RETAINED_ENVELOPE_POINTER);
}

function writePointer(runDir: string, base: string): void {
  const path = pointerPath(runDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ envelope_base: base }) + "\n");
  renameSync(tmp, path);
}

/** The envelope `runId` holds in retained custody, or null. */
export function retainedEnvelopeOfRun(runDir: string, runId: string): EnvelopeCustody | null {
  try {
    const pointer = JSON.parse(readFileSync(pointerPath(runDir), "utf8")) as {
      envelope_base?: unknown;
    };
    if (typeof pointer.envelope_base !== "string") return null;
    const custody = readEnvelopeCustody(pointer.envelope_base);
    return custody?.state === "retained" && custody.holder_run_id === runId ? custody : null;
  } catch {
    return null;
  }
}

/** Keep `env` for continuation under `holder` (custody first, then the
 * pointer: a crash in between leaves a retained envelope the sweeper keeps). */
export function retainForContinuation(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
  cause: ResumableCause | null,
): EnvelopeCustody {
  const custody = retainEnvelopeCustody(env, holder, cause);
  writePointer(holder.runDir, envelopeBaseOf(env));
  return custody;
}

/**
 * Hand a retained envelope to its `continueFrom` successor: the same envelope
 * (same path, base and files) now `live` under the successor, the crash-GC
 * owner marker re-stamped to this process, and the predecessor's pointer
 * dropped (its terminal facts stay; custody moved on). The caller verified
 * that the record's holder is the successor's predecessor.
 */
export function adoptRetainedEnvelope(
  custody: EnvelopeCustody,
  successor: { runId: string; runDir: string },
): WorkspaceEnvelope {
  const env = custody.envelope;
  const base = envelopeBaseOf(env);
  writeFileSync(
    join(base, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      started: processStartTime(process.pid),
      created_at: env.created_at,
      envelope_id: env.id,
      workspace_mode: "isolated",
      workspace_kind: env.workspace_kind,
      adopted_at: nowIso(),
    }) + "\n",
  );
  writeEnvelopeCustody(base, liveEnvelopeCustody(env, successor));
  rmSync(pointerPath(custody.holder_run_dir), { force: true });
  return env;
}

/** Explicit disposition of a retained envelope (discard, apply): custody and
 * pointer end first, so the run stops reporting it; disk cleanup follows. */
export async function releaseRetainedEnvelope(custody: EnvelopeCustody): Promise<void> {
  rmSync(pointerPath(custody.holder_run_dir), { force: true });
  releaseEnvelopeCustody(envelopeBaseOf(custody.envelope));
  await new WorkspaceManager(custody.envelope.repo_root).dispose(custody.envelope);
}

/**
 * Crash recovery of an ownerless envelope (the startup sweeper, before any new
 * work is accepted). `retained`: kept, its route-scoped auth stripped again.
 * `live` with a dead owner: the holder run was interrupted mid-attempt; a tree
 * that differs from its base, or has a session capsule, is retained (`host_restart`) when the
 * holder run's directory still exists. Anything else (`null`) is an ordinary
 * orphan the sweeper disposes as before.
 */
export async function recoverOrphanCustody(base: string): Promise<"kept" | "retained" | null> {
  const custody = readEnvelopeCustody(base);
  if (!custody) return null;
  if (custody.state === "retained") {
    stripRouteScopedAuth(custody.envelope);
    writePointer(custody.holder_run_dir, base);
    return "kept";
  }
  if (!existsSync(custody.holder_run_dir)) return null;
  if (
    !holderHasSession(custody.holder_run_dir) &&
    (await envelopeTreeChanged(custody.envelope)) !== true
  )
    return null;
  retainForContinuation(
    custody.envelope,
    { runId: custody.holder_run_id, runDir: custody.holder_run_dir },
    "host_restart",
  );
  return "retained";
}

function holderHasSession(runDir: string): boolean {
  const attempts = join(runDir, "attempts");
  try {
    return readdirSync(attempts).some((attempt) => {
      try {
        return SessionCapsule.safeParse(
          JSON.parse(readFileSync(join(attempts, attempt, "session-capsule.json"), "utf8")),
        ).success;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
