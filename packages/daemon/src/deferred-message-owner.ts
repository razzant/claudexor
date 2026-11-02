import type {
  CapturedRunStart,
  DeferredMessageDetail,
  DeferredMessageHold,
  DeferredMessageMutation,
  DeferredMessageProjection,
  DeferredMessageReceipt,
} from "@claudexor/schema";
import type { JobRecord } from "./job-record.js";
import { delegatedParentOf } from "@claudexor/schema";

/** This operation belongs to an ordinary launching controller. An engine
 * Delegate child has a bounded parent-owned lifetime, never a deferred one. */
export function assertDeferredOperator(beltContext: boolean, targetParams?: unknown): void {
  if (beltContext || delegatedParentOf(targetParams))
    throw Object.assign(
      new Error(
        "the delegation belt and Delegate children cannot reserve or launch deferred messages",
      ),
      {
        code: "delegation_forbidden",
        status: 403,
        retryable: false,
      },
    );
}

/** Command-adjacent storage boundary; preparation and queue publication stay
 * with the daemon's existing admission/settlement owner. */
/** The successor identity a promotion's staged acceptance was written under. */
export interface PromotionStamp {
  jobId: string;
  createdAt: string;
}

export interface DeferredMessageOwner {
  get(id: string): DeferredMessageDetail | null;
  reservation(predecessor: string): DeferredMessageProjection | null;
  latest(predecessor: string): DeferredMessageProjection | null;
  outcomeHold(id: string): DeferredMessageHold | null;
  assertCreatable(predecessor: string): void;
  replay(input: DeferredMessageMutation, key: string): DeferredMessageReceipt | null;
  mutate(
    input: DeferredMessageMutation,
    key: string,
    capturedStart?: CapturedRunStart,
  ): DeferredMessageReceipt;
  /** Off-loop staging of the draft body `mutate` will own (best effort). */
  stage?(input: DeferredMessageMutation, capturedStart?: CapturedRunStart): Promise<void>;
  request(id: string): CapturedRunStart;
  /** Off-loop staging of the acceptance bodies `promote` will own (best effort). */
  stagePromotion?(id: string, expectedRevision: number): Promise<PromotionStamp>;
  promote(
    id: string,
    expectedRevision: number,
    preparedStart: CapturedRunStart,
    fence: () => DeferredMessageHold | null,
    admit: (request: CapturedRunStart, draftId: string) => void,
    stamp?: PromotionStamp,
  ): {
    draft: DeferredMessageProjection;
    record: JobRecord | null;
    reused: boolean;
  };
  hold(id: string, reason: DeferredMessageHold): void;
}
