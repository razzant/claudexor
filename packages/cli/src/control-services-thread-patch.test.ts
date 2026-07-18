import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlServices } from "./control-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";

describe("thread PATCH forwarding (release wave round-7 tier1 blocker)", () => {
  it("updateThread forwards EVERY typed patch field — credentialProfileId included", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-thread-patch-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    let seen: Record<string, unknown> | undefined;
    const threads = {
      getThread: () => ({
        credential_profile_id: null,
        eligible_harnesses: [],
        primary_harness: null,
      }),
      updateThread: (_id: string, patch: Record<string, unknown>) => {
        seen = patch;
        return { id: "th-1" };
      },
    };
    const services = controlServices(
      undefined as never,
      undefined as never,
      threads as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      async () => [],
    );
    await services.updateThread("th-1", {
      title: "t",
      state: "active",
      primaryHarness: "claude",
      credentialProfileId: "work",
      eligibleHarnesses: ["claude"],
    });
    // The schema contract promises the sticky profile is settable/clearable;
    // a service-layer drop silently voids it (the exact blocker class).
    expect(seen).toMatchObject({
      title: "t",
      primaryHarness: "claude",
      credentialProfileId: "work",
      eligibleHarnesses: ["claude"],
    });
    await services.updateThread("th-1", { credentialProfileId: null });
    expect(seen).toMatchObject({ credentialProfileId: null });
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("rejects a profile that is incompatible with any explicit pool lane", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-thread-profile-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const threads = {
      getThread: () => ({
        credential_profile_id: null,
        eligible_harnesses: [],
        primary_harness: null,
      }),
    };
    const services = controlServices(
      undefined as never,
      undefined as never,
      threads as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      async () => [],
    );
    await expect(
      services.updateThread("th-1", {
        primaryHarness: "claude",
        credentialProfileId: "work",
        eligibleHarnesses: ["claude", "codex"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  });
});
