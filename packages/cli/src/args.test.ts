import { describe, expect, it } from "vitest";
import { commandAllowedFlagError, commandScopedFlagError, flagBool, flagStr, parseArgs, requiredStringFlagError } from "./args.js";

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

  it("rejects plugin-only --force outside plugin commands", () => {
    expect(commandScopedFlagError(parseArgs(["run", "fix it", "--force"]))).toBe("claudexor: --force is only valid for plugin commands");
    expect(commandScopedFlagError(parseArgs(["run", "fix it", "--force=false"]))).toBe("claudexor: --force is only valid for plugin commands");
    expect(commandScopedFlagError(parseArgs(["plugin", "repair", "all", "--force"]))).toBeNull();
  });

  it("rejects --dry-run outside commands that implement dry-run semantics", () => {
    expect(commandScopedFlagError(parseArgs(["run", "fix it", "--dry-run"]))).toBe("claudexor: --dry-run is only valid for plugin and apply commands");
    expect(commandScopedFlagError(parseArgs(["plugin", "install", "all", "--dry-run"]))).toBeNull();
    expect(commandScopedFlagError(parseArgs(["apply", "run_123", "--dry-run"]))).toBeNull();
  });

  it("rejects value-taking flags when no value is provided", () => {
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--spec", "--json"]), ["spec"])).toBe("claudexor: --spec requires a value");
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--spec="]), ["spec"])).toBe("claudexor: --spec requires a value");
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--spec", "spec.json"]), ["spec"])).toBeNull();
  });

  it("rejects unrelated known flags on command-specific allowlists", () => {
    expect(commandAllowedFlagError(parseArgs(["plugin", "install", "all", "--harness", "codex"]), "plugin", ["json", "dry-run", "force"])).toBe(
      "claudexor: flag(s) not valid for plugin commands: --harness",
    );
    expect(commandAllowedFlagError(parseArgs(["plugin", "install", "all", "--dry-run", "--force"]), "plugin", ["json", "dry-run", "force"])).toBeNull();
    expect(commandAllowedFlagError(parseArgs(["run", "fix it", "--harness", "codex"]), "plugin", ["json", "dry-run", "force"])).toBeNull();
  });
});
