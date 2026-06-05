import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBenchmark } from "./runner.js";
import { loadTasksFromJsonl, parseSweBenchReport, writePredictions } from "./swebench.js";
import { terminalBench } from "./scaffolds.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "claudex-bench-"));
}

describe("swebench predictions + report", () => {
  it("writes predictions in sb-cli map format", () => {
    const path = join(tmp(), "preds.json");
    writePredictions([{ instance_id: "a__b-1", model_name_or_path: "claudex", model_patch: "diff --git" }], path);
    const j = JSON.parse(readFileSync(path, "utf8"));
    expect(j["a__b-1"].model_patch).toBe("diff --git");
    expect(j["a__b-1"].model_name_or_path).toBe("claudex");
  });

  it("parses the resolved_ids report shape", () => {
    const r = parseSweBenchReport({ resolved_ids: ["i1"], unresolved_ids: ["i2"] });
    expect(r.total).toBe(2);
    expect(r.resolved).toBe(1);
  });

  it("parses tests_status (FAIL_TO_PASS AND PASS_TO_PASS)", () => {
    const r = parseSweBenchReport({
      i1: { tests_status: { FAIL_TO_PASS: { failure: [] }, PASS_TO_PASS: { failure: [] } } },
      i2: { tests_status: { FAIL_TO_PASS: { failure: [] }, PASS_TO_PASS: { failure: ["regressed_test"] } } },
    });
    expect(r.instances.find((x) => x.instance_id === "i1")?.resolved).toBe(true);
    expect(r.instances.find((x) => x.instance_id === "i2")?.resolved).toBe(false);
  });

  it("loads tasks from JSONL", () => {
    const f = join(tmp(), "t.jsonl");
    writeFileSync(f, JSON.stringify({ instance_id: "x__y-1", problem_statement: "fix it", repo: "x/y" }) + "\n");
    const tasks = loadTasksFromJsonl(f);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.instance_id).toBe("x__y-1");
  });
});

describe("runBenchmark", () => {
  it("runs a solver per task, writes predictions, and evaluates", async () => {
    const path = join(tmp(), "preds.json");
    const tasks = [
      { instance_id: "i1", problem_statement: "fix" },
      { instance_id: "i2", problem_statement: "fix2" },
    ];
    const res = await runBenchmark(tasks, async (t) => ({ patch: `diff for ${t.instance_id}` }), {
      predictionsPath: path,
      modelName: "claudex",
      evaluator: async () => ({
        total: 2,
        resolved: 1,
        instances: [
          { instance_id: "i1", resolved: true, fail_to_pass: true, pass_to_pass: true },
          { instance_id: "i2", resolved: false, fail_to_pass: false, pass_to_pass: true },
        ],
      }),
    });
    expect(res.predictions).toHaveLength(2);
    expect(res.report?.resolved).toBe(1);
  });
});

describe("scaffolds", () => {
  it("scaffolded benchmarks throw with a docs pointer", () => {
    expect(() => terminalBench.loadTasks()).toThrow(/scaffold/);
  });
});
