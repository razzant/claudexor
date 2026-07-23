import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brokenInstallAdvisory,
  managedRunnerNodeDir,
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
    // Pin a non-launchable runner so the QA-022 managed-runner prepend is
    // suppressed and this case keeps asserting shim resolution order.
    expect(normalizedHarnessPath(env, "/no/such/node").split(delimiter)[0]).toBe(shimDir);
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

  it("brokenInstallAdvisory recommends the brew PACKAGE token, not the binary basename", () => {
    if (process.platform === "win32") return;
    // A package can ship a binary under a different name; `brew reinstall`
    // must name the package (the Caskroom/Cellar path segment).
    const home = join(root, "adv-home8");
    const prefix = join(root, "adv-brew8");
    const binDir = join(prefix, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(
      join(prefix, "Caskroom", "vendor-package", "1.0", "tool-k"),
      join(binDir, "tool-k"),
    );
    const env = { HOME: home, PATH: binDir } as NodeJS.ProcessEnv;
    const advisory = brokenInstallAdvisory("tool-k", env, [prefix]);
    expect(advisory).toContain("brew reinstall --cask vendor-package");
    expect(advisory).not.toContain("--cask tool-k");
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

describe("managedRunnerNodeDir (QA-022 grandchild-shell Node anchor)", () => {
  let root: string;

  beforeEach(() => {
    // Canonicalize the temp root: managedRunnerNodeDir now anchors the REAL
    // binary's dir (realpath), and on macOS tmpdir is /var -> /private/var, so
    // exact-path assertions must compare against the resolved form.
    root = realpathSync(mkdtempSync(join(tmpdir(), "runner-node-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fakeNode(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "node");
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  }

  it("returns the dir of a spawnable, non-Homebrew running Node", () => {
    const dir = join(root, "app", "Resources");
    const exec = fakeNode(dir);
    expect(managedRunnerNodeDir(exec, "darwin")).toBe(dir);
  });

  it("returns null for an at-risk Homebrew Node (prepending it would poison the shell)", () => {
    // Not on disk here, but the path shape alone is the at-risk signal.
    expect(managedRunnerNodeDir("/opt/homebrew/bin/node", "darwin")).toBeNull();
    expect(managedRunnerNodeDir("/opt/homebrew/Cellar/node/25.8.1/bin/node", "darwin")).toBeNull();
  });

  it("returns null for a non-absolute or non-launchable execPath", () => {
    expect(managedRunnerNodeDir("node", "darwin")).toBeNull();
    expect(managedRunnerNodeDir(join(root, "missing", "node"), "darwin")).toBeNull();
  });

  it("returns null when the runner dir is group/world-writable (PATH injection surface)", () => {
    const dir = join(root, "writable", "Resources");
    const exec = fakeNode(dir);
    // A world-writable runner dir lets a local attacker drop a malicious node.
    chmodSync(dir, 0o777);
    expect(managedRunnerNodeDir(exec, "darwin")).toBeNull();
    // Group-writable alone is also refused.
    chmodSync(dir, 0o775);
    expect(managedRunnerNodeDir(exec, "darwin")).toBeNull();
    // Owner-only is accepted again.
    chmodSync(dir, 0o755);
    expect(managedRunnerNodeDir(exec, "darwin")).toBe(dir);
  });

  it("anchors the REAL dir when execPath is a symlinked launcher", () => {
    const realDir = join(root, "real", "Resources");
    const exec = fakeNode(realDir);
    const linkDir = join(root, "link");
    mkdirSync(linkDir, { recursive: true });
    const linked = join(linkDir, "node");
    symlinkSync(exec, linked);
    // The symlink's own dir is NOT prepended; the resolved binary's dir is.
    expect(managedRunnerNodeDir(linked, "darwin")).toBe(realDir);
  });

  it("returns null when the symlink resolves into a group/world-writable real dir", () => {
    const realDir = join(root, "real2", "Resources");
    const exec = fakeNode(realDir);
    chmodSync(realDir, 0o777);
    const linkDir = join(root, "safe-link");
    mkdirSync(linkDir, { recursive: true, mode: 0o755 });
    const linked = join(linkDir, "node");
    symlinkSync(exec, linked);
    // Even though the symlink's own dir is safe, the RESOLVED dir is writable.
    expect(managedRunnerNodeDir(linked, "darwin")).toBeNull();
  });

  it("normalizedHarnessPath prepends the managed-runner dir ahead of every guessed entry", () => {
    const home = join(root, "home");
    const dir = join(root, "app", "Resources");
    const exec = fakeNode(dir);
    const env = { HOME: home, PATH: "/opt/homebrew/bin:/usr/bin" } as NodeJS.ProcessEnv;
    const entries = normalizedHarnessPath(env, exec, "darwin").split(delimiter);
    expect(entries[0]).toBe(dir);
    // The guessed managed-bin dir still follows; nothing inherited is dropped.
    expect(entries).toContain(join(home, ".claudexor", "node", "bin"));
    expect(entries).toContain("/opt/homebrew/bin");
    expect(entries).toContain("/usr/bin");
  });

  it("normalizedHarnessPath de-dupes when the runner dir equals the managed-bin dir", () => {
    const home = join(root, "home2");
    const managedBin = join(home, ".claudexor", "node", "bin");
    const exec = fakeNode(managedBin);
    const env = { HOME: home, PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const entries = normalizedHarnessPath(env, exec, "darwin").split(delimiter);
    expect(entries[0]).toBe(managedBin);
    expect(entries.filter((e) => e === managedBin)).toHaveLength(1);
  });

  it("normalizedHarnessPath falls back to the guessed order when no safe runner exists", () => {
    const home = join(root, "home3");
    const env = { HOME: home, PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const entries = normalizedHarnessPath(env, "/opt/homebrew/bin/node", "darwin").split(delimiter);
    expect(entries[0]).toBe(join(home, ".claudexor", "node", "bin"));
  });
});
