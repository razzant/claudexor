import { describe, expect, it } from "vitest";
import { formatRunEventLine } from "./live.js";

describe("soft run time limit reached notification", () => {
  it("renders only the soft reached control event", () => {
    expect(
      formatRunEventLine({
        type: "control.applied",
        payload: {
          control: { kind: "time_limit", action: "reached" },
          timeLimit: { mode: "soft" },
          message:
            "Soft time limit reached; work continues. The controller may extend, disable, or stop the run.",
        },
      }),
    ).toContain("Soft time limit reached");
    expect(
      formatRunEventLine({
        type: "control.applied",
        payload: {
          control: { kind: "time_limit", action: "reached" },
          timeLimit: { mode: "hard" },
        },
      }),
    ).toBeNull();
    expect(
      formatRunEventLine({
        type: "control.applied",
        payload: { control: { kind: "pause", action: "reached" }, timeLimit: { mode: "soft" } },
      }),
    ).toBeNull();
  });
});
