import type { ProjectThreadPort, ResourceStorePort } from "@claudexor/daemon";
import type { ResourceAttachmentRef, TurnEnqueueProblem } from "@claudexor/schema";

/** Thin Control API bindings over the daemon's durable thread and turn authority. */
export function threadTurnServices(
  threads: ProjectThreadPort,
  resources: Pick<ResourceStorePort, "resolve">,
) {
  return {
    findThreadCreation: async (input: unknown) =>
      threads.findThreadCreation(input as Parameters<ProjectThreadPort["findThreadCreation"]>[0]),
    threadDetail: async (id: string) => {
      const thread = threads.getThread(id);
      if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
      return {
        thread: thread as unknown,
        sessions: threads.sessionsForThread(id) as unknown[],
        turns: threads.turnsFor(id) as unknown[],
      };
    },
    createThreadTurn: async (
      id: string,
      prompt: string,
      options: {
        kind?: unknown;
        parentRunId?: string | null;
        answersPlanRunId?: string | null;
        planRunId?: string | null;
        planHash?: string | null;
        planOverridden?: boolean;
        attachments?: ResourceAttachmentRef[];
        idempotency?: { key: string; client: string; request: unknown };
      },
    ) => {
      // A large prompt's body is written off the request thread; the turn
      // commit then finds it and decides everything else as before.
      await threads.stageTurnPrompt?.(id, prompt);
      // A same-key repeat of the request that recorded a turn (#249), e.g. after the
      // daemon stopped before its first enqueue, reads the refs as that turn, which
      // already holds them, and `createTurn` answers the recorded turn. A changed
      // request under the key still conflicts here; a new turn stays a new reference.
      const recorded = options.idempotency
        ? threads.findTurnByIdempotency(id, options.idempotency)
        : undefined;
      return threads.createTurn(id, prompt, {
        kind: options.kind as any,
        parentRunId: options.parentRunId,
        answersPlanRunId: options.answersPlanRunId,
        planRunId: options.planRunId,
        planHash: options.planHash,
        planOverridden: options.planOverridden,
        attachments: resources.resolve(
          options.attachments,
          recorded ? { owner: "turn", id: recorded.id } : undefined,
        ),
        idempotency: options.idempotency,
      });
    },
    findThreadTurnByIdempotency: async (
      id: string,
      idempotency: { key: string; client: string; request: unknown },
    ) => threads.findTurnByIdempotency(id, idempotency) ?? null,
    setTurnEnqueueError: (turnId: string, problem: TurnEnqueueProblem) =>
      threads.setTurnEnqueueError(turnId, problem),
  };
}
