import { describe, expect, it } from "vitest";
import { parseReplLine } from "./repl.js";

describe("parseReplLine", () => {
  it("treats bare text and /best-of as agent (write) turns", () => {
    expect(parseReplLine("fix the bug")).toMatchObject({ mode: "agent", prompt: "fix the bug" });
    expect(parseReplLine("/best-of make it faster")).toMatchObject({
      mode: "agent",
      prompt: "make it faster",
      race: true,
    });
  });

  it("maps read-only commands to their read-only modes", () => {
    expect(parseReplLine("/ask why")).toMatchObject({ mode: "ask" });
    expect(parseReplLine("/plan do x")).toMatchObject({ mode: "plan" });
  });

  it("parses /harness and /profile sticky-preference commands with their id arg", () => {
    expect(parseReplLine("/harness codex")).toEqual({ command: "harness", arg: "codex" });
    expect(parseReplLine("/profile work")).toEqual({ command: "profile", arg: "work" });
    expect(parseReplLine("/profile default")).toEqual({ command: "profile", arg: "default" });
  });

  it("parses a bare /harness or /profile as a clear (empty arg)", () => {
    expect(parseReplLine("/harness")).toEqual({ command: "harness", arg: "" });
    expect(parseReplLine("/profile")).toEqual({ command: "profile", arg: "" });
  });
});
