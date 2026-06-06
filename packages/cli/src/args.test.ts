import { describe, expect, it } from "vitest";
import { flagBool, flagStr, parseArgs } from "./args.js";

describe("cli args", () => {
  it("parses --in-place as a boolean flag (present => true, absent => false)", () => {
    // Followed by another --flag (how the Terminal-Bench adapter emits it).
    expect(flagBool(parseArgs(["run", "p", "--in-place", "--mode", "max-attempts"]), "in-place")).toBe(true);
    // Trailing boolean flag.
    expect(flagBool(parseArgs(["run", "p", "--in-place"]), "in-place")).toBe(true);
    // Absent.
    expect(flagBool(parseArgs(["run", "p"]), "in-place")).toBe(false);
  });

  it("keeps --mode/--attempts/--access/--reviewer-model reachable alongside --in-place", () => {
    const args = parseArgs([
      "run",
      "--in-place",
      "--mode",
      "max-attempts",
      "--attempts",
      "2",
      "--access",
      "full",
      "--reviewer-model",
      "openai=gpt-x",
      "the instruction",
    ]);
    expect(flagBool(args, "in-place")).toBe(true);
    expect(flagStr(args, "mode")).toBe("max-attempts");
    expect(flagStr(args, "attempts")).toBe("2");
    expect(flagStr(args, "access")).toBe("full");
    expect(flagStr(args, "reviewer-model")).toBe("openai=gpt-x");
    // The instruction remains a positional, not swallowed by the boolean flag.
    expect(args._).toContain("the instruction");
  });
});
