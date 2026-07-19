import { z } from "zod";
import {
  AccessProfile,
  AuthPreference,
  FallbackReason,
  Id,
  IsoTimestamp,
  ModeKind,
  SchemaVersion,
} from "./primitives.js";
import { Attachment } from "./attachment.js";

/**
 * Threads / Sessions are the v0.9 chat/session-first SSOT.
 *
 * A `Thread` is a Claudexor-owned conversation about a project; runs are "turns"
 * (moves) inside it. A `Session` is the *vendor* CLI session bound to one harness
 * for one thread — a re-hostable CACHE, not the source of truth. When a turn
 * cannot resume the native session in place (isolated-envelope candidates,
 * race lanes included, or re-hosting onto a different harness) the engine
 * serializes a `SessionReboundLineage` and emits a typed `session.rebound`
 * event (honest, lossy disclosure — never silent).
 */

/** A thread is open, archived, in 30-day trash, or terminally purged.
 * "Blocked" is not a thread state — it is a live run projection. */
export const ThreadState = z
  .enum(["active", "closed", "trashed", "purged"])
  .describe("Thread lifecycle state: active, closed, trashed for recovery, or terminally purged.");
export type ThreadState = z.infer<typeof ThreadState>;

export const SessionState = z
  .enum(["live", "stale", "rebound"])
  .describe(
    "Vendor session cache state: live (resumable), stale, or rebound (re-hosted elsewhere).",
  );
export type SessionState = z.infer<typeof SessionState>;

/** How a session can be continued on its native CLI. Staged-field rule:
 * only values the daemon actually stamps (`resume_by_id` when a native
 * session id exists, `none` otherwise). */
export const SessionResumeKind = z
  .enum(["resume_by_id", "none"])
  .describe(
    "How the session can be continued on its native CLI: resume_by_id when a native session id exists, none otherwise.",
  );
export type SessionResumeKind = z.infer<typeof SessionResumeKind>;

export const ThreadTurnKind = z
  .enum(["initial", "followup", "decision"])
  .describe("Kind of thread turn: the initial message, a followup, or an operator decision turn.");
export type ThreadTurnKind = z.infer<typeof ThreadTurnKind>;

/**
 * Per-thread workspace mode (v0.10). `in_place` mutates the live project tree
 * directly (continuity is the tree itself; native vendor sessions resume); the
 * default, matching how Claude Code / Cursor work locally. `isolated` keeps a
 * persistent git worktree per thread; turns accumulate there and `apply` merges
 * into the project. Race candidates always run in throwaway envelopes regardless.
 */
export const WorkspaceMode = z
  .enum(["in_place", "isolated"])
  .describe(
    "Per-thread workspace mode: in_place mutates the live project tree directly (the default); isolated keeps a persistent git worktree per thread that apply merges into the project.",
  );
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

export const ThreadWorkspace = z
  .object({
    mode: WorkspaceMode.default("in_place"),
    /** Set lazily on the first write turn of an isolated thread. */
    worktree_path: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Persistent worktree path; set lazily on the first write turn of an isolated thread.",
      ),
    /** Snapshot SHA the isolated worktree (or last apply) is based on. */
    base_sha: z
      .string()
      .nullable()
      .default(null)
      .describe("Snapshot SHA the isolated worktree (or last apply) is based on."),
    delivered_through_run_id: Id.nullable()
      .default(null)
      .describe("Last run in the lineage prefix already delivered from this isolated thread."),
  })
  .describe("How the thread's turns touch files (in-place live tree vs isolated worktree).");
export type ThreadWorkspace = z.infer<typeof ThreadWorkspace>;

/** The Claudexor-owned conversation. SSOT for lineage; vendor sessions are caches. */
export const Thread = z
  .object({
    schema_version: SchemaVersion,
    id: Id.describe("Thread id."),
    created_at: IsoTimestamp.describe("When the thread was created."),
    updated_at: IsoTimestamp.describe("When the thread was last updated."),
    /** Project the thread is anchored to; null for a no-project Ask thread. */
    repo: z
      .object({
        root: z.string().describe("Absolute path of the project root."),
        base_ref: z.string().describe("Git ref the thread works against."),
      })
      .nullable()
      .default(null)
      .describe("Project the thread is anchored to; null for a no-project Ask thread."),
    title: z.string().nullable().default(null).describe("Thread title; null until set."),
    /** Default mode for new turns; individual turns may override. */
    mode: ModeKind.default("agent").describe(
      "Default mode for new turns; individual turns may override.",
    ),
    /** Per-thread auth preference override (subscription/api_key/auto). */
    auth_preference: AuthPreference.default("auto"),
    /** Sticky write scope for the thread's write turns (D26): a per-turn
     * selection wins; null = the repo's trust access_default. Read-only
     * intents are clamped to readonly by the engine regardless. */
    access: AccessProfile.nullable()
      .default(null)
      .describe(
        "Sticky write scope for write turns; per-turn selection wins, null = the repo trust default.",
      ),
    /** Sticky credential profile for the thread (INV-135): turns inherit it
     * unless they carry an explicit per-turn profile; null = engine default. */
    credential_profile_id: Id.nullable()
      .default(null)
      .describe(
        "Sticky credential profile for the thread; per-turn selection wins, null = engine-default credentials.",
      ),
    /** Sticky orchestrate/primary harness for the thread (re-routable). A bias /
     * ordering hint, NOT a privileged role — orderPool just pins it first. */
    primary_harness: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Sticky primary harness for the thread (re-routable); an ordering bias, not a privileged role.",
      ),
    /** Sticky eligible harness pool for the thread (Best-of runs this pool, one
     * candidate per harness). Empty => the engine auto-pools doctor-ok harnesses.
     * primary_harness, when set, must be a member of this pool when non-empty. */
    eligible_harnesses: z
      .array(z.string())
      .default([])
      .describe(
        "Sticky eligible harness pool for the thread (races run one candidate per pool member); empty = the engine auto-pools doctor-ok harnesses.",
      ),
    /** How turns touch files (in-place live tree vs isolated worktree). */
    workspace: ThreadWorkspace.default({}),
    /** Ordered run lineage (each run is a turn move). */
    run_ids: z.array(Id).default([]).describe("Ordered run lineage (each run is a turn move)."),
    head_run_id: Id.nullable()
      .default(null)
      .describe("Most recent run of the thread; null before the first turn runs."),
    state: ThreadState.default("active"),
    trashed_at: IsoTimestamp.nullable()
      .default(null)
      .describe("When the thread entered recoverable trash."),
    purge_after: IsoTimestamp.nullable()
      .default(null)
      .describe("Earliest automatic purge time; 30 days after trash."),
    pre_trash_state: z
      .enum(["active", "closed"])
      .nullable()
      .default(null)
      .describe("Lifecycle state restored while the trash retention window remains open."),
  })
  .describe(
    "The Claudexor-owned conversation about a project; runs are turns inside it. SSOT for lineage; vendor sessions are caches.",
  );
export type Thread = z.infer<typeof Thread>;

/** A re-hostable pointer to one harness's native CLI session for a thread. */
export const Session = z
  .object({
    id: Id.describe("Session id."),
    thread_id: Id.describe("Thread the session belongs to."),
    harness_id: Id.describe("Harness the session is bound to."),
    /** The vendor CLI session id (codex thread id / claude session uuid / ...). */
    native_session_id: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "The vendor CLI session id (codex thread id / claude session uuid / ...); null when none exists.",
      ),
    resume_kind: SessionResumeKind.default("none"),
    /** Credential profile the vendor session was created under (INV-135).
     * Resume must never cross profiles: a session recorded under profile A is
     * ineligible for a turn running as profile B (or as the null default). */
    profile_id: Id.nullable()
      .default(null)
      .describe(
        "Credential profile the vendor session was created under; resume never crosses profiles (null = engine-default credentials).",
      ),
    last_observed_model: z
      .string()
      .nullable()
      .default(null)
      .describe("Model last observed on the session's stream."),
    state: SessionState.default("live"),
    created_at: IsoTimestamp.describe("When the session was created."),
    updated_at: IsoTimestamp.describe("When the session was last updated."),
  })
  .describe(
    "A re-hostable pointer to one harness's native CLI session for a thread — a cache, not the source of truth.",
  );
export type Session = z.infer<typeof Session>;

/**
 * Well-known machine code for the trust-gate refusal (access=full without the
 * user-level allow). ONE producer — the engine's trust gate throw — and typed
 * consumers (the macOS one-click remedy keys on it; never substring matching
 * on the human message). New gates may attach their own codes without a
 * schema change: `code` is an open string by design.
 */
export const TRUST_FULL_ACCESS_CODE = "trust_full_access_required";

/**
 * Typed record of a turn whose run could not be enqueued/started (e.g. the
 * trust gate refused `access: full`). Persisted ON the turn so every surface
 * renders the honest refusal inline — a runless turn must never be a silent
 * orphan whose reason lived only in one HTTP response (INV-093). Cleared when
 * a retry binds a run.
 */
export const TurnEnqueueError = z
  .object({
    message: z.string().describe("Human-readable refusal message."),
    /** Machine-readable refusal code carried from the throwing gate (e.g.
     * TRUST_FULL_ACCESS_CODE); null when the failure had no typed code. */
    code: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Machine-readable refusal code carried from the throwing gate; null when the failure had no typed code.",
      ),
    /** Whether retry can REPLAY this turn: true when a job was recorded before
     * the failure (the registry holds the params to replay); false when the
     * enqueue itself threw and no job exists — surfaces then offer "send a new
     * message" instead of a doomed Retry. */
    retryable: z
      .boolean()
      .default(true)
      .describe(
        "True when retry can replay this turn (a job was recorded before the failure); false when no job exists to replay.",
      ),
    failed_at: IsoTimestamp.describe("When the enqueue failed."),
  })
  .describe(
    "Typed record of a turn whose run could not be enqueued/started, persisted on the turn so every surface renders the refusal inline; cleared when a retry binds a run.",
  );
export type TurnEnqueueError = z.infer<typeof TurnEnqueueError>;

/** One follow-up unit within a thread (a run is its backing execution). */
export const ThreadTurn = z
  .object({
    id: Id.describe("Turn id."),
    thread_id: Id.describe("Thread the turn belongs to."),
    run_id: Id.nullable().default(null).describe("Run backing this turn; null while unbound."),
    parent_run_id: Id.nullable().default(null).describe("Run this turn follows up on, when any."),
    /** Set when this turn implements an approved plan from an earlier plan run. */
    plan_run_id: Id.nullable()
      .default(null)
      .describe("Set when this turn implements an approved plan from an earlier plan run."),
    kind: ThreadTurnKind.default("followup"),
    prompt: z.string().default("").describe("The user's message for this turn."),
    /** Files/images the user attached to this turn (resolved scoped paths). */
    attachments: z
      .array(Attachment)
      .default([])
      .describe("Files/images the user attached to this turn (resolved scoped paths)."),
    /** Why this turn has no run (enqueue/preflight refusal); null once a run binds. */
    enqueue_error: TurnEnqueueError.nullable()
      .default(null)
      .describe("Why this turn has no run (enqueue/preflight refusal); null once a run binds."),
    created_at: IsoTimestamp.describe("When the turn was created."),
  })
  .describe("One follow-up unit within a thread; a run is its backing execution.");
export type ThreadTurn = z.infer<typeof ThreadTurn>;

/**
 * The lossy payload serialized when a turn cannot resume the native session
 * in place: isolated-envelope candidates (race lanes included) and re-hosting
 * onto a different harness (no native memory of the old session). Carried by
 * the typed `session.rebound` event; the disclosure is explicit, never silent.
 */
export const SessionReboundLineage = z
  .object({
    thread_id: Id.describe("Thread whose session was re-hosted."),
    harness_id: Id.describe("Harness the new session runs on."),
    /** The vendor native session id we are leaving behind (not a Claudexor Id). */
    from_native_session_id: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "The vendor native session id being left behind (not a Claudexor id); null when none existed.",
      ),
    to_session_id: Id.nullable()
      .default(null)
      .describe("New Claudexor session id; null when no new session was created."),
    summary: z
      .string()
      .default("")
      .describe("Carried-over conversation summary injected into the new session."),
    reason: FallbackReason.default("not_portable"),
  })
  .describe(
    "The lossy payload serialized when a turn cannot resume the native session in place (isolated candidates or re-hosting onto a different harness); carried by the session.rebound event.",
  );
export type SessionReboundLineage = z.infer<typeof SessionReboundLineage>;
