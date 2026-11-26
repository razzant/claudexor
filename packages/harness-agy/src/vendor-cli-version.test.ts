import { describe, expect, it } from "vitest";
import {
  AGY_READONLY_MIN_CLI_VERSION,
  AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION,
  AGY_VENDOR_CLI_VERSION,
  AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
  agyReadonlyDoctorCheck,
  agyWorkspaceWriteCliFacts,
  agyWorkspaceWriteDoctorCheck,
} from "./vendor-cli-version.js";

describe("agy minimum CLI versions (#653)", () => {
  it("keeps readonly and workspace_write minimums separate from the fixture pin", () => {
    expect(AGY_READONLY_MIN_CLI_VERSION).toBe("1.4.10");
    expect(AGY_STRICT_OVER_ACCEPT_EDITS_MIN_CLI_VERSION).toBe("1.5.7");
    expect(AGY_WORKSPACE_WRITE_MIN_CLI_VERSION).toBe("1.5.8");
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
    ["1.5.7", "fail"],
    ["1.5.8", "pass"],
    ["1.5.14", "pass"],
    ["1.10.0", "pass"],
    ["2.0.0", "pass"],
    ["1.5.8-rc.1", "fail"],
    ["1.6.0-rc.1", "pass"],
    ["1.5.8+build.42", "pass"],
  ] as const)("workspace_write reports %s as %s", (installed, status) => {
    const check = agyWorkspaceWriteDoctorCheck(installed);
    expect(check).toMatchObject({ id: "workspace_write_min_version", status });
    expect(check.detail).toContain(
      "workspace_write runs request agy's terminal sandbox for shell commands on agy 1.5.8 or newer",
    );
    expect(check.detail).toContain("full runs do not");
    expect(check.detail).toContain(
      "run a profile set to strict, or one whose settings cannot be read, only on agy 1.5.7 or newer",
    );
    // An older agy still edits files: the doctor names a lost request, not a stopped run.
    if (status === "fail") {
      expect(check.detail).toContain("edits files");
      expect(check.detail).not.toContain("stops");
      expect(check.detail).toContain("update agy");
    }
    expect(check.detail.includes("refuses a strict or unreadable profile before the model")).toBe(
      ["1.1.13", "1.4.10"].includes(installed),
    );
  });

  it.each([
    ["1.4.9", { determined: true, strictKept: false, terminal: false }],
    ["1.4.10", { determined: true, strictKept: false, terminal: false }],
    ["1.5.7-rc.1", { determined: true, strictKept: false, terminal: false }],
    ["1.5.7", { determined: true, strictKept: true, terminal: false }],
    ["1.5.8", { determined: true, strictKept: true, terminal: true }],
    ["1.6.0-rc.1", { determined: true, strictKept: true, terminal: true }],
    [null, { determined: false, strictKept: false, terminal: false }],
    ["agy (version unknown)", { determined: false, strictKept: false, terminal: false }],
  ] as const)("judges each workspace_write threshold separately for %s", (installed, facts) => {
    expect(agyWorkspaceWriteCliFacts(installed)).toEqual({ installed, ...facts });
  });

  it.each([null, "", "agy (version unknown)", "1.5", "1.5.14+ local build"])(
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
