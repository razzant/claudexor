/**
 * Run-level view of retained envelopes: the pointer a holder run keeps to its
 * retained envelope, retention, adoption by a `continueFrom` successor, and
 * release (discard, apply, or the successor finishing). The custody record in
 * the envelope base is the authority (`envelope-custody.ts`); the run-dir
 * pointer is only its address, so an absent or stale pointer reads as
 * "nothing retained". Only the destructive owners (file GC, command pruning,
 * explicit discard) read strictly: an unreadable or invalid pointer or custody
 * record is reported to them, never read as nothing retained.
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
import { dirname, isAbsolute, join } from "node:path";
import {
  SessionCapsule,
  type EnvelopeCustody,
  type ResumableCause,
  type WorkspaceEnvelope,
} from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import {
  absentPath,
  envelopeBaseOf,
  envelopeTreeChanged,
  liveEnvelopeCustody,
  readEnvelopeCustody,
  readEnvelopeCustodyStrict,
  releaseEnvelopeCustody,
  retainEnvelopeCustody,
  stripRouteScopedAuth,
  writeEnvelopeCustody,
} from "./envelope-custody.js";
import { envelopeRuntimeRoot, processStartTime } from "./envelope-recovery.js";
import { WorkspaceManager } from "./manager.js";

/** Run-dir pointer to the run's retained envelope (address only). */
export const RETAINED_ENVELOPE_POINTER = "final/retained-envelope.json";

function pointerPath(runDir: string, attemptId?: string): string {
  return attemptId
    ? join(runDir, "attempts", attemptId, "retained-envelope.json")
    : join(runDir, RETAINED_ENVELOPE_POINTER);
}

function writePointer(runDir: string, base: string, attemptId?: string): void {
  const path = pointerPath(runDir, attemptId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ envelope_base: base }) + "\n");
  renameSync(tmp, path);
}

/** The address a pointer names, read strictly: an absent pointer (never
 * written, or removed by release) is null; an unreadable or invalid one,
 * including an empty or relative address (the writer records an absolute
 * envelope base), throws. */
function pointerBaseStrict(runDir: string, attemptId?: string): string | null {
  const path = pointerPath(runDir, attemptId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (absentPath(error)) return null;
    throw error;
  }
  let pointer: { envelope_base?: unknown } | null;
  try {
    pointer = JSON.parse(text) as { envelope_base?: unknown } | null;
  } catch (error) {
    throw new Error(
      `invalid retained-envelope pointer at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof pointer?.envelope_base !== "string")
    throw new Error(`invalid retained-envelope pointer at ${path}: envelope_base is missing`);
  if (!isAbsolute(pointer.envelope_base))
    throw new Error(`invalid retained-envelope pointer at ${path}: envelope_base is not absolute`);
  return pointer.envelope_base;
}

/** Address only: keep it observable even when custody is absent, no longer
 * retained, or the pointer itself cannot be read (projections never fail on it). */
export function retainedEnvelopeBase(runDir: string, attemptId?: string): string | null {
  try {
    return pointerBaseStrict(runDir, attemptId);
  } catch {
    return null;
  }
}

/** The envelope `runId` holds in retained custody, or null. */
export function retainedEnvelopeOfRun(runDir: string, runId: string): EnvelopeCustody | null {
  const base = retainedEnvelopeBase(runDir);
  const custody = base === null ? null : readEnvelopeCustody(base);
  return custody?.state === "retained" &&
    custody.holder_run_id === runId &&
    custody.continuation_eligible !== false
    ? custody
    : null;
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

/** Capture-refused source is addressed per envelope attempt, never by overwriting
 * the run's singular continuation pointer. Custody is durable before its address. */
export function retainForInspection(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
): EnvelopeCustody {
  const custody = retainEnvelopeCustody(env, holder, null, false);
  writePointer(holder.runDir, envelopeBaseOf(env), env.attempt_id);
  return custody;
}

/** Addressed inspection sources for GC/discard, read strictly: custody, not a
 * stale pointer, decides whether the source still belongs to this run (absent
 * pointer, released custody or another holder read as not held), while an
 * unreadable or invalid pointer or custody record throws to the caller. */
export function retainedInspectionEnvelopes(runDir: string, runId: string): EnvelopeCustody[] {
  const attempts = join(runDir, "attempts");
  if (!existsSync(attempts)) return [];
  const found = new Map<string, EnvelopeCustody>();
  for (const attempt of readdirSync(attempts)) {
    const base = pointerBaseStrict(runDir, attempt);
    const custody = base ? readEnvelopeCustodyStrict(base) : null;
    if (
      custody?.state === "retained" &&
      custody.holder_run_id === runId &&
      custody.continuation_eligible === false
    )
      found.set(custody.envelope.id, custody);
  }
  return [...found.values()];
}

/** Every source `runId` still holds, read strictly for a destructive owner:
 * its continuation singleton (same rule as `retainedEnvelopeOfRun`) and its
 * addressed inspection sources. Absent or stale addresses and released custody
 * read as nothing held; an unreadable or invalid pointer or custody record
 * throws, so the caller holds and reports instead of reading it as released. */
export function retainedSourcesOfRun(runDir: string, runId: string): EnvelopeCustody[] {
  const base = pointerBaseStrict(runDir);
  const custody = base === null ? null : readEnvelopeCustodyStrict(base);
  const singleton =
    custody?.state === "retained" &&
    custody.holder_run_id === runId &&
    custody.continuation_eligible !== false
      ? [custody]
      : [];
  const found = new Map<string, EnvelopeCustody>(
    [...singleton, ...retainedInspectionEnvelopes(runDir, runId)].map((source) => [
      source.envelope.id,
      source,
    ]),
  );
  return [...found.values()];
}

/** Automatic retention's question (file GC, command pruning): does the run
 * still hold a retained source? An unreadable or invalid address or custody
 * record holds the run and is reported, never read as nothing held. Explicit
 * discard reads the same strict sources and surfaces the failure itself. */
export function holdsRetainedSources(
  runDir: string,
  runId: string,
  report: (error: unknown) => void,
): boolean {
  try {
    return retainedSourcesOfRun(runDir, runId).length > 0;
  } catch (error) {
    report(error);
    return true;
  }
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
      // The same physical envelope and execution root: adoption never relocates it (#503).
      execution_root: env.repo_root,
      adopted_at: nowIso(),
    }) + "\n",
  );
  writeEnvelopeCustody(base, liveEnvelopeCustody(env, successor));
  if (retainedEnvelopeBase(custody.holder_run_dir) === envelopeBaseOf(custody.envelope))
    rmSync(pointerPath(custody.holder_run_dir), { force: true });
  return env;
}

/** Explicit disposition of a retained envelope (discard, apply): custody and
 * pointer end first, so the run stops reporting it; disk cleanup follows. */
export async function releaseRetainedEnvelope(custody: EnvelopeCustody): Promise<void> {
  if (retainedEnvelopeBase(custody.holder_run_dir) === envelopeBaseOf(custody.envelope))
    rmSync(pointerPath(custody.holder_run_dir), { force: true });
  if (custody.continuation_eligible === false)
    rmSync(pointerPath(custody.holder_run_dir, custody.envelope.attempt_id), { force: true });
  releaseEnvelopeCustody(envelopeBaseOf(custody.envelope));
  // Dispose where the envelope physically is: its recorded base names the namespace (#503).
  const runtimeRoot = envelopeRuntimeRoot(envelopeBaseOf(custody.envelope)) ?? undefined;
  await new WorkspaceManager(custody.envelope.repo_root, { runtimeRoot }).dispose(custody.envelope);
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
    writePointer(
      custody.holder_run_dir,
      base,
      custody.continuation_eligible === false ? custody.envelope.attempt_id : undefined,
    );
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
