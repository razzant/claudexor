import type { RouteProof } from "@claudex/schema";
import type { BenchReport, BenchTask, Evaluator, Prediction, Solver } from "./types.js";
import { writePredictions } from "./swebench.js";

export interface RunBenchmarkOptions {
  modelName?: string;
  predictionsPath?: string;
  evaluator?: Evaluator;
}

export interface RunBenchmarkResult {
  predictions: Prediction[];
  routeProofs: RouteProof[];
  report?: BenchReport;
}

/**
 * Generic benchmark runner: produce a prediction per task via the solver, write
 * predictions, and (optionally) evaluate. Reproducibility is the caller's
 * responsibility (immutable base + recorded route proofs + exact versions).
 */
export async function runBenchmark(
  tasks: BenchTask[],
  solver: Solver,
  opts: RunBenchmarkOptions = {},
): Promise<RunBenchmarkResult> {
  const predictions: Prediction[] = [];
  const routeProofs: RouteProof[] = [];
  const modelName = opts.modelName ?? "claudex";

  for (const task of tasks) {
    const r = await solver(task);
    predictions.push({ instance_id: task.instance_id, model_name_or_path: modelName, model_patch: r.patch });
    if (r.routeProof) routeProofs.push(r.routeProof);
  }

  if (opts.predictionsPath) writePredictions(predictions, opts.predictionsPath);

  let report: BenchReport | undefined;
  if (opts.evaluator && opts.predictionsPath) {
    report = await opts.evaluator(opts.predictionsPath);
  }

  return { predictions, routeProofs, report };
}
