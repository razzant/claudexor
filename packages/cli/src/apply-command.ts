import { controlProblemError } from "@claudexor/control-api";
import { flagBool, flagStr, type ParsedArgs } from "./args.js";
import { print, printCliFailure, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

const APPLY_MODES = ["apply", "commit", "branch", "pr"] as const;

export async function applyCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const runId = args._[1];
  if (!runId) {
    return printUsageError(
      json,
      "usage: claudexor apply <run_id> [--mode apply|commit|branch|pr] [--dry-run]",
    );
  }
  const rawMode = flagStr(args, "mode") ?? "apply";
  if (!APPLY_MODES.includes(rawMode as (typeof APPLY_MODES)[number])) {
    return printUsageError(json, `unsupported apply mode: ${rawMode}`, {
      fallbackCode: "invalid_apply_mode",
      context: { runId, mode: rawMode },
    });
  }

  const { addr } = await ensureDaemon();
  const dryRun = flagBool(args, "dry-run");
  const response = await controlApiFetch(
    addr,
    `/runs/${encodeURIComponent(runId)}/apply${dryRun ? "/check" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        dryRun
          ? { target: { kind: "original_project" } }
          : {
              target: { kind: "original_project" },
              mode: rawMode,
              message: `claudexor: apply ${runId}`,
            },
      ),
    },
  );
  const text = await response.text();
  let result: Record<string, unknown> = {};
  try {
    result = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (error) {
    if (!response.ok) return applyFailure(json, response.status, text, runId, rawMode, dryRun);
    throw error;
  }
  if (!response.ok) return applyFailure(json, response.status, result, runId, rawMode, dryRun);

  if (json) printJson({ runId, ...(dryRun ? { dryRun: true } : {}), ...result });
  else if (dryRun) print(result["ok"] === true ? "patch applies cleanly" : "patch does not apply");
  else
    print(
      `${String(result["mode"] ?? rawMode)}: applied=${String(result["applied"] ?? false)}` +
        (typeof result["commit"] === "string" ? ` commit=${result["commit"].slice(0, 8)}` : "") +
        (typeof result["branch"] === "string" ? ` branch=${result["branch"]}` : "") +
        (typeof result["detail"] === "string" ? ` (${result["detail"]})` : ""),
    );
  return dryRun ? (result["ok"] === true ? 0 : 1) : result["applied"] === true ? 0 : 1;
}

function applyFailure(
  json: boolean,
  status: number,
  body: unknown,
  runId: string,
  mode: string,
  dryRun: boolean,
): number {
  return printCliFailure(json, controlProblemError(status, body), {
    fallbackCode: "apply_failed",
    prefix: "claudexor apply: ",
    context: { runId, mode, dryRun },
  });
}
