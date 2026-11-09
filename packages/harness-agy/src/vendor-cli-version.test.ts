import { describe, expect, it } from "vitest";
import {
  AGY_READONLY_MIN_CLI_VERSION,
  AGY_VENDOR_CLI_VERSION,
  agyReadonlyDoctorCheck,
} from "./vendor-cli-version.js";

describe("agy readonly minimum CLI version (#653)", () => {
  it("is its own fact, apart from the fixture and transport pin", () => {
    expect(AGY_READONLY_MIN_CLI_VERSION).toBe("1.4.10");
    expect(AGY_VENDOR_CLI_VERSION).toBe("1.1.13");
  });

  it.each([
    ["1.1.13", "fail"],
    ["1.3.4", "fail"],
    ["1.4.9", "fail"],
    ["1.4.10", "pass"],
    ["1.5.0", "pass"],
    ["2.0.0", "pass"],
    ["1.10.0", "pass"],
  ] as const)("reports %s as %s", (installed, status) => {
    const check = agyReadonlyDoctorCheck(installed);
    expect(check).toMatchObject({ id: "readonly_min_version", status });
    expect(check.detail).toContain("readonly runs need agy 1.4.10 or newer");
    expect(check.detail).toContain("full and workspace_write runs do not");
    if (status === "fail") expect(check.detail).toContain("update agy");
  });

  it.each([null, "", "agy (version unknown)", "1.5"])(
    "claims nothing about an unknown version (%s)",
    (installed) => {
      expect(agyReadonlyDoctorCheck(installed)).toMatchObject({
        status: "skip",
        detail: expect.stringContaining("installed version unknown"),
      });
    },
  );
});
