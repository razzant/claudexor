import type { RouteProof } from "@claudexor/schema";

export interface BenchTask {
  instance_id: string;
  problem_statement: string;
  repo?: string;
  base_commit?: string;
  meta?: Record<string, unknown>;
}

/** SWE-bench prediction: model_patch is a git diff applied via `git apply`. */
export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface SolveResult {
  patch: string;
  routeProof?: RouteProof;
  costUsd?: number;
}

export type Solver = (task: BenchTask) => Promise<SolveResult>;

export interface InstanceResult {
  instance_id: string;
  resolved: boolean;
  fail_to_pass: boolean;
  pass_to_pass: boolean;
}

export interface BenchReport {
  total: number;
  resolved: number;
  instances: InstanceResult[];
}

export type Evaluator = (predictionsPath: string) => Promise<BenchReport>;

/** Ablation modes for fair comparison against single-harness baselines. */
export type AblationMode =
  | "single_harness_baseline"
  | "tournament"
  | "convergence"
  | "no_synthesis"
  | "no_review"
  | "no_router";

export interface BenchMetrics {
  resolved: boolean;
  attempts: number;
  wall_time_sec: number;
  exact_cost_usd: number | null;
  route_diversity_verified: boolean;
}
