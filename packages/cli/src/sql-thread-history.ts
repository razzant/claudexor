import {
  SqlThreadHistoryRead,
  readThreadPromptPart,
  type createSqlDaemonServices,
} from "@claudexor/daemon";
import { createThreadHistoryRead } from "@claudexor/control-api";
import { pendingQuestionAttention } from "@claudexor/schema";

type Graph = Pick<
  ReturnType<typeof createSqlDaemonServices>,
  "store" | "blobs" | "commands" | "threads" | "interactions"
>;
/** Recovery follows the current SQL graph; all projection reads stay in the
 * read owner's synchronous turn, including command summaries and decisions. */
export function sqlThreadHistoryReads(current: () => Graph) {
  return createThreadHistoryRead(() => {
    const graph = current();
    const reader = new SqlThreadHistoryRead(graph.store, graph.blobs);
    return {
      storeId: graph.store.storeId,
      incarnation: graph.store,
      identity: (id) => reader.identity(id),
      header: (id) => reader.header(id),
      select: (input, cursor) => reader.select(input, cursor),
      turn: (threadId, key) => reader.turn(threadId, key),
      coverage: (threadId, low, high, ceiling) => reader.coverage(threadId, low, high, ceiling),
      runs: (ids) => (ids.length ? graph.commands.queries.publicList({ ids }) : []),
      runInput: (record) => ({
        ...pendingQuestionAttention(graph.interactions.pendingForRun(record.runId ?? record.id)),
        operator: graph.threads.operatorDecision(record.params, record.runId ?? record.id),
        childRunIds: graph.commands.queries
          .publicList({ delegatedFromRunId: record.runId ?? record.id })
          .map((r) => r.runId ?? r.id),
      }),
      planAnswer: (threadId, planRunId) => reader.planAnswer(threadId, planRunId),
      prompt: (input) => readThreadPromptPart(graph.store, graph.blobs, input),
    };
  });
}
