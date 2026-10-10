import {
  CommandListQuery,
  continuedRunOf,
  delegatedParentOf,
  directDelegatedChildrenFromRecords,
  selectRunListPage,
} from "@claudexor/schema";
import type { JobRecord } from "./job-record.js";

/** Parse at the RPC boundary before scanning anything, including empty history. */
export function parseCommandListQuery(query: unknown): CommandListQuery {
  const parsed = CommandListQuery.safeParse(query);
  if (parsed.success) return parsed.data;
  throw Object.assign(new Error("a command list query must name an addressed selector"), {
    code: query == null ? "list_query_required" : "invalid_command_list_query",
    status: 400,
    retryable: false,
  });
}

function param(record: JobRecord, key: string): unknown {
  return record.params && typeof record.params === "object"
    ? (record.params as Record<string, unknown>)[key]
    : undefined;
}

/** Reference-only graph scan. Preserve original record order for admission's
 * first-successor rule, including old aliases, rejected successors and cycles. */
function continuationChain(records: readonly JobRecord[], from: string): JobRecord[] {
  const predecessor = records.find((record) => record.id === from || record.runId === from);
  if (!predecessor) return [];
  const children = new Map<string, JobRecord[]>();
  for (const record of records) {
    const parent = continuedRunOf(record.params);
    if (parent === null) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(record);
    children.set(parent, siblings);
  }
  const selected = new Set<JobRecord>([predecessor]);
  const pending = [predecessor];
  for (let i = 0; i < pending.length; i++) {
    const record = pending[i]!;
    for (const id of [record.id, ...(record.runId ? [record.runId] : [])]) {
      for (const child of children.get(id) ?? []) {
        if (selected.has(child)) continue;
        selected.add(child);
        pending.push(child);
      }
    }
  }
  return records.filter((record) => selected.has(record));
}

/** Transitive Delegate cancellation remains uncapped and cycle-safe. */
function delegatedDescendants(records: readonly JobRecord[], from: string): JobRecord[] {
  const children = new Map<string, JobRecord[]>();
  for (const record of records) {
    const parent = delegatedParentOf(record.params);
    if (parent === null) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(record);
    children.set(parent, siblings);
  }
  const out: JobRecord[] = [];
  const seen = new Set([from]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]!) ?? []) {
      const id = child.runId ?? child.id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(child);
      queue.push(id);
    }
  }
  return out;
}

/** Turn cards also disclose direct Delegate children, whose commands need not
 * carry their parent's threadId. Select those references without widening the
 * read to unrelated history. Active-only fences need only the thread members. */
function threadRecords(
  records: readonly JobRecord[],
  ids: ReadonlySet<string>,
  activeOnly = false,
): JobRecord[] {
  const members = records.filter((r) => {
    const threadId = param(r, "threadId");
    return (
      typeof threadId === "string" &&
      ids.has(threadId) &&
      (!activeOnly || r.state === "queued" || r.state === "running")
    );
  });
  if (activeOnly) return members;
  const memberSet = new Set(members);
  const parents = new Set(members.map((r) => r.runId ?? r.id));
  return records.filter((r) => memberSet.has(r) || parents.has(delegatedParentOf(r.params) ?? ""));
}

/** Select BEFORE redaction/copy/serialization. O(N) shallow reference scans
 * are intentional; no unrelated prompt or result body is visited. */
export function selectCommandRecords(
  records: readonly JobRecord[],
  query: CommandListQuery,
): JobRecord[] {
  if ("id" in query) {
    const record = records.find((r) => r.id === query.id || r.runId === query.id);
    return record ? [record] : [];
  }
  if ("turnId" in query) {
    const last = records
      .filter((r) => param(r, "turnId") === query.turnId)
      .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
      .at(-1);
    return last ? [last] : [];
  }
  if ("ids" in query) {
    const ids = new Set(query.ids);
    return records.filter((r) => ids.has(r.id) || (!!r.runId && ids.has(r.runId)));
  }
  if ("delegatedFromRunId" in query)
    return directDelegatedChildrenFromRecords(query.delegatedFromRunId, records);
  if ("continuationChainOf" in query) return continuationChain(records, query.continuationChainOf);
  if ("delegatedDescendantsOf" in query)
    return delegatedDescendants(records, query.delegatedDescendantsOf);
  if ("page" in query)
    return selectRunListPage(records, { ...query.page, limit: query.page.limit + 1 }).page;
  if ("threadIds" in query) {
    const ids = new Set<string>(query.threadIds);
    return threadRecords(records, ids);
  }
  const active = query.activeOnly
    ? records.filter((r) => r.state === "queued" || r.state === "running")
    : records;
  return "threadId" in query
    ? threadRecords(records, new Set([query.threadId]), query.activeOnly)
    : [...active];
}
