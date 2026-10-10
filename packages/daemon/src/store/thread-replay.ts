import type { Thread } from "@claudexor/schema";
import type { CreateThreadInput } from "../threads.js";
import { idempotencyConflict, threadCreationIdempotency } from "../thread-store-support.js";
import type { SqlWriteContext } from "./mutation.js";
import type { PartitionGeneration } from "./partitions.js";
import { readThread } from "./thread-rows.js";

/** Two variables per scope, exactly Node SQLite's 32766-variable bound. */
const ROW_VALUE_SCOPE_LIMIT = 16_383;

export function threadReplayQuery(pairs: readonly (readonly [number, string])[]): {
  sql: string;
  values: Array<string | number>;
} {
  const columns = "pid,key_digest,request_digest,target_id";
  if (pairs.length > ROW_VALUE_SCOPE_LIMIT) {
    return {
      sql: `SELECT ${columns} FROM idempotency WHERE owner='thread' AND (pid,key_digest) IN (
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`,
      values: [JSON.stringify(pairs)],
    };
  }
  return {
    sql: `SELECT ${columns} FROM idempotency WHERE owner='thread' AND (pid,key_digest) IN
    (VALUES ${pairs.map(() => "(?,?)").join(",")})`,
    values: pairs.flatMap(([pid, key]) => [pid, key]),
  };
}

/** No path resolution, admission or project registration precedes this lookup.
 * A different request in an unrelated project is not this request's conflict. */
export function findThreadCreationAcross(
  sql: Pick<SqlWriteContext, "prepare">,
  scopes: readonly Pick<PartitionGeneration, "pid" | "name">[],
  input: CreateThreadInput["idempotency"],
  exactRequestOnly = true,
): Thread | undefined {
  if (!input || scopes.length === 0) return undefined;
  const keys = scopes.map((scope) => ({
    scope,
    key: threadCreationIdempotency(scope.name, input)!,
  }));
  const query = threadReplayQuery(keys.map(({ scope, key }) => [scope.pid, key.keyDigest]));
  const rows = sql.prepare(query.sql).all(...query.values) as Array<{
    pid: number;
    key_digest: string;
    request_digest: string;
    target_id: string;
  }>;
  // Legacy searches healthy project partitions in registry insertion order.
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const { scope, key } of keys) {
    const row = byPid.get(scope.pid);
    if (!row) continue;
    if (row.request_digest !== key.requestDigest) {
      if (exactRequestOnly) continue;
      throw idempotencyConflict();
    }
    const thread = readThread(sql, scope.pid, row.target_id);
    if (!thread) throw new Error(`idempotency record points to missing thread ${row.target_id}`);
    return thread;
  }
  return undefined;
}
