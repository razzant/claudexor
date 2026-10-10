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
    ) =>
      threads.createTurn(id, prompt, {
        kind: options.kind as any,
        parentRunId: options.parentRunId,
        answersPlanRunId: options.answersPlanRunId,
        planRunId: options.planRunId,
        planHash: options.planHash,
        planOverridden: options.planOverridden,
        attachments: resources.resolve(options.attachments),
        idempotency: options.idempotency,
      }),
    findThreadTurnByIdempotency: async (
      id: string,
      idempotency: { key: string; client: string; request: unknown },
    ) => threads.findTurnByIdempotency(id, idempotency) ?? null,
    setTurnEnqueueError: (turnId: string, problem: TurnEnqueueProblem) =>
      threads.setTurnEnqueueError(turnId, problem),
  };
}
