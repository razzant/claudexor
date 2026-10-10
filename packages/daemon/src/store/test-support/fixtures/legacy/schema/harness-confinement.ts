import { z } from "zod/v3";
import { RecordedAccessProfile } from "./primitives.js";

/** One schema-owned statement used by every new delegated mutating attempt. */
export const DELIBERATE_NO_OUTER_BOUNDARY_REASON =
  "Claudexor deliberately applies no additional outer OS filesystem boundary; the native harness access mode remains in effect.";

/**
 * The confinement half of an attempt record, as every reader sees it.
 *
 * Deliberately NOT a zod object: this is the projection shape shared by the
 * orchestrator (which writes it) and the control API (which reads the written
 * artifact back), and the artifact itself is untyped YAML from a possibly older
 * engine — so the fields arrive as `unknown` and the predicate below is the one
 * place that decides what they mean.
 */
export interface AppliedConfinementRecord {
  confinement_mechanism?: unknown;
  confinement_profile_digest?: unknown;
  confinement_verified_denied_path?: unknown;
  /** Why NO boundary was applied; present exactly when the boundary is absent. */
  confinement_unavailable_reason?: unknown;
}

/** Bounded decoder for the access/evidence block in historical attempt.yaml
 * artifacts. New writers still accept active AccessProfile only. */
export const RecordedAppliedAttemptFacts = z
  .object({
    harness_home_isolated: z.boolean().optional(),
    harness_home_dir: z.string().nullable(),
    access_applied: RecordedAccessProfile,
    credential_profile_applied: z.string().nullable(),
    confinement_mechanism: z.string().nullable(),
    confinement_profile_digest: z.string().nullable(),
    confinement_verified_denied_path: z.string().nullable(),
    confinement_unavailable_reason: z.string().nullable(),
  })
  .passthrough()
  .describe("Applied access and boundary evidence read from a historical attempt artifact.");
export type RecordedAppliedAttemptFacts = z.infer<typeof RecordedAppliedAttemptFacts>;

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/**
 * Whether an attempt record proves a boundary was actually enforced.
 *
 * ONE owner, because the answer is load-bearing in two codebases: a mechanism
 * named WITHOUT the path it was proven to deny is exactly the bare promise the
 * applied-fact block exists to replace, so it reads as NO boundary. An external
 * orchestrator asks this question and nothing else — never the platform, never
 * the mechanism's name.
 */
export function confinementBoundaryProven(record: AppliedConfinementRecord | null): boolean {
  if (!record) return false;
  return (
    nonEmpty(record.confinement_mechanism) &&
    nonEmpty(record.confinement_profile_digest) &&
    nonEmpty(record.confinement_verified_denied_path)
  );
}

export const ContainmentKind = z
  .enum([
    "env_or_file_injection",
    "scoped_home_keychain_bridge",
    "private_per_profile_keychain",
    "host_user_context",
    "process_sandbox",
    "container",
  ])
  .describe(
    "Isolation containment level an adapter supports for run environments, from env/file injection through scoped-HOME keychain bridging or a private per-profile keychain to process sandboxes and containers.",
  );
export type ContainmentKind = z.infer<typeof ContainmentKind>;

export const IsolationCapabilities = z
  .object({
    supported_containment: z
      .array(ContainmentKind)
      .default(["env_or_file_injection"])
      .describe("Containment mechanisms the adapter can run under."),
  })
  .default({})
  .describe("Declared isolation containment facts for a harness.");
export type IsolationCapabilities = z.infer<typeof IsolationCapabilities>;
