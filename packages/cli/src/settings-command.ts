/** `claudexor settings` is a thin projection of the daemon-owned /v2/settings surface. */
import {
  ControlSettingsSnapshot,
  ControlSettingsUpdateRequest,
  type ControlSettingsUpdateRequest as SettingsPatch,
} from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

const USAGE =
  "usage: claudexor settings set routing_goal|paid_fallback|quality_tiers|primary_harness|eligible_harnesses|harness.<id>.default_model|harness.<id>.fallback_model|harness.<id>.effort|env_inheritance|routing_policy|paid_budget_per_run|interaction_timeout_ms <value>";

export async function settingsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "show";
  if (sub !== "show" && sub !== "set")
    return printUsageError(json, "usage: claudexor settings show|set");
  try {
    const { addr } = await ensureDaemon();
    if (sub === "show") {
      const snapshot = await settingsRequest(addr, "GET");
      if (json) printJson(snapshot);
      else printSettings(snapshot);
      return 0;
    }
    const key = args._[2];
    const value = args._[3];
    if (!key || value === undefined) return printUsageError(json, USAGE);
    const snapshot = await settingsRequest(addr, "POST", settingPatch(key, value));
    if (json) printJson(snapshot);
    else print(`updated ${key}`);
    return 0;
  } catch (error) {
    const message = `claudexor settings: ${error instanceof Error ? error.message : String(error)}`;
    if (json) printJson({ ok: false, exitCode: 1, error: message });
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}

async function settingsRequest(
  addr: ControlApiAddress,
  method: "GET" | "POST",
  body?: SettingsPatch,
) {
  const response = await controlApiFetch(addr, "/settings", {
    method,
    headers: {
      Authorization: `Bearer ${addr.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value: unknown = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`settings endpoint returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const detail = value as Record<string, unknown>;
    throw new Error(
      typeof detail["message"] === "string"
        ? detail["message"]
        : typeof detail["error"] === "string"
          ? detail["error"]
          : `settings request failed (HTTP ${response.status})`,
    );
  }
  return ControlSettingsSnapshot.parse(value);
}

function settingPatch(key: string, value: string): SettingsPatch {
  if (key === "default_model") {
    throw new Error(
      "the global default_model setting was removed (model choice is harness-scoped, INV-103); use `claudexor settings set harness.<id>.default_model <model>`",
    );
  }
  const harness = /^harness\.([^.]+)\.(default_model|fallback_model|effort)$/.exec(key);
  if (harness) {
    const id = harness[1] as string;
    const field = harness[2] as "default_model" | "fallback_model" | "effort";
    const cleared = value === "none";
    return ControlSettingsUpdateRequest.parse({
      harnesses: {
        [id]:
          field === "default_model"
            ? { defaultModel: cleared ? null : value }
            : field === "fallback_model"
              ? { fallbackModel: cleared ? null : value }
              : { effort: cleared ? null : value },
      },
    });
  }
  if (key === "default_portfolio") {
    throw new Error("default_portfolio was removed in v2; use routing_goal");
  }
  if (key === "routing_goal") return ControlSettingsUpdateRequest.parse({ routingGoal: value });
  if (key === "paid_fallback") return ControlSettingsUpdateRequest.parse({ paidFallback: value });
  if (key === "quality_tiers") {
    let qualityTiers: unknown;
    try {
      qualityTiers = JSON.parse(value);
    } catch {
      throw new Error("quality_tiers must be a JSON object of per-intent ordered tiers");
    }
    return ControlSettingsUpdateRequest.parse({ qualityTiers });
  }
  if (key === "primary_harness")
    return ControlSettingsUpdateRequest.parse({ primaryHarness: value === "none" ? null : value });
  if (key === "eligible_harnesses") {
    const eligibleHarnesses =
      value === "none"
        ? []
        : value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    return ControlSettingsUpdateRequest.parse({ eligibleHarnesses });
  }
  if (key === "env_inheritance")
    return ControlSettingsUpdateRequest.parse({ envInheritance: value });
  if (key === "paid_budget_per_run") {
    if (value === "unlimited")
      return ControlSettingsUpdateRequest.parse({ paidBudgetPerRun: { kind: "unlimited" } });
    const maxUsd = Number(value.trim());
    if (!Number.isFinite(maxUsd) || maxUsd < 0 || value.trim() === "")
      throw new Error(`${key} must be a non-negative number or unlimited`);
    return ControlSettingsUpdateRequest.parse({
      paidBudgetPerRun: { kind: "finite", maxUsd },
    });
  }
  if (key === "interaction_timeout_ms") {
    const interactionTimeoutMs = Number(value.trim());
    return ControlSettingsUpdateRequest.parse({ interactionTimeoutMs });
  }
  throw new Error(`unknown setting: ${key}`);
}

function printSettings(settings: ReturnType<typeof ControlSettingsSnapshot.parse>): void {
  print(`sources: ${settings.sources.length ? settings.sources.join(", ") : "(defaults)"}`);
  print(`routing.goal: ${settings.routing.goal}`);
  print(`routing.paid_fallback: ${settings.routing.paidFallback}`);
  print(`routing.primary_harness: ${settings.routing.primaryHarness ?? "(none)"}`);
  print(
    `routing.eligible_harnesses: ${settings.routing.eligibleHarnesses.length ? settings.routing.eligibleHarnesses.join(", ") : "(auto)"}`,
  );
  print(`routing.env_inheritance: ${settings.routing.envInheritance}`);
  print(
    `budget.paid_budget_per_run: ${settings.budget.paidBudgetPerRun.kind === "unlimited" ? "unlimited" : settings.budget.paidBudgetPerRun.maxUsd}`,
  );
  print(`interaction_timeout_ms: ${settings.interactionTimeoutMs}`);
  print(`runtime.reviewer_timeout_ms: ${settings.runtime.reviewerTimeoutMs}`);
  print(`runtime.transient_retry.max_retries: ${settings.runtime.transientRetry.maxRetries}`);
  print(
    `runtime.transient_retry.initial_delay_ms: ${settings.runtime.transientRetry.initialDelayMs}`,
  );
  print(`runtime.transient_retry.max_delay_ms: ${settings.runtime.transientRetry.maxDelayMs}`);
  const harnesses = Object.entries(settings.harnesses);
  if (harnesses.length === 0) return;
  print("harnesses:");
  for (const [id, harness] of harnesses) {
    print(
      `  ${id}: enabled=${harness.enabled} model=${harness.defaultModel ?? "(native)"} effort=${harness.effort ?? "(native)"} web=${harness.web} max_turns=${harness.maxTurns ?? "(none)"}`,
    );
  }
}
