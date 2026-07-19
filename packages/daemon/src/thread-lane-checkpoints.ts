import type { ContinuityDisclosure, LaneCheckpoint, Session, ThreadTurn } from "@claudexor/schema";
import {
  ContinuityDisclosure as ContinuityDisclosureSchema,
  LaneCheckpoint as LaneCheckpointSchema,
  Session as SessionSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import { newId, nowIso } from "@claudexor/util";

/**
 * Pure lane-checkpoint helpers (INV-137). Extracted from `threads.ts` so the
 * store file stays under the new-file complexity cap (INV-124); the ThreadStore
 * owns journaling/commit, these just build + query the checkpoint rows.
 *
 * A lane is a (thread, harness, profile) triple; its checkpoint is the last turn
 * it has SEEN (it produced it, or a continuation packet hydrated it up to there).
 */

/** Composite lane id `<thread>::<harness>::<profileOrDefault>` — the row identity. */
export function laneId(threadId: string, harnessId: string, profileId: string | null): string {
  return `${threadId}::${harnessId}::${profileId ?? "default"}`;
}

/** Build (and validate) a checkpoint row advancing a lane to `turnId`. */
export function makeLaneCheckpoint(
  threadId: string,
  harnessId: string,
  profileId: string | null,
  turnId: string,
): LaneCheckpoint {
  return LaneCheckpointSchema.parse({
    id: laneId(threadId, harnessId, profileId),
    thread_id: threadId,
    harness_id: harnessId,
    profile_id: profileId,
    turn_id: turnId,
    updated_at: nowIso(),
  });
}

/** The last turn a lane has seen, or null when the lane never ran. */
export function findLaneCheckpoint(
  checkpoints: readonly LaneCheckpoint[],
  threadId: string,
  harnessId: string,
  profileId: string | null,
): string | null {
  const id = laneId(threadId, harnessId, profileId);
  return checkpoints.find((c) => c.id === id)?.turn_id ?? null;
}

/** All lane checkpoints of a thread (to locate the prior head's lane). */
export function threadLaneCheckpoints(
  checkpoints: readonly LaneCheckpoint[],
  threadId: string,
): LaneCheckpoint[] {
  return checkpoints.filter((c) => c.thread_id === threadId);
}

/** Stamp a turn's continuity disclosure (validated), returning the next turn. */
export function stampContinuity(turn: ThreadTurn, disclosure: ContinuityDisclosure): ThreadTurn {
  return ThreadTurnSchema.parse({
    ...turn,
    continuity: ContinuityDisclosureSchema.parse(disclosure),
  });
}

/**
 * Native resume map for a thread (INV-135): harnessId -> {sessionId, profile}.
 * Resume never crosses credential profiles — a session recorded under one
 * profile (or the null engine default) is eligible ONLY for a turn running as
 * exactly that profile; the entry carries its profile so the engine boundary
 * re-verifies against the RESOLVED profile (preflight rotation may differ).
 */
export function resumeMapFrom(
  sessions: readonly Session[],
  threadId: string,
  profileId: string | null,
): Record<string, { sessionId: string; profileId: string | null }> {
  const map: Record<string, { sessionId: string; profileId: string | null }> = {};
  for (const s of sessions) {
    if (
      s.thread_id === threadId &&
      s.state === "live" &&
      s.native_session_id &&
      (s.profile_id ?? null) === profileId
    ) {
      map[s.harness_id] = { sessionId: s.native_session_id, profileId: s.profile_id ?? null };
    }
  }
  return map;
}

/** Mark a session row stale (its profile was deleted): drop the resumable id. */
export function staleSession(session: Session): Session {
  return SessionSchema.parse({
    ...session,
    native_session_id: null,
    resume_kind: "none",
    state: "stale",
    updated_at: nowIso(),
  });
}

/**
 * Build (and validate) the native-session row a harness emitted, keyed by
 * (thread, harness, PROFILE) so profile B's session never overwrites A's row
 * (an A→B→A sequence resumes A's own native conversation; the null engine
 * default is its own row). `existing` is the current row for that lane, if any.
 */
export function makeSessionRecord(
  existing: Session | undefined,
  threadId: string,
  harnessId: string,
  nativeSessionId: string,
  observedModel: string | null | undefined,
  profileId: string | null,
): Session {
  const now = nowIso();
  return SessionSchema.parse({
    ...(existing ?? {
      id: newId("se"),
      thread_id: threadId,
      harness_id: harnessId,
      created_at: now,
    }),
    profile_id: profileId,
    native_session_id: nativeSessionId,
    last_observed_model: observedModel || existing?.last_observed_model || null,
    resume_kind: "resume_by_id",
    state: "live",
    updated_at: now,
  });
}
