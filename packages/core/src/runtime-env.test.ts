import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brokenInstallAdvisory,
  normalizedHarnessPath,
  resolveHarnessBinary,
} from "./runtime-env.js";

describe("resolveHarnessBinary", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runtime-env-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fakeBin(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  }

  it("resolves through the SAME normalized PATH the spawn layer composes (managed shim dir wins)", () => {
    // The live incident this guards: ~/.claudexor/node/bin/<bin> (first
    // preferred entry) shadowing a newer install later on PATH — doctor must
    // report the shim path that harness children will actually execute.
    const home = join(root, "home");
    const shimDir = join(home, ".claudexor", "node", "bin");
    const laterDir = join(root, "later");
    const shim = fakeBin(shimDir, "codex-x");
    fakeBin(laterDir, "codex-x");
    const env = { HOME: home, PATH: laterDir } as NodeJS.ProcessEnv;
    expect(normalizedHarnessPath(env).split(delimiter)[0]).toBe(shimDir);
    expect(resolveHarnessBinary("codex-x", env)).toBe(shim);
  });

  it("falls back to inherited PATH entries and returns null when absent", () => {
    const home = join(root, "home2");
    const onlyDir = join(root, "only");
    const bin = fakeBin(onlyDir, "claude-x");
    const env = { HOME: home, PATH: onlyDir } as NodeJS.ProcessEnv;
    expect(resolveHarnessBinary("claude-x", env)).toBe(bin);
    expect(resolveHarnessBinary("missing-bin", env)).toBeNull();
  });

  it("passes absolute paths through only when they exist", () => {
    const abs = fakeBin(join(root, "abs"), "tool");
    expect(resolveHarnessBinary(abs, { HOME: root, PATH: "" } as NodeJS.ProcessEnv)).toBe(abs);
    expect(
      resolveHarnessBinary(join(root, "abs", "nope"), {
        HOME: root,
        PATH: "",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("splits and joins PATH with the platform delimiter", () => {
    const home = join(root, "home3");
    const a = join(root, "a");
    const b = join(root, "b");
    const target = fakeBin(b, "tool-b");
    mkdirSync(a, { recursive: true });
    const env = { HOME: home, PATH: [a, b].join(delimiter) } as NodeJS.ProcessEnv;
    expect(resolveHarnessBinary("tool-b", env)).toBe(target);
  });

  it("brokenInstallAdvisory returns null when the binary resolves or nothing is on disk", () => {
    const home = join(root, "adv-home");
    const binDir = join(root, "adv-bin");
    fakeBin(binDir, "tool-ok");
    const env = { HOME: home, PATH: binDir } as NodeJS.ProcessEnv;
    expect(brokenInstallAdvisory("tool-ok", env, [])).toBeNull();
    expect(brokenInstallAdvisory("tool-never-installed", env, [])).toBeNull();
  });

  it("brokenInstallAdvisory names a dangling Caskroom symlink and prescribes brew reinstall --cask", () => {
    if (process.platform === "win32") return;
    // The live incident: Caskroom payload purged, /opt/homebrew/bin symlink left dangling.
    const home = join(root, "adv-home2");
    const prefix = join(root, "adv-brew");
    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, "tool-e");
    symlinkSync(join(prefix, "Caskroom", "tool-e", "1.0", "tool-e"), link);
    const env = { HOME: home, PATH: binDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory("tool-e", env, [prefix]);
    expect(advisory).toContain(link);
    expect(advisory).toContain("its target is missing");
    expect(advisory).toContain("brew reinstall --cask tool-e");
  });

  it("brokenInstallAdvisory reports a registered-but-empty Caskroom when PATH has no entry at all", () => {
    // The other half of the live incident: brew still lists the cask as
    // installed while no bin link exists anywhere on the harness PATH.
    const home = join(root, "adv-home3");
    const prefix = join(root, "adv-brew2");
    const caskDir = join(prefix, "Caskroom", "tool-f");
    mkdirSync(join(caskDir, "0.106.0"), { recursive: true });
    const emptyDir = join(root, "adv-empty");
    mkdirSync(emptyDir, { recursive: true });
    const env = { HOME: home, PATH: emptyDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory("tool-f", env, [prefix]);
    expect(advisory).toContain(caskDir);
    expect(advisory).toContain("brew reinstall --cask tool-f");
  });

  it("brokenInstallAdvisory distinguishes a Cellar formula (no --cask flag)", () => {
    const home = join(root, "adv-home4");
    const prefix = join(root, "adv-brew3");
    mkdirSync(join(prefix, "Cellar", "tool-g", "2.0"), { recursive: true });
    const emptyDir = join(root, "adv-empty2");
    mkdirSync(emptyDir, { recursive: true });
    const env = { HOME: home, PATH: emptyDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory("tool-g", env, [prefix]);
    expect(advisory).toContain("brew reinstall tool-g");
    expect(advisory).not.toContain("--cask");
  });

  it("brokenInstallAdvisory explains a non-executable file outside Homebrew generically", () => {
    if (process.platform === "win32") return;
    const home = join(root, "adv-home5");
    const binDir = join(root, "adv-bin5");
    mkdirSync(binDir, { recursive: true });
    const stripped = join(binDir, "tool-h");
    writeFileSync(stripped, "#!/bin/sh\nexit 0\n");
    chmodSync(stripped, 0o644);
    const env = { HOME: home, PATH: binDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory("tool-h", env, []);
    expect(advisory).toContain(stripped);
    expect(advisory).toContain("it is not executable");
    expect(advisory).toContain("reinstall tool-h");
  });

  it("brokenInstallAdvisory never emits a brew command for a shell-unsafe basename", () => {
    if (process.platform === "win32") return;
    // A configured override like CLAUDEXOR_CODEX_BIN with metacharacters in
    // its basename must not turn into a pasteable `brew reinstall $(...)`.
    const home = join(root, "adv-home6");
    const prefix = join(root, "adv-brew6");
    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    const evil = "tool-i;$(rm x)";
    symlinkSync(join(prefix, "Caskroom", evil, "1.0", evil), join(binDir, evil));
    const env = { HOME: home, PATH: binDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory(evil, env, [prefix]);
    expect(advisory).toContain("its target is missing");
    expect(advisory).not.toContain("brew reinstall");
    expect(advisory).toContain("point the binary override at a working install");
  });

  it("brokenInstallAdvisory names the missing absolute override instead of claiming a PATH sweep", () => {
    const home = join(root, "adv-home7");
    const prefix = join(root, "adv-brew7");
    mkdirSync(join(prefix, "Caskroom", "tool-j", "2.0"), { recursive: true });
    const emptyDir = join(root, "adv-empty7");
    mkdirSync(emptyDir, { recursive: true });
    const override = join(root, "adv-missing", "tool-j");
    const env = { HOME: home, PATH: emptyDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory(override, env, [prefix]);
    expect(advisory).toContain(`the configured override ${override} does not exist`);
    expect(advisory).not.toContain("no runnable binary is on the harness PATH");
    expect(advisory).toContain("brew reinstall --cask tool-j");
    expect(advisory).toContain("or fix the binary override");
  });

  it("skips non-executable files and directories shadowing the name (spawn-faithful)", () => {
    const home = join(root, "home4");
    const shadowDir = join(root, "shadow");
    const realDir = join(root, "real");
    // A directory named like the binary, then a chmod-x file — neither is spawnable.
    mkdirSync(join(shadowDir, "tool-c"), { recursive: true });
    mkdirSync(realDir, { recursive: true });
    const nonExec = join(realDir, "tool-d");
    writeFileSync(nonExec, "#!/bin/sh\nexit 0\n");
    chmodSync(nonExec, 0o644);
    const target = fakeBin(realDir, "tool-c");
    const env = { HOME: home, PATH: [shadowDir, realDir].join(delimiter) } as NodeJS.ProcessEnv;
    expect(resolveHarnessBinary("tool-c", env)).toBe(target);
    if (process.platform !== "win32") {
      expect(resolveHarnessBinary("tool-d", env)).toBeNull();
    }
  });
});
