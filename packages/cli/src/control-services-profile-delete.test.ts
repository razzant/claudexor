import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { ensureLaneHomeEnv } from "@claudexor/workspace";
import { createAccountEvidence } from "@claudexor/daemon";
import { controlServices } from "./control-services.js";
import { registerConfigDirProfile } from "./profile-registration.js";

const noteCredentialChange = vi.fn();
const setupListFilters: Array<Record<string, unknown> | undefined> = [];

// DELETE /credential-profiles/:harness/:id — the one branch of the accounts
// scope that recursively deletes a directory. These tests pin the review-wave
// findings: the 409 active-login guard, the delete-grade profiles-tree fence
// (stricter than the creation-grade confinement, which accepts the owned root
// itself), honest cleanup reporting, and warning disclosure over silence.

function servicesWithJobs(
  jobs: Array<Record<string, unknown>>,
  invalidationError?: Error & { status?: number },
  onRemoveSubject?: (harness: string, subjectId: string | null) => void,
) {
  const setupBinding = {
    current: () => ({
      list: (filter?: Record<string, unknown>) => {
        setupListFilters.push(filter);
        return jobs;
      },
    }),
  };
  const threads = {
    invalidateCredentialProfile: () => {
      if (invalidationError) throw invalidationError;
      return { clearedThreads: 0, invalidatedSessions: 0 };
    },
    listThreads: () => [] as unknown[],
  };
  const quota = {
    removeSubject: (harness: string, subjectId: string | null) => {
      onRemoveSubject?.(harness, subjectId);
      return 0;
    },
    noteCredentialChange,
  };
  return controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    threads as never,
    setupBinding as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => quota) as never,
    createAccountEvidence(),
    () => [],
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
    noteCredentialChange.mockClear();
    setupListFilters.length = 0;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

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
    expect(noteCredentialChange).toHaveBeenCalledOnce();
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

  it("removes an agy private keychain with the owned profile HOME", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "agy", profileId: "work" });
    const locator = profile.isolation_locator as string;
    const keychains = join(locator, "Library", "Keychains");
    mkdirSync(keychains, { recursive: true, mode: 0o700 });
    const keychain = join(keychains, "login.keychain-db");
    writeFileSync(keychain, "private-keychain-fixture", { mode: 0o600 });
    expect(existsSync(keychain)).toBe(true);
    const receipt = (await servicesWithJobs([]).deleteCredentialProfile({
      harnessId: "agy",
      profileId: "work",
    })) as { removed: boolean; credentialCleanup: string };
    expect(receipt.removed).toBe(true);
    expect(receipt.credentialCleanup).toBe("config_dir_removed");
    expect(existsSync(locator)).toBe(false);
  });

  it("refuses with a typed 409 while a login job for the account is active", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const services = servicesWithJobs([{ jobId: "setup-1", state: "running", profileId: "work" }]);
    await expect(
      services.deleteCredentialProfile({ harnessId: "claude", profileId: "work" }),
    ).rejects.toMatchObject({ status: 409 });
    // The registry must be untouched after the refusal.
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
    expect(setupListFilters).toEqual([{ harness: "claude" }]);
  });

  it("fences an agy deletion against its own live login, and skips the lookup for a harness with no managed logins", async () => {
    // agy joined ControlHarnessSetupHarness with the in-app login card, so its
    // deletion now takes the SAME 409 fence as claude: a live login must not be
    // deleted out from under itself.
    registerConfigDirProfile({ harnessId: "agy", profileId: "work" });
    await expect(
      servicesWithJobs([
        { jobId: "setup-1", state: "running", profileId: "work" },
      ]).deleteCredentialProfile({ harnessId: "agy", profileId: "work" }),
    ).rejects.toThrow(/login for this account is in progress/);
    expect(setupListFilters).toEqual([{ harness: "agy" }]);

    // A harness OUTSIDE the setup enum still never resolves the manager: the
    // fence is derived from the enum's own options, never a hand-copied list.
    setupListFilters.length = 0;
    const { profile } = registerConfigDirProfile({ harnessId: "cursor", profileId: "solo" });
    const locator = profile.isolation_locator as string;
    const receipt = (await servicesWithJobs([]).deleteCredentialProfile({
      harnessId: "cursor",
      profileId: "solo",
    })) as { removed: boolean; credentialCleanup: string };
    expect(receipt.removed).toBe(true);
    expect(receipt.credentialCleanup).toBe("config_dir_removed");
    expect(existsSync(locator)).toBe(false);
  });

  it("refuses before registry removal when dependent partitions need recovery", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const error = Object.assign(new Error("project partition requires recovery"), { status: 409 });
    await expect(
      servicesWithJobs([], error).deleteCredentialProfile({
        harnessId: "claude",
        profileId: "work",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });

  it("delete-grade fence: never rm -rf outside the profiles tree — typed retryable refusal, row kept (D-U4)", async () => {
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
    // D-U4: a failed cleanup is a TYPED RETRYABLE error, never removed:true
    // with a warning — the row must stay registered so the removal can be
    // retried instead of the surviving material resurrecting a ghost account.
    await expect(
      servicesWithJobs([]).deleteCredentialProfile({ harnessId: "claude", profileId: "escape" }),
    ).rejects.toMatchObject({ status: 503, code: "credential_cleanup_failed", retryable: true });
    expect(
      loadConfig(noProjectRepoRoot()).global.credential_profiles.some(
        (profile) => profile.profile_id === "escape",
      ),
    ).toBe(true);
    expect(existsSync(join(dir, "config.yaml"))).toBe(true);
  });

  it("deletes the MIGRATED row through the exact legacy-locator allowlist and retires its aliases (K.3)", async () => {
    const { runAccountsUnifiedMigration } = await import("./accounts-unified-migration.js");
    const { defaultNativeCodexHome } = await import("@claudexor/harness-codex");
    const home = defaultNativeCodexHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    const removedSubjects: Array<{ harness: string; subjectId: string | null }> = [];
    const migrationStores = {
      threads: {
        migrateNullProfileContinuity: () => ({
          sessions: 0,
          checkpoints: 0,
          skippedPartitions: [],
        }),
        rollbackProfileContinuity: () => ({ sessions: 0, checkpoints: 0, skippedPartitions: [] }),
        listThreads: () => [],
      },
      quota: {
        removeSubject: (harness: string, subjectId: string | null) => {
          removedSubjects.push({ harness, subjectId });
          return 0;
        },
      },
    };
    runAccountsUnifiedMigration(migrationStores);
    removedSubjects.length = 0;
    // A leftover legacy-alias lane home (`<harness>-default`, e.g. recovered
    // from a quarantined partition after the migration pass renamed the rest).
    const rt = projectRuntimeDir(noProjectRepoRoot());
    ensureLaneHomeEnv(rt, "th-legacy", "codex", null);
    const services = servicesWithJobs([], undefined, (harness, subjectId) =>
      removedSubjects.push({ harness, subjectId }),
    );
    const receipt = (await services.deleteCredentialProfile({
      harnessId: "codex",
      profileId: "codex-default",
    })) as { removed: boolean; credentialCleanup: string; cleanupWarning?: string };
    // The legacy native locator is deletable through the EXACT allowlist from
    // the migration record — never a general native-tree deletion class.
    expect(receipt.removed).toBe(true);
    expect(receipt.credentialCleanup).toBe("config_dir_removed");
    expect(receipt.cleanupWarning).toBeUndefined();
    expect(existsSync(home)).toBe(false);
    // One lifecycle operation retires the canonical id AND the null alias.
    expect(removedSubjects).toEqual([
      { harness: "codex", subjectId: "codex-default" },
      { harness: "codex", subjectId: null },
    ]);
    // K.6: the alias's `<harness>-default` LANE dir is purged with the row.
    expect(existsSync(join(rt, "lanes", "th-legacy", "codex-default"))).toBe(false);
    // The migration record died with its row: a later start re-detects nothing.
    const { readAccountsMigrationFile } = await import("./accounts-unified-migration.js");
    expect(readAccountsMigrationFile()["codex"]).toBeUndefined();
    expect(runAccountsUnifiedMigration(migrationStores)).toEqual([]);
  });

  it("deletes a BOOTSTRAP row at the native locator without a migration record (cancelled-login recovery)", async () => {
    // ensureBootstrapProfile registers claude-default/codex-default with the
    // native dir as locator BEFORE any migration record exists (a cancelled
    // login leaves exactly this cold row). The delete fence keys on the
    // structural default-store rule, not on record presence — the row must
    // not be stuck behind a typed 503 forever.
    const { ensureBootstrapProfile } = await import("./profile-registration.js");
    const { readAccountsMigrationFile } = await import("./accounts-unified-migration.js");
    const row = ensureBootstrapProfile("codex");
    expect(row.profile_id).toBe("codex-default");
    const locator = row.isolation_locator as string;
    expect(existsSync(locator)).toBe(true);
    expect(readAccountsMigrationFile()["codex"]).toBeUndefined();
    const receipt = (await servicesWithJobs([]).deleteCredentialProfile({
      harnessId: "codex",
      profileId: "codex-default",
    })) as { removed: boolean; credentialCleanup: string };
    expect(receipt.removed).toBe(true);
    expect(receipt.credentialCleanup).toBe("config_dir_removed");
    expect(existsSync(locator)).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });

  it("still refuses a hand-written row at an arbitrary path outside the profiles tree and the default store", async () => {
    // The structural allowlist is the harness's EXACT default native dir —
    // registry contents never become general rm -rf authority: a hand-written
    // locator elsewhere in the owned root keeps the typed retryable refusal.
    registerConfigDirProfile({ harnessId: "codex", profileId: "handmade" });
    const outside = join(dir, "native", "codex-imposter");
    mkdirSync(outside, { recursive: true });
    const { updateGlobalConfig } = await import("@claudexor/config");
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((profile) =>
        profile.profile_id === "handmade" ? { ...profile, isolation_locator: outside } : profile,
      ),
    }));
    await expect(
      servicesWithJobs([]).deleteCredentialProfile({ harnessId: "codex", profileId: "handmade" }),
    ).rejects.toMatchObject({ status: 503, code: "credential_cleanup_failed", retryable: true });
    expect(existsSync(outside)).toBe(true);
    expect(
      loadConfig(noProjectRepoRoot()).global.credential_profiles.some(
        (profile) => profile.profile_id === "handmade",
      ),
    ).toBe(true);
  });

  it("clears any harness's rotation_eligible entry at the deleted profile (INV-135; F1: Active removed)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const { updateGlobalConfig } = await import("@claudexor/config");
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: { limit_action: "rotate", rotation_eligible: ["work"] },
        },
      } as never,
    }));
    // Precondition: the rotation entry is set.
    expect(
      loadConfig(noProjectRepoRoot()).global.harnesses.claude?.profile_policy.rotation_eligible,
    ).toEqual(["work"]);
    await servicesWithJobs([]).deleteCredentialProfile({ harnessId: "claude", profileId: "work" });
    const after = loadConfig(noProjectRepoRoot()).global.harnesses.claude;
    // The rotation entry no longer dangles at the deleted id.
    expect(after?.profile_policy.rotation_eligible).toEqual([]);
  });

  it("unknown ids refuse with a typed 404 before any cleanup", async () => {
    await expect(
      servicesWithJobs([]).deleteCredentialProfile({ harnessId: "claude", profileId: "ghost" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sweeps the deleted profile's DURABLE per-lane read-only homes (INV-034 owner b)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-lane-repo-"));
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const rt = projectRuntimeDir(repo);
    // Two lanes for the doomed (claude, work) account, plus a survivor lane.
    ensureLaneHomeEnv(rt, "th-1", "claude", "work");
    ensureLaneHomeEnv(rt, "th-2", "claude", "work");
    ensureLaneHomeEnv(rt, "th-1", "codex", "work");

    const threads = {
      invalidateCredentialProfile: () => ({ clearedThreads: 0, invalidatedSessions: 0 }),
      listThreads: () => [{ id: "th-1", repo: { root: repo } }] as unknown[],
    };
    const quota = { removeSubject: () => 0, noteCredentialChange };
    const svc = controlServices(
      undefined as never,
      undefined as never,
      undefined as never,
      threads as never,
      { current: () => ({ list: () => [] }) } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      (() => quota) as never,
      createAccountEvidence(),
      () => [],
    );

    await svc.deleteCredentialProfile({ harnessId: "claude", profileId: "work" });

    expect(existsSync(join(rt, "lanes", "th-1", "claude-work"))).toBe(false);
    expect(existsSync(join(rt, "lanes", "th-2", "claude-work"))).toBe(false);
    // A different harness's lane under the same thread is untouched.
    expect(existsSync(join(rt, "lanes", "th-1", "codex-work"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});
