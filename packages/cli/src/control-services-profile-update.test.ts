import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  ControlCredentialProfilesResponse,
  ControlCredentialProfileUpdateResponse,
} from "@claudexor/schema";
import { controlServices } from "./control-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";

// PATCH /credential-profiles/:harness/:id (the Enabled toggle of the accounts
// symmetry, INV-135) + the per-harness accounts-authority projection served on
// the listing so no surface re-derives Active/native truth.

function services() {
  const threads = {
    invalidateCredentialProfile: () => ({ clearedThreads: 0, invalidatedSessions: 0 }),
    listThreads: () => [] as unknown[],
  };
  const quota = { removeSubject: () => 0 };
  return controlServices(
    undefined as never,
    undefined as never,
    threads as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => quota) as never,
    async () => [],
  );
}

describe("updateCredentialProfile (INV-135 Enabled toggle) + accounts projection", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profile-update-"));
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

  it("flips the profile's durable enabled flag and returns the receipt", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    const off = ControlCredentialProfileUpdateResponse.parse(
      await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false }),
    );
    expect(off.profile.enabled).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles[0]?.enabled).toBe(false);
    const on = ControlCredentialProfileUpdateResponse.parse(
      await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: true }),
    );
    expect(on.profile.enabled).toBe(true);
  });

  it("refuses an unknown id with a typed 404 and a missing enabled with a 400", async () => {
    const svc = services();
    await expect(
      svc.updateCredentialProfile({ harnessId: "claude", profileId: "ghost", enabled: true }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.updateCredentialProfile({ harnessId: "claude", profileId: "work" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("projects per-harness accounts authority: native default, Active pin, and disabled-CLI-login none", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();

    // Default: no Active pin, CLI login enabled → Active identity is native.
    const base = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const claudeBase = base.harnessAccounts.find((h) => h.harness_id === "claude");
    expect(claudeBase).toBeDefined();
    expect(claudeBase?.active_profile_id).toBeNull();
    expect(claudeBase?.native_credentials_enabled).toBe(true);
    expect(claudeBase?.active_identity).toEqual({ kind: "native" });

    // Pin Active → the profile is the Active identity.
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        claude: { ...(config.harnesses.claude ?? {}), active_profile_id: "work" },
      } as never,
    }));
    const pinned = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(pinned.harnessAccounts.find((h) => h.harness_id === "claude")?.active_identity).toEqual({
      kind: "profile",
      profileId: "work",
    });

    // Disable the CLI login with no Active pin → nothing routable (none).
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        claude: {
          ...(config.harnesses.claude ?? {}),
          active_profile_id: null,
          native_credentials_enabled: false,
        },
      } as never,
    }));
    const none = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const claudeNone = none.harnessAccounts.find((h) => h.harness_id === "claude");
    expect(claudeNone?.native_credentials_enabled).toBe(false);
    expect(claudeNone?.active_identity.kind).toBe("none");
  });
});
