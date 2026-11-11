import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { composeBaseEnv } from "@claudexor/core";
import { describe, expect, it } from "vitest";
import {
  GitCapabilityError,
  gitCapabilityProblem,
  probeGitCapability,
  resolveGitExecutable,
  requireGitCapability,
} from "./git-capability.js";

describe("Git capability", () => {
  it("recognizes a working executable", async () => {
    await expect(
      probeGitCapability({
        resolveGit: () => "/opt/homebrew/bin/git",
        runVersion: async () => ({
          code: 0,
          signal: null,
          stdout: "git version 2.50.1\n",
          stderr: "",
        }),
      }),
    ).resolves.toEqual({
      status: "available",
      version: "git version 2.50.1",
      detail: null,
      remediation: null,
    });
  });

  it("distinguishes the clean-macOS developer-tools launcher", async () => {
    let versionSpawned = false;
    const capability = await probeGitCapability({
      resolveGit: () => "/usr/bin/git",
      runXcodeSelect: async () => ({
        code: 1,
        signal: null,
        stdout: "",
        stderr: "xcode-select: error: unable to get active developer directory\n",
      }),
      runVersion: async () => {
        versionSpawned = true;
        throw new Error("must not execute the Apple Git launcher");
      },
    });
    expect(capability).toMatchObject({
      status: "developer_tools_stub",
      version: null,
      remediation: expect.stringContaining("xcode-select --install"),
    });
    expect(versionSpawned).toBe(false);
    expect(() => requireGitCapability(capability)).toThrow(GitCapabilityError);
  });

  it("distinguishes executable absence from an opaque failure", async () => {
    const missing = await probeGitCapability({
      resolveGit: () => null,
    });
    const failed = await probeGitCapability({
      resolveGit: () => "/custom/git",
      runVersion: async () => ({
        code: 128,
        signal: null,
        stdout: "",
        stderr: "fatal: unusable installation\n",
      }),
    });
    expect(missing.status).toBe("missing");
    expect(failed.status).toBe("failed");
  });

  it("runs system Git only after xcode-select proves developer tools exist", async () => {
    const calls: string[] = [];
    const capability = await probeGitCapability({
      resolveGit: () => "/usr/bin/git",
      runXcodeSelect: async () => {
        calls.push("xcode-select");
        return {
          code: 0,
          signal: null,
          stdout: "/Library/Developer/CommandLineTools\n",
          stderr: "",
        };
      },
      runVersion: async (path) => {
        calls.push(path);
        return { code: 0, signal: null, stdout: "git version 2.50.1\n", stderr: "" };
      },
    });
    expect(capability.status).toBe("available");
    expect(calls).toEqual(["xcode-select", "/usr/bin/git"]);
  });

  it("owns one safe problem projection for errors and applicability", () => {
    const capability = {
      status: "developer_tools_stub" as const,
      version: null,
      detail: "private probe detail",
      remediation: "Install Apple Command Line Tools, then retry.",
    };
    const problem = gitCapabilityProblem(capability);
    expect(problem).toEqual({
      code: "git_developer_tools_stub",
      reason: "Git is unavailable because Apple Command Line Tools are not installed.",
      remediation: "Install Apple Command Line Tools, then retry.",
    });
    const error = new GitCapabilityError(capability);
    expect(error.code).toBe(problem?.code);
    expect(error.message).toBe(`${problem?.reason} ${problem?.remediation}`);
    expect(error.message).not.toContain(capability.detail);
  });

  it("skips a directory named git and resolves the launchable file behind it", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-git-resolver-"));
    const invalid = join(root, "invalid");
    const valid = join(root, "valid");
    mkdirSync(join(invalid, "git"), { recursive: true });
    mkdirSync(valid);
    writeFileSync(join(valid, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(join(valid, "git"), 0o700);
    try {
      expect(resolveGitExecutable([invalid, valid].join(delimiter))).toBe(
        realpathSync(join(valid, "git")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves git.exe on win32 where the bare name never exists", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-git-win32-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Real Windows PATH dirs hold git.exe, never an extensionless git. On a
    // Windows host the inspection also requires the PE shape (MZ, then PE\0\0).
    const image = Buffer.alloc(512);
    image.write("MZ", 0, "latin1");
    image.writeUInt32LE(0x80, 0x3c);
    image.write("PE\0\0", 0x80, "latin1");
    writeFileSync(join(bin, "git.exe"), image, { mode: 0o700 });
    chmodSync(join(bin, "git.exe"), 0o700);
    try {
      expect(resolveGitExecutable(bin, "win32")).toBe(realpathSync(join(bin, "git.exe")));
      // POSIX resolution must NOT pick up the Windows-only name.
      expect(resolveGitExecutable(bin, "linux")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not resolve a POSIX-named git on win32", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-git-win32-neg-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(join(bin, "git"), 0o700);
    try {
      expect(resolveGitExecutable(bin, "win32")).toBeNull();
      expect(resolveGitExecutable(bin, "linux")).toBe(realpathSync(join(bin, "git")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves from the same normalized mirror-native PATH used for execution", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-git-env-"));
    const managed = join(root, "managed");
    const inherited = join(root, "inherited");
    mkdirSync(managed);
    mkdirSync(inherited);
    // The managed-runner prepend is refused for a group/world-writable dir, so
    // pin the mode instead of inheriting the runner's umask (0002 -> 0o775).
    chmodSync(managed, 0o755);
    for (const dir of [managed, inherited]) {
      writeFileSync(join(dir, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(join(dir, "git"), 0o700);
    }
    writeFileSync(join(managed, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(join(managed, "node"), 0o700);
    const env = composeBaseEnv(
      "mirror_native",
      { PATH: inherited },
      join(managed, "node"),
      process.platform,
    );
    try {
      expect(resolveGitExecutable(env.PATH)).toBe(realpathSync(join(managed, "git")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
