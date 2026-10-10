import { z } from "zod/v3";
import { ControlRunState } from "./control.js";

export interface RunListRecord {
  id: string;
  state: string;
  createdAt?: string;
}
export const RunListCursor = z.object({ createdAt: z.string(), id: z.string().min(1) }).strict();
export type RunListCursor = z.infer<typeof RunListCursor>;
export const RunListQuery = z
  .object({
    limit: z.number().int().min(1).max(1000),
    state: ControlRunState.nullable(),
    cursor: RunListCursor.nullable(),
  })
  .strict();
export type RunListQuery = z.infer<typeof RunListQuery>;

function invalidRunListQuery(
  message: string,
  code: "invalid_run_list_query" | "invalid_run_list_cursor",
): Error & { status: number; code: string; requiredActions: string[] } {
  return Object.assign(new Error(message), {
    status: 400,
    code,
    requiredActions:
      code === "invalid_run_list_cursor" ? ["resnapshot"] : ["retry_with_valid_query"],
  });
}

/** Newest-first deterministic order: `(createdAt desc, id desc)`. Records with
 * no `createdAt` sort last (empty string) with `id` as the stable tiebreak, so
 * the traversal is total and duplicate-free even across foreign record shapes. */
export function orderRunRecords<T extends RunListRecord>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => {
    const ac = a.createdAt ?? "";
    const bc = b.createdAt ?? "";
    if (ac !== bc) return ac < bc ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });
}

/** True when `rec` sorts strictly AFTER the cursor key in newest-first order
 * (i.e. is older, or same instant with a smaller id). */
function recordSortsAfterCursor(rec: RunListRecord, cursor: RunListCursor): boolean {
  const rc = rec.createdAt ?? "";
  if (rc !== cursor.createdAt) return rc < cursor.createdAt;
  return rec.id < cursor.id;
}

/**
 * Index of the first record strictly after `cursor` within an already-ordered
 * list. Comparison-based (not id-equality) so a cursor whose record was pruned
 * between pages still resumes at the correct neighbor — no duplicate, no gap.
 */
export function indexAfterCursor(ordered: readonly RunListRecord[], cursor: RunListCursor): number {
  let i = 0;
  while (i < ordered.length && !recordSortsAfterCursor(ordered[i]!, cursor)) i++;
  return i;
}

export function encodeRunCursor(rec: RunListRecord): string {
  return Buffer.from(`${rec.createdAt ?? ""}\0${rec.id}`, "utf8").toString("base64url");
}

/** Strict opaque-cursor decode: base64url alphabet only, exactly one separator,
 * non-empty id. Anything else is a typed 400 (never a silent full-list fall
 * back), mirroring the QA-061 run-event cursor contract. */
export function decodeRunCursor(raw: string): RunListCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidRunListQuery(
      "cursor is malformed; refetch the run list and resume from its nextCursor",
      "invalid_run_list_cursor",
    );
  }
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.indexOf("\0");
  const id = sep < 0 ? "" : decoded.slice(sep + 1);
  if (sep < 0 || id.length === 0 || id.includes("\0")) {
    throw invalidRunListQuery(
      "cursor is malformed; refetch the run list and resume from its nextCursor",
      "invalid_run_list_cursor",
    );
  }
  return { createdAt: decoded.slice(0, sep), id };
}

/**
 * Select one bounded page from the raw daemon records: order newest-first,
 * apply the optional `state` filter, then keyset-slice by cursor + limit. All of
 * it happens on the raw records BEFORE any summary is materialized, so the
 * caller only fingerprints/projects the returned page — work bounded by page
 * size, not total retained records (QA-052).
 */
export function selectRunListPage<T extends RunListRecord>(
  records: readonly T[],
  query: RunListQuery,
): { page: T[]; hasMore: boolean; nextCursor: string | null } {
  const ordered = orderRunRecords(records);
  const filtered = query.state ? ordered.filter((r) => r.state === query.state) : ordered;
  const start = query.cursor ? indexAfterCursor(filtered, query.cursor) : 0;
  const page = filtered.slice(start, start + query.limit);
  const hasMore = start + page.length < filtered.length;
  const tail = page[page.length - 1];
  return { page, hasMore, nextCursor: hasMore && tail ? encodeRunCursor(tail) : null };
}
