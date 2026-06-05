#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "@claudex/orchestrator";
import {
  SWE_BENCH_EVAL_INSTRUCTIONS,
  loadTasksFromJsonl,
  runBenchmark,
  writePredictions,
} from "@claudex/benchmark";
import { DaemonClient, defaultSocketPath, logPath, readToken } from "@claudex/daemon";
import { McpServer, defaultClaudexTools } from "@claudex/mcp-server";
import { AcpServer } from "@claudex/acp-server";
import { initProjectConfig } from "@claudex/config";
import type { ModeKind } from "@claudex/schema";
import { flagBool, flagStr, parseArgs, type ParsedArgs } from "./args.js";
import { type PluginHost, installPlugin } from "./plugins.js";
import { buildGateway, buildRegistry } from "./registry.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function orchestratorRunner() {
  const orch = new Orchestrator({ registry: buildRegistry() });
  return async (p: any) => {
    if (p?.mode === "__status") return { harnesses: [...buildRegistry().keys()] };
    return orch.run({
      repoRoot: process.cwd(),
      prompt: String(p?.prompt ?? ""),
      mode: p?.mode,
      harnesses: p?.harness ? [String(p.harness)] : undefined,
      n: typeof p?.n === "number" ? p.n : undefined,
    });
  };
}

const HELP = `claudex — harness-agnostic AI coding control plane (v0.1.0)

Usage:
  claudex init                          Scaffold repo-local config (.claudex/config.yaml)
  claudex doctor [--harness <id>] [--all]   Detect + conformance-test harnesses
  claudex run "<prompt>" [opts]         Run a task (default mode: daily)
  claudex race "<prompt>" [--n N]       Best-of-n tournament with cross-family review
  claudex plan "<prompt>"               Read-only planning report
  claudex create "<prompt>" [--target]  Create-from-scratch (new repo)
  claudex audit | map                   Read-only repo audit / map
  claudex daemon start|status|stop|logs Optional local daemon (claudexd)
  claudex mcp serve                     Expose Claudex as an MCP server (stdio)
  claudex acp serve                     Expose Claudex as an ACP agent (stdio)
  claudex plugin install <host>         Install thin host plugin (cursor|claude|codex|opencode)
  claudex bench list|instructions|run   SWE-bench Verified (+ scaffolds)
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

async function daemonCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1] ?? "status";
  if (sub === "start") {
    const daemonScript = fileURLToPath(new URL("./claudexd.js", import.meta.url));
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
    child.unref();
    print(`claudexd starting (pid ${child.pid}); socket ${defaultSocketPath()}`);
    return 0;
  }
  const token = readToken();
  if (!token) {
    print("daemon not initialized — run: claudex daemon start");
    return 1;
  }
  const client = new DaemonClient(defaultSocketPath(), token);
  try {
    if (sub === "status") {
      const health = await client.health();
      if (json) printJson(health);
      else print(`claudexd: ${JSON.stringify(health)}`);
      return 0;
    }
    if (sub === "stop") {
      await client.shutdown();
      print("claudexd shutting down");
      return 0;
    }
    if (sub === "logs") {
      print(readFileSync(logPath(), "utf8").split("\n").slice(-40).join("\n"));
      return 0;
    }
    print("usage: claudex daemon start|status|stop|logs");
    return 2;
  } catch (err) {
    print(`claudexd not reachable (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
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

    case "daemon":
      return daemonCommand(args, json);

    case "mcp": {
      if (args._[1] === "serve") {
        await new McpServer({
          tools: defaultClaudexTools(orchestratorRunner()),
          transport: { read: process.stdin, write: process.stdout },
        }).serve();
        return 0;
      }
      print("usage: claudex mcp serve");
      return 2;
    }

    case "acp": {
      if (args._[1] === "serve") {
        await new AcpServer({
          runner: orchestratorRunner(),
          transport: { read: process.stdin, write: process.stdout },
        }).serve();
        return 0;
      }
      print("usage: claudex acp serve");
      return 2;
    }

    case "bench": {
      const sub = args._[1];
      if (sub === "list") {
        print("swe-bench-verified [implemented]");
        print("terminal-bench-2.1 [scaffold]");
        print("osworld [scaffold]");
        print("programbench [scaffold]");
        return 0;
      }
      if (sub === "instructions") {
        print(SWE_BENCH_EVAL_INSTRUCTIONS);
        return 0;
      }
      if (sub === "run") {
        const name = args._[2] ?? "swe-bench";
        if (!name.startsWith("swe")) {
          print(`${name} is scaffolded; see 'claudex bench list'`);
          return 2;
        }
        const tasksFile = flagStr(args, "tasks");
        const out = flagStr(args, "predictions") ?? "predictions.json";
        const workdir = flagStr(args, "workdir");
        if (!tasksFile) {
          print("usage: claudex bench run swe-bench --tasks <tasks.jsonl> --predictions <out.json> [--workdir <dir>]");
          return 2;
        }
        const tasks = loadTasksFromJsonl(tasksFile);
        if (!workdir) {
          writePredictions(
            tasks.map((t) => ({ instance_id: t.instance_id, model_name_or_path: "claudex", model_patch: "" })),
            out,
          );
          print(`wrote ${tasks.length} skeleton predictions to ${out}`);
          print("(no --workdir: prepare per-instance repos at <workdir>/<instance_id> to actually solve.)");
          print(SWE_BENCH_EVAL_INSTRUCTIONS);
          return 0;
        }
        const orch = new Orchestrator({ registry: buildRegistry(), portfolio: "benchmark" });
        const res = await runBenchmark(
          tasks,
          async (t) => {
            const r = await orch.run({
              repoRoot: join(workdir, t.instance_id),
              prompt: t.problem_statement,
              mode: "best_of_n",
              n: intFlag(args, "n") ?? 1,
            });
            let patch = "";
            try {
              patch = readFileSync(join(r.runDir, "final", "patch.diff"), "utf8");
            } catch {
              patch = "";
            }
            return { patch };
          },
          { predictionsPath: out, modelName: "claudex" },
        );
        print(`wrote ${res.predictions.length} predictions to ${out}`);
        print(SWE_BENCH_EVAL_INSTRUCTIONS);
        return 0;
      }
      print("usage: claudex bench list|instructions|run");
      return 2;
    }

    case "plugin": {
      const sub = args._[1];
      const host = args._[2] as PluginHost | undefined;
      if (sub === "install" && host) {
        const r = installPlugin(host);
        if (json) printJson(r);
        else {
          print(`installed claudex plugin for ${host}: ${r.path}`);
          print(`  ${r.note}`);
        }
        return 0;
      }
      print("usage: claudex plugin install <cursor|claude|codex|opencode>");
      return 2;
    }

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
