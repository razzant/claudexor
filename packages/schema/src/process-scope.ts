import { z } from "zod/v3";

/**
 * The run's process-scope outcome: who the whole-run terminal barrier found
 * still carrying the run's scope marker, and what became of them. Written once
 * to `final/process_scope.yaml` as its OWN artifact so it survives the later
 * rewrites and projections the immutable RunFacts receipt goes through — a
 * finished run must always be able to say what it left running.
 *
 * It is a DISCLOSURE, never a verdict axis: a non-empty survivor set or a
 * Windows `tree_only` coverage never flips a succeeded run into a failure
 * (INV-116 is untouched). Environment bytes are never recorded — pid, measured
 * birth token and a short reason only.
 */
export const RunProcessScopeMember = z
  .object({
    pid: z.number().int().positive(),
    start_token: z
      .string()
      .min(1)
      .describe("Measured kernel birth token the member was ended under."),
  })
  .strict();
export type RunProcessScopeMember = z.infer<typeof RunProcessScopeMember>;

export const RunProcessScopeUnreadable = z
  .object({
    pid: z.number().int().positive(),
    reason: z.string().min(1).describe("Why a known member could not be read (never env bytes)."),
  })
  .strict();
export type RunProcessScopeUnreadable = z.infer<typeof RunProcessScopeUnreadable>;

export const RunProcessScopeOutcome = z
  .object({
    marker: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*_SCOPE_[0-9a-f]{32}$/)
      .describe("The run's scope marker NAME (the value is always 1; never persisted)."),
    coverage: z
      .enum(["marker+capture", "marker", "tree_only"])
      .describe(
        "marker+capture: environment census plus the daemon's recorded descendants/process groups (POSIX with the daemon index); marker: environment census only (an embedder without the index); tree_only: no environment census exists on this host (Windows), the parent-chain tree kill ran instead.",
      ),
    census: z
      .enum(["ok", "failed", "unsupported"])
      .describe(
        "ok: a census completed; failed: the process table could not be read; unsupported: no census on this platform.",
      ),
    census_failure: z.string().nullable().default(null),
    restricted: z
      .boolean()
      .default(false)
      .describe(
        "The platform withholds some processes' environments from the census (macOS SIP hides Apple platform-binary environments), so an empty census cannot exclude a hidden platform-binary leftover — a disclosed residual, never a failure.",
      ),
    ended: z
      .array(RunProcessScopeMember)
      .default([])
      .describe("Members found alive and proven gone."),
    survivors: z
      .array(RunProcessScopeMember)
      .default([])
      .describe("Members still alive under their recorded identity when the bounded ladder ended."),
    unreadable: z
      .array(RunProcessScopeUnreadable)
      .default([])
      .describe(
        "Known members whose identity or membership could not be read; never signalled unverified.",
      ),
    reused_groups: z
      .array(z.number().int().positive())
      .default([])
      .describe(
        "Recorded process groups skipped entirely because the pgid-reuse rule failed; disclosed, never signalled. Another birth at the id proves the recorded group gone; any other skip (no floor, an unreadable birth, a member older than the scope, a leader that cannot be told) also lists its possibly owned live members in `unreadable`, so the scope does not settle.",
      ),
    settled: z
      .boolean()
      .describe(
        "True only when every census source succeeded and no known member survived or stayed unreadable. Unreadable discovery candidates are not members; they limit completeness separately.",
      ),
    completeness: z
      .enum(["complete", "not_provable"])
      .default("not_provable")
      .describe(
        "Whether a settled reap proves the scope empty: complete only where the census reads every same-uid environment (Linux) and every source succeeded; not_provable on macOS (SIP hides platform-binary environments, so a system binary started in the background by a shell that exited before capture cannot be ruled out), on Windows, after any census failure, and for an incomplete settlement (the single deadline expired: `incomplete` is true and completeness_reason names the deadline).",
      ),
    completeness_reason: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Why the scope is not provably empty (null when complete): the census failure, the expired settlement deadline, the macOS platform-binary limit, or the unreadable same-uid count.",
      ),
    incomplete: z
      .boolean()
      .default(false)
      .describe(
        "The single settlement deadline expired before every source was read: scanning and signalling stopped at that moment and what is known is disclosed; never a verdict.",
      ),
  })
  .strict()
  .describe("What the whole-run terminal barrier found carrying the run's scope marker, and did.");
export type RunProcessScopeOutcome = z.infer<typeof RunProcessScopeOutcome>;

/**
 * A later, separately bounded settlement attempt of a FINISHED run's scope
 * (INV-144, #613), written beside the historical terminal record, never over
 * it: `final/process_scope_later.yaml`, the latest attempt only. Its own fresh
 * census and identity proof under its own budget; it never extends the expired
 * terminal attempt.
 */
export const RunProcessScopeLater = z
  .object({
    attempt: z.number().int().positive().describe("Later attempts made by the owning daemon."),
    at: z.string().min(1).describe("When this attempt finished (ISO-8601)."),
    outcome: RunProcessScopeOutcome,
  })
  .strict()
  .describe("Latest later settlement attempt of a finished run's process scope.");
export type RunProcessScopeLater = z.infer<typeof RunProcessScopeLater>;
