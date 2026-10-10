import type {
  ContinuityDisclosure,
  LaneCheckpoint,
  Session,
  Thread,
  ThreadTurn,
} from "@claudexor/schema";
import {
  ContinuityDisclosure as ContinuityDisclosureSchema,
  LaneCheckpoint as LaneCheckpointSchema,
  Session as SessionSchema,
  Thread as ThreadSchema,
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

/**
 * The thread's durable per-harness ACCOUNT BINDINGS (unified account model,
 * D-U1 order 2): the account an UNPINNED turn stays on — derived from the
 * lane evidence the thread already persists (its latest live session, else
 * its latest lane checkpoint, per harness), never a second hand-maintained
 * record. Null-profile lanes (unmigrated legacy state) bind nothing.
 */
export function accountBindingsFrom(
  sessions: readonly Session[],
  checkpoints: readonly LaneCheckpoint[],
  threadId: string,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  const freshest: Record<string, string> = {};
  const consider = (harnessId: string, profileId: string | null, updatedAt: string): void => {
    if (!profileId) return;
    const seen = freshest[harnessId];
    if (seen !== undefined && seen >= updatedAt) return;
    freshest[harnessId] = updatedAt;
    bindings[harnessId] = profileId;
  };
  for (const s of sessions) {
    if (s.thread_id !== threadId || s.state !== "live") continue;
    consider(s.harness_id, s.profile_id ?? null, s.updated_at);
  }
  for (const c of checkpoints) {
    if (c.thread_id !== threadId) continue;
    consider(c.harness_id, c.profile_id ?? null, c.updated_at);
  }
  return bindings;
}

/**
 * Native resume map for an UNPINNED thread turn: the latest live session per
 * harness REGARDLESS of profile. Each entry carries its own profile, and the
 * engine boundary (`resumeSessionForProfile`) re-verifies it against the
 * RESOLVED account, so a pool switch away from the recorded account starts
 * fresh instead of crossing profiles (INV-135/137).
 */
export function resumeMapAutoFrom(
  sessions: readonly Session[],
  threadId: string,
): Record<string, { sessionId: string; profileId: string | null }> {
  const map: Record<string, { sessionId: string; profileId: string | null }> = {};
  const freshest: Record<string, string> = {};
  for (const s of sessions) {
    if (s.thread_id !== threadId || s.state !== "live" || !s.native_session_id) continue;
    const seen = freshest[s.harness_id];
    if (seen !== undefined && seen >= s.updated_at) continue;
    freshest[s.harness_id] = s.updated_at;
    map[s.harness_id] = { sessionId: s.native_session_id, profileId: s.profile_id ?? null };
  }
  return map;
}

/**
 * Unified-accounts migration mutation (INV-137, one unit with the lane-home
 * rename): live sessions recorded under the null engine-default subject are
 * rewritten IN PLACE onto the auto-registered row id, and every
 * `<thread>::<harness>::default` lane checkpoint gains a row under the new
 * lane id (the legacy row stays inert — exact-id lookups never see it).
 * Idempotent: a second run finds no null sessions and no missing checkpoints.
 * A row-lane checkpoint that already exists is never moved backwards (a crash
 * between phases followed by new turns may have advanced it) — but a BEHIND
 * row checkpoint advances forward to the ::default lane's turn: a rollback
 * leaves the old row-lane checkpoint in place while new turns advance the
 * default lane, and resuming the stale checkpoint on re-migration would
 * re-inject context the lane already saw. Recency is judged by updated_at,
 * the only ordering evidence at this layer.
 */
export function migrateNullProfileContinuityMutation(
  sessions: readonly Session[],
  checkpoints: readonly LaneCheckpoint[],
  harnessId: string,
  rowId: string,
): { sessions: Session[]; checkpoints: LaneCheckpoint[] } {
  const now = nowIso();
  const migratedSessions = sessions
    .filter((s) => s.harness_id === harnessId && (s.profile_id ?? null) === null)
    .map((s) => SessionSchema.parse({ ...s, profile_id: rowId, updated_at: now }));
  const migratedCheckpoints: LaneCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.harness_id !== harnessId || (checkpoint.profile_id ?? null) !== null) continue;
    const migrated = makeLaneCheckpoint(checkpoint.thread_id, harnessId, rowId, checkpoint.turn_id);
    const existing = checkpoints.find((c) => c.id === migrated.id);
    if (existing) {
      const behind =
        existing.turn_id !== checkpoint.turn_id && existing.updated_at < checkpoint.updated_at;
      if (behind) migratedCheckpoints.push(migrated);
      continue;
    }
    migratedCheckpoints.push(migrated);
  }
  return { sessions: migratedSessions, checkpoints: migratedCheckpoints };
}

/**
 * The supported downgrade path's reverse of the migration mutation: sessions
 * recorded under the migrated row id return to the null engine-default
 * subject a legacy engine resumes, and each row-lane checkpoint re-seeds the
 * `::default` lane id at its turn.
 */
export function rollbackProfileContinuityMutation(
  sessions: readonly Session[],
  checkpoints: readonly LaneCheckpoint[],
  harnessId: string,
  rowId: string,
): { sessions: Session[]; checkpoints: LaneCheckpoint[] } {
  const now = nowIso();
  const rolledSessions = sessions
    .filter((s) => s.harness_id === harnessId && s.profile_id === rowId)
    .map((s) => SessionSchema.parse({ ...s, profile_id: null, updated_at: now }));
  const rolledCheckpoints: LaneCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.harness_id !== harnessId || checkpoint.profile_id !== rowId) continue;
    rolledCheckpoints.push(
      makeLaneCheckpoint(checkpoint.thread_id, harnessId, null, checkpoint.turn_id),
    );
  }
  return { sessions: rolledSessions, checkpoints: rolledCheckpoints };
}

/**
 * Credential-profile deletion mutation (INV-135): clear every matching scalar
 * thread pin (pins predate a harness discriminator, so any harness's pin at
 * the id clears rather than leave an unrunnable route) and stale the deleted
 * account's live sessions.
 */
export function invalidateCredentialProfileMutation(
  threads: readonly Thread[],
  sessions: readonly Session[],
  harnessId: string,
  profileId: string,
): { threads: Thread[]; sessions: Session[] } {
  const now = nowIso();
  return {
    threads: threads
      .filter((thread) => thread.credential_profile_id === profileId)
      .map((thread) =>
        ThreadSchema.parse({ ...thread, credential_profile_id: null, updated_at: now }),
      ),
    sessions: sessions
      .filter(
        (session) =>
          session.harness_id === harnessId &&
          session.profile_id === profileId &&
          session.state === "live",
      )
      .map(staleSession),
  };
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
