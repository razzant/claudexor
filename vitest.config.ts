import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "benchmarks/runner/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    clearMocks: true,
    // Hermeticity: no test may touch the operator's real ~/.claudexor.
    setupFiles: ["./vitest.setup.ts"],
  },
});
