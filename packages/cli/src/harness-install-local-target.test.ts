/**
 * The LOCAL install target: the prefix a host integration installs into and the
 * receipt it must earn. The watched remote flow's disclosure/exit-code contract
 * lives in harness-installer.test.ts; everything here is about the unattended
 * path — the managed toolchain prefix, the cross-process install lease, the
 * post-install binary/version proof, and the single typed JSON envelope a
 * machine caller sees when something throws.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync as spawnChildSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_VENDOR_CLI_VERSION } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import { OPENCODE_VENDOR_CLI_VERSION } from "@claudexor/harness-opencode";
import { harnessBinaryIdentityOnPath, normalizedHarnessPath } from "@claudexor/core";
import type { ParsedArgs } from "./args.js";
import {
  CURSOR_INSTALL_URL,
  HARNESS_INSTALL_TARGETS,
  harnessInstallCommand,
  isHarnessInstallTarget,
  runHarnessInstaller,
} from "./harness-installer.js";

const args = (positional: string[], flags: ParsedArgs["flags"] = {}): ParsedArgs => ({
  _: positional,
  flags,
});

const captureStdout = (): { lines: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(""), restore: () => spy.mockRestore() };
};

const captureStderr = (): { lines: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks.join(""), restore: () => spy.mockRestore() };
};

type NpmHarness = "claude" | "codex" | "opencode";

const NPM_FIXTURES: Record<NpmHarness, { npmPackage: string; binary: string; version: string }> = {
  claude: {
    npmPackage: "@anthropic-ai/claude-code",
    binary: "claude",
    version: CLAUDE_VENDOR_CLI_VERSION,
  },
  codex: {
    npmPackage: "@openai/codex",
    binary: "codex",
    version: CODEX_VENDOR_CLI_VERSION,
  },
  opencode: {
    npmPackage: "opencode-ai",
    binary: "opencode",
    version: OPENCODE_VENDOR_CLI_VERSION,
  },
};

const vendorRoot = (home: string, target: "local" | "remote"): string =>
  target === "local"
    ? join(home, ".claudexor", "node")
    : join(home, ".claudexor", "remote", "vendor");

const writeExecutable = (path: string, body: string | Buffer = "#!/bin/sh\nexit 0\n"): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
};

/** Windows starts a `.exe` only with the PE shape: `MZ`, then `PE\0\0` at e_lfanew. */
const windowsImage = (): Buffer => {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  return bytes;
};

/** npm global layout observed for the exact Codex pin: the main package under
 * `<prefix>/node_modules`, its optional platform package NESTED under the main
 * package's `node_modules`, and shims (`codex`, `codex.cmd`) in the prefix root.
 * `image: false` reproduces a shim-only install (platform package missing). */
const WINDOWS_CODEX_IMAGE_DIR = (root: string): string =>
  join(
    root,
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
  );

const installNpmFixture = (
  home: string,
  target: "local" | "remote",
  harness: NpmHarness,
  options: {
    packageVersion?: string;
    binaryBody?: string;
    layout?: "posix" | "win32";
    image?: boolean;
  } = {},
): { binary: string; packageRoot: string } => {
  const fixture = NPM_FIXTURES[harness];
  const root = vendorRoot(home, target);
  const windows = options.layout === "win32";
  const packageRoot = windows
    ? join(root, "node_modules", ...fixture.npmPackage.split("/"))
    : join(root, "lib", "node_modules", ...fixture.npmPackage.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ version: options.packageVersion ?? fixture.version })}\n`,
  );
  if (windows) {
    writeExecutable(join(root, fixture.binary), "");
    const binary =
      harness === "codex"
        ? join(WINDOWS_CODEX_IMAGE_DIR(root), `${fixture.binary}.exe`)
        : join(packageRoot, "bin", `${fixture.binary}.exe`);
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: fixture.npmPackage,
        version: options.packageVersion ?? fixture.version,
        bin: { [fixture.binary]: relative(packageRoot, binary) },
      }),
    );
    const targetPath = relative(root, binary).split("/").join("\\");
    writeExecutable(
      join(root, `${fixture.binary}.cmd`),
      `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${targetPath}"   %*\r\n`,
    );
    if (options.image !== false) writeExecutable(binary, options.binaryBody ?? windowsImage());
    return { binary, packageRoot };
  }
  const binary = join(root, "bin", fixture.binary);
  writeExecutable(binary, options.binaryBody);
  return { binary, packageRoot };
};

/** The ambient HOME a test inherits (a developer's real one, in effect), holding
 * a runnable NEWER managed Codex in both npm layouts. Its POSIX launcher
 * records that it ran. A hermetic test passes its own home and never reads it. */
const ambientManagedCodex = (): { home: string; marker: string } => {
  const home = mkdtempSync(join(tmpdir(), "claudexor-ambient-home-"));
  const marker = join(home, "ambient-launcher-ran");
  const packageRoot = join(home, ".claudexor", "node", "lib", "node_modules", "@openai", "codex");
  writeExecutable(
    join(packageRoot, "bin", "codex.js"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log("codex-cli 50.0.0");\n`,
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: "50.0.0" }),
  );
  mkdirSync(join(home, ".claudexor", "node", "bin"), { recursive: true });
  symlinkSync(
    "../lib/node_modules/@openai/codex/bin/codex.js",
    join(home, ".claudexor", "node", "bin", "codex"),
  );
  installNpmFixture(home, "local", "codex", { layout: "win32", packageVersion: "50.0.0" });
  vi.stubEnv("HOME", home);
  return { home, marker };
};

const installCursorFixture = (home: string): { binary: string; canonicalTarget: string } => {
  const canonicalTarget = join(
    home,
    ".local",
    "share",
    "cursor-agent",
    "versions",
    "1.2.3",
    "cursor-agent",
  );
  writeExecutable(canonicalTarget);
  const binary = join(home, ".local", "bin", "cursor-agent");
  mkdirSync(dirname(binary), { recursive: true });
  symlinkSync(canonicalTarget, binary);
  return { binary, canonicalTarget };
};

interface InstallerSpawnOptions {
  home: string;
  harness: NpmHarness | "cursor";
  target?: "local" | "remote";
  installerStatus?: number;
  versionStatus?: number;
  versionOutput?: string;
  materialize?: boolean;
  noisy?: boolean;
  /** Which npm prefix layout a successful install materializes. */
  layout?: "posix" | "win32";
  /** Windows only: leave the platform package (and its image) out. */
  image?: boolean;
}

/** A contract-faithful fake: successful installer children materialize the
 * exact postcondition, while `--version` is a separate absolute-path probe.
 * With `noisy`, vendor output follows the supplied stdio routing. */
const installerSpawn = (options: InstallerSpawnOptions) => {
  const target = options.target ?? "remote";
  const installerStatus = options.installerStatus ?? 0;
  const materialize = options.materialize ?? true;
  const versionOutput =
    options.versionOutput ??
    (options.harness === "cursor"
      ? "cursor-agent 1.2.3\n"
      : `${options.harness} ${NPM_FIXTURES[options.harness].version}\n`);
  return vi.fn((binary: string, argv: string[], spawnOptions?: { stdio?: unknown }) => {
    if (argv.length === 1 && argv[0] === "--version") {
      return {
        status: options.versionStatus ?? 0,
        stdout: versionOutput,
        stderr: "",
      } as never;
    }
    if (binary === "curl") {
      writeFileSync(argv.at(-1) ?? "", "#!/bin/sh\necho fake-installer\n");
    } else if (installerStatus === 0 && materialize) {
      if (binary === "/bin/bash") installCursorFixture(options.home);
      else if (options.harness !== "cursor") {
        installNpmFixture(options.home, target, options.harness, {
          layout: options.layout,
          image: options.image,
        });
      }
    }
    if (options.noisy) {
      const stdio = spawnOptions?.stdio;
      const stdoutTarget = Array.isArray(stdio) && stdio[1] === 2 ? process.stderr : process.stdout;
      stdoutTarget.write("vendor noise: added 42 packages in 3s\n");
    }
    return { status: installerStatus } as never;
  });
};

afterEach(() => vi.restoreAllMocks());

describe("harness install --target local", () => {
  it("accepts only the two explicit install targets", () => {
    expect(HARNESS_INSTALL_TARGETS).toEqual(["local", "remote"]);
    expect(isHarnessInstallTarget("local")).toBe(true);
    expect(isHarnessInstallTarget("remote")).toBe(true);
    expect(isHarnessInstallTarget("../../tmp")).toBe(false);
  });

  it("uses managedNodeRoot for an explicit local npm target", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-local-npm-proof-"));
    const spawn = installerSpawn({ home, harness: "codex", target: "local" });
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/bin/node",
        target: "local",
        spawn: spawn as never,
        mkdir: vi.fn(),
        exists: () => true,
        lock: false,
      });
      expect(result).toEqual({
        exitCode: 0,
        installedBinary: join(home, ".claudexor", "node", "bin", "codex"),
        installedVersion: CODEX_VENDOR_CLI_VERSION,
      });
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "/runtime/node/bin/node",
        [
          "/runtime/node/lib/node_modules/npm/bin/npm-cli.js",
          "install",
          "--global",
          "--prefix",
          join(home, ".claudexor", "node"),
          `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
        ],
        expect.objectContaining({ stdio: "inherit" }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("turns a zero-exit npm false-success into a typed verification refusal", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-npm-false-success-"));
    const spawn = installerSpawn({
      home,
      harness: "codex",
      target: "local",
      materialize: false,
    });
    try {
      const result = runHarnessInstaller("codex", {
        home,
        target: "local",
        nodePath: "/runtime/node/bin/node",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
      });
      expect(result).toEqual({
        exitCode: 1,
        code: "install_verification_failed",
        refusal:
          "codex installer exited successfully, but installation verification failed: the exact npm package root is missing or unreadable",
      });
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an exact npm pin whose launcher is zero bytes", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-npm-zero-launcher-"));
    installNpmFixture(home, "local", "codex", { binaryBody: "" });
    const spawn = installerSpawn({
      home,
      harness: "codex",
      target: "local",
      materialize: false,
    });
    try {
      expect(
        runHarnessInstaller("codex", {
          home,
          nodePath: "/runtime/node/bin/node",
          target: "local",
          spawn: spawn as never,
          exists: () => true,
          lock: false,
        }),
      ).toMatchObject({ exitCode: 1, code: "install_verification_failed" });
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an npm launcher whose canonical symlink target escapes the prefix", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-npm-escaping-launcher-"));
    const installed = installNpmFixture(home, "local", "codex");
    const outside = join(home, "outside", "codex");
    writeExecutable(outside);
    rmSync(installed.binary);
    symlinkSync(outside, installed.binary);
    const spawn = installerSpawn({
      home,
      harness: "codex",
      target: "local",
      materialize: false,
    });
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/bin/node",
        target: "local",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
      });
      expect(result).toMatchObject({ exitCode: 1, code: "install_verification_failed" });
      expect(result.refusal).toContain("canonical target escapes the install prefix");
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an exact npm package root symlink that escapes the prefix", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-npm-escaping-package-"));
    const root = vendorRoot(home, "local");
    const outsidePackage = join(home, "outside-package");
    mkdirSync(outsidePackage, { recursive: true });
    writeFileSync(
      join(outsidePackage, "package.json"),
      `${JSON.stringify({ version: CODEX_VENDOR_CLI_VERSION })}\n`,
    );
    const packageRoot = join(root, "lib", "node_modules", "@openai", "codex");
    mkdirSync(dirname(packageRoot), { recursive: true });
    symlinkSync(outsidePackage, packageRoot);
    writeExecutable(join(root, "bin", "codex"));
    const spawn = installerSpawn({
      home,
      harness: "codex",
      target: "local",
      materialize: false,
    });
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/bin/node",
        target: "local",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
      });
      expect(result).toMatchObject({ exitCode: 1, code: "install_verification_failed" });
      expect(result.refusal).toContain("package root escapes the install prefix");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps Cursor installer evidence when a zero exit fails post-install verification", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-false-success-"));
    const spawn = installerSpawn({ home, harness: "cursor", materialize: false });
    try {
      const result = runHarnessInstaller("cursor", {
        home,
        target: "local",
        spawn: spawn as never,
        lock: false,
        sourceEnv: { PATH: "" },
      });
      expect(result).toMatchObject({
        exitCode: 1,
        code: "install_verification_failed",
        refusal: expect.stringContaining("exact cursor-agent launcher is missing"),
        installerByteLength: expect.any(Number),
        installerSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(Object.keys(result).sort()).toEqual(
        ["code", "exitCode", "installerByteLength", "installerSha256", "refusal"].sort(),
      );
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts Cursor's official .local/bin symlink into .local/share", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-share-link-"));
    const installed = installCursorFixture(home);
    const spawn = installerSpawn({ home, harness: "cursor", target: "local" });
    try {
      expect(
        runHarnessInstaller("cursor", {
          home,
          target: "local",
          spawn: spawn as never,
          lock: false,
          sourceEnv: { PATH: "" },
        }),
      ).toEqual({
        exitCode: 0,
        installedBinary: installed.binary,
        installedVersion: "cursor-agent 1.2.3",
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        installed.binary,
        ["--version"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a zero-byte cursor-agent even when it is launchable", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-zero-launcher-"));
    const installed = join(home, ".local", "bin", "cursor-agent");
    writeExecutable(installed, "");
    const spawn = installerSpawn({
      home,
      harness: "cursor",
      target: "local",
      materialize: false,
    });
    try {
      const result = runHarnessInstaller("cursor", {
        home,
        target: "local",
        spawn: spawn as never,
        lock: false,
        sourceEnv: { PATH: "" },
      });
      expect(result).toMatchObject({ exitCode: 1, code: "install_verification_failed" });
      expect(result.refusal).toContain("cursor-agent target is empty");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a local Windows install typed, before side effects, for every vendor without a verified image", () => {
    for (const [harness, reason] of [
      ["opencode", "npm entrypoint has not been verified for Windows"],
      ["cursor", "not supported on Windows for cursor"],
      ["agy", "not supported on Windows for agy"],
    ] as const) {
      const spawn = vi.fn(() => ({ status: 0 }) as never);
      const mkdir = vi.fn();
      const result = runHarnessInstaller(harness, {
        home: "/tmp/operator",
        target: "local",
        platform: "win32",
        arch: "x64",
        spawn: spawn as never,
        mkdir,
      });
      expect(result).toMatchObject({ exitCode: 1, code: "unsupported_platform" });
      expect(result.refusal).toContain(reason);
      expect(result.refusal).toContain("nothing was executed");
      expect(spawn).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    }
    // The verified image exists only for x64/arm64 platform packages.
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("codex", {
      home: "/tmp/operator",
      target: "local",
      platform: "win32",
      arch: "ia32",
      spawn: spawn as never,
    });
    expect(result).toMatchObject({ exitCode: 1, code: "unsupported_platform" });
    expect(result.refusal).toContain("ia32 architecture");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("installs a native Codex npm bin on Windows using the embedded npm CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-win-codex-"));
    const spawn = installerSpawn({ home, harness: "codex", target: "local", layout: "win32" });
    const secrets = { OPENAI_API_KEY: "sk-never", ANTHROPIC_API_KEY: "never" };
    const windowsKeys = {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/node.exe",
        target: "local",
        platform: "win32",
        arch: "x64",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
        sourceEnv: { PATH: "", ...secrets, ...windowsKeys },
      });
      const image = join(WINDOWS_CODEX_IMAGE_DIR(vendorRoot(home, "local")), "codex.exe");
      expect(result).toEqual({
        exitCode: 0,
        installedBinary: image,
        installedVersion: CODEX_VENDOR_CLI_VERSION,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "/runtime/node/node.exe",
        [
          join("/runtime", "node", "node_modules", "npm", "bin", "npm-cli.js"),
          "install",
          "--global",
          "--prefix",
          join(home, ".claudexor", "node"),
          `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
        ],
        expect.objectContaining({ stdio: "inherit" }),
      );
      // The absolute image, never the `codex`/`codex.cmd` shims npm left in
      // the prefix root, is what the proof executes.
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        image,
        ["--version"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
      );
      // The captured proof hides its direct child; the npm install keeps its terminal.
      expect(spawn.mock.calls[0]![2]).not.toHaveProperty("windowsHide");
      // Windows process keys reach npm and the image; provider secrets never do.
      const npmEnv = (spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
      expect(npmEnv).toMatchObject({
        SYSTEMROOT: "C:\\Windows",
        TEMP: "C:\\Temp",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        HOME: home,
      });
      expect(npmEnv.OPENAI_API_KEY).toBeUndefined();
      expect(npmEnv.ANTHROPIC_API_KEY).toBeUndefined();
      // The same PATH every local surface composes resolves the same image.
      const harnessPath = normalizedHarnessPath(
        { HOME: home, PATH: "" },
        "/no/such/node",
        "win32",
        "x64",
      );
      expect(harnessBinaryIdentityOnPath("codex", harnessPath, "win32")?.path).toBe(
        realpathSync(image),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs Claude's declared Windows executable through the same npm proof", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-win-claude-"));
    const spawn = installerSpawn({ home, harness: "claude", target: "local", layout: "win32" });
    try {
      const result = runHarnessInstaller("claude", {
        home,
        nodePath: "/runtime/node/node.exe",
        target: "local",
        platform: "win32",
        arch: "x64",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
        sourceEnv: { PATH: "" },
      });
      expect(result).toEqual({
        exitCode: 0,
        installedBinary: join(
          vendorRoot(home, "local"),
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "bin",
          "claude.exe",
        ),
        installedVersion: CLAUDE_VENDOR_CLI_VERSION,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a shim-only Windows install (platform package missing) as a verification failure", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-win-shim-only-"));
    const spawn = installerSpawn({
      home,
      harness: "codex",
      target: "local",
      layout: "win32",
      image: false,
    });
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/node.exe",
        target: "local",
        platform: "win32",
        arch: "x64",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
        sourceEnv: { PATH: "" },
      });
      expect(result).toMatchObject({ exitCode: 1, code: "install_verification_failed" });
      expect(result.refusal).toContain("standard npm Windows entrypoint is missing");
      expect(spawn).toHaveBeenCalledOnce();
      expect(existsSync(join(vendorRoot(home, "local"), "codex.cmd"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("anchors the Windows prefix on the HOME the harness PATH producer reads", () => {
    const scoped = mkdtempSync(join(tmpdir(), "claudexor-win-scoped-home-"));
    const spawn = installerSpawn({
      home: scoped,
      harness: "codex",
      target: "local",
      layout: "win32",
    });
    try {
      const result = runHarnessInstaller("codex", {
        nodePath: "/runtime/node/node.exe",
        target: "local",
        platform: "win32",
        arch: "x64",
        spawn: spawn as never,
        exists: () => true,
        lock: false,
        sourceEnv: { PATH: "", HOME: scoped },
      });
      expect(result).toMatchObject({ exitCode: 0 });
      const argv = spawn.mock.calls[0]![1] as string[];
      expect(argv[argv.indexOf("--prefix") + 1]).toBe(join(scoped, ".claudexor", "node"));
      expect(result.installedBinary?.startsWith(join(scoped, ".claudexor", "node"))).toBe(true);
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  });

  it("serializes installs and rechecks an exact npm pin after taking the lease", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-harness-install-"));
    const packageRoot = join(home, ".claudexor", "node", "lib", "node_modules", "@openai", "codex");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ version: CODEX_VENDOR_CLI_VERSION })}\n`,
    );
    const installed = join(home, ".claudexor", "node", "bin", "codex");
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(installed, 0o755);
    const spawn = installerSpawn({ home, harness: "codex", target: "local" });
    try {
      expect(
        runHarnessInstaller("codex", {
          home,
          nodePath: "/runtime/node/bin/node",
          target: "local",
          exists: () => true,
          spawn: spawn as never,
          sourceEnv: { PATH: "" },
        }),
      ).toEqual({
        exitCode: 0,
        installedBinary: installed,
        installedVersion: CODEX_VENDOR_CLI_VERSION,
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        installed,
        ["--version"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(existsSync(join(home, ".claudexor", "harness-install.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("repairs an exact npm package when its binary exists only outside the target prefix", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-harness-partial-"));
    const packageRoot = join(home, ".claudexor", "node", "lib", "node_modules", "@openai", "codex");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ version: CODEX_VENDOR_CLI_VERSION })}\n`,
    );
    const outsideBin = join(home, "outside-bin");
    const outsideCodex = join(outsideBin, "codex");
    mkdirSync(outsideBin);
    writeFileSync(outsideCodex, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(outsideCodex, 0o755);
    const spawn = installerSpawn({ home, harness: "codex", target: "local" });
    try {
      expect(
        runHarnessInstaller("codex", {
          home,
          nodePath: "/runtime/node/bin/node",
          target: "local",
          exists: () => true,
          spawn: spawn as never,
          sourceEnv: { PATH: outsideBin },
        }),
      ).toEqual({
        exitCode: 0,
        installedBinary: join(home, ".claudexor", "node", "bin", "codex"),
        installedVersion: CODEX_VENDOR_CLI_VERSION,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "/runtime/node/bin/node",
        expect.arrayContaining([
          "/runtime/node/lib/node_modules/npm/bin/npm-cli.js",
          `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
        ]),
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(existsSync(join(home, ".claudexor", "harness-install.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns a typed busy refusal when another live process owns the install lease", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-harness-lock-"));
    const lock = join(home, ".claudexor", "harness-install.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "held" })}\n`,
    );
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/bin/node",
        target: "local",
        exists: () => true,
        spawn: spawn as never,
        lockTimeoutMs: 0,
      });
      expect(result).toMatchObject({ exitCode: 1, code: "install_lock_busy" });
      expect(result.refusal).toContain("nothing was executed");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves the watched remote flow outside the lease and the proof entirely", () => {
    // The unattended local contract must not reach the SSH-host flow: a lease
    // there would add a 120s block plus a manual cleanup step to a path this
    // release promises to leave alone, and a proof would turn its historical
    // exit-code contract into a stricter one.
    const home = mkdtempSync(join(tmpdir(), "claudexor-remote-untouched-"));
    const lock = join(home, ".claudexor", "harness-install.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "held" })}\n`,
    );
    // No fixture is materialized, so a proof would refuse this install.
    const spawn = vi.fn((_binary: string, _argv: readonly string[]) => ({ status: 0 }) as never);
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/bin/node",
        exists: () => true,
        spawn: spawn as never,
        lockTimeoutMs: 0,
      });
      expect(result).toEqual({ exitCode: 0 });
      expect(spawn).toHaveBeenCalledOnce();
      const argv = spawn.mock.calls[0]![1] as string[];
      expect(argv).toContain("--prefix");
      expect(argv[argv.indexOf("--prefix") + 1]).toBe(join(home, ".claudexor", "remote", "vendor"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses an empty local download but lets the watched remote flow run it as upstream did", () => {
    // The empty-body refusal is part of the unattended local proof contract.
    // Remote keeps upstream behaviour: the human sees "0 bytes" printed and the
    // vendor script's own exit decides the outcome.
    const emptyCurlSpawn = () =>
      vi.fn((binary: string, argv: readonly string[]) => {
        if (binary === "curl") writeFileSync(String(argv.at(-1)), "");
        return { status: 0 } as never;
      });
    const localHome = mkdtempSync(join(tmpdir(), "claudexor-empty-local-"));
    const remoteHome = mkdtempSync(join(tmpdir(), "claudexor-empty-remote-"));
    try {
      const localSpawn = emptyCurlSpawn();
      const local = runHarnessInstaller("cursor", {
        home: localHome,
        target: "local",
        spawn: localSpawn as never,
        lock: false,
        // Pin resolution to the fixture HOME: the host machine may really have
        // a cursor-agent on PATH, which would satisfy the pre-install proof.
        sourceEnv: { PATH: "" } as NodeJS.ProcessEnv,
      });
      expect(local).toMatchObject({ exitCode: 1, code: "installer_empty" });
      expect(localSpawn).toHaveBeenCalledOnce();

      const remoteSpawn = emptyCurlSpawn();
      const remote = runHarnessInstaller("cursor", {
        home: remoteHome,
        spawn: remoteSpawn as never,
        sourceEnv: { PATH: "" } as NodeJS.ProcessEnv,
      });
      expect(remote).toEqual({ exitCode: 0 });
      expect(remoteSpawn).toHaveBeenCalledTimes(2);
      expect(remoteSpawn.mock.calls[1]![0]).toBe("/bin/bash");
    } finally {
      rmSync(localHome, { recursive: true, force: true });
      rmSync(remoteHome, { recursive: true, force: true });
    }
  });

  it("fails closed without mutating a lease whose recorded owner has exited", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-harness-stale-lock-"));
    const lock = join(home, ".claudexor", "harness-install.lock");
    mkdirSync(lock, { recursive: true });
    const exited = spawnChildSync(process.execPath, ["-e", ""]);
    expect(exited.status).toBe(0);
    expect(exited.pid).toBeTypeOf("number");
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({ pid: exited.pid, token: "dead-owner" })}\n`,
    );
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    try {
      const result = runHarnessInstaller("codex", {
        home,
        nodePath: "/runtime/node/bin/node",
        target: "local",
        exists: () => true,
        spawn: spawn as never,
        lockTimeoutMs: 0,
      });
      expect(result).toMatchObject({ exitCode: 1, code: "install_lock_stale" });
      expect(result.refusal).toContain("verify no installer is running");
      expect(existsSync(lock)).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed on an old owner-less lease but treats its write grace as busy", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-harness-ownerless-lock-"));
    const lock = join(home, ".claudexor", "harness-install.lock");
    mkdirSync(lock, { recursive: true });
    const options = {
      home,
      nodePath: "/runtime/node/bin/node",
      target: "local" as const,
      exists: () => true,
      spawn: vi.fn(() => ({ status: 0 }) as never) as never,
      lockTimeoutMs: 0,
    };
    try {
      expect(runHarnessInstaller("codex", options)).toMatchObject({
        exitCode: 1,
        code: "install_lock_busy",
      });
      const old = new Date(Date.now() - 10_000);
      utimesSync(lock, old, old);
      expect(runHarnessInstaller("codex", options)).toMatchObject({
        exitCode: 1,
        code: "install_lock_stale",
      });
      expect(existsSync(lock)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rechecks supported cursor-agent under the target-aware PATH after taking the lease", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-install-"));
    const installed = join(home, ".cursor", "bin", "cursor-agent");
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(installed, 0o755);
    const spawn = installerSpawn({ home, harness: "cursor", target: "local" });
    try {
      expect(
        runHarnessInstaller("cursor", {
          home,
          target: "local",
          spawn: spawn as never,
          sourceEnv: { PATH: "" },
        }),
      ).toEqual({
        exitCode: 0,
        installedBinary: installed,
        installedVersion: "cursor-agent 1.2.3",
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        installed,
        ["--version"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(existsSync(join(home, ".claudexor", "harness-install.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat an unrelated bare agent as Cursor readiness", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-cursor-agent-alias-"));
    const unrelated = join(home, ".cursor", "bin", "agent");
    mkdirSync(dirname(unrelated), { recursive: true });
    writeFileSync(unrelated, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(unrelated, 0o755);
    const spawn = installerSpawn({ home, harness: "cursor", target: "local" });
    try {
      expect(
        runHarnessInstaller("cursor", {
          home,
          target: "local",
          spawn: spawn as never,
          sourceEnv: { PATH: "" },
        }),
      ).toMatchObject({ exitCode: 0, installerByteLength: expect.any(Number) });
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        "curl",
        expect.any(Array),
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "/bin/bash",
        expect.any(Array),
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(spawn).toHaveBeenNthCalledWith(
        3,
        join(home, ".local", "bin", "cursor-agent"),
        ["--version"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--target local projects the local managed destination", () => {
    const ambient = ambientManagedCodex();
    const home = mkdtempSync(join(tmpdir(), "claudexor-local-destination-"));
    const spawn = vi.fn();
    const stdout = captureStdout();
    try {
      const code = harnessInstallCommand(
        args(["harness", "install", "codex"], {
          "dry-run": true,
          target: "local",
          "release-tested": true,
        }),
        true,
        { home, spawn: spawn as never },
      );
      stdout.restore();
      const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
      expect(code).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        dryRun: true,
        harness: "codex",
        target: "local",
        installLocation: "~/.claudexor/node/bin",
        pinnedVersion: CODEX_VENDOR_CLI_VERSION,
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(ambient.marker)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(ambient.home, { recursive: true, force: true });
    }
  });

  it("rejects an absent or unknown --target before any install", () => {
    const stdout = captureStdout();
    expect(
      harnessInstallCommand(args(["harness", "install", "codex"], { target: "elsewhere" }), true),
    ).toBe(2);
    expect(
      harnessInstallCommand(args(["harness", "install", "codex"], { target: true }), true),
    ).toBe(2);
    stdout.restore();
    expect(stdout.lines()).not.toContain("@openai/codex@");
  });

  it("returns a typed local Windows refusal before the runner can spawn", () => {
    const stdout = captureStdout();
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const code = harnessInstallCommand(
      args(["harness", "install", "opencode"], { target: "local", yes: true }),
      true,
      { platform: "win32", arch: "x64", spawn: spawn as never },
    );
    stdout.restore();
    expect(code).toBe(1);
    expect(JSON.parse(stdout.lines())).toMatchObject({
      ok: false,
      dryRun: false,
      exitCode: 1,
      code: "unsupported_platform",
      harness: "opencode",
      target: "local",
      installLocation: "~/.claudexor/node/node_modules/opencode-ai (npm executable entrypoint)",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("emits the exact tested-baseline receipt for a Windows codex install, naming the image dir", () => {
    const ambient = ambientManagedCodex();
    const home = mkdtempSync(join(tmpdir(), "claudexor-win-json-receipt-"));
    const stdout = captureStdout();
    const stderr = captureStderr();
    const spawn = installerSpawn({ home, harness: "codex", target: "local", layout: "win32" });
    const imageDir = "~/.claudexor/node/node_modules/@openai/codex (npm executable entrypoint)";
    // Would prove the ambient 50.0.0 copy if selection read the ambient HOME.
    const dryRunSpawn = vi.fn(() => ({ status: 0, stdout: "codex-cli 50.0.0\n", stderr: "" }));
    try {
      const dryRunCode = harnessInstallCommand(
        args(["harness", "install", "codex"], {
          target: "local",
          "dry-run": true,
          "release-tested": true,
        }),
        true,
        { home, platform: "win32", arch: "x64", spawn: dryRunSpawn as never },
      );
      expect(dryRunCode).toBe(0);
      expect(dryRunSpawn).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.lines())).toEqual({
        ok: true,
        dryRun: true,
        harness: "codex",
        target: "local",
        command: `npm install --global --prefix ~/.claudexor/node @openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
        installLocation: imageDir,
        pinnedVersion: CODEX_VENDOR_CLI_VERSION,
        verification: "release_verified",
        // Dry-run only: the executed receipt below keeps its exact keys.
        versionBinding: "vendor-version",
      });
      stdout.restore();
      const executed = captureStdout();
      const code = harnessInstallCommand(
        args(["harness", "install", "codex"], {
          target: "local",
          yes: true,
          "release-tested": true,
        }),
        true,
        {
          home,
          nodePath: "/runtime/node/node.exe",
          platform: "win32",
          arch: "x64",
          spawn: spawn as never,
          exists: () => true,
          lock: false,
          sourceEnv: { PATH: "" },
        },
      );
      executed.restore();
      expect(code).toBe(0);
      const payload = JSON.parse(executed.lines()) as Record<string, unknown>;
      // Exactly the receipt fields an embedding host validates — no new keys.
      expect(payload).toEqual({
        ok: true,
        dryRun: false,
        exitCode: 0,
        harness: "codex",
        target: "local",
        command: `npm install --global --prefix ~/.claudexor/node @openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
        installLocation: imageDir,
        pinnedVersion: CODEX_VENDOR_CLI_VERSION,
        verification: "release_verified",
        installedBinary: join(WINDOWS_CODEX_IMAGE_DIR(vendorRoot(home, "local")), "codex.exe"),
        installedVersion: CODEX_VENDOR_CLI_VERSION,
      });
      expect(existsSync(ambient.marker)).toBe(false);
    } finally {
      stdout.restore();
      stderr.restore();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(ambient.home, { recursive: true, force: true });
    }
  });

  it("normalizes an unexpected npm mkdir failure into one fully disclosed JSON envelope", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-json-mkdir-failure-"));
    const stdout = captureStdout();
    const stderr = captureStderr();
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const mkdir = vi.fn(() => {
      throw failure;
    });
    try {
      const code = harnessInstallCommand(
        args(["harness", "install", "codex"], {
          yes: true,
          target: "local",
          "release-tested": true,
        }),
        true,
        {
          home,
          nodePath: "/runtime/node/bin/node",
          exists: () => true,
          mkdir: mkdir as never,
          lock: false,
          sourceEnv: { PATH: "" },
        },
      );
      expect(code).toBe(1);
      const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
      expect(payload).toEqual({
        dryRun: false,
        harness: "codex",
        target: "local",
        command: `npm install --global --prefix ~/.claudexor/node @openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
        installLocation: "~/.claudexor/node/bin",
        pinnedVersion: CODEX_VENDOR_CLI_VERSION,
        verification: "release_verified",
        ok: false,
        exitCode: 1,
        code: "harness_install_failed",
        message:
          "claudexor harness install: harness installer failed without a verified result: permission denied",
        error:
          "claudexor harness install: harness installer failed without a verified result: permission denied",
        details: { causeCode: "EACCES" },
      });
      expect(mkdir).toHaveBeenCalledOnce();
      expect(stderr.lines()).toBe("");
    } finally {
      stdout.restore();
      stderr.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("normalizes a thrown Cursor shell and cleans its temp directory and install lease", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-json-cursor-throw-"));
    const stdout = captureStdout();
    const stderr = captureStderr();
    let installerPath = "";
    const spawn = vi.fn((binary: string, argv: string[]) => {
      if (binary === "curl") {
        installerPath = argv.at(-1) ?? "";
        writeFileSync(installerPath, "#!/bin/sh\n");
        return { status: 0 } as never;
      }
      if (binary === "/bin/bash") {
        throw Object.assign(new Error("shell execution failed"), { code: "EIO" });
      }
      throw new Error(`unexpected child ${binary}`);
    });
    try {
      const code = harnessInstallCommand(
        args(["harness", "install", "cursor"], { yes: true, target: "local" }),
        true,
        {
          home,
          spawn: spawn as never,
          sourceEnv: { PATH: "" },
        },
      );
      expect(code).toBe(1);
      const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
      expect(payload).toEqual({
        dryRun: false,
        harness: "cursor",
        target: "local",
        command:
          `curl --fail --silent --show-error --location ${CURSOR_INSTALL_URL} ` +
          "--output <private-tmpdir>/install.sh && /bin/bash <private-tmpdir>/install.sh",
        installLocation: "~/.local/bin (or ~/.cursor/bin, as selected by Cursor's installer)",
        pinnedVersion: null,
        verification: "unattended_unpinned",
        ok: false,
        exitCode: 1,
        code: "harness_install_failed",
        message:
          "claudexor harness install: harness installer failed without a verified result: shell execution failed",
        error:
          "claudexor harness install: harness installer failed without a verified result: shell execution failed",
        details: { causeCode: "EIO" },
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(installerPath).not.toBe("");
      expect(existsSync(dirname(installerPath))).toBe(false);
      expect(existsSync(join(home, ".claudexor", "harness-install.lock"))).toBe(false);
      expect(stderr.lines()).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
      expect(stderr.lines()).toContain("running: /bin/bash ");
    } finally {
      stdout.restore();
      stderr.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
