import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { controlProblemError } from "./cli-error.js";

/** Durable journal recovery through the existing daemon boundary. */
export async function journalRecoveryQuery(input: Record<string, unknown>): Promise<unknown> {
  const conn = await connectDaemonIfRunning();
  if (!conn) throw daemonUnavailableError(false, "journal recovery requires an existing daemon");
  const action = String(input["action"] ?? "inspect");
  const partition = String(input["partition"] ?? "");
  if (!partition) throw new Error("partition is required");
  const base = `/recovery/partitions/${encodeURIComponent(partition)}`;
  const suffix =
    action === "inspect"
      ? ""
      : action === "validate" || action === "export" || action === "quarantine"
        ? `/${action}`
        : null;
  if (suffix === null) throw new Error(`unknown journal recovery action '${action}'`);
  const body =
    action === "quarantine"
      ? {
          expectedFingerprint: String(input["expectedFingerprint"] ?? ""),
          confirmation: String(input["confirmation"] ?? ""),
        }
      : undefined;
  const response = await controlApiFetch(conn.addr, `${base}${suffix}`, {
    method: action === "inspect" ? "GET" : "POST",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw controlProblemError(
      response.status,
      result,
      `journal recovery failed (HTTP ${response.status})`,
    );
  }
  return result;
}
