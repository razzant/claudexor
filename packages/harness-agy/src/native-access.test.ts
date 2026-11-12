import { describe, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { createAgyAdapter } from "./index.js";

/** #413: the receipt names Antigravity's own permission mode as passed. */
const spec = (access: string): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-agy-native-access",
    intent: "implement",
    prompt: "go",
    cwd: "/repo",
    access,
  });

describe("agy native access disclosure", () => {
  it.each([
    ["readonly", "--mode plan"],
    ["workspace_write", "--mode accept-edits"],
    ["full", "--dangerously-skip-permissions"],
    ["inherit_native", null],
  ])("%s discloses %s", (access, expected) => {
    expect(createAgyAdapter().nativeAccess?.(spec(access))).toBe(expected);
  });
});
