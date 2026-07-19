import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureLaneHomeEnv } from "@claudexor/workspace";
import { controlServices } from "./control-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { updateGlobalConfig } from "@claudexor/config";

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
    await expect(
      services.updateThread("th-1", { credentialProfileId: "ghost" }),
    ).rejects.toMatchObject({ status: 400 });
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("allows title/state edits when an existing pinned profile was disabled", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-thread-disabled-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((profile) => ({
        ...profile,
        enabled: false,
      })),
    }));
    let updated = false;
    const threads = {
      getThread: () => ({
        credential_profile_id: "work",
        eligible_harnesses: ["claude"],
        primary_harness: "claude",
      }),
      updateThread: () => {
        updated = true;
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
    await services.updateThread("th-1", { title: "Renamed" });
    expect(updated).toBe(true);
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("purgeThread sweeps the thread's DURABLE per-lane read-only homes (INV-034 owner a)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-thread-purge-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-purge-repo-"));
    const rt = projectRuntimeDir(repo);
    ensureLaneHomeEnv(rt, "th-1", "claude", "work");
    ensureLaneHomeEnv(rt, "th-1", "codex", null);
    ensureLaneHomeEnv(rt, "th-2", "claude", "work");

    const threads = {
      getThread: () => ({ repo: { root: repo }, workspace: { mode: "in_place" } }),
      purgeThread: (id: string) => ({ id, state: "purged" }),
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

    await services.purgeThread("th-1");

    // Every lane of the purged thread is gone regardless of workspace mode.
    expect(existsSync(join(rt, "lanes", "th-1"))).toBe(false);
    // Another thread's lanes are untouched.
    expect(existsSync(join(rt, "lanes", "th-2"))).toBe(true);

    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
});
