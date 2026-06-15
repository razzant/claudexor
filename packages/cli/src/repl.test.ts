import { describe, expect, it } from "vitest";
import { parseReplLine, replModeIsMutating } from "./repl.js";

describe("parseReplLine", () => {
  it("treats bare text and /race as agent (write) turns", () => {
    expect(parseReplLine("fix the bug")).toMatchObject({ mode: "agent", prompt: "fix the bug" });
    expect(parseReplLine("/race make it faster")).toMatchObject({ mode: "agent", prompt: "make it faster", race: true });
  });

  it("maps read-only commands to their read-only modes", () => {
    expect(parseReplLine("/ask why")).toMatchObject({ mode: "ask" });
    expect(parseReplLine("/plan do x")).toMatchObject({ mode: "plan" });
    expect(parseReplLine("/audit")).toMatchObject({ mode: "audit" });
    expect(parseReplLine("/orchestrate ship it")).toMatchObject({ mode: "orchestrate" });
  });
});

describe("replModeIsMutating (CLI1: mutating turns are daemon-only)", () => {
  it("classifies agent as mutating and the read-only modes as not", () => {
    // The only mutating REPL mode is agent (bare text and /race). The local,
    // daemon-less REPL refuses these and serves read-only turns only.
    expect(replModeIsMutating("agent")).toBe(true);
    for (const ro of ["ask", "plan", "audit", "orchestrate"] as const) {
      expect(replModeIsMutating(ro)).toBe(false);
    }
  });
});
