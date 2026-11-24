import { afterEach, describe, expect, it } from "vitest";
import {
  CGROUP_ENTRY_FAILED_EXIT,
  enterScopeCgroup,
  registerScopeCgroup,
  unregisterScopeCgroup,
} from "./process-cgroup.js";

const MARKER = `CLAUDEXOR_RUN_SCOPE_${"d".repeat(32)}`;
const OTHER = `CLAUDEXOR_RUN_SCOPE_${"e".repeat(32)}`;
const invocation = { binary: "/usr/bin/git", args: ["status", "--short"], env: {} };

afterEach(() => {
  unregisterScopeCgroup(MARKER);
});

describe("enterScopeCgroup", () => {
  it("moves a launch carrying a registered run marker into its cgroup before exec (Linux)", () => {
    registerScopeCgroup(MARKER, "/sys/fs/cgroup/svc/claudexor-runs/job-1/cgroup.procs");
    const launch = enterScopeCgroup(invocation, { [MARKER]: "1", PATH: "/usr/bin" }, "linux");
    expect(launch.binary).toBe("/bin/sh");
    expect(launch.args).toEqual([
      "-c",
      `echo 0 > "$0" || exit ${CGROUP_ENTRY_FAILED_EXIT}; exec "$@"`,
      "/sys/fs/cgroup/svc/claudexor-runs/job-1/cgroup.procs",
      "/usr/bin/git",
      "status",
      "--short",
    ]);
    expect(launch.env).toBe(invocation.env);
  });

  it("leaves every other launch untouched", () => {
    registerScopeCgroup(MARKER, "/sys/fs/cgroup/svc/claudexor-runs/job-1/cgroup.procs");
    expect(enterScopeCgroup(invocation, { [OTHER]: "1" }, "linux")).toBe(invocation);
    expect(enterScopeCgroup(invocation, { [MARKER]: "0" }, "linux")).toBe(invocation);
    expect(enterScopeCgroup(invocation, { [MARKER]: "1" }, "darwin")).toBe(invocation);
    unregisterScopeCgroup(MARKER);
    expect(enterScopeCgroup(invocation, { [MARKER]: "1" }, "linux")).toBe(invocation);
  });
});
