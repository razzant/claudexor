import { describe, expect, it } from "vitest";
import {
  AGY_READONLY_MIN_CLI_VERSION,
  AGY_VENDOR_CLI_VERSION,
  AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
  agyReadonlyDoctorCheck,
  agyWorkspaceWriteDoctorCheck,
} from "./vendor-cli-version.js";

describe("agy minimum CLI versions (#653)", () => {
  it("keeps readonly and workspace_write minimums separate from the fixture pin", () => {
    expect(AGY_READONLY_MIN_CLI_VERSION).toBe("1.4.10");
    expect(AGY_WORKSPACE_WRITE_MIN_CLI_VERSION).toBe("1.5.7");
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
    ["1.5.7-rc.1", "pass"],
    ["1.4.10-rc.1", "fail"],
  ] as const)("readonly reports %s as %s", (installed, status) => {
    const check = agyReadonlyDoctorCheck(installed);
    expect(check).toMatchObject({ id: "readonly_min_version", status });
    expect(check.detail).toContain("readonly runs need agy 1.4.10 or newer");
    expect(check.detail).toContain("full runs do not");
    if (status === "fail") expect(check.detail).toContain("update agy");
  });

  it.each([
    ["1.1.13", "fail"],
    ["1.4.10", "fail"],
    ["1.5.6", "fail"],
    ["1.5.7", "pass"],
    ["1.5.14", "pass"],
    ["1.10.0", "pass"],
    ["2.0.0", "pass"],
    ["1.5.7-rc.1", "fail"],
    ["1.6.0-rc.1", "pass"],
  ] as const)("workspace_write reports %s as %s", (installed, status) => {
    const check = agyWorkspaceWriteDoctorCheck(installed);
    expect(check).toMatchObject({ id: "workspace_write_min_version", status });
    expect(check.detail).toContain("workspace_write runs need agy 1.5.7 or newer");
    expect(check.detail).toContain("full runs do not");
    if (status === "fail") expect(check.detail).toContain("update agy");
  });

  it.each([null, "", "agy (version unknown)", "1.5"])(
    "claims nothing about an unknown version (%s)",
    (installed) => {
      expect(agyReadonlyDoctorCheck(installed)).toMatchObject({
        status: "skip",
        detail: expect.stringContaining("installed version unknown"),
      });
      expect(agyWorkspaceWriteDoctorCheck(installed)).toMatchObject({
        status: "skip",
        detail: expect.stringContaining("installed version unknown"),
      });
    },
  );
});
