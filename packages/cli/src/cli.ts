#!/usr/bin/env node
import process from "node:process";
import { Orchestrator } from "@claudex/orchestrator";
import { initProjectConfig } from "@claudex/config";
import type { ModeKind } from "@claudex/schema";
import { flagBool, flagStr, parseArgs, type ParsedArgs } from "./args.js";
import { buildGateway, buildRegistry } from "./registry.js";

const HELP = `claudex — harness-agnostic AI coding control plane (v0.1.0)

Usage:
  claudex init                          Scaffold repo-local config (.claudex/config.yaml)
  claudex doctor [--harness <id>] [--all]   Detect + conformance-test harnesses
  claudex run "<prompt>" [opts]         Run a task (default mode: daily)
  claudex race "<prompt>" [--n N]       Best-of-n tournament with cross-family review
  claudex plan "<prompt>"               Read-only planning report
  claudex create "<prompt>" [--target]  Create-from-scratch (new repo)
  claudex audit | map                   Read-only repo audit / map
  claudex harness list                  List registered harnesses
  claudex help                          Show this help

Options:
  --harness <id[,id...]>   Force harness(es)
  --mode <mode>            daily | plan | create | best_of_n | until_convergence | max_attempts | readonly_swarm | benchmark
  --n <N>                  Candidates for best-of-n
  --attempts <N>           Max attempts (max_attempts mode)
  --json                   Machine-readable JSON output
`;

const MODES = new Set<ModeKind>([
  "daily",
  "plan",
  "create",
  "best_of_n",
  "until_convergence",
  "max_attempts",
  "readonly_swarm",
  "benchmark",
]);

function harnessList(args: ParsedArgs): string[] | undefined {
  const h = flagStr(args, "harness");
  return h ? h.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function intFlag(args: ParsedArgs, key: string): number | undefined {
  const v = flagStr(args, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function orchestrate(args: ParsedArgs, mode: ModeKind, json: boolean): Promise<number> {
  const prompt = args._.slice(1).join(" ").trim();
  if (!prompt && mode !== "readonly_swarm") {
    process.stderr.write('claudex: missing prompt\n');
    return 2;
  }
  const orch = new Orchestrator({ registry: buildRegistry() });
  try {
    const res = await orch.run({
      repoRoot: process.cwd(),
      prompt: prompt || "audit this repository",
      mode,
      harnesses: harnessList(args),
      n: intFlag(args, "n"),
      attempts: intFlag(args, "attempts") ?? null,
    });
    if (json) {
      printJson(res);
    } else {
      print(`run ${res.runId} [${res.status}] mode=${res.mode} winner=${res.winner ?? "none"}`);
      print(`  artifacts: ${res.runDir}`);
      for (const c of res.candidates) print(`  - ${c.attemptId} ${c.harnessId} [${c.status}]`);
      print("");
      print(res.summary);
    }
    return res.status === "success" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`claudex: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function print(s: string): void {
  process.stdout.write(s + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function statusGlyph(status: string): string {
  return status === "ok" ? "[ok]" : status === "degraded" ? "[degraded]" : "[unavailable]";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = flagBool(args, "json");
  const cmd = args._[0] ?? "help";
  const cwd = process.cwd();

  switch (cmd) {
    case "init": {
      const res = initProjectConfig(cwd);
      if (json) printJson(res);
      else print(res.created ? `Created ${res.configPath}` : `Config already exists: ${res.configPath}`);
      return 0;
    }

    case "doctor": {
      const gateway = buildGateway({ includeFakes: flagBool(args, "all") });
      const statuses = await gateway.statusAll({ cwd });
      const only = flagStr(args, "harness");
      const filtered = only ? statuses.filter((s) => s.id === only) : statuses;
      if (json) {
        printJson({ harnesses: filtered });
        return 0;
      }
      for (const s of filtered) {
        const ver = s.manifest?.version ? ` ${s.manifest.version}` : "";
        print(`${statusGlyph(s.status)} ${s.id}${ver}`);
        if (s.enabledIntents.length) print(`    intents: ${s.enabledIntents.join(", ")}`);
        if (s.reasons.length) print(`    reasons: ${s.reasons.join(", ")}`);
      }
      return 0;
    }

    case "run": {
      const modeStr = flagStr(args, "mode");
      const mode: ModeKind = modeStr && MODES.has(modeStr as ModeKind) ? (modeStr as ModeKind) : "daily";
      return orchestrate(args, mode, json);
    }

    case "race":
      return orchestrate(args, "best_of_n", json);

    case "plan":
      return orchestrate(args, "plan", json);

    case "create":
      return orchestrate(args, "create", json);

    case "audit":
    case "map":
      return orchestrate(args, "readonly_swarm", json);

    case "harness": {
      const sub = args._[1];
      if (sub === "list") {
        const ids = [...buildRegistry().keys()];
        if (json) printJson({ harnesses: ids });
        else ids.forEach((id) => print(id));
        return 0;
      }
      print("usage: claudex harness list");
      return 2;
    }

    case "help":
    default:
      print(HELP);
      return 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`claudex: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
