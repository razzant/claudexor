/**
 * Thread-store projections: raw persisted thread/session/turn records ->
 * typed Control DTOs. Pure and schema-parsed — the store shape is validated
 * at the boundary, never trusted.
 */
import {
  ControlSession,
  ControlThread,
  ControlThreadTurn,
  ControlTurnRunCard,
  type ControlRunSummary,
} from "@claudexor/schema";

export function projectThread(raw: unknown, needsHuman: boolean): ControlThread {
  const t = raw as Record<string, unknown>;
  const repo = t["repo"] as { root?: string } | null;
  const workspace = t["workspace"] as { mode?: string } | undefined;
  return ControlThread.parse({
    id: t["id"],
    title: t["title"] ?? null,
    repoRoot: repo?.root ?? null,
    mode: t["mode"],
    workspaceMode: workspace?.mode ?? "in_place",
    authPreference: t["auth_preference"] ?? "auto",
    primaryHarness: t["primary_harness"] ?? null,
    eligibleHarnesses: t["eligible_harnesses"] ?? [],
    credentialProfileId: t["credential_profile_id"] ?? null,
    access: t["access"] ?? null,
    state: t["state"] ?? "active",
    trashedAt: t["trashed_at"] ?? null,
    purgeAfter: t["purge_after"] ?? null,
    runIds: t["run_ids"] ?? [],
    headRunId: t["head_run_id"] ?? null,
    needsHuman,
    createdAt: t["created_at"],
    updatedAt: t["updated_at"],
  });
}

export function projectSession(raw: unknown): ControlSession {
  const s = raw as Record<string, unknown>;
  return ControlSession.parse({
    id: s["id"],
    threadId: s["thread_id"],
    harnessId: s["harness_id"],
    nativeSessionId: s["native_session_id"] ?? null,
    observedModel: s["last_observed_model"] ?? null,
    profileId: s["profile_id"] ?? null,
    state: s["state"] ?? "live",
  });
}

/** Project a run summary down to the compact card embedded on a thread turn. */
export function turnRunCard(summary: ControlRunSummary): ControlTurnRunCard {
  return ControlTurnRunCard.parse({
    state: summary.state,
    mode: summary.mode,
    strategy: summary.strategy ?? null,
    n: summary.n,
    result: summary.result,
    spendUsd: summary.spendUsd ?? null,
    outputReadyState: summary.outputReadyState,
    waitingOnUser: summary.waitingOnUser,
    finishedAt: summary.finishedAt ?? null,
  });
}

export function projectTurn(
  raw: unknown,
  cards: Map<string, ControlTurnRunCard>,
): ControlThreadTurn {
  const t = raw as Record<string, unknown>;
  const runId = (t["run_id"] as string | null) ?? null;
  const enqueueError = t["enqueue_error"] as
    | { message?: unknown; code?: unknown; retryable?: unknown; failed_at?: unknown }
    | null
    | undefined;
  const continuity = t["continuity"] as
    | {
        kind?: unknown;
        packet_turns?: unknown;
        summarized?: unknown;
        lane_switched_from?: { harness_id?: unknown; profile_id?: unknown } | null;
      }
    | null
    | undefined;
  return ControlThreadTurn.parse({
    id: t["id"],
    threadId: t["thread_id"],
    runId,
    parentRunId: t["parent_run_id"] ?? null,
    planRunId: t["plan_run_id"] ?? null,
    kind: t["kind"] ?? "followup",
    prompt: t["prompt"] ?? "",
    // Embedded run card so the chat renders the whole conversation (state +
    // honest outcome) from this one response — no N+1 run-detail fetch per turn.
    run: runId ? (cards.get(runId) ?? null) : null,
    // A runless turn's refusal (trust gate / preflight) rides the projection so
    // the chat shows WHY there is no run instead of an eternally-empty bubble.
    enqueueError:
      !runId && enqueueError && typeof enqueueError === "object"
        ? {
            message: String(enqueueError.message ?? ""),
            code: typeof enqueueError.code === "string" ? enqueueError.code : null,
            // Legacy records (pre-retryable) default to true — they came from
            // the runner-hook path, where a job exists to replay.
            retryable: enqueueError.retryable !== false,
            failedAt: String(enqueueError.failed_at ?? ""),
          }
        : null,
    // Continuity disclosure (INV-137): snake_case persisted record -> camelCase
    // DTO so every surface renders the one-line "continued with thread context"
    // label without re-deriving it from raw events.
    continuity:
      continuity && typeof continuity === "object" && typeof continuity.kind === "string"
        ? {
            kind: continuity.kind,
            packetTurns: typeof continuity.packet_turns === "number" ? continuity.packet_turns : 0,
            summarized: continuity.summarized === true,
            laneSwitchedFrom:
              continuity.lane_switched_from &&
              typeof continuity.lane_switched_from === "object" &&
              typeof continuity.lane_switched_from.harness_id === "string"
                ? {
                    harness: continuity.lane_switched_from.harness_id,
                    profileId:
                      typeof continuity.lane_switched_from.profile_id === "string"
                        ? continuity.lane_switched_from.profile_id
                        : null,
                  }
                : null,
          }
        : null,
    createdAt: t["created_at"],
  });
}
