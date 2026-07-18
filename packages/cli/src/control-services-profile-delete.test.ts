import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import { controlServices } from "./control-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";

// DELETE /credential-profiles/:harness/:id — the one branch of the accounts
// scope that recursively deletes a directory. These tests pin the review-wave
// findings: the 409 active-login guard, the delete-grade profiles-tree fence
// (stricter than the creation-grade confinement, which accepts the owned root
// itself), honest cleanup reporting, and warning disclosure over silence.

function servicesWithJobs(jobs: Array<Record<string, unknown>>) {
  const setupBinding = { current: () => ({ list: () => jobs }) };
  const threads = {
    invalidateCredentialProfile: () => ({ clearedThreads: 0, invalidatedSessions: 0 }),
  };
  const quota = { removeSubject: () => 0 };
  return controlServices(
    undefined as never,
    undefined as never,
    threads as never,
    setupBinding as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => quota) as never,
    async () => [],
  );
}

describe("deleteCredentialProfile (INV-135 delete service)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profile-delete-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the registry entry AND the scoped login dir, honestly receipted", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const locator = profile.isolation_locator as string;
    expect(existsSync(locator)).toBe(true);
    const receipt = (await servicesWithJobs([]).deleteCredentialProfile({
      harnessId: "claude",
      profileId: "work",
    })) as { removed: boolean; credentialCleanup: string; cleanupWarning?: string };
    expect(receipt.removed).toBe(true);
    expect(receipt.credentialCleanup).toBe("config_dir_removed");
    expect(receipt.cleanupWarning).toBeUndefined();
    expect(existsSync(locator)).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });

  it("reports 'none' when the login dir never existed (no fake removal claim)", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "codex", profileId: "fresh" });
    rmSync(profile.isolation_locator as string, { recursive: true, force: true });
    const receipt = (await servicesWithJobs([]).deleteCredentialProfile({
      harnessId: "codex",
      profileId: "fresh",
    })) as { credentialCleanup: string; cleanupWarning?: string };
    expect(receipt.credentialCleanup).toBe("none");
    expect(receipt.cleanupWarning).toBeUndefined();
  });

  it("refuses with a typed 409 while a login job for the account is active", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const services = servicesWithJobs([{ jobId: "setup-1", state: "running", profileId: "work" }]);
    await expect(
      services.deleteCredentialProfile({ harnessId: "claude", profileId: "work" }),
    ).rejects.toMatchObject({ status: 409 });
    // The registry must be untouched after the refusal.
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });

  it("delete-grade fence: never rm -rf outside the profiles tree — disclosed, not silent", async () => {
    // Simulate a hand-edited registry entry whose locator escapes the
    // profiles tree while staying inside the owned root (the creation-grade
    // confinement accepts it; the DELETE fence must not).
    registerConfigDirProfile({ harnessId: "claude", profileId: "escape" });
    const { updateGlobalConfig } = await import("@claudexor/config");
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((profile) =>
        profile.profile_id === "escape" ? { ...profile, isolation_locator: dir } : profile,
      ),
    }));
    const receipt = (await servicesWithJobs([]).deleteCredentialProfile({
      harnessId: "claude",
      profileId: "escape",
    })) as { removed: boolean; credentialCleanup: string; cleanupWarning?: string };
    // Registry entry gone, but the owned root itself survives — the failed
    // cleanup is disclosed as a warning, never silently ignored.
    expect(receipt.removed).toBe(true);
    expect(receipt.credentialCleanup).toBe("none");
    expect(receipt.cleanupWarning).toMatch(/not inside the profiles tree/);
    expect(existsSync(join(dir, "config.yaml"))).toBe(true);
  });

  it("unknown ids refuse with a typed 404 before any cleanup", async () => {
    await expect(
      servicesWithJobs([]).deleteCredentialProfile({ harnessId: "claude", profileId: "ghost" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
