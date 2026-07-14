#!/usr/bin/env node
/**
 * SWE-bench prediction runner — the concrete `CLAUDEXOR_BENCHMARK_RUNNER` that
 * `benchmarks/swe-bench/make-predictions.sh` shells out to. It loads the exported
 * tasks, runs the locally built Claudexor CLI (`claudexor agent --n N`) inside each
 * prepared per-instance repo, captures the envelope git diff as the SWE-bench
 * `model_patch`, and writes predictions in the official harness shape.
 *
 *   usage: claudexor-bench --tasks <tasks.jsonl> --predictions <preds.jsonl> \
 *                          --workdir <repos-dir> [--n N] [--max-usd X] [--reviewer-model M]
 *
 * Env: CLAUDEXOR_SWE_HARNESS (default "codex"; cross-family review needs >=2 healthy
 * families), CLAUDEXOR_SWE_MODEL_NAME (prediction model_name_or_path, default "claudexor"),
 * CLAUDEXOR_REPO_ROOT (repo root holding packages/cli/dist/cli.js).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasksFromJsonl, writePredictions } from "./swebench.js";
import type { Prediction } from "./types.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function die(msg: string): never {
  process.stderr.write(`[claudexor-bench] ERROR: ${msg}\n`);
  process.exit(2);
}

function log(msg: string): void {
  process.stderr.write(`[claudexor-bench] ${msg}\n`);
}

const tasksPath = flag("tasks") ?? die("--tasks <tasks.jsonl> is required");
const predsPath = flag("predictions") ?? die("--predictions <preds.jsonl> is required");
const workdir = flag("workdir") ?? die("--workdir <repos-dir> is required");
const n = Math.max(1, Number.parseInt(flag("n") ?? "2", 10) || 2);
const maxUsd = flag("max-usd");
const reviewerModel = flag("reviewer-model");
// Per-task wall-clock timeout so one stuck `claudexor agent` can't hang the whole
// sweep. Flag wins over env; default 1800s (30 min). A timed-out task is logged and
// recorded as an EMPTY prediction, then the loop continues.
const taskTimeoutSec = Math.max(
  1,
  Number.parseInt(
    flag("task-timeout-sec") ?? process.env.CLAUDEXOR_SWE_TASK_TIMEOUT_SEC ?? "1800",
    10,
  ) || 1800,
);
const harness = process.env.CLAUDEXOR_SWE_HARNESS || "codex";
const modelName = process.env.CLAUDEXOR_SWE_MODEL_NAME || "claudexor";

const here = dirname(fileURLToPath(import.meta.url));
// dist/cli.js -> repo root is THREE levels up (dist -> runner -> benchmarks -> repo).
const repoRoot = process.env.CLAUDEXOR_REPO_ROOT || resolve(here, "..", "..", "..");
const cliEntry = join(repoRoot, "packages", "cli", "dist", "cli.js");
if (!existsSync(cliEntry)) die(`built CLI not found at ${cliEntry} (run \`pnpm build\` first)`);

const tasks = loadTasksFromJsonl(tasksPath);
if (tasks.length === 0) die(`no tasks loaded from ${tasksPath}`);
log(
  `runner: ${tasks.length} task(s), n=${n}, harness=${harness}, task-timeout=${taskTimeoutSec}s, cli=${cliEntry}`,
);

const workRoot = isAbsolute(workdir) ? workdir : resolve(process.cwd(), workdir);
const predictions: Prediction[] = [];

for (const task of tasks) {
  const dir = join(workRoot, task.instance_id);
  if (!existsSync(join(dir, ".git"))) {
    log(`skip ${task.instance_id}: prepared repo missing at ${dir} (empty prediction)`);
    predictions.push({
      instance_id: task.instance_id,
      model_name_or_path: modelName,
      model_patch: "",
    });
    writePredictions(predictions, predsPath);
    continue;
  }
  const cliArgs = [
    cliEntry,
    "agent",
    task.problem_statement,
    "--n",
    String(n),
    "--harness",
    harness,
    "--json",
  ];
  if (maxUsd) cliArgs.push("--max-usd", maxUsd);
  if (reviewerModel) cliArgs.push("--reviewer-model", reviewerModel);

  log(`solve ${task.instance_id} (${task.repo ?? "?"})`);
  const r = spawnSync(process.execPath, cliArgs, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: process.env,
    timeout: taskTimeoutSec * 1000,
    killSignal: "SIGKILL",
  });

  // A wall-clock timeout (or any signal-kill) leaves no usable patch — record an
  // empty prediction and move on so the sweep doesn't hang on one stuck task.
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    log(`  ${task.instance_id}: TIMED OUT after ${taskTimeoutSec}s (killed); empty patch`);
    predictions.push({
      instance_id: task.instance_id,
      model_name_or_path: modelName,
      model_patch: "",
    });
    writePredictions(predictions, predsPath);
    continue;
  }
  if (r.signal) {
    log(`  ${task.instance_id}: killed by signal ${r.signal}; empty patch`);
    predictions.push({
      instance_id: task.instance_id,
      model_name_or_path: modelName,
      model_patch: "",
    });
    writePredictions(predictions, predsPath);
    continue;
  }

  let patch = "";
  // --json prints exactly one JSON object on stdout; tolerate trailing whitespace.
  const out = (r.stdout ?? "").trim();
  try {
    const start = out.indexOf("{");
    const res = JSON.parse(start >= 0 ? out.slice(start) : out) as {
      runDir?: string;
      status?: string;
    };
    if (res.runDir) {
      const patchFile = join(res.runDir, "final", "patch.diff");
      if (existsSync(patchFile)) patch = readFileSync(patchFile, "utf8");
    }
    log(`  ${task.instance_id}: status=${res.status ?? "?"} patch=${patch.length}B`);
  } catch {
    log(`  ${task.instance_id}: could not parse CLI --json output (exit ${r.status}); empty patch`);
    if (r.stderr) log(`  stderr: ${r.stderr.slice(0, 400)}`);
  }

  predictions.push({
    instance_id: task.instance_id,
    model_name_or_path: modelName,
    model_patch: patch,
  });
  writePredictions(predictions, predsPath); // incremental: survive a mid-run abort
}

writePredictions(predictions, predsPath);
const nonEmpty = predictions.filter((p) => p.model_patch.trim().length > 0).length;
log(`wrote ${predictions.length} prediction(s) (${nonEmpty} non-empty) -> ${predsPath}`);
