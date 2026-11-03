import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import { credentialProfileMutations } from "./credential-profile-mutations.js";
import {
  disabledProfileSharesOsUserCredential,
  profileAccountProjection,
} from "./accounts-projection.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import {
  assertDefaultLoginAllowed,
  preflightSetupJobCreateRequest,
  resolveProfileBinding,
  setupProfileBindingMessage,
} from "./setup-job-support.js";

function mutations(platform: NodeJS.Platform = "win32") {
  return credentialProfileMutations({
    threads: {
      invalidateCredentialProfile: () => ({}),
      listThreads: () => [],
    },
    quotaRegistry: () => ({
      removeSubject: () => 0,
      read: () => ({ snapshots: [], absences: [], refreshed_at: null }),
    }),
    secretStore: { delete: () => true },
    bustStatusCaches: () => {},
    activeLoginJob: () => undefined,
    platform,
  });
}

describe("platform credential-profile cardinality", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudexor-profile-policy-"));
    previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("allows one enabled Windows agy binding and rejects a second create before mkdir", () => {
    registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "win32" });
    const secondHome = join(root, "profiles", "agy-b");
    expect(() =>
      registerConfigDirProfile({ harnessId: "agy", profileId: "b", platform: "win32" }),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        code: "credential_profile_limit_exceeded",
        retryable: false,
        requiredActions: ["disable_extra_profiles"],
      }),
    );
    expect(existsSync(secondHome)).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });

  it("keys disabled-probe suppression on OS-user scope, not a finite cardinality", () => {
    const state = {
      harnessId: "future-shared-harness",
      platform: "win32" as const,
      policy: {
        identity_scope: "os_user" as const,
        max_enabled_profiles: null,
        cleanup_owner: "vendor" as const,
      },
      enabledProfileCount: 0,
      ambiguous: false,
    };
    expect(disabledProfileSharesOsUserCredential(state)).toBe(true);
    expect(
      disabledProfileSharesOsUserCredential({
        ...state,
        policy: { ...state.policy, identity_scope: "profile" },
      }),
    ).toBe(false);
  });

  it("reports an exact duplicate before the platform limit", () => {
    registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "win32" });
    expect(() =>
      registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "win32" }),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        code: "credential_profile_exists",
        fieldErrors: {
          "/profileId": ["A profile with this id already exists for this harness."],
        },
      }),
    );
  });

  it("leaves Darwin/Linux multi-profile behavior unbounded", () => {
    registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "darwin" });
    registerConfigDirProfile({ harnessId: "agy", profileId: "b", platform: "darwin" });
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(2);
  });

  it("allows disable, rejects re-enable at the Windows limit, and fails loud on legacy ambiguity", async () => {
    // Seed a legacy multi-row shape through the still-unbounded Darwin policy.
    registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "darwin" });
    registerConfigDirProfile({ harnessId: "agy", profileId: "b", platform: "darwin" });
    const svc = mutations("win32");

    await expect(
      svc.updateCredentialProfile({ harnessId: "agy", profileId: "a", enabled: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: "credential_profile_ambiguous",
      fieldErrors: {},
      requiredActions: ["disable_extra_profiles"],
    });
    // Explicit disabling is the recovery action and remains permitted.
    const disabled = await svc.updateCredentialProfile({
      harnessId: "agy",
      profileId: "b",
      enabled: false,
    });
    expect(disabled.profile.enabled).toBe(false);
    await expect(
      svc.updateCredentialProfile({ harnessId: "agy", profileId: "b", enabled: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: "credential_profile_limit_exceeded",
      fieldErrors: {
        "/enabled": ["Enabling this profile would exceed the platform limit of 1."],
      },
    });
    expect(
      loadConfig(noProjectRepoRoot()).global.credential_profiles.find(
        (profile) => profile.profile_id === "b",
      )?.enabled,
    ).toBe(false);
  });

  it("normalizes mkdir filesystem failures instead of leaking raw Node errno", () => {
    writeFileSync(join(root, "profiles"), "not a directory");
    try {
      registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "win32" });
      expect.unreachable("mkdir failure must refuse registration");
    } catch (error) {
      expect(error).toMatchObject({ status: 400 });
      expect((error as { code?: unknown }).code).toBeUndefined();
      expect((error as Error).message).toContain("could not register the profile");
    }
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });

  it("deletes the owned Windows binding HOME while reporting vendor OS-user custody unchanged", async () => {
    const vendorSentinel = join(root, "vendor-owned-credential.bin");
    const vendorBytes = Buffer.from([0, 255, 17, 42, 9]);
    writeFileSync(vendorSentinel, vendorBytes, { mode: 0o640 });
    chmodSync(vendorSentinel, 0o640);
    const created = registerConfigDirProfile({
      harnessId: "agy",
      profileId: "a",
      platform: "win32",
    });
    expect(existsSync(created.profile.isolation_locator!)).toBe(true);
    const receipt = await mutations("win32").deleteCredentialProfile({
      harnessId: "agy",
      profileId: "a",
    });
    expect(receipt).toMatchObject({
      removed: true,
      credentialCleanup: "config_dir_removed",
      vendorCredentialDisposition: {
        owner: "vendor",
        state: "left_unchanged",
        scope: "os_user",
      },
    });
    expect(existsSync(created.profile.isolation_locator!)).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toEqual([]);
    expect(readFileSync(vendorSentinel)).toEqual(vendorBytes);
    expect(statSync(vendorSentinel).mode & 0o777).toBe(0o640);
    await expect(
      mutations("win32").deleteCredentialProfile({ harnessId: "agy", profileId: "a" }),
    ).rejects.toBeDefined();
    expect(readFileSync(vendorSentinel)).toEqual(vendorBytes);
    expect(statSync(vendorSentinel).mode & 0o777).toBe(0o640);
  });

  it("projects honest Windows setup copy and the typed named-profile remedy", () => {
    registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "win32" });
    const binding = resolveProfileBinding("agy", "a", "win32");
    expect(binding).not.toBeNull();
    const message = setupProfileBindingMessage("agy", binding!);
    expect(message).toContain("shared by the current OS user");
    expect(message).toContain("not a separate per-folder identity");
    expect(message).toContain("removing the binding does not sign out");
    expect(message).not.toContain("every Google account");

    expect(() => assertDefaultLoginAllowed("agy", false)).toThrow(
      expect.objectContaining({
        status: 400,
        code: "credential_profile_required",
        fieldErrors: {
          "/profileId": ["A named credential profile is required for this harness."],
        },
        requiredActions: ["add_named_account"],
      }),
    );
  });

  it("refuses setup admission for a legacy ambiguous Windows set before selecting a row", () => {
    registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "darwin" });
    registerConfigDirProfile({ harnessId: "agy", profileId: "b", platform: "darwin" });
    expect(() => resolveProfileBinding("agy", "a", "win32")).toThrow(
      expect.objectContaining({
        status: 409,
        code: "credential_profile_ambiguous",
        fieldErrors: {},
      }),
    );
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(2);
  });

  it("performs setup request/profile/cardinality checks without bootstrap mutation", () => {
    const cursor = preflightSetupJobCreateRequest(
      {
        harness: "cursor",
        action: "login",
        authRequest: "subscription",
        transport: "daemon",
      },
      "win32",
    );
    expect(cursor.harness).toBe("cursor");
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toEqual([]);

    expect(() =>
      preflightSetupJobCreateRequest(
        {
          harness: "agy",
          action: "login",
          authRequest: "subscription",
          profileId: "missing",
          transport: "daemon",
        },
        "win32",
      ),
    ).toThrow(/no credential profile/);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toEqual([]);
  });

  it("projects every ambiguous row unavailable/not_run without invoking agy", async () => {
    const marker = join(root, "vendor-called");
    const bin = join(root, "fake-agy");
    writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\n`);
    const previousBin = process.env.CLAUDEXOR_AGY_BIN;
    process.env.CLAUDEXOR_AGY_BIN = bin;
    try {
      registerConfigDirProfile({ harnessId: "agy", profileId: "a", platform: "darwin" });
      registerConfigDirProfile({ harnessId: "agy", profileId: "b", platform: "darwin" });
      const registry = loadConfig(noProjectRepoRoot()).global.credential_profiles;
      const projected = await Promise.all(
        registry.map((profile) => profileAccountProjection(profile, registry, "win32")),
      );
      expect(
        projected.map((entry) => [entry.status.availability, entry.status.verification]),
      ).toEqual([
        ["unavailable", "not_run"],
        ["unavailable", "not_run"],
      ]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
      else process.env.CLAUDEXOR_AGY_BIN = previousBin;
    }
  });

  it("probes disabled isolated bindings but keeps disabled OS-user bindings dormant", async () => {
    const marker = join(root, "vendor-called");
    const bin = join(root, "fake-agy");
    writeFileSync(
      bin,
      `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' '{"status":"SUCCESS","command":{"data":{"id":"gemini-3.7-flash-high"}}}'\n`,
    );
    chmodSync(bin, 0o755);
    const previousBin = process.env.CLAUDEXOR_AGY_BIN;
    process.env.CLAUDEXOR_AGY_BIN = bin;
    try {
      const created = registerConfigDirProfile({
        harnessId: "agy",
        profileId: "disabled",
        platform: "darwin",
      });
      const disabled = { ...created.profile, enabled: false };

      const isolated = await profileAccountProjection(disabled, [disabled], "darwin");
      expect(isolated.status).toMatchObject({
        availability: "available",
        verification: "passed",
        verification_source: "vendor",
      });
      expect(existsSync(marker)).toBe(true);

      rmSync(marker, { force: true });
      const shared = await profileAccountProjection(disabled, [disabled], "win32");
      expect(shared.status).toMatchObject({
        availability: "unavailable",
        verification: "not_run",
      });
      expect(shared.status.detail).toContain("disabled and was not probed");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
      else process.env.CLAUDEXOR_AGY_BIN = previousBin;
    }
  });
});
