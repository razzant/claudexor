import { describe, expect, it } from "vitest";
import { cursorStatusAuthenticated } from "./index.js";

describe("cursor auth status parsing", () => {
  it("does not treat exit 0 Not logged in as authenticated", () => {
    expect(cursorStatusAuthenticated(0, "Not logged in\n")).toBe(false);
  });

  it("recognizes authenticated status text", () => {
    expect(cursorStatusAuthenticated(0, "Logged in as user@example.com\n")).toBe(true);
    expect(cursorStatusAuthenticated(0, "Authenticated\n")).toBe(true);
  });

  it("fails closed on non-zero status probes", () => {
    expect(cursorStatusAuthenticated(1, "Logged in as user@example.com\n")).toBe(false);
  });
});
