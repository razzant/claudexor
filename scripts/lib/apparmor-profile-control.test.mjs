import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPARMOR_PARSER,
  applyProfile,
  DISTRO_PROFILE,
  loadProfileFile,
  profileNames,
  restoreProfile,
} from "./apparmor-profile-control.mjs";
import { MINIMAL_BWRAP_PROFILE } from "./linux-codex-appserver-phases.mjs";

/** The two profile headers of noble's packaged bwrap-userns-restrict (sha256 11d39094...). */
const NOBLE_PROFILE = [
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "profile bwrap /usr/bin/bwrap flags=(attach_disconnected) {",
  "  allow px /** -> bwrap//&unpriv_bwrap,",
  "}",
  "profile unpriv_bwrap flags=(attach_disconnected) {",
  "  audit deny capability,",
  "}",
].join("\n");
const PINNED = "/artifacts/bwrap-userns-restrict";
const INSTALL = DISTRO_PROFILE.installPath;
const NAMES = ["bwrap", "unpriv_bwrap"];

/** A host model: files, the kernel's loaded profiles, and `sudo` acting on both. */
function fakeHost({ files = {}, failLoad = false, failUnload = false, unreadable = false } = {}) {
  const fs = new Map(
    Object.entries({
      [PINNED]: { bytes: NOBLE_PROFILE, mode: 0o644, uid: 1001, gid: 1001 },
      ...files,
    }),
  );
  const kernel = new Set(["unprivileged_userns (enforce)"]);
  const calls = [];
  const backups = new Map();
  const host = {
    fs,
    kernel,
    calls,
    fileState: (path) => {
      const file = fs.get(path);
      if (!file) return { exists: false };
      return {
        exists: true,
        type: "file",
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        mode: file.mode,
        uid: file.uid,
        gid: file.gid,
      };
    },
    readBytes: (path) => Buffer.from(fs.get(path).bytes),
    saveBackup: (bytes) => {
      const path = `/artifacts/backup-${backups.size}`;
      backups.set(path, true);
      fs.set(path, { bytes: bytes.toString(), mode: 0o600, uid: 1001, gid: 1001 });
      return path;
    },
    persisted: [],
    persist: (record) => host.persisted.push({ ...record, callsSoFar: calls.length }),
    loadedProfiles: () => (unreadable ? null : [...kernel].sort()),
    sudo: (step, args) => {
      calls.push(args.join(" "));
      const [, command, ...rest] = args;
      if (command === "install") {
        const [, mode, , owner, , group, from, to] = rest;
        fs.set(to, {
          bytes: fs.get(from).bytes,
          mode: Number.parseInt(mode, 8),
          uid: owner === "root" ? 0 : Number(owner),
          gid: group === "root" ? 0 : Number(group),
        });
      } else if (command === "rm") fs.delete(rest.at(-1));
      else if (command === APPARMOR_PARSER) {
        const [, flag, file] = rest;
        if (flag === "-r" && !failLoad)
          for (const name of profileNames(fs.get(file).bytes)) kernel.add(`${name} (enforce)`);
        if (flag === "-R" && !failUnload)
          for (const name of profileNames(fs.get(file).bytes)) kernel.delete(`${name} (enforce)`);
        if ((flag === "-r" && failLoad) || (flag === "-R" && failUnload)) return { status: 1 };
      }
      return { status: 0 };
    },
  };
  return host;
}

function apply(host) {
  return applyProfile({ ...host, pinnedFile: PINNED, installPath: INSTALL });
}

function restore(host, applied) {
  return restoreProfile({ ...host, applied, pinnedFile: PINNED, names: NAMES });
}

describe("distro bwrap-userns-restrict control", () => {
  it("reads both profile names from the packaged file", () => {
    expect(profileNames(NOBLE_PROFILE)).toEqual(NAMES);
  });

  it("installs the pinned bytes as root:root 0644, loads them, then restores the absent start", () => {
    const host = fakeHost();
    const applied = apply(host);
    expect(host.calls).toEqual([
      `-n install -m 0644 -o root -g root ${PINNED} ${INSTALL}`,
      `-n ${APPARMOR_PARSER} -K -r ${INSTALL}`,
    ]);
    expect(host.persisted).toEqual([
      expect.objectContaining({ before: { exists: false }, backup: null, callsSoFar: 0 }),
    ]);
    expect([...host.kernel].sort()).toEqual([
      "bwrap (enforce)",
      "unpriv_bwrap (enforce)",
      "unprivileged_userns (enforce)",
    ]);
    expect(host.fileState(INSTALL)).toMatchObject({ mode: 0o644, uid: 0, gid: 0 });

    const first = restore(host, applied);
    expect(first.steps.map((step) => step.step)).toEqual(["unload-profile", "remove-profile-file"]);
    expect(first).toMatchObject({ restored: true, gaps: [], after: { exists: false } });
    expect([...host.kernel]).toEqual(["unprivileged_userns (enforce)"]);

    const again = restore(host, applied);
    expect(again).toMatchObject({ restored: true, steps: [] });
  });

  it("keeps a prior file and restores its exact bytes, mode and owner", () => {
    const prior = {
      bytes: "# site copy\nprofile bwrap /usr/bin/bwrap {}\n",
      mode: 0o600,
      uid: 0,
      gid: 4,
    };
    const host = fakeHost({ files: { [INSTALL]: prior } });
    const before = host.fileState(INSTALL);
    const applied = apply(host);
    expect(applied.backup).toBe("/artifacts/backup-0");
    expect(host.fs.get(INSTALL).bytes).toBe(NOBLE_PROFILE);
    const result = restore(host, applied);
    expect(result.steps.map((step) => step.argv.slice(2, 10).join(" "))).toContain(
      "install -m 0600 -o 0 -g 4 /artifacts/backup-0",
    );
    expect(result.restored).toBe(true);
    expect(host.fileState(INSTALL)).toEqual(before);
    expect(restore(host, applied).steps).toEqual([]);
  });

  it("still removes the file when the load failed", () => {
    const host = fakeHost({ failLoad: true });
    const result = restore(host, apply(host));
    expect(result.steps.map((step) => step.step)).toEqual(["remove-profile-file"]);
    expect(result.restored).toBe(true);
  });

  it("reports a profile that stays loaded or an unreadable profile list as not restored", () => {
    const stuck = fakeHost({ failUnload: true });
    const stuckResult = restore(stuck, apply(stuck));
    expect(stuckResult.restored).toBe(false);
    expect(stuckResult.gaps).toEqual(["still loaded: bwrap (enforce), unpriv_bwrap (enforce)"]);

    const blind = fakeHost({ unreadable: true });
    const blindResult = restore(blind, apply(blind));
    expect(blindResult.steps[0].step).toBe("unload-profile");
    expect(blindResult.restored).toBe(false);
    expect(blindResult.gaps).toEqual(["the loaded AppArmor profile list is unreadable"]);
  });

  it("loads the minimal comparison from a file only, and unloads it without touching files", () => {
    const file = "/artifacts/bwrap-minimal.apparmor";
    const host = fakeHost({
      files: { [file]: { bytes: MINIMAL_BWRAP_PROFILE, mode: 0o644, uid: 1001, gid: 1001 } },
    });
    const applied = loadProfileFile({ ...host, profileFile: file });
    expect(host.persisted).toEqual([
      expect.objectContaining({ installPath: null, profileFile: file, callsSoFar: 0 }),
    ]);
    expect(host.calls).toEqual([`-n ${APPARMOR_PARSER} -K -r ${file}`]);
    expect([...host.kernel].sort()).toEqual(["bwrap (enforce)", "unprivileged_userns (enforce)"]);
    const result = restoreProfile({ ...host, applied, pinnedFile: file, names: ["bwrap"] });
    expect(result.steps.map((step) => step.argv.slice(1).join(" "))).toEqual([
      `-n ${APPARMOR_PARSER} -K -R ${file}`,
    ]);
    expect(result).toMatchObject({ restored: true, gaps: [], after: null });
    expect(host.fs.has(INSTALL)).toBe(false);
    expect(restoreProfile({ ...host, applied, pinnedFile: file, names: ["bwrap"] }).steps).toEqual(
      [],
    );
  });

  it("changes nothing when the install path is not a regular file", () => {
    const host = fakeHost();
    host.fileState = (path) =>
      path === INSTALL
        ? { exists: true, type: "symlink", sha256: null, mode: 0o777, uid: 0, gid: 0 }
        : { exists: false };
    const applied = apply(host);
    expect(applied.refused).toMatch(/symlink/);
    expect(host.calls).toEqual([]);
  });
});
