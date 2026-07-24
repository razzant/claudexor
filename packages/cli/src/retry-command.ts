/**
 * `claudexor retry` / `claudexor run-again`.
 *
 * Both refusals go through the SAME projector the rest of the CLI uses
 * (`controlProblemError` → `renderCliFailure`), because the daemon does not
 * serve the field these commands used to read. Every `>= 400` reply from the
 * control API is re-projected into a strict `ControlProblem` before it reaches
 * the wire, so the human text arrives in `message` and there is no `error` key
 * at all — reading `data["error"]` therefore always fell through to a bare
 * `HTTP <status>` and threw away the actionable refusal. The projector reads
 * `message` first and still salvages a legacy `error` body, so a sender that
 * has not moved to problem+json does not regress, and the typed fields
 * (`code`/`retryable`/`requiredActions`/`context`) survive instead of being
 * flattened into one string.
 */
import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { controlProblemError, renderCliFailure } from "./cli-error.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

export async function retryCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const runId = args._[1];
  if (!runId) return printUsageError(json, "usage: claudexor retry <run_id>");
  try {
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${addr.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const data = (await response.json()) as Record<string, unknown>;
    // A pre-start terminal (the trust gate's typed 403, a requirements refusal)
    // answers here — its message is what the operator has to act on.
    if (!response.ok) throw controlProblemError(response.status, data, `HTTP ${response.status}`);
    if (json) printJson(data);
    else
      print(`retry ${runId}: ${String(data["state"])} (${String(data["runId"] ?? data["jobId"])})`);
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor retry:" });
  }
}

export async function runAgainCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const runId = args._[1];
  if (!runId) return printUsageError(json, "usage: claudexor run-again <run_id>");
  try {
    const { addr } = await ensureDaemon();
    const response = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}/run-again`, {
      headers: { Authorization: `Bearer ${addr.token}` },
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw controlProblemError(response.status, data, `HTTP ${response.status}`);
    if (json) printJson(data);
    else {
      print(`editable Run Again draft from ${runId}:`);
      print(JSON.stringify(data["request"] ?? {}, null, 2));
      const differences = Array.isArray(data["differences"]) ? data["differences"] : [];
      for (const difference of differences) {
        const row = difference as Record<string, unknown>;
        print(`  omitted ${String(row["field"])}: ${String(row["reason"])}`);
      }
    }
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor run-again:" });
  }
}
