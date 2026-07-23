import { describe, expect, it } from "vitest";
import type { ControlSetupJob } from "@claudexor/schema";
import { terminalLoginReport } from "./setup-login-inline.js";

type TerminalJob = Pick<ControlSetupJob, "state" | "message" | "nativeCommand">;

function receipt(
  errorCode?: "device_auth_unsupported" | "spawn_failed",
): ControlSetupJob["nativeCommand"] {
  return {
    executionId: "exec-1",
    commandDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    permitIssuedAt: null,
    commandStarted: false,
    exitCode: null,
    signal: null,
    ...(errorCode ? { errorCode } : {}),
    finishedAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("D-17 audit 8: CLI terminal login report", () => {
  it("renders device_auth_unsupported as an ACTIONABLE next step, not a dead end", () => {
    const job: TerminalJob = {
      state: "not_supported",
      message: "codex does not expose typed device-code auth over its app-server",
      nativeCommand: receipt("device_auth_unsupported"),
    };
    const report = terminalLoginReport(job, "codex");
    expect(report.exitCode).toBe(1);
    // The consistent typed code is surfaced verbatim…
    expect(report.lines.join("\n")).toContain("device_auth_unsupported");
    // …with the exact actionable next step (start the Terminal sign-in).
    expect(report.lines.join("\n")).toContain("claudexor auth login codex --browser-redirect");
  });

  it("keeps ordinary terminal states on the plain status line", () => {
    expect(
      terminalLoginReport({ state: "succeeded", message: "ok", nativeCommand: undefined }, "codex"),
    ).toEqual({ lines: ["codex login succeeded: ok"], exitCode: 0 });
    // A not_supported WITHOUT the typed code (e.g. vendor not installed) has no
    // Terminal fallback claim — it stays the plain message.
    const bare: TerminalJob = {
      state: "not_supported",
      message: "install codex first",
      nativeCommand: undefined,
    };
    const report = terminalLoginReport(bare, "codex");
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).not.toContain("device_auth_unsupported");
  });
});
