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
  "Run via the Harbor suite at benchmarks/terminal_bench/ (in-place convergence + cross-family review), not this in-CLI scaffold. See benchmarks/terminal_bench/README.md.",
);

export const osWorld = notImplemented(
  "osworld",
  "https://os-world.github.io/ — computer-use benchmark in a VM; requires an OSWorld environment runner.",
);

export const programBench = notImplemented(
  "programbench",
  "https://arxiv.org/html/2605.03546v1 — build-from-scratch tasks; solver uses `claudexor create`, evaluate against the task's spec/tests.",
);
