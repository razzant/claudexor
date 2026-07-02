/**
 * `claudexor settings show|set` — user defaults over the layered config, with
 * the same strict validation the daemon settings endpoint applies (D3): model
 * values pass the harness truth source, effort passes the declared ladder,
 * and routing ids must be REAL harnesses (fakes never persist).
 */
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { validateModel } from "@claudexor/core";
import {
  ControlSettingsSnapshot,
  EffortHint,
  GlobalConfig,
  Portfolio,
} from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { buildRegistry, harnessModels } from "./registry.js";
import { daemonRuntimeDiffLines } from "./settings-display.js";

function print(s: string): void {
  process.stdout.write(s + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * A REAL harness id (fakes excluded), for `settings set` validation. A persistent
 * routing default is not an explicit per-run selection, so a `fake-*` fixture must
 * never be accepted as primary/eligible (it could route ordinary runs to a fake).
 */
function isKnownHarness(id: string): boolean {
  return buildRegistry({ includeFakes: false }).has(id);
}

async function daemonSettingsSnapshotIfRunning() {
  const conn = await connectDaemonIfRunning();
  if (!conn) return null;
  try {
    const res = await fetch(`${conn.addr.baseUrl}/settings`, {
      headers: { Authorization: `Bearer ${conn.addr.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return ControlSettingsSnapshot.parse(await res.json());
  } catch {
    return null;
  }
}

export async function settingsCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "show";
  if (sub === "show") {
    const cfg = loadConfig(process.cwd());
    if (json) printJson(cfg);
    else {
      print(`sources: ${cfg.sources.length ? cfg.sources.join(", ") : "(defaults)"}`);
      print(`default_portfolio: ${cfg.global.default_portfolio}`);
      print(`routing.default_policy: ${cfg.global.routing.default_policy}`);
      print(`routing.primary_harness: ${cfg.global.routing.primary_harness ?? "(none)"}`);
      print(
        `routing.eligible_harnesses: ${cfg.global.routing.eligible_harnesses.length ? cfg.global.routing.eligible_harnesses.join(", ") : "(auto)"}`,
      );
      print(`routing.env_inheritance: ${cfg.global.routing.env_inheritance}`);
      print(`budget.max_usd_per_run: ${cfg.global.budget.max_usd_per_run ?? "(none)"}`);
      print(`interaction_timeout_ms: ${cfg.global.interaction_timeout_ms}`);
      print(`runtime.reviewer_timeout_ms: ${cfg.global.runtime.reviewer_timeout_ms}`);
      print(
        `runtime.transient_retry.max_retries: ${cfg.global.runtime.transient_retry.max_retries}`,
      );
      print(
        `runtime.transient_retry.initial_delay_ms: ${cfg.global.runtime.transient_retry.initial_delay_ms}`,
      );
      print(
        `runtime.transient_retry.max_delay_ms: ${cfg.global.runtime.transient_retry.max_delay_ms}`,
      );
      const harnessIds = Object.keys(cfg.global.harnesses);
      if (harnessIds.length) {
        print("harnesses:");
        for (const id of harnessIds) {
          const h = cfg.global.harnesses[id]!;
          print(
            `  ${id}: enabled=${h.enabled} model=${h.default_model ?? "(native)"} effort=${h.effort ?? "(native)"} web=${h.web} max_turns=${h.max_turns ?? "(none)"} max_usd=${h.max_usd ?? "(none)"}`,
          );
        }
      }
      const daemonSettings = await daemonSettingsSnapshotIfRunning();
      if (daemonSettings) {
        const diffLines = daemonRuntimeDiffLines(cfg, daemonSettings);
        for (const line of diffLines) print(line);
      }
    }
    return 0;
  }
  if (sub === "set") {
    const key = args._[2];
    const value = args._[3];
    if (!key || value === undefined) {
      print(
        "usage: claudexor settings set default_portfolio|primary_harness|eligible_harnesses|harness.<id>.default_model|harness.<id>.fallback_model|harness.<id>.effort|env_inheritance|routing_policy|budget_max_usd_per_run|interaction_timeout_ms <value>",
      );
      return 2;
    }
    try {
      // Harness-scoped model/effort keys (D2/INV-103: model choice is
      // harness-scoped — there is no global model setting). Values are
      // validated against the harness's truth source BEFORE persisting, the
      // same strict gate the daemon settings endpoint applies.
      const harnessKey = /^harness\.([^.]+)\.(default_model|fallback_model|effort)$/.exec(key);
      if (harnessKey) {
        const [, harnessId, field] = harnessKey as unknown as [string, string, "default_model" | "fallback_model" | "effort"];
        if (!isKnownHarness(harnessId))
          throw new Error(`unknown harness '${harnessId}' (run \`claudexor harness list --all\`)`);
        const cleared = value === "none";
        if (!cleared && (field === "default_model" || field === "fallback_model")) {
          const truth = await harnessModels(harnessId, process.cwd(), true);
          const check = validateModel(
            value,
            truth.models.map((m) => m.id),
            truth.source === "api" ? "api" : "manifest",
          );
          if (check.status !== "ok") {
            throw new Error(
              `harness '${harnessId}' refused ${field} '${value}' (truth source: ${truth.source}): ${check.message}`,
            );
          }
        }
        let effortValue: EffortHint | null = null;
        if (!cleared && field === "effort") {
          effortValue = EffortHint.parse(value);
          const adapter = buildRegistry({ includeFakes: true }).get(harnessId);
          const ladder = adapter ? (await adapter.discover()).capabilities.effort_levels : [];
          if (!ladder.includes(effortValue)) {
            throw new Error(
              ladder.length === 0
                ? `harness '${harnessId}' declares no effort ladder; leave effort unset`
                : `harness '${harnessId}' does not accept effort '${value}' (declared ladder: ${ladder.join(", ")})`,
            );
          }
        }
        const res = updateGlobalConfig((cfg) => {
          const base =
            cfg.harnesses[harnessId] ??
            GlobalConfig.shape.harnesses.removeDefault().valueSchema.parse({});
          return {
            ...cfg,
            harnesses: {
              ...cfg.harnesses,
              [harnessId]: {
                ...base,
                ...(field === "default_model" ? { default_model: cleared ? null : value } : {}),
                ...(field === "fallback_model" ? { fallback_model: cleared ? null : value } : {}),
                ...(field === "effort" ? { effort: cleared ? null : effortValue } : {}),
              },
            },
          };
        });
        if (json) printJson(res);
        else print(`updated ${key} in ${res.path}`);
        return 0;
      }
      const res = updateGlobalConfig((cfg) => {
        if (key === "default_portfolio") {
          const p = Portfolio.parse(value);
          return { ...cfg, default_portfolio: p };
        }
        if (key === "primary_harness") {
          if (value !== "none" && !isKnownHarness(value))
            throw new Error(`unknown harness '${value}' (run \`claudexor harness list --all\`)`);
          return {
            ...cfg,
            routing: { ...cfg.routing, primary_harness: value === "none" ? null : value },
          };
        }
        if (key === "eligible_harnesses") {
          const list =
            value === "none"
              ? []
              : value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
          const unknown = list.filter((h) => !isKnownHarness(h));
          if (unknown.length)
            throw new Error(
              `unknown harness(es): ${unknown.join(", ")} (run \`claudexor harness list --all\`)`,
            );
          return { ...cfg, routing: { ...cfg.routing, eligible_harnesses: list } };
        }
        if (key === "default_model") {
          throw new Error(
            "the global default_model setting was removed (model choice is harness-scoped, INV-103); use `claudexor settings set harness.<id>.default_model <model>`",
          );
        }
        if (key === "env_inheritance") {
          if (!["mirror_native", "clean"].includes(value))
            throw new Error("env_inheritance must be mirror_native|clean");
          return { ...cfg, routing: { ...cfg.routing, env_inheritance: value as never } };
        }
        if (key === "routing_policy") {
          if (!["auto", "primary", "portfolio"].includes(value))
            throw new Error("routing_policy must be auto|primary|portfolio");
          return { ...cfg, routing: { ...cfg.routing, default_policy: value as never } };
        }
        if (key === "budget_max_usd_per_run") {
          // Number() parses the WHOLE string ('1abc' -> NaN), unlike parseFloat.
          const parsed = value === "none" ? null : Number(value.trim());
          if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || value.trim() === ""))
            throw new Error(`${key} must be a non-negative number or none`);
          return { ...cfg, budget: { ...cfg.budget, max_usd_per_run: parsed } };
        }
        if (key === "interaction_timeout_ms") {
          const parsed = Number(value.trim());
          if (!Number.isInteger(parsed) || parsed <= 0)
            throw new Error("interaction_timeout_ms must be a positive integer (milliseconds)");
          return { ...cfg, interaction_timeout_ms: parsed };
        }
        throw new Error(`unknown setting: ${key}`);
      });
      if (json) printJson(res);
      else print(`updated ${key} in ${res.path}`);
      return 0;
    } catch (err) {
      process.stderr.write(
        `claudexor settings: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  print("usage: claudexor settings show|set");
  return 2;
}
