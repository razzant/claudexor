import { ControlProblem, ControlQuotaResponse } from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { accountResourceQuery, parseAccountTarget } from "./account-resource-query.js";
import { flagBool, flagStr } from "./args.js";
import { print, printJson, quotaRefreshLabel } from "./cli-io.js";
import { renderCliFailure } from "./cli-error.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import {
  CLAUDE_STATUSLINE_MANAGED_ARG,
  runClaudeStatuslineCollector,
} from "./claude-statusline.js";

export async function quotaCommand(args: ParsedArgs, json: boolean): Promise<number> {
  if (args._[1] === "ingest-claude-statusline") {
    if (args._[2] !== CLAUDE_STATUSLINE_MANAGED_ARG || args._.length > 4) return 2;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    await runClaudeStatuslineCollector(Buffer.concat(chunks).toString("utf8"), args._[3]);
    return 0;
  }
  try {
    const profile = flagStr(args, "profile");
    const model = flagStr(args, "model");
    if (profile && !flagBool(args, "refresh")) throw new Error("--profile requires --refresh");
    if (model && !flagBool(args, "refresh")) throw new Error("--model requires --refresh");
    if (flagBool(args, "resources")) {
      const value = await accountResourceQuery("resources", {
        refresh: flagBool(args, "refresh"),
        ...(profile ? { target: parseAccountTarget(profile) } : {}),
        ...(model ? { model } : {}),
      });
      if (json) printJson(value);
      else {
        printQuota(value);
        for (const row of value.resources) {
          const subject =
            row.target.profile_id === null
              ? `${row.target.harness} (default API key)`
              : `${row.target.harness}/${row.target.profile_id}`;
          print(`${subject}: resources`);
          for (const key of ["balances", "spending", "resets", "diagnostics"] as const)
            print(
              `  ${key}: ${row[key].freshness}; ${JSON.stringify(row[key].value)}${row[key].last_error ? ` (${row[key].last_error})` : ""}`,
            );
        }
      }
      return 0;
    }
    const { addr } = await ensureDaemon();
    const refresh = flagBool(args, "refresh");
    const response = await controlApiFetch(addr, "/quota", {
      method: refresh ? "POST" : "GET",
      headers: {
        ...(refresh ? { "Content-Type": "application/json" } : {}),
      },
      ...(refresh
        ? {
            body: JSON.stringify({
              ...(profile ? { target: parseAccountTarget(profile) } : {}),
              ...(model ? { model } : {}),
            }),
          }
        : {}),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const problem = ControlProblem.safeParse(payload);
      const detail = problem.success ? `: ${problem.data.code}: ${problem.data.message}` : "";
      throw new Error(`quota request failed (HTTP ${response.status})${detail}`);
    }
    const value = ControlQuotaResponse.parse(payload);
    if (json) printJson(value);
    else printQuota(value);
    return 0;
  } catch (error) {
    return renderCliFailure(json, error, { messagePrefix: "claudexor quota:" });
  }
}

function printQuota(value: ReturnType<typeof ControlQuotaResponse.parse>): void {
  // Paused subjects (or a legacy vendor floor) retain last-known registry data.
  for (const skip of value.refresh_skipped ?? []) {
    print(
      `${quotaRefreshLabel(skip)}: refresh skipped (rate-limit cooldown until ${skip.not_before})`,
    );
  }
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
  // Typed observation gaps may accompany stale snapshots printed above.
  for (const absence of value.absences) {
    const subject = `${absence.subject.harness}/${absence.subject.subject_id ?? "default"}`;
    const retryAfter =
      absence.retry_after_ms === undefined
        ? ""
        : ` retry-after=${Math.ceil(absence.retry_after_ms / 1000)}s`;
    const detail = absence.detail ? ` (${absence.detail})` : "";
    const reason =
      absence.reason === "no_source"
        ? "no quota-window source (account resources may be reported separately)"
        : absence.reason;
    print(`${subject}: no fresh snapshot — ${reason}${retryAfter}${detail}`);
  }
}
