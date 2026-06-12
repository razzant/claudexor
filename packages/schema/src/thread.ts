import { z } from "zod";
import {
  AuthPreference,
  FallbackReason,
  Id,
  IsoTimestamp,
  ModeKind,
  ProviderFamily,
  SchemaVersion,
} from "./primitives.js";
import { AuthMode, Portfolio } from "./budget.js";

/**
 * Threads / Sessions are the v0.9 chat/session-first SSOT.
 *
 * A `Thread` is a Claudexor-owned conversation about a project; runs are "turns"
 * (moves) inside it. A `Session` is the *vendor* CLI session bound to one harness
 * for one thread — a re-hostable CACHE, not the source of truth. When a thread
 * moves to another harness the engine serializes a `SessionReboundLineage` and
 * emits a typed `session.rebound` event (honest, lossy disclosure — never silent).
 */

export const ThreadState = z.enum(["active", "blocked", "closed"]);
export type ThreadState = z.infer<typeof ThreadState>;

export const SessionState = z.enum(["live", "stale", "rebound"]);
export type SessionState = z.infer<typeof SessionState>;

/** How a session can be continued on its native CLI. */
export const SessionResumeKind = z.enum(["resume_by_id", "resume_latest", "rehost", "none"]);
export type SessionResumeKind = z.infer<typeof SessionResumeKind>;

export const ThreadTurnKind = z.enum(["initial", "followup", "decision", "orchestrate"]);
export type ThreadTurnKind = z.infer<typeof ThreadTurnKind>;

/** The Claudexor-owned conversation. SSOT for lineage; vendor sessions are caches. */
export const Thread = z.object({
  schema_version: SchemaVersion,
  id: Id,
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  /** Project the thread is anchored to; null for a no-project Ask thread. */
  repo: z
    .object({ root: z.string(), base_ref: z.string() })
    .nullable()
    .default(null),
  title: z.string().nullable().default(null),
  /** Default mode for new turns; individual turns may override. */
  mode: ModeKind.default("agent"),
  /** Per-thread auth preference override (subscription/api_key/auto). */
  auth_preference: AuthPreference.default("auto"),
  /** Sticky orchestrate/primary harness for the thread (re-routable). */
  primary_harness: z.string().nullable().default(null),
  portfolio: Portfolio.default("subscription-first"),
  /** Ordered run lineage (each run is a turn move). */
  run_ids: z.array(Id).default([]),
  head_run_id: Id.nullable().default(null),
  state: ThreadState.default("active"),
});
export type Thread = z.infer<typeof Thread>;

/** A re-hostable pointer to one harness's native CLI session for a thread. */
export const Session = z.object({
  id: Id,
  thread_id: Id,
  harness_id: Id,
  provider_family: ProviderFamily.default("unknown"),
  /** The vendor CLI session id (codex thread id / claude session uuid / ...). */
  native_session_id: z.string().nullable().default(null),
  auth_mode: AuthMode.default("unknown"),
  resume_kind: SessionResumeKind.default("none"),
  last_attempt_id: Id.nullable().default(null),
  last_observed_model: z.string().nullable().default(null),
  state: SessionState.default("live"),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
});
export type Session = z.infer<typeof Session>;

/** One follow-up unit within a thread (a run is its backing execution). */
export const ThreadTurn = z.object({
  id: Id,
  thread_id: Id,
  run_id: Id.nullable().default(null),
  parent_run_id: Id.nullable().default(null),
  session_id: Id.nullable().default(null),
  kind: ThreadTurnKind.default("followup"),
  prompt: z.string().default(""),
  created_at: IsoTimestamp,
});
export type ThreadTurn = z.infer<typeof ThreadTurn>;

/**
 * The lossy payload serialized when a thread re-hosts onto a different harness
 * (the new harness has no native memory of the old session). Carried by the
 * typed `session.rebound` event; the disclosure is explicit, never silent.
 */
export const SessionReboundLineage = z.object({
  thread_id: Id,
  harness_id: Id,
  from_session_id: Id.nullable().default(null),
  to_session_id: Id.nullable().default(null),
  summary: z.string().default(""),
  contract_ref: z.string().nullable().default(null),
  open_tasks: z.array(z.string()).default([]),
  diff_state: z.string().nullable().default(null),
  reason: FallbackReason.default("manual"),
});
export type SessionReboundLineage = z.infer<typeof SessionReboundLineage>;
