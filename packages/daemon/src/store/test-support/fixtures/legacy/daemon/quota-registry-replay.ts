import type { DurableJournal } from "../journal/index.js";
import { hashJson } from "../util/index.js";
import {
  AccountResourcesInvalidated,
  AccountResourcesObserved,
  QuotaSnapshot as QuotaSnapshotSchema,
  QuotaWindowObservation,
  QuotaWindowSupersession,
  type QuotaSnapshot,
  type AccountResourceObservation,
  type AccountTarget,
} from "../schema/index.js";
import { legacyV320Snapshot } from "./quota-registry-support.js";
export const RESOURCES_INVALIDATED = "quota.resources.invalidated";
export const RESOURCES_OBSERVED = "quota.resources.observed";
const UPSERTED = "quota.snapshot.upserted";
const WINDOW_OBSERVED = "quota.window.observed";
export const WINDOW_SUPERSEDED = "quota.window.superseded";
const SCOPED_PREPARED = "quota.snapshot.scoped_prepared";
export const REMOVED = "quota.subject.removed";
export const PROJECTION_UPDATED = "quota.projection.updated";
const REPLAY_TYPES = [
  RESOURCES_OBSERVED,
  RESOURCES_INVALIDATED,
  SCOPED_PREPARED,
  UPSERTED,
  WINDOW_OBSERVED,
  WINDOW_SUPERSEDED,
  REMOVED,
  PROJECTION_UPDATED,
];

/** Replay is part of QuotaRegistry's existing journal projection, not another store. */
export function replayQuotaJournal(
  journal: DurableJournal,
  owner: {
    apply: (snapshot: QuotaSnapshot) => void;
    applyWindowSupersession: (value: QuotaWindowSupersession) => void;
    applyResources: (value: AccountResourceObservation) => void;
    invalidateResources: (target: AccountTarget, at: string) => void;
    remove: (harness: string, id: string | null, resources: boolean) => void;
  },
) {
  let projectionSignature: string | null = null;
  let rawMutationAfterMarker = false;
  let pendingScoped: { seq: number; baseHash: string; snapshot: QuotaSnapshot } | null = null;
  for (const record of journal.records(0, REPLAY_TYPES)) {
    // Filtering must not make a formerly interrupted pair adjacent.
    if (pendingScoped && record.seq !== pendingScoped.seq + 1) pendingScoped = null;
    if (record.type === SCOPED_PREPARED) {
      const payload =
        typeof record.payload === "object" &&
        record.payload !== null &&
        !Array.isArray(record.payload)
          ? (record.payload as {
              version?: unknown;
              base_hash?: unknown;
              snapshot?: unknown;
            })
          : {};
      const snapshot = QuotaSnapshotSchema.safeParse(payload.snapshot);
      pendingScoped =
        payload.version === 1 && typeof payload.base_hash === "string" && snapshot.success
          ? {
              seq: record.seq,
              baseHash: payload.base_hash,
              snapshot: snapshot.data,
            }
          : null;
      continue;
    }
    if (record.type === UPSERTED) {
      const base = QuotaSnapshotSchema.parse(record.payload);
      const baseHash = hashJson(base);
      const committedScoped =
        pendingScoped !== null &&
        pendingScoped.baseHash === baseHash &&
        hashJson(legacyV320Snapshot(pendingScoped.snapshot)) === baseHash
          ? pendingScoped.snapshot
          : null;
      owner.apply(committedScoped ?? base);
      pendingScoped = null;
      rawMutationAfterMarker = true;
      continue;
    }
    // A scoped prepare commits only through the immediately following
    // matching legacy upsert. If the writer stopped or another record
    // intervened, ignore the incomplete prepare on replay.
    pendingScoped = null;
    if (record.type === RESOURCES_INVALIDATED) {
      const value = AccountResourcesInvalidated.parse(record.payload);
      owner.invalidateResources(value.target, value.observed_at);
      rawMutationAfterMarker = true;
      continue;
    }
    if (record.type === RESOURCES_OBSERVED) {
      const { observation } = AccountResourcesObserved.parse(record.payload);
      owner.applyResources(observation);
      rawMutationAfterMarker = true;
      continue;
    }
    if (record.type === WINDOW_OBSERVED) {
      owner.apply(QuotaWindowObservation.parse(record.payload).snapshot);
      rawMutationAfterMarker = true;
      continue;
    }
    if (record.type === WINDOW_SUPERSEDED) {
      owner.applyWindowSupersession(QuotaWindowSupersession.parse(record.payload));
      rawMutationAfterMarker = true;
      continue;
    }
    if (record.type === REMOVED) {
      const payload = record.payload as {
        harness?: unknown;
        subject_id?: unknown;
        preserve_resources?: boolean;
      };
      // subject_id is null for a harness's default/native subject, which is
      // exactly the one a revocation retirement can name.
      if (
        typeof payload.harness === "string" &&
        (typeof payload.subject_id === "string" || payload.subject_id === null)
      ) {
        owner.remove(payload.harness, payload.subject_id, payload.preserve_resources !== true);
      }
      rawMutationAfterMarker = true;
    }
    if (record.type === PROJECTION_UPDATED) {
      const payload = record.payload as { projection_signature?: unknown };
      projectionSignature =
        typeof payload.projection_signature === "string" ? payload.projection_signature : null;
      rawMutationAfterMarker = false;
    }
  }
  return { rawMutationAfterMarker, projectionSignature };
}
