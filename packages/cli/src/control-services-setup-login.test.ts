import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigDirProfile } from "./profile-registration.js";

const capability = vi.hoisted(() => ({
  calls: [] as string[],
  project: vi.fn(async () => {
    capability.calls.push("project");
    return {
      status: "ready" as const,
      backend: "windows_conpty" as const,
      capability: { mode: "in_app" as const },
      detail: "ready",
    };
  }),
  assert: vi.fn(() => {
    capability.calls.push("assert");
  }),
}));

vi.mock("./setup-login-capability.js", () => ({
  projectSetupLoginCapability: capability.project,
  assertSetupLoginAdmission: capability.assert,
  effectiveSetupLoginCapability: vi.fn(async () => null),
}));

import { createAccountEvidence } from "@claudexor/daemon";
import { controlServices } from "./control-services.js";

function services(create: (...args: unknown[]) => unknown) {
  const quota = {
    removeSubject: () => 0,
    noteCredentialChange: () => {},
    read: () => ({ snapshots: [], absences: [], refreshed_at: null }),
  };
  return controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    { listThreads: () => [] } as never,
    {
      current: () => ({
        create: (...args: unknown[]) => {
          capability.calls.push("create");
          return create(...args);
        },
        list: () => [],
      }),
    } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => quota) as never,
    createAccountEvidence(),
    () => [],
  );
}

describe("control setup-login admission order", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudexor-setup-admission-"));
    previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    capability.calls = [];
    capability.project.mockClear();
    capability.assert.mockClear();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("rejects required/missing profiles before any host projection or durable create", async () => {
    const create = vi.fn();
    const svc = services(create);
    await expect(
      svc.createSetupJob({
        request: {
          harness: "agy",
          action: "login",
          authRequest: "subscription",
          transport: "daemon",
        },
        idempotencyKey: "required",
        clientId: "test",
      }),
    ).rejects.toMatchObject({ code: "credential_profile_required", status: 400 });
    await expect(
      svc.createSetupJob({
        request: {
          harness: "agy",
          action: "login",
          authRequest: "subscription",
          profileId: "missing",
          transport: "daemon",
        },
        idempotencyKey: "missing",
        clientId: "test",
      }),
    ).rejects.toThrow(/no credential profile/);
    expect(capability.project).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(capability.calls).toEqual([]);
  });

  it("projects the host only after pure validation, then performs one durable create", async () => {
    registerConfigDirProfile({ harnessId: "agy", profileId: "work" });
    const create = vi.fn(() => ({ jobId: "setup-1" }));
    const svc = services(create);
    await expect(
      svc.createSetupJob({
        request: {
          harness: "agy",
          action: "login",
          authRequest: "subscription",
          profileId: "work",
          transport: "daemon",
        },
        idempotencyKey: "ready",
        clientId: "test",
      }),
    ).resolves.toEqual({ jobId: "setup-1" });
    expect(capability.project).toHaveBeenCalledWith("agy", {
      transport: "daemon",
      loginFlow: undefined,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(capability.calls).toEqual(["project", "assert", "create"]);
  });
});
