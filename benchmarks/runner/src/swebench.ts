import { readTextSafe, writeJson, writeText } from "@claudexor/util";
import type { BenchTask, Prediction } from "./types.js";

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
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    // Avoid a lone blank line for empty input (the harness json.loads each line).
    writeText(path, body ? body + "\n" : "");
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
