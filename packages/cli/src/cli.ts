#!/usr/bin/env node
import process from "node:process";
import { ExecutionEngine } from "@claudex/core";
import { HarnessGateway } from "@claudex/gateway";
import { initProjectConfig } from "@claudex/config";
import type { ModeKind } from "@claudex/schema";
import { ModeKind as ModeKindEnum } from "@claudex/schema";
import { flagBool, flagStr, parseArgs } from "./args.js";
import { buildGateway, buildRegistry } from "./registry.js";

const HELP = `claudex — harness-agnostic AI coding control plane (v0.1.0)

Usage:
  claudex init                      Scaffold repo-local config (.claudex/config.yaml)
  claudex doctor [--harness <id>] [--all]   Detect + conformance-test harnesses (--all includes fakes)
  claudex run "<prompt>" [opts]     Run a task through the ExecutionEngine
  claudex harness list              List registered harnesses
  claudex help                      Show this help

Options:
  --harness <id>   Force a specific harness
  --mode <mode>    ${ModeKindEnum.options.join(" | ")}
  --json           Machine-readable JSON output
`;

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
      const prompt = args._.slice(1).join(" ").trim();
      if (!prompt) {
        print('error: missing prompt. Usage: claudex run "<prompt>"');
        return 2;
      }
      const modeStr = flagStr(args, "mode");
      const mode: ModeKind | undefined =
        modeStr && (ModeKindEnum.options as readonly string[]).includes(modeStr)
          ? (modeStr as ModeKind)
          : undefined;
      const registry = buildRegistry();
      let harnessId = flagStr(args, "harness");
      if (!harnessId) {
        try {
          harnessId = (await new HarnessGateway(registry).resolve()).id;
        } catch (err) {
          process.stderr.write(`claudex: ${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
      }
      const engine = new ExecutionEngine(registry);
      const res = await engine.run({ repoRoot: cwd, prompt, harnessId, mode });
      if (json) {
        printJson(res);
        return res.status === "success" ? 0 : 1;
      }
      print(`run ${res.runId} ${statusGlyph(res.status === "success" ? "ok" : "unavailable")} via ${res.harnessId} ($${res.costUsd.toFixed(4)})`);
      print(`  artifacts: ${res.runDir}`);
      if (res.changedFiles.length) print(`  changed: ${res.changedFiles.join(", ")}`);
      print("");
      print(res.summary);
      return res.status === "success" ? 0 : 1;
    }

    case "harness": {
      const sub = args._[1];
      if (sub === "list") {
        const ids = new ExecutionEngine(buildRegistry()).listHarnesses();
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
