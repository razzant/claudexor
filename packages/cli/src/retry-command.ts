import { controlProblemError } from "@claudexor/control-api";
import type { ParsedArgs } from "./args.js";
import { print, printCliFailure, printJson, printUsageError } from "./cli-io.js";
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
    const data: unknown = await response.json();
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, data), {
        prefix: "claudexor retry: ",
      });
    }
    const result = data as Record<string, unknown>;
    if (json) printJson(result);
    else
      print(
        `retry ${runId}: ${String(result["state"])} (${String(result["runId"] ?? result["jobId"])})`,
      );
    return 0;
  } catch (error) {
    return printCliFailure(json, error, {
      category: "operational",
      fallbackCode: "retry_failed",
      prefix: "claudexor retry: ",
    });
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
    const data: unknown = await response.json();
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, data), {
        prefix: "claudexor run-again: ",
      });
    }
    const result = data as Record<string, unknown>;
    if (json) printJson(result);
    else {
      print(`editable Run Again draft from ${runId}:`);
      print(JSON.stringify(result["request"] ?? {}, null, 2));
      const differences = Array.isArray(result["differences"]) ? result["differences"] : [];
      for (const difference of differences) {
        const row = difference as Record<string, unknown>;
        print(`  omitted ${String(row["field"])}: ${String(row["reason"])}`);
      }
    }
    return 0;
  } catch (error) {
    return printCliFailure(json, error, {
      category: "operational",
      fallbackCode: "run_again_failed",
      prefix: "claudexor run-again: ",
    });
  }
}
