import type { BenchTask } from "./types.js";

/** Scaffolds for benchmarks not yet wired end-to-end (interfaces + docs). */
export interface BenchmarkScaffold {
  id: string;
  status: "implemented" | "scaffold";
  docs: string;
  loadTasks(path?: string): BenchTask[];
}

function notImplemented(id: string, docs: string): BenchmarkScaffold {
  return {
    id,
    status: "scaffold",
    docs,
    loadTasks() {
      throw new Error(`${id} is scaffolded only; see docs: ${docs}`);
    },
  };
}

export const terminalBench = notImplemented(
  "terminal-bench-2.1",
  "https://www.tbench.ai/ — wrap the Terminal-Bench harness; solver runs `claudex run` per task in the provided environment.",
);

export const osWorld = notImplemented(
  "osworld",
  "https://os-world.github.io/ — computer-use benchmark in a VM; requires an OSWorld environment runner.",
);

export const programBench = notImplemented(
  "programbench",
  "https://arxiv.org/html/2605.03546v1 — build-from-scratch tasks; solver uses `claudex create`, evaluate against the task's spec/tests.",
);
