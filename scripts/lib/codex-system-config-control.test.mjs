import { describe, expect, it } from "vitest";
import {
  applySystemConfig,
  CODEX_SYSTEM_CONFIG,
  CODEX_SYSTEM_DIR,
  restoreSystemConfig,
  systemConfigInstalled,
} from "./codex-system-config-control.mjs";

const SHA = "a".repeat(64);
const INSTALLED = { exists: true, type: "file", sha256: SHA, mode: 0o644, uid: 0, gid: 0 };

/** A fake root filesystem that the recorded `sudo` steps act on. */
function fakeHost({ dir = false, file = false, installWorks = true, removeWorks = true } = {}) {
  const fs = {
    [CODEX_SYSTEM_DIR]: dir ? { exists: true, type: dir === true ? "directory" : dir } : null,
    [CODEX_SYSTEM_CONFIG]: file ? { ...INSTALLED, sha256: "b".repeat(64) } : null,
  };
  const steps = [];
  const persisted = [];
  return {
    fs,
    steps,
    persisted,
    fileState: (path) => fs[path] ?? { exists: false },
    sudo: (step, args) => {
      steps.push(`${step}: ${args.join(" ")}`);
      if (step === "install-codex-system-config" && installWorks) {
        fs[CODEX_SYSTEM_DIR] ??= { exists: true, type: "directory" };
        fs[CODEX_SYSTEM_CONFIG] = { ...INSTALLED };
      }
      if (step === "remove-codex-system-config" && removeWorks) fs[CODEX_SYSTEM_CONFIG] = null;
      if (step === "remove-codex-system-dir" && removeWorks) fs[CODEX_SYSTEM_DIR] = null;
      return { status: 0, signal: null, error: null };
    },
    persist: (record) => persisted.push(structuredClone(record)),
  };
}

describe("Codex system config route", () => {
  it("installs the provider config as root 0644, persisting the record first, then removes all", () => {
    const host = fakeHost();
    const applied = applySystemConfig({ ...host, configFile: "/out/config.toml" });
    expect(host.persisted).toHaveLength(1);
    expect(host.persisted[0].steps).toEqual([]);
    expect(host.steps).toEqual([
      `install-codex-system-config: -n install -D -m 0644 -o root -g root /out/config.toml ${CODEX_SYSTEM_CONFIG}`,
    ]);
    expect(systemConfigInstalled(applied.after, SHA)).toBe(true);
    expect(systemConfigInstalled({ ...applied.after, mode: 0o666 }, SHA)).toBe(false);
    const restored = restoreSystemConfig({ ...host, applied });
    expect(restored).toMatchObject({ restored: true, gaps: [] });
    expect(host.steps.slice(1)).toEqual([
      `remove-codex-system-config: -n rm -f -- ${CODEX_SYSTEM_CONFIG}`,
      `remove-codex-system-dir: -n rmdir -- ${CODEX_SYSTEM_DIR}`,
    ]);
    // Idempotent: a second restore finds nothing to do and still verifies.
    expect(restoreSystemConfig({ ...host, applied })).toMatchObject({ restored: true, steps: [] });
  });

  it("keeps an existing /etc/codex directory and never replaces a host's config", () => {
    const keepDir = fakeHost({ dir: true });
    const applied = applySystemConfig({ ...keepDir, configFile: "/out/config.toml" });
    restoreSystemConfig({ ...keepDir, applied });
    expect(keepDir.steps.some((step) => step.startsWith("remove-codex-system-dir"))).toBe(false);
    expect(keepDir.fs[CODEX_SYSTEM_DIR]).toMatchObject({ exists: true });
    for (const host of [fakeHost({ dir: true, file: true }), fakeHost({ dir: "symlink" })]) {
      const refused = applySystemConfig({ ...host, configFile: "/out/config.toml" });
      expect(refused.refused).toBeTruthy();
      expect(host.steps).toEqual([]);
      expect(host.persisted).toEqual([]);
      expect(restoreSystemConfig({ ...host, applied: refused })).toMatchObject({ restored: true });
      expect(host.steps).toEqual([]);
    }
  });

  it("reports a config that stays behind as not restored", () => {
    const host = fakeHost({ removeWorks: false });
    const applied = applySystemConfig({ ...host, configFile: "/out/config.toml" });
    expect(restoreSystemConfig({ ...host, applied })).toMatchObject({
      restored: false,
      gaps: [
        `${CODEX_SYSTEM_CONFIG} still exists`,
        `${CODEX_SYSTEM_DIR} does not match its recorded start`,
      ],
    });
  });
});
