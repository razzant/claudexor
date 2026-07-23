import { controlProblemError } from "@claudexor/control-api";
import { ControlQuotaResponse } from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { flagBool } from "./args.js";
import { print, printCliFailure, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import {
  CLAUDE_STATUSLINE_MANAGED_ARG,
  runClaudeStatuslineCollector,
} from "./claude-statusline.js";

export async function quotaCommand(args: ParsedArgs, json: boolean): Promise<number> {
  if (args._[1] === "ingest-claude-statusline") {
    if (args._[2] !== CLAUDE_STATUSLINE_MANAGED_ARG || args._.length > 4) {
      return printUsageError(
        json,
        `usage: claudexor quota ingest-claude-statusline ${CLAUDE_STATUSLINE_MANAGED_ARG} [upstream-command]`,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    await runClaudeStatuslineCollector(Buffer.concat(chunks).toString("utf8"), args._[3]);
    return 0;
  }
  try {
    const { addr } = await ensureDaemon();
    const refresh = flagBool(args, "refresh");
    const response = await controlApiFetch(addr, "/quota", {
      method: refresh ? "POST" : "GET",
      headers: { Authorization: `Bearer ${addr.token}` },
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      return printCliFailure(json, controlProblemError(response.status, payload), {
        prefix: "claudexor quota: ",
      });
    }
    const value = ControlQuotaResponse.parse(payload);
    if (json) printJson(value);
    else printQuota(value);
    return 0;
  } catch (error) {
    return printCliFailure(json, error, {
      category: "operational",
      fallbackCode: "quota_failed",
      prefix: "claudexor quota: ",
    });
  }
}

function printQuota(value: ReturnType<typeof ControlQuotaResponse.parse>): void {
  if (value.snapshots.length === 0 && value.absences.length === 0) {
    print("quota: unknown (no vendor-owned snapshot available)");
    return;
  }
  for (const snapshot of value.snapshots) {
    print(
      `${snapshot.subject.harness}: source=${snapshot.source} freshness=${snapshot.freshness} observed=${snapshot.observed_at}`,
    );
    for (const constraint of snapshot.constraints) {
      const used =
        constraint.used_ratio === null ? "unknown" : `${(constraint.used_ratio * 100).toFixed(1)}%`;
      print(
        `  ${constraint.label}: used=${used} reset=${constraint.resets_at ?? "unknown"} cooldown=${constraint.cooldown_until ?? "none"}`,
      );
    }
  }
  // Every registered subject reports either a snapshot above or a typed absence
  // here — absence is stated, never silent emptiness (zen: absence ≠ empty).
  for (const absence of value.absences) {
    const subject = `${absence.subject.harness}/${absence.subject.subject_id ?? "default"}`;
    const detail = absence.detail ? ` (${absence.detail})` : "";
    print(`${subject}: no snapshot — ${absence.reason}${detail}`);
  }
}
