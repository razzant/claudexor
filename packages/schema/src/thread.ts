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
import { Portfolio } from "./budget.js";
import { Attachment } from "./attachment.js";

/**
 * Threads / Sessions are the v0.9 chat/session-first SSOT.
 *
 * A `Thread` is a Claudexor-owned conversation about a project; runs are "turns"
 * (moves) inside it. A `Session` is the *vendor* CLI session bound to one harness
 * for one thread — a re-hostable CACHE, not the source of truth. When a thread
 * moves to another harness the engine serializes a `SessionReboundLineage` and
 * emits a typed `session.rebound` event (honest, lossy disclosure — never silent).
 */

/** A thread is open or explicitly closed (archived). "Blocked" is not a thread
 * state — it is a live projection of whether the head turn's run needs a human. */
export const ThreadState = z.enum(["active", "closed"]);
export type ThreadState = z.infer<typeof ThreadState>;

export const SessionState = z.enum(["live", "stale", "rebound"]);
export type SessionState = z.infer<typeof SessionState>;

/** How a session can be continued on its native CLI. */
export const SessionResumeKind = z.enum(["resume_by_id", "resume_latest", "rehost", "none"]);
export type SessionResumeKind = z.infer<typeof SessionResumeKind>;

export const ThreadTurnKind = z.enum(["initial", "followup", "decision"]);
export type ThreadTurnKind = z.infer<typeof ThreadTurnKind>;

/**
 * Per-thread workspace mode (v0.10). `in_place` mutates the live project tree
 * directly (continuity is the tree itself; native vendor sessions resume); the
 * default, matching how Claude Code / Cursor work locally. `isolated` keeps a
 * persistent git worktree per thread; turns accumulate there and `apply` merges
 * into the project. Race candidates always run in throwaway envelopes regardless.
 */
export const WorkspaceMode = z.enum(["in_place", "isolated"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

export const ThreadWorkspace = z.object({
  mode: WorkspaceMode.default("in_place"),
  /** Set lazily on the first write turn of an isolated thread. */
  worktree_path: z.string().nullable().default(null),
  /** Snapshot SHA the isolated worktree (or last apply) is based on. */
  base_sha: z.string().nullable().default(null),
});
export type ThreadWorkspace = z.infer<typeof ThreadWorkspace>;

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
  /** Sticky orchestrate/primary harness for the thread (re-routable). A bias /
   * ordering hint, NOT a privileged role — orderPool just pins it first. */
  primary_harness: z.string().nullable().default(null),
  /** Sticky eligible harness pool for the thread (Race runs this pool, one
   * candidate per harness). Empty => the engine auto-pools doctor-ok harnesses.
   * primary_harness, when set, must be a member of this pool when non-empty. */
  eligible_harnesses: z.array(z.string()).default([]),
  /** How turns touch files (in-place live tree vs isolated worktree). */
  workspace: ThreadWorkspace.default({}),
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
  /** The vendor CLI session id (codex thread id / claude session uuid / ...). */
  native_session_id: z.string().nullable().default(null),
  resume_kind: SessionResumeKind.default("none"),
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
  /** Set when this turn implements an approved plan from an earlier plan run. */
  plan_run_id: Id.nullable().default(null),
  kind: ThreadTurnKind.default("followup"),
  prompt: z.string().default(""),
  /** Files/images the user attached to this turn (resolved scoped paths). */
  attachments: z.array(Attachment).default([]),
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
  /** The vendor native session id we are leaving behind (not a Claudexor Id). */
  from_native_session_id: z.string().nullable().default(null),
  to_session_id: Id.nullable().default(null),
  summary: z.string().default(""),
  reason: FallbackReason.default("not_portable"),
});
export type SessionReboundLineage = z.infer<typeof SessionReboundLineage>;
