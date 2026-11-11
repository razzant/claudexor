import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import { registerConfigDirProfile } from "./profile-registration.js";
import { quotaSubjectUniverseFromConfig } from "./quota-subject-universe.js";

describe("quotaSubjectUniverseFromConfig", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudexor-quota-subjects-"));
    previous = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("contains only enabled primary-capable harness subjects", () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "ignored" });
    registerConfigDirProfile({ harnessId: "codex", profileId: "work" });
    registerConfigDirProfile({ harnessId: "codex", profileId: "off" });
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((profile) =>
        profile.profile_id === "off" ? { ...profile, enabled: false } : profile,
      ),
      harnesses: {
        ...config.harnesses,
        claude: { ...(config.harnesses.claude ?? {}), enabled: false },
        codex: {
          ...(config.harnesses.codex ?? {}),
          enabled: true,
          native_credentials_enabled: false,
        },
      },
    }));

    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(3);
    expect(quotaSubjectUniverseFromConfig()).toEqual([
      {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "work",
      },
    ]);
  });
  it("includes enabled Cursor resource subjects from real config, never disabled accounts or harnesses", () => {
    registerConfigDirProfile({ harnessId: "cursor", profileId: "cursor-on" });
    registerConfigDirProfile({ harnessId: "cursor", profileId: "cursor-off" });
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((p) =>
        p.profile_id === "cursor-off" ? { ...p, enabled: false } : p,
      ),
      harnesses: {
        ...config.harnesses,
        cursor: { ...config.harnesses.cursor, enabled: true, native_credentials_enabled: false },
      },
    }));
    expect(quotaSubjectUniverseFromConfig().filter((s) => s.harness === "cursor")).toEqual([
      {
        harness: "cursor",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "cursor-on",
      },
    ]);
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: { ...config.harnesses, cursor: { ...config.harnesses.cursor, enabled: false } },
    }));
    expect(quotaSubjectUniverseFromConfig().filter((s) => s.harness === "cursor")).toEqual([]);
  });
});
