import { z } from "zod/v3";

/**
 * Reasoning-effort vocabulary: the open wire type and the ONE owner of every
 * derived lookup (per-model narrowing, ladder merging, untyped-surface schema,
 * help text). Split out of harness.ts because effort is its own contract with
 * its own consumers — adapters, the CLI, the MCP tool schema and the macOS
 * picker all resolve through here rather than copying a level list.
 *
 * There is deliberately NO static rank table here. Vendors already return
 * their effort levels ORDERED weakest→strongest (codex `model/list` →
 * `supportedReasoningEfforts` is an ordered array per model; `claude --help`
 * prints the `--effort` values in order), and that order is part of the parsed
 * vendor response. Ordering authority is therefore the vendor's own advertised
 * sequence: a model's ladder is its own ordered list, a harness's ladder is
 * the positional merge of its models' lists (`mergeEffortLadders`), and a
 * level's rank is its position in that merged list. A second, hand-maintained
 * copy of that knowledge can only ever disagree with the first.
 */

/** Longest effort slug accepted on the wire. */
export const EFFORT_HINT_MAX_LENGTH = 32;
/** Lowercase slug shape: `low`, `xhigh`, `ultra`, `super-max`, `turbo_2`. */
export const EFFORT_HINT_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/**
 * OPEN cross-harness reasoning-effort vocabulary — deliberately a bounded slug,
 * not an enum, mirroring the vendor contract (codex's own generated schema types
 * `ReasoningEffort` as "a non-empty reasoning effort value advertised by the
 * model"). Adapters advertise the subset they actually accept per (harness,
 * model); the shared normalizer passes an advertised level through verbatim,
 * clamps an unadvertised-but-mergeable one onto the nearest advertised level
 * inside the vendor's own order, and REFUSES a level the merged ladder has
 * never seen — so a vendor level newer than this repo works with no code
 * change, and a typo is never silently downgraded.
 */
export const EffortHint = z
  .string()
  .min(1)
  .max(EFFORT_HINT_MAX_LENGTH)
  .regex(
    EFFORT_HINT_PATTERN,
    "effort must be a lowercase slug (letters, digits, single - or _ separators)",
  )
  .describe(
    "Cross-harness reasoning-effort level as a lowercase slug (open vocabulary, mirroring the vendor contract); adapters advertise the levels they accept per model, ordered weakest to strongest by the vendor itself, and a shared normalizer passes advertised levels through, clamps inside the vendor order, and refuses levels the advertised ladder has never seen.",
  );
export type EffortHint = z.infer<typeof EffortHint>;

/** What one model advertises: its ordered effort vocabulary and vendor default. */
export const ModelEffortCapability = z
  .object({
    levels: z
      .array(EffortHint)
      .default([])
      .describe(
        "Ordered (weakest to strongest) reasoning-effort levels this model advertises, in the vendor's own order.",
      ),
    default: EffortHint.nullable()
      .default(null)
      .describe("The effort level the vendor uses for this model when none is requested."),
  })
  .strict()
  .describe("Reasoning-effort vocabulary a single model advertises.");
export type ModelEffortCapability = z.infer<typeof ModelEffortCapability>;

/**
 * How every surface describes the effort vocabulary in help and refusal text.
 * ONE owner (INV-122) so no CLI string hand-copies a level list — and it
 * deliberately names NO levels of its own: the real answer is per (harness,
 * model), lives in the manifest, and is ordered by the vendor. Surfaces that
 * know the resolved harness/model name the actual advertised set instead.
 */
export const EFFORT_HINT_HELP =
  "reasoning-effort level the resolved harness/model advertises " +
  "(a lowercase slug; each vendor lists its own levels, weakest to strongest)";

/**
 * JSON-Schema fragment for an effort value on UNTYPED surfaces (the MCP tool
 * schema). ONE owner (INV-121/122): the bounds come from the same constants the
 * zod SSOT enforces, so no surface hand-copies a level list — and, critically,
 * the surface stays as OPEN as the vendor contract. Pinning an enum here would
 * reject a level a model genuinely advertises, which is the bug this design
 * exists to prevent.
 *
 * The guidance is `EFFORT_HINT_HELP`, the SAME string the CLI renders, so an MCP
 * client and a `--effort` refusal describe the vocabulary identically.
 */
export function effortJsonSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: EFFORT_HINT_MAX_LENGTH,
    pattern: EFFORT_HINT_PATTERN.source,
    description: `${description} Expects a ${EFFORT_HINT_HELP}; an advertised level is passed through as-is.`,
  };
}

/**
 * The effort vocabulary advertised for one (harness, model) pair. ONE owner for
 * the per-model narrowing (INV-122): the model's own advertised list when the
 * probe recorded one, else the harness-wide merged ladder. Every surface that
 * needs to know "what efforts may this run use" resolves through here.
 */
export function effortLevelsForModel(
  capabilities: {
    effort_levels: readonly EffortHint[];
    model_effort_levels: Record<string, ModelEffortCapability>;
  },
  model: string | null | undefined,
): readonly EffortHint[] {
  const id = typeof model === "string" ? model.trim() : "";
  const advertised = id ? capabilities.model_effort_levels[id]?.levels : undefined;
  return advertised && advertised.length > 0 ? advertised : capabilities.effort_levels;
}

/** Result of merging several vendor-ordered effort ladders into one. */
export interface MergedEffortLadder {
  /**
   * The merged RANK order, weakest→strongest, honoring every input list's own
   * order when they are mutually consistent. It carries ONLY levels some input
   * list actually ordered against a neighbor; a level no list constrains lives
   * in `unconstrained` instead. When the inputs are NOT consistent
   * (`consistent` false), this is a first-seen deduplication — usable as a
   * display set, never as a rank authority.
   */
  order: EffortHint[];
  /**
   * Levels that appear in some input list but share NO ordering constraint
   * with any other level (each came only from single-level lists). Their
   * position is UNKNOWN, not maximal: the old behavior let a plain topological
   * tail place `medium` ABOVE `high` in a merge of ["low","high"] and
   * ["medium"], silently making the unconstrained level the strongest rank.
   * They stay advertised (membership, pickers), but clamping to or from them
   * refuses with disclosure — exactly like the inconsistent case — because any
   * rank for them would be invented.
   */
  unconstrained: EffortHint[];
  /**
   * False when two input lists genuinely contradict each other's relative
   * order (`a` before `b` in one, `b` before `a` in another). Cross-model
   * clamping is then IMPOSSIBLE for the affected harness — there is no honest
   * rank to clamp along — and consumers must refuse with disclosure rather
   * than invent an order (see `resolveEffort`'s ladder argument).
   */
  consistent: boolean;
}

/**
 * Positional merge of vendor-ordered effort ladders — the ONE owner of
 * cross-model effort ordering (INV-122). Each input list is treated as a chain
 * of ordering constraints exactly as the vendor advertised it; the merge is a
 * stable topological sort (ties break on first appearance across the inputs),
 * so a set of lists that are prefixes/subsets of one another merge into the
 * longest ladder, and a brand-new vendor level lands at its vendor-advertised
 * position with no code change here.
 *
 * A level that carries NO ordering constraint at all (it only ever appears in
 * single-level lists) has an UNKNOWN position, not a maximal one: a plain
 * topological tail would park it after everything else and accidentally crown
 * it the strongest rank (merging ["low","high"] with ["medium"] used to yield
 * medium ABOVE high). Such levels are returned separately as `unconstrained`
 * — advertised but unrankable — so no consumer can clamp along a position the
 * vendor never stated. (Disconnected multi-level chains remain approximated
 * by first-seen tie-breaking, as before.)
 *
 * The Swift side orders its pickers by merging the manifest's already-ordered
 * `effort_levels`/`model_effort_levels` arrays the same way (`EffortLadder`,
 * display ordering only — Swift never clamps, so it keeps the flat merge).
 */
export function mergeEffortLadders(
  lists: ReadonlyArray<readonly EffortHint[]>,
): MergedEffortLadder {
  const firstSeen: EffortHint[] = [];
  const successors = new Map<EffortHint, Set<EffortHint>>();
  const indegree = new Map<EffortHint, number>();
  const constrained = new Set<EffortHint>();
  for (const list of lists) {
    for (const level of list) {
      if (!indegree.has(level)) {
        indegree.set(level, 0);
        successors.set(level, new Set());
        firstSeen.push(level);
      }
    }
    for (let i = 1; i < list.length; i += 1) {
      const before = list[i - 1] as EffortHint;
      const after = list[i] as EffortHint;
      if (before === after) continue;
      constrained.add(before);
      constrained.add(after);
      const outs = successors.get(before) as Set<EffortHint>;
      if (!outs.has(after)) {
        outs.add(after);
        indegree.set(after, (indegree.get(after) ?? 0) + 1);
      }
    }
  }
  // Every edge connects two constrained levels, so excluding the unconstrained
  // ones from the sort cannot change any indegree.
  const ranked = firstSeen.filter((level) => constrained.has(level));
  const unconstrained = firstSeen.filter((level) => !constrained.has(level));
  const order: EffortHint[] = [];
  const emitted = new Set<EffortHint>();
  while (emitted.size < ranked.length) {
    const next = ranked.find((level) => !emitted.has(level) && indegree.get(level) === 0);
    if (next === undefined) {
      // A cycle: the vendors' own orders contradict each other. Do not invent
      // an order — fall back to first-seen for display and say so.
      return {
        order: [...order, ...ranked.filter((level) => !emitted.has(level))],
        unconstrained,
        consistent: false,
      };
    }
    emitted.add(next);
    order.push(next);
    for (const succ of successors.get(next) ?? []) {
      indegree.set(succ, (indegree.get(succ) ?? 1) - 1);
    }
  }
  return { order, unconstrained, consistent: true };
}
