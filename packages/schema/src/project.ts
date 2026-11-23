import { z } from "zod/v3";
import { ControlHandshakeResponse } from "./operation.js";
import { Id, IsoTimestamp, SchemaVersion } from "./primitives.js";

/** Durable v2 registration for a local project root. */
export const Project = z
  .object({
    schema_version: SchemaVersion,
    id: Id.describe("Stable Claudexor project id."),
    root: z.string().min(1).describe("Canonical absolute project root."),
    created_at: IsoTimestamp.describe("When the project was first registered."),
    updated_at: IsoTimestamp.describe("When the project link was last updated."),
  })
  .strict()
  .describe("A durable v2 project registration; v1 state is never imported implicitly.");
export type Project = z.infer<typeof Project>;

/** A non-refusing nesting relation between two registered projects (F3,
 * INV-137): `inside` = this project's root lives under `root`; `contains` =
 * `root` (another project) lives under this one. Legit monorepos nest, so this
 * is DISCLOSURE only — surfaces show "nested inside <root>" so an owner is not
 * confused by overlapping roots (e.g. robot_journey inside racing4). */
export const ProjectNesting = z
  .object({
    relation: z.enum(["inside", "contains"]).describe("How this project overlaps the other."),
    root: z.string().min(1).describe("The other registered project's root."),
    projectId: Id.describe("The other registered project's id."),
  })
  .strict()
  .describe("A disclosed (never refused) nesting relation with another registered project.");
export type ProjectNesting = z.infer<typeof ProjectNesting>;

export const ControlProject = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    root: z.string().min(1),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
    nesting: z
      .array(ProjectNesting)
      .default([])
      .describe(
        "Disclosed nesting relations with other registered projects (F3) — informational, never a refusal.",
      ),
  })
  .strict()
  .describe("Control API projection of a registered project.");
export type ControlProject = z.infer<typeof ControlProject>;

/** `POST /v2/projects` answer: the project plus whether THIS registration made it. */
export const ControlProjectRegisterResponse = ControlProject.extend({
  storeId: ControlHandshakeResponse.shape.storeId.describe(
    "Durable store serving this registration. Returned on store identity opt-in when known.",
  ),
  created: z
    .boolean()
    .describe(
      "True when this registration created the project; false when the root was already registered. An Idempotency-Key replay retains that key's creation provenance.",
    ),
})
  .strict()
  .describe("A registered project and whether this registration created it.");
export type ControlProjectRegisterResponse = z.infer<typeof ControlProjectRegisterResponse>;

/** The exact pair a paired-custody caller must quote back: the durable store it
 * registered on and the canonical root the registration named. A caller that
 * cannot reproduce this pair never owned the record it is asking about. */
export const ControlProjectBinding = z
  .object({
    expectedStoreId: ControlHandshakeResponse.shape.storeId.unwrap(),
    expectedRoot: ControlProject.shape.root,
  })
  .strict();
export type ControlProjectBinding = z.infer<typeof ControlProjectBinding>;

const boundRegistration = z
  .object({
    projectId: Id,
    storeId: ControlHandshakeResponse.shape.storeId.unwrap(),
    root: ControlProject.shape.root.describe(
      "Observed canonical root, or the requested root when absent.",
    ),
  })
  .strict();

/** `GET /v2/projects/:id/registration` — the paired-custody address probe. `absent`
 * covers archived, missing and never-existed rows alike: it is a state, never an
 * existence oracle, and it never distinguishes whose release archived the row. */
export const ControlProjectRegistrationState = boundRegistration.extend({
  state: z.enum(["present", "absent"]),
  candidateMatch: z
    .enum(["same", "different", "unknown"])
    .optional()
    .describe(
      "Present only when the probe named a candidate folder and the registration is present. same: the candidate is the registration's recorded folder (equal spelling, or resolved to it by the registry's own canonicalization, or the two directories' filesystem identity proves them one). different: the candidate resolved to another directory AND the two directories' own identity proves them distinct — a mere string difference is never enough, and no case normalization is promised on any volume. unknown: the comparison cannot be decided now (unresolvable candidate or unavailable identity evidence); never treated as different. The resolved form is never returned.",
    ),
});
export type ControlProjectRegistrationState = z.infer<typeof ControlProjectRegistrationState>;

/** `POST /v2/projects/:id/release` — the confirming side's one bound archival.
 * `released` marks the single transition; every later call answers `absent`. */
export const ControlProjectReleaseReceipt = boundRegistration.extend({
  state: z.enum(["released", "absent"]),
});
export type ControlProjectReleaseReceipt = z.infer<typeof ControlProjectReleaseReceipt>;

export const ControlProjectListResponse = z.object({ projects: z.array(ControlProject) }).strict();
export type ControlProjectListResponse = z.infer<typeof ControlProjectListResponse>;

export const ControlProjectRegisterRequest = z.object({ root: z.string().min(1) }).strict();
export type ControlProjectRegisterRequest = z.infer<typeof ControlProjectRegisterRequest>;

export const ControlProjectRelinkRequest = z.object({ root: z.string().min(1) }).strict();
export type ControlProjectRelinkRequest = z.infer<typeof ControlProjectRelinkRequest>;

export const ControlDirectoryEntry = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(["directory", "file"]),
    readable: z.boolean(),
  })
  .strict();
export type ControlDirectoryEntry = z.infer<typeof ControlDirectoryEntry>;

export const ControlDirectoryListing = z
  .object({
    path: z.string().min(1),
    home: z.string().min(1),
    parent: z.string().min(1).nullable(),
    entries: z.array(ControlDirectoryEntry).max(1_000),
    truncated: z
      .boolean()
      .describe("True when more actionable entries existed than the bounded response contains."),
  })
  .strict()
  .describe("A home-contained server directory listing for the remote project picker.");
export type ControlDirectoryListing = z.infer<typeof ControlDirectoryListing>;

/** The exact `trashedThreads` query opt-in of DELETE /v2/projects/:id (#333). */
export const ControlProjectRemoveTrashedThreads = z
  .enum(["purge"])
  .describe(
    "purge: also purge the threads already in the project's trash, in the same removal. Omission keeps the default refusal while any non-purged thread remains.",
  );
export type ControlProjectRemoveTrashedThreads = z.infer<typeof ControlProjectRemoveTrashedThreads>;

/** One trashed thread purged by an opted-in project removal (#333). The purge
 * is committed with the removal; its directory cleanup is reported separately. */
export const ControlProjectPurgedThread = z
  .object({
    threadId: Id.describe("The thread that was in the project's trash and is now purged."),
    cleanup: z
      .enum(["completed", "pending"])
      .describe(
        "completed: every directory the thread purge owns is deleted. pending: the purge is committed but that deletion did not finish; the engine retries it when the daemon next starts.",
      ),
    cleanupError: z
      .string()
      .nullable()
      .describe("Why the deletion did not finish; null when cleanup completed."),
  })
  .strict()
  .describe("A trashed thread purged together with its project.");
export type ControlProjectPurgedThread = z.infer<typeof ControlProjectPurgedThread>;

/**
 * Receipt for DELETE /v2/projects/:id (QA-049). Removing a durable project
 * retires the global-registry entry and ARCHIVES the project's journal
 * partition (renamed out of the active journal tree — never deleted — the same
 * non-destructive move the partition-quarantine path uses). Run artifact trees
 * are left in place for normal GC/retention; remove never deletes them or the
 * user's project directory. Refused with a typed 409 while any non-purged
 * thread or live/queued run still references the project; with the explicit
 * `trashedThreads=purge` opt-in, threads already in the trash are purged in the
 * same transaction instead (#333).
 */
export const ControlProjectRemoveReceipt = z
  .object({
    projectId: Id.describe("The retired project's stable id."),
    root: z.string().min(1).describe("The project's canonical root at removal time."),
    registryRemoved: z
      .literal(true)
      .describe("The durable global-registry entry (and its indexes) were removed."),
    journalPartitionArchived: z
      .boolean()
      .describe(
        "Whether the project's journal partition directory was archived (renamed out of the active journal tree). False only when the partition never materialized on disk.",
      ),
    archivedPartitionPath: z
      .string()
      .nullable()
      .describe(
        "Absolute path the partition journal was archived to, or null when there was no partition directory to archive.",
      ),
    artifactsRetained: z
      .literal(true)
      .describe(
        "Run artifact trees are left in place for normal GC/retention — remove never deletes run bytes or the user's project directory.",
      ),
    activeRunCheck: z
      .literal("snapshot")
      .describe(
        "How the live/queued-run fence was evaluated. Always 'snapshot': the daemon reads its in-process activity projection and removes the project in the same synchronous turn, with no await between the snapshot and registry/partition mutation.",
      ),
    purgedThreads: z
      .array(ControlProjectPurgedThread)
      .optional()
      .describe(
        "Present only when the request opted in with trashedThreads=purge: every thread that was in the project's trash, purged in the same store transaction that retired the project. Absent on a default removal.",
      ),
  })
  .strict()
  .describe(
    "DELETE /v2/projects/:id receipt: registry entry removed, journal partition archived, artifacts left to GC.",
  );
export type ControlProjectRemoveReceipt = z.infer<typeof ControlProjectRemoveReceipt>;

/** The one caller remedy for the typed `project_not_registered` refusal (404):
 * the daemon raises it and the control API preserves it on the wire; both
 * transports carry the safe requiredActions alongside code/status/retryable. */
export const PROJECT_NOT_REGISTERED_REQUIRED_ACTIONS: readonly string[] = [
  'Register the root with POST /v2/projects {"root": …} (Idempotency-Key required), or declare scope.ephemeral=true for a one-shot tree.',
];
