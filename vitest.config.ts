import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "benchmarks/runner/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    clearMocks: true,
    // Many suites drive real git worktrees on disk; under full-suite
    // parallelism (one fork per core) individual tests can blow the 5s
    // default on contention spikes. The timeout is a hang detector, not a
    // perf gate — keep it generous.
    testTimeout: 30_000,
    // Hermeticity: no test may touch the operator's real ~/.claudexor.
    setupFiles: ["./vitest.setup.ts"],
  },
});
