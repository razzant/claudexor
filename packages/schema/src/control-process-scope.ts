import { z } from "zod/v3";

/** The run's process-scope outcome, compact (counts, not pids) for the run summary. */
export const ControlProcessScope = z
  .object({
    settled: z
      .boolean()
      .describe(
        "Every census source succeeded and no known member survived or stayed unreadable. Unreadable discovery candidates are not members; they limit completeness separately.",
      ),
    coverage: z.enum(["marker+capture", "marker", "tree_only"]),
    completeness: z
      .enum(["complete", "not_provable"])
      .describe(
        "Whether a settled reap proves the scope empty (not on macOS for background system binaries, not on Windows, not after a census failure, not when the single settlement deadline expired — then settled is false and the run's final/process_scope.yaml carries incomplete=true with completeness_reason naming the deadline).",
      ),
    census: z.enum(["ok", "failed", "unsupported"]),
    survivors: z
      .number()
      .int()
      .nonnegative()
      .describe("Members still alive when the bounded ladder ended."),
    unreadable: z
      .number()
      .int()
      .nonnegative()
      .describe("Known members whose identity or membership could not be read."),
  })
  .strict()
  .describe(
    "Compact process-scope outcome of a terminal run (full artifact: final/process_scope.yaml).",
  );
export type ControlProcessScope = z.infer<typeof ControlProcessScope>;

/**
 * `ControlRunSummary.processScope`: projected from the run's
 * final/process_scope.yaml. An engine that has the field always sends the
 * property: the compact outcome for a terminal run whose record is readable and
 * valid, otherwise an explicit null — UNKNOWN, never clean (the run is live, its
 * record was never written or could not be, or it is unreadable or invalid).
 * `.default(null)` only fills a missing input, so the generated JSON Schema
 * lists the property as optional; engines that predate the field omit the key,
 * which is equally unknown.
 */
export const ControlRunSummaryProcessScope = ControlProcessScope.nullable()
  .default(null)
  .describe(
    "Compact process-scope outcome from final/process_scope.yaml (settled, coverage, completeness, survivors, unreadable, census). Always present in this engine's responses: null means unknown (the run is live, or the record is missing, unreadable or invalid), never clean. Engines that predate the field omit the key, which is equally unknown.",
  );

/**
 * `ControlRunSummary.processScopeLater`: the latest later settlement attempt
 * (final/process_scope_later.yaml) beside the unchanged terminal record. Null
 * when none ran or its record is unreadable: unknown, never clean.
 */
export const ControlRunSummaryProcessScopeLater = ControlProcessScope.extend({
  attempt: z.number().int().positive(),
  at: z.string().min(1),
})
  .strict()
  .nullable()
  .default(null)
  .describe(
    "Latest later, separately bounded settlement attempt of this finished run's scope (final/process_scope_later.yaml), beside the unchanged terminal processScope. Null when none ran or it is unreadable: unknown, never clean.",
  );
