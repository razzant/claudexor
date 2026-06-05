import { readTextSafe, writeJson, writeText } from "@claudex/util";
import type { BenchReport, BenchTask, InstanceResult, Prediction } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Write predictions in a format the official SWE-bench harness accepts:
 * `.jsonl` -> one `{instance_id, model_name_or_path, model_patch}` object per
 * line; any other extension -> a JSON list of the same objects.
 *
 * Each entry MUST carry `instance_id`: the harness loads a `.json` dict via
 * `list(values())`, so a bare `{instance_id: {patch}}` map loses the id and
 * fails the harness's own validation. A list/JSONL of id-bearing objects is the
 * portable shape across `.json` and `.jsonl`.
 */
export function writePredictions(predictions: Prediction[], path: string): void {
  const rows = predictions.map((p) => ({
    instance_id: p.instance_id,
    model_name_or_path: p.model_name_or_path,
    model_patch: p.model_patch,
  }));
  if (path.endsWith(".jsonl")) {
    writeText(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } else {
    writeJson(path, rows);
  }
}

/** Load SWE-bench tasks from a JSONL file (one instance per line). */
export function loadTasksFromJsonl(path: string): BenchTask[] {
  const text = readTextSafe(path);
  if (text === null) return [];
  const tasks: BenchTask[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o: any = JSON.parse(t);
      if (!o.instance_id) continue;
      tasks.push({
        instance_id: String(o.instance_id),
        problem_statement: String(o.problem_statement ?? ""),
        repo: o.repo,
        base_commit: o.base_commit,
        meta: o,
      });
    } catch {
      /* skip malformed line */
    }
  }
  return tasks;
}

/**
 * Parse a SWE-bench harness / sb-cli report into a normalized BenchReport.
 * Resolution requires FAIL_TO_PASS (bug fixed) AND PASS_TO_PASS (no regressions).
 */
export function parseSweBenchReport(json: any): BenchReport {
  const instances: InstanceResult[] = [];

  if (Array.isArray(json?.resolved_ids) || Array.isArray(json?.unresolved_ids)) {
    const resolved = new Set<string>(json.resolved_ids ?? []);
    const all = new Set<string>([
      ...(json.resolved_ids ?? []),
      ...(json.unresolved_ids ?? []),
      ...(json.submitted_ids ?? []),
      ...(json.error_ids ?? []),
    ]);
    for (const id of all) {
      const r = resolved.has(id);
      instances.push({ instance_id: id, resolved: r, fail_to_pass: r, pass_to_pass: r });
    }
  } else if (json && typeof json === "object") {
    for (const [id, v] of Object.entries<any>(json)) {
      if (!v || typeof v !== "object") continue;
      let ftp = true;
      let ptp = true;
      let resolved: boolean;
      if (typeof v.resolved === "boolean") {
        resolved = v.resolved;
        ftp = resolved;
        ptp = resolved;
      } else if (v.tests_status) {
        ftp = (v.tests_status.FAIL_TO_PASS?.failure ?? []).length === 0;
        ptp = (v.tests_status.PASS_TO_PASS?.failure ?? []).length === 0;
        resolved = ftp && ptp;
      } else {
        continue;
      }
      instances.push({ instance_id: id, resolved, fail_to_pass: ftp, pass_to_pass: ptp });
    }
  }

  return { total: instances.length, resolved: instances.filter((i) => i.resolved).length, instances };
}

/** A docs pointer for running the official harness (Docker/sb-cli) locally. */
export const SWE_BENCH_EVAL_INSTRUCTIONS = `Evaluate predictions with the official harness:
  # local (Docker):
  python -m swebench.harness.run_evaluation \\
    --dataset_name princeton-nlp/SWE-bench_Verified --split test \\
    --predictions_path <predictions.json> --run_id claudex
  # or cloud:
  pip install sb-cli && sb login && sb submit swe-bench_verified test --predictions_path <predictions.json>
Resolution = FAIL_TO_PASS ∧ PASS_TO_PASS; the test_patch is hidden from the model.`;
