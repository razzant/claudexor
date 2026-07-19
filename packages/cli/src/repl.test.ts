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
    expect(parseReplLine("/orchestrate ship it")).toMatchObject({ mode: "orchestrate" });
  });
});
