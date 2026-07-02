import { defineConfig } from "vitest/config";

// Canary golden stories are USER stories, not unit tests: each one drives the
// built CLI (`packages/cli/dist/cli.js`) with offline fake harnesses in a
// hermetic temp environment and asserts the user-visible contract the Bible
// invariant promises. They require `pnpm build` first and are kept out of the
// unit-test run so `pnpm test` stays fast and dist-independent.
export default defineConfig({
  test: {
    include: ["packages/canary/src/**/*.story.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
