import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
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
    if (!response.ok) throw new Error(String(data["error"] ?? `HTTP ${response.status}`));
    if (json) printJson(data);
    else
      print(`retry ${runId}: ${String(data["state"])} (${String(data["runId"] ?? data["jobId"])})`);
    return 0;
  } catch (error) {
    return printUsageError(
      json,
      `claudexor retry: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    if (!response.ok) throw new Error(String(data["error"] ?? `HTTP ${response.status}`));
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
    return printUsageError(
      json,
      `claudexor run-again: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
