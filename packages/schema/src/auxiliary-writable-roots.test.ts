import { describe, expect, it } from "vitest";
import { runAuxiliaryWritableRootsViolation } from "./auxiliary-writable-roots.js";
import { ControlRunStartRequest, RunExecution } from "./control.js";
import { ControlThreadTurnRequest } from "./control-operation-responses.js";
import { AgentCapabilityCatalog } from "./agent-capabilities.js";
import { HarnessCapabilityProfile, HarnessRunSpec } from "./harness.js";
import { ActiveTaskContract, TaskContract } from "./task.js";

describe("execution.auxiliaryWritableRoots contract", () => {
  it("keeps the caller spelling on run and thread-turn requests", () => {
    const roots = ["/srv/cache/uv", "/srv/cache/uv/"];
    expect(RunExecution.parse({ auxiliaryWritableRoots: roots }).auxiliaryWritableRoots).toEqual(
      roots,
    );
    expect(RunExecution.parse({}).auxiliaryWritableRoots).toBeUndefined();
    expect(RunExecution.parse({ auxiliaryWritableRoots: [] }).auxiliaryWritableRoots).toEqual([]);
    expect(RunExecution.safeParse({ auxiliaryWritableRoots: [""] }).success).toBe(false);
    expect(
      ControlRunStartRequest.parse({ prompt: "p", execution: { auxiliaryWritableRoots: roots } })
        .execution.auxiliaryWritableRoots,
    ).toEqual(roots);
    expect(
      ControlThreadTurnRequest.parse({ prompt: "p", execution: { auxiliaryWritableRoots: roots } })
        .execution?.auxiliaryWritableRoots,
    ).toEqual(roots);
    // The turn still cannot rebind the thread's delegated execution tree.
    expect(
      ControlThreadTurnRequest.safeParse({ prompt: "p", execution: { workspaceRoot: "/w" } })
        .success,
    ).toBe(false);
  });

  it("is a typed access conflict outside an Agent run with workspace_write", () => {
    const roots = { execution: { auxiliaryWritableRoots: ["/srv/cache"] } };
    expect(runAuxiliaryWritableRootsViolation({ execution: {} }, "readonly")).toBeNull();
    expect(
      runAuxiliaryWritableRootsViolation({ execution: { auxiliaryWritableRoots: [] } }, "full"),
    ).toBeNull();
    expect(runAuxiliaryWritableRootsViolation(roots, "workspace_write")).toBeNull();
    // An omitted Agent access is the configured default, decided later.
    expect(runAuxiliaryWritableRootsViolation(roots, undefined)).toBeNull();
    for (const access of ["readonly", "full", "inherit_native"] as const) {
      const violation = runAuxiliaryWritableRootsViolation(roots, access);
      expect(violation).toMatchObject({
        code: "auxiliary_writable_roots_access_conflict",
        retryable: false,
      });
      expect(violation?.requiredActions[0]).toContain("POST /v2/runs");
      expect(violation?.requiredActions[0]).toContain("complete replacement execution group");
      expect(violation?.requiredActions[0]).toContain("claudexor_run_continue cannot replace");
    }
    for (const mode of ["ask", "plan"] as const) {
      expect(
        runAuxiliaryWritableRootsViolation({ ...roots, mode }, "workspace_write"),
      ).toMatchObject({ code: "auxiliary_writable_roots_access_conflict" });
    }
  });

  it("decodes historical contracts, specs and manifests as no extra grant", () => {
    expect(TaskContract.shape.access.parse(undefined).auxiliary_writable_roots).toEqual([]);
    expect(
      TaskContract.shape.access.parse({
        requested_profile: "workspace_write",
        effective_profile: "workspace_write",
      }).auxiliary_writable_roots,
    ).toEqual([]);
    expect(
      ActiveTaskContract.shape.access.parse({
        effective_profile: "workspace_write",
        auxiliary_writable_roots: ["/srv/cache"],
      }).auxiliary_writable_roots,
    ).toEqual(["/srv/cache"]);
    expect(
      HarnessRunSpec.parse({ session_id: "s", intent: "implement", prompt: "p", cwd: "/w" })
        .auxiliary_writable_roots,
    ).toEqual([]);
    expect(HarnessCapabilityProfile.parse({}).access_control.auxiliary_writable_roots).toBe(false);
  });

  it("defaults the negotiated catalog row to unsupported for older engines", () => {
    const row = AgentCapabilityCatalog.shape.harnesses.element.shape.accessControl;
    expect(row.parse(undefined)).toEqual({ auxiliaryWritableRoots: false });
    expect(row.parse({ auxiliaryWritableRoots: true })).toEqual({ auxiliaryWritableRoots: true });
  });
});
