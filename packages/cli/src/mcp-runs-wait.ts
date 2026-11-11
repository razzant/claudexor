import { RunWaitManyInput, RunWaitManyResult } from "@claudexor/schema";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";
import { connectForObservation } from "./mcp-run-wait.js";
import { invalidServiceResponse, readObservationJson } from "./observation-read.js";

/** One existing-daemon observer request; cancellation never controls a worker. */
export async function runsWaitQuery(
  rawInput: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
): Promise<RunWaitManyResult> {
  if (beltContext)
    throw Object.assign(new Error("the delegation belt cannot wait on runs"), {
      code: "delegation_forbidden",
      status: 403,
    });
  // Preserve optional omission on the wire so defaults do not consume payload bytes.
  const input = RunWaitManyInput.parse(rawInput);
  signal?.throwIfAborted();
  const connection = await connectForObservation(signal);
  if (!connection) throw daemonUnavailableError(false, "run observation does not start one");
  signal?.throwIfAborted();
  const body = await readObservationJson(
    connection.addr,
    "/runs/wait-many",
    {
      method: "POST",
      body: JSON.stringify({
        targets: input.targets,
        ...(rawInput["waitMs"] === undefined ? {} : { waitMs: input.waitMs }),
        // Only the opt-in travels: false is the default an older daemon's strict input refuses.
        ...(input.includeBlocking ? { includeBlocking: true } : {}),
      }),
      timeoutMs: input.waitMs + 5_000,
      label: "compact run observation",
      unsupported: {
        code: "run_observation_unavailable",
        message: "compact run observation is unavailable; use a daemon supporting wait-many",
      },
    },
    signal,
  );
  const parsed = RunWaitManyResult.safeParse(body);
  if (!parsed.success || parsed.data.summaries.length !== input.targets.length)
    throw invalidServiceResponse(
      "daemon returned an invalid compact run observation or mismatched target positions",
    );
  return parsed.data;
}
