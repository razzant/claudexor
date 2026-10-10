import { CommandListQuery } from "@claudexor/schema";

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
