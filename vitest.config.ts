import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "benchmarks/runner/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    clearMocks: true,
  },
});
