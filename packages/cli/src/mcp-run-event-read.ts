import { ControlRunEventPart, McpRunEventReadInput } from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch } from "./live.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

/**
 * One addressed part of one run event through the daemon's event-part route:
 * a run id and seq, never a path or a whole log. The answer must describe
 * exactly the requested range, or it is refused rather than reassembled.
 */
export async function runEventReadQuery(
  rawInput: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<ControlRunEventPart> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot read run events"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const input = McpRunEventReadInput.parse(rawInput);
  signal?.throwIfAborted();
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "event reads do not start one");
  const query = new URLSearchParams({
    offset: String(input.offset),
    limit: String(input.maxBytes),
  });
  const response = await controlApiFetch(
    connection.addr,
    `/runs/${encodeURIComponent(input.runId)}/events/${input.seq}?${query.toString()}`,
    { method: "GET", ...(signal ? { signal } : {}) },
  );
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw controlProblemError(
      response.status,
      body,
      `run event read failed (HTTP ${response.status})`,
    );
  const parsed = ControlRunEventPart.safeParse(body);
  const part = parsed.success ? parsed.data : null;
  if (
    !part ||
    part.seq !== input.seq ||
    part.offset !== input.offset ||
    part.nextOffset <= part.offset ||
    part.nextOffset > part.totalBytes ||
    part.nextOffset - part.offset > input.maxBytes ||
    Buffer.byteLength(part.text) !== part.nextOffset - part.offset
  ) {
    throw new CliError(
      "operational",
      "daemon returned an event part that does not match its address",
      {
        code: "invalid_service_response",
        retryable: true,
      },
    );
  }
  return part;
}
