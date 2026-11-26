import { afterEach, expect, it, vi } from "vitest";
import { defineHarnessProgram } from "./program-registry.js";
import { invalidateProgramObservations, observeHarnessProgram } from "./program-observation.js";

const asked = vi.hoisted(() => [] as Array<{ windowsConsole?: string } | undefined>);
vi.mock("./selected-program.js", async (original) => {
  const actual = await original<typeof import("./selected-program.js")>();
  return {
    ...actual,
    // No version process: record the options the observation asks with.
    resolveSelectedProgramAsync: async (
      program: Parameters<typeof actual.resolveSelectedProgramAsync>[0],
      options: Parameters<typeof actual.resolveSelectedProgramAsync>[1],
    ) => {
      asked.push(options);
      return { ...actual.selectProgramEntry(program, options).observed, version: "1.0.0" };
    },
  };
});

afterEach(() => {
  asked.length = 0;
  invalidateProgramObservations();
}, 0);

const program = defineHarnessProgram({
  id: "console-fixture",
  overrideEnv: "CONSOLE_FIXTURE_BIN",
  launchers: [{ name: "console-fixture" }],
  installationEnv: [],
  platforms: {},
});

it("asks its version under the caller's Windows console policy, keyed without it", async () => {
  const bin = "/fixture/console-fixture";
  const plain = await observeHarnessProgram(program, undefined, bin, { fresh: true });
  const none = await observeHarnessProgram(program, undefined, bin, {
    fresh: true,
    windowsConsole: "none",
  });
  expect(asked.map((options) => options?.windowsConsole)).toEqual([undefined, "none"]);
  expect(none.key).toBe(plain.key);
});
