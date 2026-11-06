import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_VENDOR_CLI_VERSION } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import { OPENCODE_VENDOR_CLI_VERSION } from "@claudexor/harness-opencode";
import { copilot } from "@claudexor/harness-acp";
import type { ParsedArgs } from "./args.js";
import { INSTALLABLE_HARNESSES } from "./harness-command-specs.js";
import {
  AGY_INSTALL_URL,
  AGY_INSTALL_URL_WINDOWS,
  CURSOR_INSTALL_URL,
  harnessInstallCommand,
  harnessInstallerDisclosure,
  isInstallableHarness,
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

/** A hostile child: writes vendor noise onto whatever fd its stdout was
 * routed to (fd 2 in json mode, the caller's stdout otherwise) — exactly
 * what real npm/curl/install.sh interleaving looks like. */
const noisySpawn = (status: number) =>
  vi.fn((binary: string, argv: string[], options?: { stdio?: unknown }) => {
    if (binary === "curl") {
      const target = argv.at(-1) ?? "";
      writeFileSync(target, "#!/bin/sh\necho fake-installer\n");
    }
    const stdio = options?.stdio;
    const stdoutTarget = Array.isArray(stdio) && stdio[1] === 2 ? process.stderr : process.stdout;
    stdoutTarget.write("vendor noise: added 42 packages in 3s\n");
    return { status } as never;
  });

afterEach(() => vi.restoreAllMocks());

describe("remote harness installer allowlist", () => {
  it("rejects every non-allowlisted identifier", () => {
    expect(isInstallableHarness("codex")).toBe(true);
    expect(isInstallableHarness("../../bin/sh")).toBe(false);
    expect(isInstallableHarness("codex; touch /tmp/pwned")).toBe(false);
  });
});

describe("pinned versions (issue #89: never @latest)", () => {
  it("every npm harness pins the exact vendor-version SSOT the freshness gates read", () => {
    const pins = {
      claude: {
        version: CLAUDE_VENDOR_CLI_VERSION,
        verification: "release_verified",
      },
      codex: {
        version: CODEX_VENDOR_CLI_VERSION,
        verification: "release_verified",
      },
      opencode: {
        version: OPENCODE_VENDOR_CLI_VERSION,
        verification: "deterministic_only",
      },
      copilot: { version: copilot.version, verification: "deterministic_only" },
    } as const;
    for (const [harness, pin] of Object.entries(pins)) {
      const disclosure = harnessInstallerDisclosure(
        harness as (typeof INSTALLABLE_HARNESSES)[number],
      );
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(disclosure.pinnedVersion).toBe(pin.version);
      expect(disclosure.command.endsWith(`@${pin.version}`)).toBe(true);
      expect(disclosure.verification).toBe(pin.verification);
    }
    for (const harness of INSTALLABLE_HARNESSES) {
      expect(harnessInstallerDisclosure(harness).command).not.toContain("@latest");
    }
  });

  it("discloses the exact command and destination", () => {
    expect(harnessInstallerDisclosure("claude")).toEqual({
      harness: "claude",
      target: "remote",
      command: `npm install --global --prefix ~/.claudexor/remote/vendor @anthropic-ai/claude-code@${CLAUDE_VENDOR_CLI_VERSION}`,
      installLocation: "~/.claudexor/remote/vendor/bin",
      pinnedVersion: CLAUDE_VENDOR_CLI_VERSION,
      verification: "release_verified",
    });
  });

  it("the local target names the managed toolchain prefix, not the remote one", () => {
    expect(harnessInstallerDisclosure("claude", "local")).toEqual({
      harness: "claude",
      target: "local",
      command: `npm install --global --prefix ~/.claudexor/node @anthropic-ai/claude-code@${CLAUDE_VENDOR_CLI_VERSION}`,
      installLocation: "~/.claudexor/node/bin",
      pinnedVersion: CLAUDE_VENDOR_CLI_VERSION,
      verification: "release_verified",
    });
  });

  it("a script vendor installed unattended locally never claims human observation", () => {
    expect(harnessInstallerDisclosure("cursor", "local").verification).toBe("unattended_unpinned");
    expect(harnessInstallerDisclosure("agy", "local").verification).toBe("unattended_unpinned");
    expect(harnessInstallerDisclosure("cursor", "remote").verification).toBe("human_observed");
  });

  it("agy takes the same honest unpinnable path as cursor (one branch, two rows)", () => {
    const disclosure = harnessInstallerDisclosure("agy");
    expect(disclosure.pinnedVersion).toBeNull();
    expect(disclosure.verification).toBe("human_observed");
    expect(disclosure.command).toContain(AGY_INSTALL_URL);
    expect(disclosure.command).toContain("--fail");
    // Google documents `curl ... | bash`; Claudexor NEVER pipes a remote
    // script into a shell — it downloads the whole file, prints its sha256,
    // and executes the file the operator was shown.
    expect(disclosure.command).not.toMatch(/\|\s*(\/bin\/)?(ba)?sh/);
    expect(disclosure.installLocation).toContain("~/.local/bin");
  });

  it("cursor is honestly unpinnable: full download, never piped, human watches the PTY", () => {
    const disclosure = harnessInstallerDisclosure("cursor");
    expect(disclosure.pinnedVersion).toBeNull();
    expect(disclosure.verification).toBe("human_observed");
    expect(disclosure.command).toContain(CURSOR_INSTALL_URL);
    expect(disclosure.command).toContain("--fail");
    expect(disclosure.command).not.toMatch(/\|\s*(\/bin\/)?(ba)?sh/);
  });
});

describe("runHarnessInstaller", () => {
  it("downloads and executes the agy script through the shared script branch", () => {
    const spawn = noisySpawn(0);
    const stdout = captureStdout();
    const result = runHarnessInstaller("agy", { home: "/tmp/operator", spawn: spawn as never });
    stdout.restore();
    expect(result).toEqual({ exitCode: 0 });
    const curlArgv = spawn.mock.calls[0]![1] as string[];
    expect(curlArgv).toContain(AGY_INSTALL_URL);
    const installerPath = curlArgv.at(-1)!;
    expect(installerPath).toContain("claudexor-agy-install-");
    expect(spawn.mock.calls[1]![0]).toBe("/bin/bash");
    expect(stdout.lines()).toMatch(/agy installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    // The private temp dir is removed on the success path too.
    expect(existsSync(dirname(installerPath))).toBe(false);
  });

  it("uses the shared clean child environment instead of forwarding provider secrets", () => {
    const names = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "HTTPS_PROXY"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.OPENAI_API_KEY = "secret-openai";
    process.env.ANTHROPIC_API_KEY = "secret-anthropic";
    process.env.GITHUB_TOKEN = "secret-github";
    process.env.HTTPS_PROXY = "https://proxy.example";
    let environment: NodeJS.ProcessEnv | undefined;
    const spawn = vi.fn(
      (_binary: string, _argv: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        environment = options?.env;
        return { status: 0 } as never;
      },
    );
    try {
      runHarnessInstaller("codex", {
        home: "/tmp/operator",
        nodePath: "/runtime/node/bin/node",
        spawn: spawn as never,
        mkdir: vi.fn(),
        exists: () => true,
      });
      expect(environment?.HOME).toBe("/tmp/operator");
      expect(environment?.HTTPS_PROXY).toBe("https://proxy.example");
      expect(environment?.OPENAI_API_KEY).toBeUndefined();
      expect(environment?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(environment?.GITHUB_TOKEN).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("uses typed argv for npm installers with the exact pin under the app-owned prefix", () => {
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("codex", {
      home: "/tmp/operator",
      nodePath: "/runtime/node/bin/node",
      spawn: spawn as never,
      mkdir: vi.fn(),
      exists: () => true,
    });
    expect(result).toEqual({ exitCode: 0 });
    expect(spawn).toHaveBeenCalledWith(
      "/runtime/node/bin/node",
      [
        "/runtime/node/lib/node_modules/npm/bin/npm-cli.js",
        "install",
        "--global",
        "--prefix",
        "/tmp/operator/.claudexor/remote/vendor",
        `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("refuses loudly, naming the expected path, when the bundled npm entrypoint is missing", () => {
    // A Node closure without the bundled npm tree must be a typed refusal
    // BEFORE any spawn — never node's raw "Cannot find module" crash.
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("codex", {
      home: "/tmp/operator",
      nodePath: "/runtime/node/bin/node",
      spawn: spawn as never,
      mkdir: vi.fn(),
      exists: () => false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusal).toContain("/runtime/node/lib/node_modules/npm/bin/npm-cli.js");
    expect(result.refusal).toContain("nothing was executed");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("downloads the Cursor installer, prints its sha256, executes it, and always cleans up", () => {
    const stdout = captureStdout();
    let installerPath = "";
    const spawn = vi.fn((binary: string, argv: string[]) => {
      if (binary === "curl") {
        installerPath = argv.at(-1) ?? "";
        writeFileSync(installerPath, "#!/bin/sh\necho fake-installer\n");
      }
      return { status: 0 } as never;
    });
    const result = runHarnessInstaller("cursor", {
      home: "/tmp/operator",
      spawn: spawn as never,
    });
    stdout.restore();
    expect(result).toEqual({ exitCode: 0 });
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        CURSOR_INSTALL_URL,
        "--output",
        installerPath,
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/bin/bash",
      [installerPath],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(stdout.lines()).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    expect(existsSync(dirname(installerPath))).toBe(false);
  });

  it("refuses loudly on a failed Cursor download and still removes the temp dir", () => {
    let installerPath = "";
    const spawn = vi.fn((binary: string, argv: string[]) => {
      if (binary === "curl") installerPath = argv.at(-1) ?? "";
      return { status: 22 } as never;
    });
    const result = runHarnessInstaller("cursor", { spawn: spawn as never });
    expect(result.exitCode).toBe(22);
    expect(result.refusal).toContain("nothing was executed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(installerPath))).toBe(false);
  });

  it("refuses to execute a Cursor script it cannot read back", () => {
    // curl "succeeds" but writes nothing — the read-back gate must refuse.
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const result = runHarnessInstaller("cursor", { spawn: spawn as never });
    expect(result.exitCode).toBe(1);
    expect(result.refusal).toContain("could not be read back");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["agy", "cursor"] as const)(
    "refuses %s before any download when /bin/bash is absent: no sh fallback, no checksum (#639)",
    (harness) => {
      const home = mkdtempSync(join(tmpdir(), "claudexor-no-bash-"));
      // A failing `--version` keeps any host-installed vendor CLI from
      // satisfying the local target's already-installed check.
      const spawn = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }) as never);
      const exists = vi.fn((path: PathLike) => path !== "/bin/bash");
      try {
        for (const target of ["remote", "local"] as const) {
          const result = runHarnessInstaller(harness, {
            home,
            target,
            spawn: spawn as never,
            exists,
          });
          expect(result).toEqual({
            exitCode: 1,
            code: "installer_interpreter_missing",
            refusal: `the ${harness} installer is a Bash script and /bin/bash is not present on this host; install Bash and retry — nothing was downloaded or executed`,
          });
        }
        expect(exists).toHaveBeenCalledWith("/bin/bash");
        // Only the local target's already-installed `--version` probe may run;
        // never curl, never a shell.
        for (const [binary] of spawn.mock.calls as unknown as [string][]) {
          expect(["curl", "/bin/bash", "/bin/sh"]).not.toContain(binary);
        }
        expect(existsSync(join(home, ".claudexor", "harness-install.lock"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "POSIX vendor scripts run under Bash, the interpreter both vendors require (#639)",
  () => {
    // Innocuous stand-in carrying the vendors' Bash-only constructs: agy's
    // `set -euo pipefail` + `local`, Cursor's `${VAR//…}` and `[[ … ]]`.
    const BASH_ONLY_FIXTURE = [
      "#!/bin/bash",
      "set -euo pipefail",
      'probe() { local value="$1"; printf "%s" "${value//[[:space:]]/}"; }',
      '[[ ":a:b:" == *":b:"* ]]',
      'probe " bash-ok " > "$HOME/interpreter-marker"',
      "",
    ].join("\n");
    /** curl writes the fixture; every other child is REALLY spawned, so the
     * interpreter the installer selects is the one that runs it. `runAs`
     * substitutes the runner binary to model a host whose shell differs. */
    const fixtureSpawn = (runAs?: string) =>
      vi.fn((binary: string, argv: string[], options?: Parameters<typeof spawnSync>[2]) => {
        if (binary === "curl") {
          writeFileSync(argv.at(-1) ?? "", BASH_ONLY_FIXTURE);
          return { status: 0 } as never;
        }
        return spawnSync(runAs ?? binary, argv, options ?? {});
      });

    it.each(["agy", "cursor"] as const)(
      "the real installer runs the downloaded %s script with /bin/bash",
      (harness) => {
        const home = mkdtempSync(join(tmpdir(), "claudexor-bash-runner-"));
        const stdout = captureStdout();
        try {
          const spawn = fixtureSpawn();
          const result = runHarnessInstaller(harness, { home, spawn: spawn as never });
          stdout.restore();
          expect(result).toEqual({ exitCode: 0 });
          expect(spawn.mock.calls[1]![0]).toBe("/bin/bash");
          expect(readFileSync(join(home, "interpreter-marker"), "utf8")).toBe("bash-ok");
          expect(stdout.lines()).toContain("running: /bin/bash ");
          expect(harnessInstallerDisclosure(harness).command).toMatch(
            / && \/bin\/bash <private-tmpdir>\/install\.sh$/,
          );
        } finally {
          stdout.restore();
          rmSync(home, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(!existsSync("/bin/dash"))(
      "negative control: under dash (Debian's /bin/sh) the same fixture fails and is never success",
      () => {
        const home = mkdtempSync(join(tmpdir(), "claudexor-dash-runner-"));
        const stdout = captureStdout();
        try {
          const result = runHarnessInstaller("agy", {
            home,
            spawn: fixtureSpawn("/bin/dash") as never,
          });
          stdout.restore();
          expect(result.exitCode).toBe(2);
          expect(result.installerSha256).toMatch(/^[0-9a-f]{64}$/);
          expect(existsSync(join(home, "interpreter-marker"))).toBe(false);
        } finally {
          stdout.restore();
          rmSync(home, { recursive: true, force: true });
        }
      },
    );
  },
);

describe("harnessInstallCommand disclosure/confirmation gate", () => {
  it("--dry-run prints the typed disclosure and executes nothing", () => {
    const stdout = captureStdout();
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { "dry-run": true, "release-tested": true }),
      true,
    );
    stdout.restore();
    const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
    expect(code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      dryRun: true,
      harness: "codex",
      pinnedVersion: CODEX_VENDOR_CLI_VERSION,
      installLocation: "~/.claudexor/remote/vendor/bin",
    });
  });

  it("refuses without --yes when no human can confirm (json mode / no TTY)", () => {
    const stdout = captureStdout();
    const code = harnessInstallCommand(args(["harness", "install", "claude"]), true);
    stdout.restore();
    const payload = JSON.parse(stdout.lines()) as Record<string, unknown>;
    expect(code).toBe(1);
    expect(payload).toMatchObject({ ok: false, code: "confirmation_required" });
  });

  it("rejects non-allowlisted or malformed install targets with usage exit 2", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(harnessInstallCommand(args(["harness", "install", "rm -rf /"]), false)).toBe(2);
    expect(harnessInstallCommand(args(["harness", "install"]), false)).toBe(2);
    expect(harnessInstallCommand(args(["harness", "install", "codex", "extra"]), false)).toBe(2);
    stderr.mockRestore();
  });

  it("the opencode disclosure names its pin a deterministic target, not a verified version", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    harnessInstallCommand(args(["harness", "install", "opencode"], { "dry-run": true }), false);
    harnessInstallCommand(args(["harness", "install", "claude"], { "dry-run": true }), false);
    stdout.restore();
    stderr.restore();
    const lines = stdout.lines();
    expect(lines).toContain(
      "deterministic install target — not covered by recorded verification fixtures",
    );
    expect(lines).toContain(
      `${CLAUDE_VENDOR_CLI_VERSION} (exact; the version this release was verified against`,
    );
  });
});

describe("--json stdout purity on the execute path (--yes)", () => {
  const jsonYesInstall = (
    harness: string,
    status: number,
  ): { code: number; stdout: string; stderr: string } => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    const code = harnessInstallCommand(
      args(["harness", "install", harness], {
        yes: true,
        ...(harness === "codex" ? { "release-tested": true } : {}),
      }),
      true,
      {
        home: "/tmp/operator",
        nodePath: "/runtime/node/bin/node",
        spawn: noisySpawn(status) as never,
        mkdir: vi.fn(),
        exists: () => true,
      },
    );
    stdout.restore();
    stderr.restore();
    return { code, stdout: stdout.lines(), stderr: stderr.lines() };
  };

  it("a successful npm install emits EXACTLY one JSON object on stdout; vendor noise lands on stderr", () => {
    const result = jsonYesInstall("codex", 0);
    expect(result.code).toBe(0);
    // The whole stdout parses as one object — a machine caller's JSON.parse
    // must survive a child that sprays garbage at its own stdout.
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, dryRun: false, exitCode: 0, harness: "codex" });
    expect(result.stdout).not.toContain("vendor noise");
    expect(result.stderr).toContain("vendor noise");
  });

  it("a failed install keeps stdout to the single {ok:false} envelope", () => {
    const result = jsonYesInstall("codex", 7);
    expect(result.code).toBe(7);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: false, dryRun: false, exitCode: 7 });
    expect(result.stdout).not.toContain("vendor noise");
  });

  it("the cursor path routes its sha256/running progress lines to stderr under --json", () => {
    const result = jsonYesInstall("cursor", 0);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, dryRun: false, exitCode: 0, harness: "cursor" });
    expect(result.stdout).not.toContain("cursor installer downloaded");
    expect(result.stderr).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    expect(result.stderr).toContain("running: /bin/bash ");
  });

  it("human (non-json) mode keeps the cursor progress lines on stdout", () => {
    const stdout = captureStdout();
    const spawn = noisySpawn(0);
    runHarnessInstaller("cursor", { home: "/tmp/operator", spawn: spawn as never });
    stdout.restore();
    expect(stdout.lines()).toMatch(/cursor installer downloaded: \d+ bytes, sha256 [0-9a-f]{64}/);
    expect(stdout.lines()).toContain("vendor noise");
  });
});

describe("Windows installer path (Л-24: best effort, honestly bounded)", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const asWindows = (): void => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
  });

  it("discloses the vendor's own Windows installer for agy", () => {
    asWindows();
    const disclosure = harnessInstallerDisclosure("agy");
    expect(disclosure.command).toContain(AGY_INSTALL_URL_WINDOWS);
    expect(disclosure.command).toContain("powershell");
    expect(disclosure.command).not.toMatch(/\|\s*(iex|Invoke-Expression)/i);
    expect(disclosure.installLocation).toContain("LOCALAPPDATA");
  });

  it("fetches the SAME bytes the disclosure named: the PowerShell URL, not the POSIX one", () => {
    asWindows();
    const spawn = noisySpawn(0);
    const stdout = captureStdout();
    const result = runHarnessInstaller("agy", { home: "/tmp/operator", spawn: spawn as never });
    stdout.restore();
    expect(result).toEqual({ exitCode: 0 });
    const curlArgv = spawn.mock.calls[0]![1] as string[];
    expect(curlArgv).toContain(AGY_INSTALL_URL_WINDOWS);
    expect(curlArgv).not.toContain(AGY_INSTALL_URL);
    expect(curlArgv.at(-1)).toMatch(/install\.ps1$/);
    expect(spawn.mock.calls[1]![0]).toBe("powershell");
  });

  it("keeps the PowerShell runner exactly and never asks for the POSIX Bash (#639)", () => {
    asWindows();
    expect(harnessInstallerDisclosure("agy").command).toBe(
      `curl --fail --silent --show-error --location ${AGY_INSTALL_URL_WINDOWS} ` +
        "--output <private-tmpdir>/install.ps1 && " +
        "powershell -ExecutionPolicy Bypass -File <private-tmpdir>/install.ps1",
    );
    const spawn = noisySpawn(0);
    const exists = vi.fn(() => false);
    const stdout = captureStdout();
    const result = runHarnessInstaller("agy", {
      home: "/tmp/operator",
      spawn: spawn as never,
      exists,
    });
    stdout.restore();
    expect(result).toEqual({ exitCode: 0 });
    expect(exists).not.toHaveBeenCalled();
    const [binary, argv] = spawn.mock.calls[1]! as [string, string[]];
    expect([binary, ...argv.slice(0, -1)]).toEqual([
      "powershell",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
  });

  it("refuses rather than running a POSIX script for a vendor with no Windows installer", () => {
    asWindows();
    const spawn = vi.fn();
    const result = runHarnessInstaller("cursor", { home: "/tmp/operator", spawn: spawn as never });
    expect(result.refusal).toMatch(/no Windows installer/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
