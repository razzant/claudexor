import {
  ControlAccountResourcesResponse,
  ControlAccountResetRequest,
  ControlAccountResetResponse,
  type AccountTarget,
} from "@claudexor/schema";
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { controlProblemError } from "./cli-error.js";

export function parseAccountTarget(value: string): AccountTarget {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1)
    throw new Error("Account target must be harness/profile_id");
  return { harness: value.slice(0, slash), profile_id: value.slice(slash + 1) };
}
export type ResourceQuery = { refresh?: boolean; target?: AccountTarget; model?: string };
export type ResetQuery =
  | { operation_id: string }
  | { target: AccountTarget; offer_id: string; grant_id?: string; idempotency_key: string };
export async function accountResourceQuery(
  kind: "resources",
  input: ResourceQuery,
  existing?: boolean,
  beltContext?: boolean,
): Promise<ControlAccountResourcesResponse>;
export async function accountResourceQuery(
  kind: "reset",
  input: ResetQuery,
  existing?: boolean,
  beltContext?: boolean,
): Promise<ControlAccountResetResponse>;
export async function accountResourceQuery(
  kind: "resources" | "reset",
  input: ResourceQuery | ResetQuery,
  existing = false,
  beltContext = false,
) {
  let path: string;
  let method = "GET";
  let body: unknown;
  const headers: Record<string, string> = {};
  if (kind === "resources") {
    const query = input as ResourceQuery;
    if (query.target && !query.refresh) throw new Error("target requires refresh:true");
    if (query.model && !query.refresh) throw new Error("model requires refresh:true");
    path = "/quota?view=resources";
    if (query.refresh) {
      method = "POST";
      body = {
        ...(query.target ? { target: query.target } : {}),
        ...(query.model ? { model: query.model } : {}),
      };
    }
  } else if ("operation_id" in input)
    path = `/account-resets/${encodeURIComponent(input.operation_id)}`;
  else {
    const query = input as Exclude<ResetQuery, { operation_id: string }>;
    if (!query.idempotency_key)
      throw new Error(
        "idempotency_key is required; retain it with the request for timeout recovery",
      );
    body = ControlAccountResetRequest.parse({
      target: query.target,
      offer_id: query.offer_id,
      ...(query.grant_id ? { grant_id: query.grant_id } : {}),
    });
    headers["Idempotency-Key"] = query.idempotency_key;
    method = "POST";
    path = "/account-resets";
  }
  const connection = existing ? await connectDaemonIfRunning() : await ensureDaemon();
  if (!connection) throw daemonUnavailableError(beltContext, "account request was not performed");
  const response = await controlApiFetch(connection.addr, path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok)
    throw controlProblemError(
      response.status,
      payload,
      `Account request failed (HTTP ${response.status})`,
    );
  return kind === "resources"
    ? ControlAccountResourcesResponse.parse(payload)
    : ControlAccountResetResponse.parse(payload);
}
