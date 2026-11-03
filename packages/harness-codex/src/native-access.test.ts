import { describe, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { codexExecArgs, createCodexAdapter } from "./index.js";
import { codexAppServerApprovalParams, codexSandboxMode } from "./sandbox.js";

/**
 * #413: the receipt names Codex's own sandbox and approval settings as the
 * adapter passes them (app-server parameters in production, `exec` argv on the
 * legacy transport), from the same helpers that build them. No setting changes.
 */
const spec = (access: string, resume?: string): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-codex-native-access",
    intent: "implement",
    prompt: "go",
    cwd: "/repo",
    access,
    ...(resume ? { resume_session_id: resume } : {}),
  });

describe("codex native access disclosure", () => {
  it.each([
    ["readonly", "sandbox=read-only approvalPolicy=never approvalsReviewer=auto_review"],
    [
      "workspace_write",
      "sandbox=workspace-write approvalPolicy=on-request approvalsReviewer=auto_review",
    ],
    ["full", "sandbox=danger-full-access approvalPolicy=never approvalsReviewer=auto_review"],
    ["inherit_native", "approvalPolicy=never approvalsReviewer=auto_review"],
  ])("app-server %s discloses the parameters it sends", (access, expected) => {
    const s = spec(access);
    expect(createCodexAdapter().nativeAccess?.(s)).toBe(expected);
    const sandbox = codexSandboxMode(s.access);
    const approval = codexAppServerApprovalParams(s);
    expect(expected).toContain(`approvalPolicy=${String(approval["approvalPolicy"])}`);
    if (sandbox) expect(expected).toContain(`sandbox=${sandbox}`);
  });

  it("legacy exec discloses its argv spelling, including the resume form", () => {
    const exec = createCodexAdapter({ runCliHarness: async function* () {} as never });
    expect(exec.nativeAccess?.(spec("readonly"))).toBe("--sandbox read-only");
    expect(codexExecArgs(spec("readonly")).join(" ")).toContain("--sandbox read-only");
    expect(exec.nativeAccess?.(spec("workspace_write", "thread-1"))).toBe(
      '-c sandbox_mode="workspace-write"',
    );
    expect(codexExecArgs(spec("workspace_write", "thread-1")).join(" ")).toContain(
      '-c sandbox_mode="workspace-write"',
    );
    expect(exec.nativeAccess?.(spec("inherit_native"))).toBeNull();
  });
});
