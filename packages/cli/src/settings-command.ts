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

/**
 * CLI global setting key -> the ControlSettingsUpdateRequest field it writes.
 * The settings-coverage sweep test asserts every settable global field the
 * daemon honors is reachable here — a NEW schema field with no CLI key FAILS
 * the test (self-enforcing), so the surface can never silently lag the daemon.
 */
export const GLOBAL_SETTING_FIELDS = {
  routing_goal: "routingGoal",
  paid_fallback: "paidFallback",
  quality_tiers: "qualityTiers",
  interaction_timeout_ms: "interactionTimeoutMs",
  primary_harness: "primaryHarness",
  eligible_harnesses: "eligibleHarnesses",
  env_inheritance: "envInheritance",
  paid_budget_per_run: "paidBudgetPerRun",
  auth_preference: "authPreference",
} as const;

/**
 * CLI harness.<id>.<field> -> the ControlHarnessSettingsPatch field it writes.
 * Same self-enforcing contract as the global map.
 */
export const HARNESS_SETTING_FIELDS = {
  enabled: "enabled",
  native_credentials_enabled: "nativeCredentialsEnabled",
  default_model: "defaultModel",
  fallback_model: "fallbackModel",
  effort: "effort",
  max_turns: "maxTurns",
  max_rounds: "maxRounds",
  tools_allow: "toolsAllow",
  tools_deny: "toolsDeny",
  web: "web",
  auth_preference: "authPreference",
  profile_limit_action: "profileLimitAction",
} as const;

const HARNESS_KEY_RE = new RegExp(
  `^harness\\.([^.]+)\\.(${Object.keys(HARNESS_SETTING_FIELDS).join("|")})$`,
);

const USAGE =
  "usage: claudexor settings set <key> <value>\n" +
  `  global keys: ${Object.keys(GLOBAL_SETTING_FIELDS).join(", ")}\n` +
  `  harness keys: harness.<id>.{${Object.keys(HARNESS_SETTING_FIELDS).join(",")}}`;

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

/** Parse one harness.<id>.<field> value into a ControlHarnessSettingsPatch
 * partial. Enum/model values pass through to zod validation; typed fields
 * (boolean/number/array) convert first. `none` clears nullable/list fields. */
function harnessFieldPatch(field: keyof typeof HARNESS_SETTING_FIELDS, value: string): unknown {
  const cleared = value === "none";
  switch (field) {
    case "enabled": {
      if (value !== "true" && value !== "false")
        throw new Error("harness enabled must be true or false");
      return { enabled: value === "true" };
    }
    case "native_credentials_enabled": {
      if (value !== "true" && value !== "false")
        throw new Error("harness native_credentials_enabled must be true or false");
      return { nativeCredentialsEnabled: value === "true" };
    }
    case "default_model":
      return { defaultModel: cleared ? null : value };
    case "fallback_model":
      return { fallbackModel: cleared ? null : value };
    case "effort":
      return { effort: cleared ? null : value };
    case "max_turns":
    case "max_rounds": {
      const patchKey = field === "max_turns" ? "maxTurns" : "maxRounds";
      if (cleared) return { [patchKey]: null };
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`harness ${field} must be a positive integer or none`);
      return { [patchKey]: n };
    }
    case "tools_allow":
    case "tools_deny": {
      const patchKey = field === "tools_allow" ? "toolsAllow" : "toolsDeny";
      const list = cleared
        ? []
        : value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
      return { [patchKey]: list };
    }
    case "web":
      return { web: value };
    case "auth_preference":
      return { authPreference: value };
    case "profile_limit_action":
      return { profileLimitAction: value };
  }
}

export function settingPatch(key: string, value: string): SettingsPatch {
  if (key === "default_model") {
    throw new Error(
      "the global default_model setting was removed (model choice is harness-scoped, INV-103); use `claudexor settings set harness.<id>.default_model <model>`",
    );
  }
  const harness = HARNESS_KEY_RE.exec(key);
  if (harness) {
    const id = harness[1] as string;
    const field = harness[2] as keyof typeof HARNESS_SETTING_FIELDS;
    return ControlSettingsUpdateRequest.parse({
      harnesses: { [id]: harnessFieldPatch(field, value) },
    });
  }
  if (key === "default_portfolio") {
    throw new Error("default_portfolio was removed in v2; use routing_goal");
  }
  if (key === "routing_goal") return ControlSettingsUpdateRequest.parse({ routingGoal: value });
  if (key === "paid_fallback") return ControlSettingsUpdateRequest.parse({ paidFallback: value });
  if (key === "auth_preference")
    return ControlSettingsUpdateRequest.parse({ authPreference: value });
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
  print(`routing.auth_preference: ${settings.routing.authPreference}`);
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
      `  ${id}: enabled=${harness.enabled} cli_login=${harness.nativeCredentialsEnabled ? "on" : "off"} model=${harness.defaultModel ?? "(native)"} fallback=${harness.fallbackModel ?? "(none)"} effort=${harness.effort ?? "(native)"} web=${harness.web} max_turns=${harness.maxTurns ?? "(none)"} max_rounds=${harness.maxRounds ?? "(default)"} auth=${harness.authPreference} limit_action=${harness.profileLimitAction}`,
    );
  }
}
