import { describe, expect, it } from "vitest";
import { extractJsonBlocks } from "./findings.js";

describe("extractJsonBlocks", () => {
  it("accepts a final bare JSON array after explanatory reviewer text", () => {
    expect(
      extractJsonBlocks(
        [
          "I inspected the evidence packet and found no legitimate defects.",
          "",
          "[]",
        ].join("\n"),
      ),
    ).toEqual([[]]);
  });
});
