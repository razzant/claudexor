import { describe, expect, it } from "vitest";
import { flagBool, flagStr, flagStringList, flagValues, parseArgs, requiredStringFlagError } from "./args.js";

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

  it("preserves repeated flag values while flagStr keeps last-value compatibility", () => {
    const args = parseArgs(["run", "fix", "--test", "pnpm build", "--test=pnpm test", "--harness", "codex", "--harness", "claude"]);
    expect(flagValues(args, "test")).toEqual(["pnpm build", "pnpm test"]);
    expect(flagStr(args, "test")).toBe("pnpm test");
    expect(flagValues(args, "harness")).toEqual(["codex", "claude"]);
    expect(flagStr(args, "harness")).toBe("claude");
  });

  it("collects repeated and comma-separated string-list flags for run options", () => {
    const args = parseArgs([
      "run",
      "fix",
      "--harness",
      "codex, claude",
      "--harness",
      "cursor",
      "--attach",
      "a.txt,b.txt",
      "--attach",
      "c.txt",
      "--image",
      "shot.png",
      "--image",
      "diagram.jpg, icon.png",
    ]);
    expect(flagStringList(args, "harness")).toEqual(["codex", "claude", "cursor"]);
    expect(flagStringList(args, "attach")).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(flagStringList(args, "image")).toEqual(["shot.png", "diagram.jpg", "icon.png"]);
  });

  it("rejects empty comma-separated entries in string-list flags", () => {
    expect(() => flagStringList(parseArgs(["run", "fix", "--harness", "codex,,claude"]), "harness")).toThrow(
      /invalid --harness value/,
    );
    expect(() => flagStringList(parseArgs(["run", "fix", "--attach", "a.txt,"]), "attach")).toThrow(
      /invalid --attach value/,
    );
    expect(() => flagStringList(parseArgs(["run", "fix", "--image", ",shot.png"]), "image")).toThrow(
      /invalid --image value/,
    );
  });

  it("stores flags in a prototype-free map", () => {
    const args = parseArgs(["run", "--toString", "literal", "--__proto__", "not-a-prototype"]);
    expect(Object.getPrototypeOf(args.flags)).toBeNull();
    expect(flagStr(args, "toString")).toBe("literal");
    expect(flagStr(args, "__proto__")).toBe("not-a-prototype");
    expect(Object.prototype.hasOwnProperty.call(args.flags, "__proto__")).toBe(true);
  });

  it("rejects value-taking flags when no value is provided", () => {
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--spec", "--json"]), ["spec"])).toBe("claudexor: --spec requires a value");
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--spec="]), ["spec"])).toBe("claudexor: --spec requires a value");
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--spec", "spec.json"]), ["spec"])).toBeNull();
    expect(requiredStringFlagError(parseArgs(["run", "fix it", "--test", "pnpm build", "--test", "--json"]), ["test"])).toBe(
      "claudexor: --test requires a value",
    );
  });
});

describe("boolean flags never eat positionals", () => {
  it("--json before a positional keeps both (audit --json x)", () => {
    const a = parseArgs(["audit", "--json", "x"]);
    expect(a._).toEqual(["audit", "x"]);
    expect(flagBool(a, "json")).toBe(true);
  });

  it("value flags still consume their argument", () => {
    const a = parseArgs(["run", "--model", "gpt-5.5", "--json"]);
    expect(a.flags["model"]).toBe("gpt-5.5");
    expect(flagBool(a, "json")).toBe(true);
  });

  it("boolean flag with explicit =false stays honest", () => {
    const a = parseArgs(["run", "--json=false", "task"]);
    expect(flagBool(a, "json")).toBe(false);
    expect(a._).toEqual(["run", "task"]);
  });
});
