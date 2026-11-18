// Copied to the run root in the guest, next to its unmodified src/ checkout.
export default {
  root: import.meta.dirname,
  test: {
    include: ["emit*.test.mjs"],
    setupFiles: ["./src/vitest.setup.ts"],
    maxWorkers: 1,
    passWithNoTests: false,
  },
};
