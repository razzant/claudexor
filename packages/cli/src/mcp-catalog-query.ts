import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { controlProblemError } from "./cli-error.js";

export async function catalogQuery(
  mode: "__status" | "__capabilities" | "__accounts",
  requireExistingDaemon = false,
  options: { fresh?: boolean; beltContext?: boolean } = {},
): Promise<Record<string, unknown>> {
  const connection = requireExistingDaemon ? await connectDaemonIfRunning() : await ensureDaemon();
  if (!connection)
    throw daemonUnavailableError(options.beltContext === true, "catalog unavailable");
  const { addr } = connection;
  // __accounts retains the first readiness acquisition with its age and
  // composes current quota/registry facts. The explicit snapshot refresh does a
  // live probe per profile, a full doctor sweep, and the vendor quota
  // fan-out — and is requested only by fresh:true (which itself honors the
  // subject rate-limit cooldowns and retained legacy vendor floors).
  const path =
    mode === "__status"
      ? "/harnesses"
      : mode === "__accounts"
        ? options.fresh === true
          ? "/credential-profiles?snapshot=true"
          : "/credential-profiles"
        : "/agent-capabilities";
  const response = await controlApiFetch(addr, path);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw controlProblemError(
      response.status,
      body,
      `control API ${path} failed (HTTP ${response.status})`,
    );
  if (mode !== "__status") return body;
  const harnesses = Array.isArray(body["harnesses"])
    ? (body["harnesses"] as Record<string, unknown>[])
    : [];
  return {
    ...body,
    available: harnesses.filter((item) => item["status"] === "ok").map((item) => item["id"]),
  };
}
