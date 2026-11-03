/**
 * Exact thread export and conditional retirement. One schema-defined producer
 * (the engine) and the in-repo `claudexor thread export|retire` consumer; a
 * host that keeps the bundle speaks the same contract. Catalog presence of
 * `POST /v2/threads/:id/retire` is the feature marker (INV-138).
 */
import { z } from "zod/v3";
import { sha256 } from "@claudexor/util";
import { Id, IsoTimestamp } from "./primitives.js";
import { ControlHandshakeResponse } from "./operation.js";
import { ThreadRetirementAcceptance, ThreadState, WorkspaceMode } from "./thread.js";

export const THREAD_EXPORT_SCHEMA_VERSION = 1;
const storeId = ControlHandshakeResponse.shape.storeId.unwrap();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();

/** Every reason a closure is held back. Any gap makes the export partial and
 * forbids retirement; an unknown state never becomes an empty success. */
export const ThreadExportGapCode = z.enum([
  "closure_not_quiescent",
  "closure_awaiting_decision",
  "closure_partition_unavailable",
  "command_record_not_retained",
  "run_directory_missing",
  "run_files_expired",
  "run_tree_unreadable",
  "run_observations_unreadable",
  "attachment_unavailable",
  "native_session_unattributed",
  "native_session_unsupported",
  "native_format_unqualified",
  "native_session_missing",
  "native_session_unreadable",
  "native_projection_failed",
  "lane_unreadable",
  "lane_credentials_undeclared",
  "isolated_worktree_present",
]);
export type ThreadExportGapCode = z.infer<typeof ThreadExportGapCode>;

export const ThreadExportGap = z
  .object({
    code: ThreadExportGapCode,
    subject: z.string().min(1).describe("The exact run, session, path or lane this gap names."),
    message: z.string().min(1),
  })
  .strict();
export type ThreadExportGap = z.infer<typeof ThreadExportGap>;

export const ThreadExportItemPlane = z
  .enum(["sql", "run", "native", "lane", "resource", "projection"])
  .describe(
    "sql: engine records; run: the run tree; native: vendor session material; lane: the thread's lane directory (what retirement deletes); resource: attachment bytes; projection: decoded text of a compressed original, kept beside it.",
  );
export type ThreadExportItemPlane = z.infer<typeof ThreadExportItemPlane>;

export const ThreadExportItemKind = z
  .enum(["file", "symlink", "special", "credential_store"])
  .describe(
    "file: exact bytes to transfer. symlink: recorded, never followed. special: a FIFO or socket, recorded. credential_store: an exact engine or vendor credential path, never opened or exported.",
  );
export type ThreadExportItemKind = z.infer<typeof ThreadExportItemKind>;

export const ThreadExportItem = z
  .object({
    itemId: z.string().regex(/^i[0-9a-f]{32}$/),
    plane: ThreadExportItemPlane,
    path: z
      .string()
      .min(1)
      .describe(
        "Relative POSIX path: the item's complete name and, with its plane, its identity; distinct copies stay distinct. A volume may be unable to name it, so a consumer may keep the bytes elsewhere and record that place.",
      ),
    kind: ThreadExportItemKind,
    sizeBytes: count.nullable(),
    mtimeMs: z.number().nullable(),
    sha256: digest
      .nullable()
      .describe(
        "Known before transfer for engine records, attachments, projections and symlink text; otherwise the transfer's ETag.",
      ),
    projectionOf: z.string().nullable().describe("The itemId this projection decodes."),
    linkTarget: z.string().nullable().describe("A symlink's own text; its target is never read."),
  })
  .strict();
export type ThreadExportItem = z.infer<typeof ThreadExportItem>;

export const ThreadExportSessionSource = z.enum([
  "attempt_event",
  "run_event",
  "reviewer_stream",
  "session_capsule",
  "run_resumable",
  "thread_session",
]);
export const ThreadExportSession = z
  .object({
    harness: z.string().min(1),
    nativeSessionId: z.string().min(1),
    status: z.enum(["exported", "missing", "unsupported", "unqualified", "unreadable"]),
    provenance: z.array(
      z
        .object({
          source: ThreadExportSessionSource,
          runId: z.string().nullable(),
          attemptId: z.string().nullable(),
          profileId: z.string().nullable().describe("Null when the record names no profile."),
          cwd: z.string().nullable(),
        })
        .strict(),
    ),
    copies: z
      .array(z.object({ storeKey: z.string().min(1), profileId: z.string().nullable() }).strict())
      .describe("Every store holding material of this exact session."),
  })
  .strict();
export type ThreadExportSession = z.infer<typeof ThreadExportSession>;

export const ThreadExportManifest = z
  .object({
    schemaVersion: z.literal(THREAD_EXPORT_SCHEMA_VERSION),
    storeId,
    threadId: Id,
    exportId: digest.describe("Identity of this closure, inventory and gap list."),
    closureDigest: digest.describe("Identity of the closure's engine records alone."),
    threadState: ThreadState,
    headRevision: count,
    workspaceMode: WorkspaceMode,
    coverage: z.enum(["complete", "partial"]).describe("complete exactly when gaps is empty."),
    retirable: z.boolean().describe("Retirement can be requested for this manifest."),
    gaps: z.array(ThreadExportGap),
    disclosures: z
      .array(
        z
          .object({
            harness: z.string().min(1),
            source: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .describe(
        "Known vendor state outside this export because no record binds it to these sessions. Named so it is never mistaken for covered; it does not block retirement.",
      ),
    closure: z
      .object({
        turns: z.array(
          z
            .object({
              turnId: Id,
              ordinal: count,
              runId: z.string().nullable(),
              promptSha256: z.string(),
            })
            .strict(),
        ),
        runs: z.array(
          z
            .object({
              jobId: z.string(),
              runId: z.string().nullable(),
              state: z.string(),
              kind: z.string(),
              threadId: z.string().nullable(),
              turnId: z.string().nullable(),
              continueFrom: z.string().nullable(),
              delegatedFrom: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    sessions: z.array(ThreadExportSession),
    items: z.array(ThreadExportItem),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.coverage === "complete") !== (value.gaps.length === 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "coverage disagrees with gaps" });
    if (value.retirable && value.coverage !== "complete")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a partial export cannot retire" });
  });
export type ThreadExportManifest = z.infer<typeof ThreadExportManifest>;

/** Written last by the consumer: what it received and verified, item by item. */
export const ThreadExportReceipt = z
  .object({
    schemaVersion: z.literal(THREAD_EXPORT_SCHEMA_VERSION),
    storeId,
    threadId: Id,
    exportId: digest,
    closureDigest: digest,
    contentDigest: digest,
    laneDigest: digest,
    coverage: z.enum(["complete", "partial"]),
    retirable: z.boolean(),
    transferred: z.array(
      z
        .object({
          itemId: z.string(),
          path: z.string().describe("The item's complete manifest path."),
          placedAt: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Where in this bundle the bytes are, when its volume cannot name `path`. Absent: at `path`.",
            ),
          sizeBytes: count,
          sha256: digest,
        })
        .strict(),
    ),
  })
  .strict();
export type ThreadExportReceipt = z.infer<typeof ThreadExportReceipt>;

export const ThreadRetireRequest = z
  .object({
    operationId: Id.describe(
      "The caller's durable release intent. Exactly one outcome is ever bound to it.",
    ),
    exportId: digest,
    closureDigest: digest,
    contentDigest: digest.describe("threadExportDigest over every byte the caller received."),
    laneDigest: digest.describe("threadExportDigest over the lane plane of the same transfer."),
  })
  .strict();
export type ThreadRetireRequest = z.infer<typeof ThreadRetireRequest>;

export const ThreadRetireAbandonRequest = z
  .object({ operationId: Id })
  .strict()
  .describe("Settle an unanswered operation: it can never be accepted after this returns.");
export type ThreadRetireAbandonRequest = z.infer<typeof ThreadRetireAbandonRequest>;

export const ThreadRetirementOperation = z
  .object({
    operationId: Id,
    outcome: z.enum(["accepted", "refused", "abandoned"]),
    code: z.string().nullable().describe("The refusal's code; null when accepted or abandoned."),
    message: z.string().nullable(),
    settledAt: IsoTimestamp,
  })
  .strict()
  .describe("The one outcome bound to this operation; an absent record settles nothing.");
export type ThreadRetirementOperation = z.infer<typeof ThreadRetirementOperation>;

export const ThreadRetirement = z
  .object({
    schemaVersion: z.literal(THREAD_EXPORT_SCHEMA_VERSION),
    storeId,
    threadId: Id,
    threadState: ThreadState,
    status: z
      .enum(["not_accepted", "accepted_pending_removal", "removed"])
      .describe(
        "accepted_pending_removal: durably purged; the named originals can no longer be promised back while cleanup is open. removed: every directory the purge owner deletes is gone.",
      ),
    acceptance: ThreadRetirementAcceptance.nullable(),
    cleanup: z
      .object({ reason: z.string().nullable() })
      .strict()
      .nullable()
      .describe("Present while removal is open; reason names the last failed attempt."),
    operation: ThreadRetirementOperation.nullable().describe(
      "The addressed operation's settled outcome. Null means no outcome is bound yet: an in-flight request may still settle it, so null never releases a caller's intent.",
    ),
  })
  .strict();
export type ThreadRetirement = z.infer<typeof ThreadRetirement>;

/** One item's exact identity in a digest: what a consumer received, or what the
 * engine read from disk. Acceptance keeps the lane's entries so its cleanup can
 * delete only bytes the export holds. */
export interface ThreadExportDigestEntry {
  itemId: string;
  sha256: string;
  sizeBytes: number;
}

/** Stable across reads of the same inventory, so a resumed transfer keeps its work. */
export function threadExportItemId(plane: ThreadExportItemPlane, path: string): string {
  return `i${sha256(`${plane}\0${path}`).slice("sha256:".length, "sha256:".length + 32)}`;
}

/**
 * The one digest formula: `<itemId> <sha256 hex> <size>\n` per file or symlink,
 * ordered by itemId bytes, hashed as UTF-8. A consumer computes it from what it
 * received; the engine from what is on disk at acceptance. They agree only when
 * those bytes are the same.
 */
export function threadExportDigest(entries: readonly ThreadExportDigestEntry[]): string {
  const lines = entries.map(
    ({ itemId, sha256: hash, sizeBytes }) =>
      `${itemId} ${hash.slice("sha256:".length)} ${sizeBytes}\n`,
  );
  return sha256(lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(""));
}

/** A symlink's digest identity: its own text, since its target is never read. */
export function threadExportLinkIdentity(target: string): { sha256: string; sizeBytes: number } {
  return { sha256: sha256(target), sizeBytes: Buffer.byteLength(target) };
}
