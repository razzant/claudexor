import {
  continuedRunOf,
  continuationPredecessor,
  continuationRefusal,
  continuationRefusalError,
} from "@claudexor/schema";
import { readContinuationEvidence, runFilesExpired } from "@claudexor/workspace";
import { assertUnexpiredRunFiles } from "./run-file-admission.js";
import type { JobRecord } from "./job-record.js";

/**
 * Daemon-atomic admission of a `continueFrom` successor (INTERFACES §1). It
 * runs synchronously inside the enqueue RPC immediately before the command is
 * accepted, so the accepted successor command IS the durable claim: journaled
 * before any spawn or adoption, shared by every ingress, and replayed with the
 * command store after a restart. Two concurrent requests are serialized by the
 * RPC loop: exactly one is accepted, the other refused with the chain head.
 */
export function admitContinuationRequest(
  request: unknown,
  records: readonly JobRecord[],
  ancestor: (id: string) => JobRecord | undefined = (id) => continuationPredecessor(id, records),
): unknown {
  const refusal = continuationRefusal(request, records);
  if (refusal) throw continuationRefusalError(refusal);
  // Only upgrade histories with expired links need evidence-body reads during
  // admission. Ordinary claims retain the small synchronous expiration fence.
  const seen = new Set<string>();
  const intact: JobRecord[] = [];
  let expired: JobRecord | undefined;
  for (let from = continuedRunOf(request); from && !seen.has(from);) {
    seen.add(from);
    const predecessor = ancestor(from);
    if (predecessor?.runDir && runFilesExpired(predecessor.runDir)) {
      if (seen.size === 1) assertUnexpiredRunFiles(predecessor);
      expired ??= predecessor;
    } else if (predecessor) intact.push(predecessor);
    from = continuedRunOf(predecessor?.params);
  }
  if (expired) {
    // Match the runtime's newest usable source, including an intact source
    // older than a retired intermediate link. Never reopen a retired tree.
    for (const predecessor of intact) {
      if (!predecessor.runDir) continue;
      const evidence = readContinuationEvidence(predecessor.runDir);
      if (evidence.held || evidence.resumable || evidence.hasEvidence) return request;
    }
    assertUnexpiredRunFiles(expired);
  }
  return request;
}
