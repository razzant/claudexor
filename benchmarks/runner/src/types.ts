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
