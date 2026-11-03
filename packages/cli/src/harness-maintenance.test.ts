/**
 * The CLI-first maintenance primitive against isolated fake prefixes: a temp
 * HOME, a fake runner Node with an embedded npm stub, and a fake spawnSync that
 * answers `--version`, `npm view` and `npm install` without the network. No
 * test touches ~/.claudexor, a real vendor CLI or a credential.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@claudexor/core";
import { CODEX_VENDOR_CLI_VERSION } from "@claudexor/harness-codex";
import type { ParsedArgs } from "./args.js";
import { harnessInstallCommand, localPlatformRefusal } from "./harness-installer.js";
import { compareVendorVersions } from "./harness-install-proof.js";
import { harnessMaintenanceRecipe, NPM_PINS } from "./harness-install-recipes.js";
import { harnessUpdateCommand, inspectHarness, runHarnessUpdate } from "./harness-maintenance.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

const exe = (path: string, body = "#!/bin/sh\nexit 0\n"): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
};

/** A scratch world: HOME, runner Node with embedded npm, nothing installed. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "cx maint-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const nodePath = exe(join(root, "runner", "bin", "node"));
  exe(join(root, "runner", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  const managed = join(home, ".claudexor", "node");
  /** Lay down a managed npm copy of one npm recipe's package at `version`. */
  const installNpm = (npmPackage: string, version: string): string => {
    const pin = Object.values(NPM_PINS).find((row) => row.npmPackage === npmPackage)!;
    const name = pin.binaryNames[0]!;
    const pkg = join(managed, "lib", "node_modules", ...npmPackage.split("/"));
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: npmPackage, version }));
    const binary = exe(join(pkg, "bin", `${name}.js`), `#!/bin/sh\necho ${name}-cli ${version}\n`);
    mkdirSync(join(managed, "bin"), { recursive: true });
    rmSync(join(managed, "bin", name), { force: true });
    exe(join(managed, "bin", name), `#!/bin/sh\nexec "${binary}" "$@"\n`);
    return version;
  };
  const installCodex = (version: string): string => installNpm("@openai/codex", version);
  const sourceEnv = { HOME: home, PATH: "/usr/bin:/bin" };
  return { root, home, nodePath, managed, installNpm, installCodex, sourceEnv };
}

/** spawnSync fake: `--version` reads the launcher script's echo, npm view
 * answers `latest`, npm install lays down the requested managed version. */
function fakeSpawn(w: ReturnType<typeof world>, latest = "99.1.0", installOk = true) {
  const calls: string[][] = [];
  const spawn = vi.fn((binary: string, argv: readonly string[]) => {
    calls.push([binary, ...argv]);
    if (argv.includes("--version")) {
      const target = binary.endsWith("node") ? argv[0]! : binary;
      const body = readFileSync(target, "utf8");
      const nested = /^#!\/bin\/sh\nexec "([^"\n]+)" "\$@"\n$/.exec(body)?.[1];
      const text = nested ? readFileSync(nested, "utf8") : body;
      const answer = /echo (.*)/.exec(text)?.[1] ?? "";
      return { status: 0, stdout: `${answer}\n`, stderr: "" } as never;
    }
    if (argv.includes("view")) return { status: 0, stdout: `"${latest}"\n`, stderr: "" } as never;
    if (argv.includes("install")) {
      if (!installOk) return { status: 1, signal: null } as never;
      const spec = String(argv.at(-1));
      const at = spec.lastIndexOf("@");
      w.installNpm(spec.slice(0, at), spec.slice(at + 1));
      return { status: 0 } as never;
    }
    return { status: 0, stdout: "", stderr: "" } as never;
  });
  return { spawn, calls };
}

const opts = (w: ReturnType<typeof world>, spawn: unknown) => ({
  home: w.home,
  nodePath: w.nodePath,
  sourceEnv: w.sourceEnv,
  spawn: spawn as never,
  platform: "darwin" as const,
  arch: "arm64",
  lock: false,
});

const args = (positional: string[], flags: ParsedArgs["flags"] = {}): ParsedArgs => ({
  _: positional,
  flags,
});

describe("harness maintenance primitive", () => {
  it("orders exact versions by SemVer precedence", () => {
    expect(compareVendorVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVendorVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareVendorVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareVendorVersions("2.0.0+build.1", "2.0.0")).toBe(0);
  });

  it("default Codex install keeps a runnable NEWER managed copy without a registry read", () => {
    const w = world();
    w.installCodex("99.0.0");
    const { spawn, calls } = fakeSpawn(w);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { target: "local", yes: true }),
      true,
      { ...opts(w, spawn), exists: () => true },
    );
    expect(code).toBe(0);
    expect(calls.some((call) => call.includes("install"))).toBe(false);
    const receipt = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(receipt.installedVersion).toBe("99.0.0");
    expect(receipt.pinnedVersion).toBe("99.0.0");
    expect(receipt.verification).toBe("deterministic_only");
    // Old strict parsers keep running: no maintenance-only key leaks into Connect.
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "ok",
        "dryRun",
        "exitCode",
        "installedBinary",
        "installedVersion",
        "harness",
        "target",
        "command",
        "installLocation",
        "pinnedVersion",
        "verification",
      ].sort(),
    );
  });

  it("tested-baseline install still upgrades an OLDER managed copy to the pin", () => {
    const w = world();
    w.installCodex("0.0.1");
    const { spawn, calls } = fakeSpawn(w);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { target: "local", yes: true, "release-tested": true }),
      true,
      { ...opts(w, spawn), exists: () => true },
    );
    expect(code).toBe(0);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe(
      `@openai/codex@${CODEX_VENDOR_CLI_VERSION}`,
    );
  });

  it("a fresh default Codex install resolves one latest version, installs it exactly, and does not inherit native verification", () => {
    const w = world();
    const { spawn, calls } = fakeSpawn(w, "0.163.0");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = harnessInstallCommand(
      args(["harness", "install", "codex"], { target: "local", yes: true }),
      true,
      { ...opts(w, spawn), exists: () => true },
    );
    const receipt = JSON.parse(output.join("")) as Record<string, unknown>;
    expect(code).toBe(0);
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("install"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@0.163.0");
    expect(receipt).toMatchObject({
      ok: true,
      dryRun: false,
      pinnedVersion: "0.163.0",
      verification: "deterministic_only",
      installedVersion: "0.163.0",
    });
    expect(receipt).not.toHaveProperty("previousVersion"); // Connect receipt, not Maintenance rollback data.
    expect(inspectHarness("codex", opts(w, spawn)).releaseTested.version).toBe(
      CODEX_VENDOR_CLI_VERSION,
    );
  });

  it("remote dry-run selects one exact latest, and confirmation can execute THAT version without another lookup", () => {
    const w = world();
    const { spawn, calls } = fakeSpawn(w, "0.163.0");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runtime = { ...opts(w, spawn), exists: () => true };
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { "dry-run": true }),
        true,
        runtime,
      ),
    ).toBe(0);
    const proposed = JSON.parse(output.join("")) as Record<string, unknown>;
    expect(proposed).toMatchObject({
      ok: true,
      target: "remote",
      dryRun: true,
      pinnedVersion: "0.163.0",
      verification: "deterministic_only",
    });
    expect(proposed.command).toContain("@openai/codex@0.163.0");
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    output.length = 0;
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { yes: true, "vendor-version": "0.163.0" }),
        true,
        runtime,
      ),
    ).toBe(0);
    const executed = JSON.parse(output.join("")) as Record<string, unknown>;
    expect(executed).toMatchObject({
      ok: true,
      target: "remote",
      dryRun: false,
      pinnedVersion: "0.163.0",
      verification: "deterministic_only",
    });
    expect(executed).not.toHaveProperty("installedVersion"); // The watched remote path has no local post-install proof.
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@0.163.0");
  });

  it("an older managed copy takes the new default exact latest, but a malformed registry answer refuses without install", () => {
    const w = world();
    w.installCodex("0.0.1");
    const good = fakeSpawn(w, "0.163.0");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { target: "local", yes: true }),
        true,
        { ...opts(w, good.spawn), exists: () => true },
      ),
    ).toBe(0);
    expect(good.calls.find((call) => call.includes("install"))?.at(-1)).toBe(
      "@openai/codex@0.163.0",
    );
    const fresh = world();
    const bad = fakeSpawn(fresh, "not-a-version");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { target: "local", yes: true }),
        true,
        { ...opts(fresh, bad.spawn), exists: () => true },
      ),
    ).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: false,
      code: "latest_unavailable",
      exitCode: 1,
    });
    expect(bad.calls.some((call) => call.includes("install"))).toBe(false);
  });

  it("a newer managed copy arriving between latest lookup and the install lease is not downgraded", () => {
    const w = world();
    const { spawn, calls } = fakeSpawn(w, "0.163.0");
    const racingSpawn = vi.fn((binary: string, argv: readonly string[]) => {
      if (argv.includes("view")) w.installCodex("99.0.0");
      return spawn(binary, argv);
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { target: "local", yes: true }),
        true,
        { ...opts(w, racingSpawn), exists: () => true },
      ),
    ).toBe(0);
    const receipt = JSON.parse(output.join("")) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      pinnedVersion: "0.163.0",
      installedVersion: "99.0.0",
      verification: "deterministic_only",
    });
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    expect(calls.some((call) => call.includes("install"))).toBe(false);
  });

  it("a missing registry cannot silently fall back to the tested baseline; explicit offline baseline still discloses it", () => {
    const w = world();
    const output: string[] = [];
    const { spawn, calls } = fakeSpawn(w);
    const failedRegistry = vi.fn((binary: string, argv: readonly string[]) =>
      argv.includes("view") ? ({ status: 7, stdout: "" } as never) : spawn(binary, argv),
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { "dry-run": true }),
        true,
        opts(w, failedRegistry),
      ),
    ).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: false,
      code: "latest_unavailable",
      exitCode: 1,
    });
    expect(calls).toHaveLength(0);
    output.length = 0;
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { "dry-run": true, "release-tested": true }),
        true,
        opts(w, failedRegistry),
      ),
    ).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: true,
      pinnedVersion: CODEX_VENDOR_CLI_VERSION,
      verification: "release_verified",
    });
    expect(calls).toHaveLength(0);
  });

  it("invalid and conflicting vendor-version flags refuse before registry or install", () => {
    const w = world();
    const { spawn, calls } = fakeSpawn(w);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const runtime = opts(w, spawn);
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { "vendor-version": "latest", yes: true }),
        true,
        runtime,
      ),
    ).toBe(2);
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { "vendor-version": "0.163.0;rm", yes: true }),
        true,
        runtime,
      ),
    ).toBe(2);
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], {
          "vendor-version": "0.163.0",
          "release-tested": true,
        }),
        true,
        runtime,
      ),
    ).toBe(2);
    expect(
      harnessInstallCommand(
        args(["harness", "install", "cursor"], { "vendor-version": "0.163.0" }),
        true,
        runtime,
      ),
    ).toBe(2);
    expect(calls).toHaveLength(0);
  });

  /** stdout/stderr capture for one CLI invocation. */
  const captured = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return {
      json: () => JSON.parse(out.join("")) as Record<string, unknown>,
      stderr: () => err.join(""),
      reset: () => {
        out.length = 0;
        err.length = 0;
      },
    };
  };

  it("an npm dry-run names its exact-version confirmation binding; scripts and executed receipts never carry it", () => {
    const w = world();
    const { spawn } = fakeSpawn(w, "0.163.0");
    const io = captured();
    const runtime = { ...opts(w, spawn), exists: () => true };
    const dryRun = (harness: string, flags: ParsedArgs["flags"] = {}) => {
      io.reset();
      const code = harnessInstallCommand(
        args(["harness", "install", harness], { "dry-run": true, ...flags }),
        true,
        runtime,
      );
      return { code, payload: io.json() };
    };
    for (const harness of ["codex", "claude", "copilot", "opencode"]) {
      const { code, payload } = dryRun(harness);
      expect(code).toBe(0);
      expect(typeof payload.pinnedVersion).toBe("string");
      expect(payload.versionBinding).toBe("vendor-version");
    }
    expect(dryRun("codex", { "release-tested": true }).payload).toMatchObject({
      pinnedVersion: CODEX_VENDOR_CLI_VERSION,
      versionBinding: "vendor-version",
    });
    for (const harness of ["cursor", "agy"]) {
      const { code, payload } = dryRun(harness);
      expect(code).toBe(0);
      expect(payload.pinnedVersion).toBeNull();
      expect(payload).not.toHaveProperty("versionBinding");
    }
    // The strict embedding-host execute receipt keeps its exact historical keys.
    io.reset();
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { target: "local", yes: true }),
        true,
        runtime,
      ),
    ).toBe(0);
    expect(Object.keys(io.json()).sort()).toEqual(
      [
        "ok",
        "dryRun",
        "exitCode",
        "installedBinary",
        "installedVersion",
        "harness",
        "target",
        "command",
        "installLocation",
        "pinnedVersion",
        "verification",
      ].sort(),
    );
  });

  it("a refused default Codex selection is actionable on stderr for SSH consumers and names no selected baseline", () => {
    const io = captured();
    for (const [answer, code] of [
      [{ status: 1, stdout: "", stderr: "npm error code ENOTFOUND" }, "latest_unavailable"],
      [{ status: 0, stdout: '"0.0.1"\n', stderr: "" }, "latest_older_than_tested"],
    ] as const) {
      const w = world();
      const { spawn, calls } = fakeSpawn(w);
      const registry = vi.fn((binary: string, argv: readonly string[]) =>
        argv.includes("view") ? (answer as never) : spawn(binary, argv),
      );
      io.reset();
      expect(
        harnessInstallCommand(
          args(["harness", "install", "codex"], { "dry-run": true }),
          true,
          opts(w, registry),
        ),
      ).toBe(1);
      const payload = io.json();
      // The same pre-selection shape as every other refusal before a version exists.
      expect(payload).toMatchObject({
        ok: false,
        exitCode: 1,
        code,
        harness: "codex",
        target: "remote",
        installLocation: "~/.claudexor/remote/vendor/bin",
      });
      for (const key of ["command", "pinnedVersion", "verification", "versionBinding"])
        expect(payload).not.toHaveProperty(key);
      const refusal = String(payload.refusal);
      expect(refusal).toContain("nothing was executed");
      expect(refusal).toContain(`--release-tested selects ${CODEX_VENDOR_CLI_VERSION}`);
      expect(refusal).toContain("installing it still needs the npm registry");
      expect(refusal).toContain("--vendor-version <exact>");
      // A remote dry-run exits non-zero, so the SSH consumer only sees stderr.
      expect(io.stderr()).toBe(`Install refused: ${refusal}\n`);
      expect(calls.some((call) => call.includes("install"))).toBe(false);
    }
  });

  it("a runnable release-tested copy arriving after the latest lookup is kept; older copies and explicit targets still install", () => {
    const io = captured();
    for (const [arriving, installs] of [
      [CODEX_VENDOR_CLI_VERSION, false],
      ["0.0.1", true],
    ] as const) {
      const w = world();
      const { spawn, calls } = fakeSpawn(w, "99.2.0");
      const racing = vi.fn((binary: string, argv: readonly string[]) => {
        if (argv.includes("view")) w.installCodex(arriving);
        return spawn(binary, argv);
      });
      io.reset();
      expect(
        harnessInstallCommand(
          args(["harness", "install", "codex"], { target: "local", yes: true }),
          true,
          { ...opts(w, racing), exists: () => true },
        ),
      ).toBe(0);
      expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
      expect(calls.some((call) => call.includes("install"))).toBe(installs);
      expect(io.json().installedVersion).toBe(installs ? "99.2.0" : CODEX_VENDOR_CLI_VERSION);
    }
    const w = world();
    w.installCodex(CODEX_VENDOR_CLI_VERSION);
    const { spawn, calls } = fakeSpawn(w);
    io.reset();
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], {
          target: "local",
          yes: true,
          "vendor-version": "99.2.0",
        }),
        true,
        { ...opts(w, spawn), exists: () => true },
      ),
    ).toBe(0);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@99.2.0");
  });

  it("a refusal before Codex's default selection never presents the release-tested baseline as selected", () => {
    const io = captured();
    const w = world();
    const { spawn } = fakeSpawn(w);
    const unsupported = (flags: ParsedArgs["flags"]) => {
      io.reset();
      expect(
        harnessInstallCommand(
          args(["harness", "install", "codex"], { target: "local", "dry-run": true, ...flags }),
          true,
          { ...opts(w, spawn), platform: "win32", arch: "ia32" },
        ),
      ).toBe(1);
      return io.json();
    };
    const undecided = unsupported({});
    expect(undecided).toMatchObject({ ok: false, code: "unsupported_platform", harness: "codex" });
    for (const key of ["command", "pinnedVersion", "verification"])
      expect(undecided).not.toHaveProperty(key);
    // An explicit baseline request is a real selection and is still disclosed.
    expect(unsupported({ "release-tested": true })).toMatchObject({
      code: "unsupported_platform",
      pinnedVersion: CODEX_VENDOR_CLI_VERSION,
      verification: "release_verified",
    });

    w.installCodex(CODEX_VENDOR_CLI_VERSION);
    const failing = vi.fn((binary: string, argv: readonly string[]) => {
      if (argv.includes("--version"))
        throw Object.assign(new Error("exec failed"), { code: "EIO" });
      return spawn(binary, argv);
    });
    io.reset();
    expect(
      harnessInstallCommand(
        args(["harness", "install", "codex"], { target: "local", "dry-run": true }),
        true,
        opts(w, failing),
      ),
    ).toBe(1);
    const failed = io.json();
    expect(failed).toMatchObject({ ok: false, code: "harness_install_failed", harness: "codex" });
    for (const key of ["command", "pinnedVersion", "verification"])
      expect(failed).not.toHaveProperty(key);
  });

  type NpmHarness = "claude" | "codex" | "copilot" | "opencode";
  const NPM_HARNESSES: NpmHarness[] = ["claude", "codex", "copilot", "opencode"];

  /** One production Ensure (`harness install <id> --target local --yes --json`)
   * under the REAL install lease. `between` runs once, after the Ensure's
   * pre-lease selection probe answered and before it acquires that lease.
   * Every npm install records whether the lease was held. */
  function ensureAround(
    harness: NpmHarness,
    flags: ParsedArgs["flags"],
    setup: (w: ReturnType<typeof world>) => void,
    between: (w: ReturnType<typeof world>, spawn: unknown) => void = () => undefined,
  ) {
    const w = world();
    setup(w);
    const { spawn } = fakeSpawn(w);
    const lock = join(w.home, ".claudexor", "harness-install.lock");
    const installs: { spec: string; leased: boolean }[] = [];
    const recorded = vi.fn((binary: string, argv: readonly string[]) => {
      if (argv.includes("install"))
        installs.push({ spec: String(argv.at(-1)), leased: existsSync(lock) });
      return spawn(binary, argv);
    });
    let fired = false;
    const ensureSpawn = vi.fn((binary: string, argv: readonly string[]) => {
      const answer = recorded(binary, argv);
      if (!fired && argv.includes("--version") && !existsSync(lock)) {
        fired = true;
        between(w, recorded);
      }
      return answer;
    });
    const io = captured();
    const code = harnessInstallCommand(
      args(["harness", "install", harness], { target: "local", yes: true, ...flags }),
      true,
      { ...opts(w, ensureSpawn), lock: true },
    );
    const managed = inspectHarness(harness, opts(w, spawn)).installed.version;
    return { code, receipt: io.json(), installs, fired, managed, released: !existsSync(lock) };
  }

  it.each(NPM_HARNESSES)(
    "an ordinary %s Ensure keeps the newer copy a concurrent Maintenance update installed after its selection and before its lease",
    (harness) => {
      const pin = NPM_PINS[harness]!;
      let update: ReturnType<typeof runHarnessUpdate> | undefined;
      const run = ensureAround(
        harness,
        {},
        (w) => w.installNpm(pin.npmPackage, pin.version),
        (w, spawn) => {
          update = runHarnessUpdate(harness, "999.0.0", {
            ...opts(w, spawn),
            lock: true,
            json: true,
          });
        },
      );
      expect(run.fired).toBe(true);
      expect(update).toMatchObject({
        ok: true,
        mutation: "applied",
        after: { version: "999.0.0" },
      });
      // Only Maintenance installed, under the lease; the Ensure kept its copy.
      expect(run.installs).toEqual([{ spec: `${pin.npmPackage}@999.0.0`, leased: true }]);
      expect(run.code).toBe(0);
      expect(run.receipt).toMatchObject({ ok: true, installedVersion: "999.0.0" });
      expect(run.managed).toBe("999.0.0");
      expect(run.released).toBe(true);
    },
  );

  it.each(NPM_HARNESSES)(
    "%s: an explicit --vendor-version stays exact over a newer managed copy, under the lease",
    (harness) => {
      const pin = NPM_PINS[harness]!;
      const run = ensureAround(harness, { "vendor-version": pin.version }, (w) =>
        w.installNpm(pin.npmPackage, "999.0.0"),
      );
      expect(run.installs).toEqual([{ spec: `${pin.npmPackage}@${pin.version}`, leased: true }]);
      expect(run.receipt).toMatchObject({
        ok: true,
        pinnedVersion: pin.version,
        installedVersion: pin.version,
      });
      expect(run.managed).toBe(pin.version);
    },
  );

  it.each(NPM_HARNESSES)(
    "%s: an automatically selected copy that breaks or falls below the baseline before the lease is repaired to that disclosed version",
    (harness) => {
      const pin = NPM_PINS[harness]!;
      const launcher = pin.binaryNames[0]!;
      for (const between of [
        (w: ReturnType<typeof world>) => rmSync(join(w.managed, "bin", launcher)),
        (w: ReturnType<typeof world>) => w.installNpm(pin.npmPackage, "0.0.1"),
      ]) {
        const run = ensureAround(
          harness,
          {},
          (w) => w.installNpm(pin.npmPackage, "50.0.0"),
          between,
        );
        expect(run.fired).toBe(true);
        expect(run.installs).toEqual([{ spec: `${pin.npmPackage}@50.0.0`, leased: true }]);
        expect(run.receipt).toMatchObject({
          ok: true,
          pinnedVersion: "50.0.0",
          installedVersion: "50.0.0",
        });
      }
    },
  );

  it.each(NPM_HARNESSES)(
    "%s --release-tested: a kept copy that disappears before the lease installs the baseline, and the receipt names it",
    (harness) => {
      const pin = NPM_PINS[harness]!;
      const run = ensureAround(
        harness,
        { "release-tested": true },
        (w) => w.installNpm(pin.npmPackage, "50.0.0"),
        (w) => rmSync(join(w.managed, "lib"), { recursive: true, force: true }),
      );
      expect(run.fired).toBe(true);
      expect(run.installs).toEqual([{ spec: `${pin.npmPackage}@${pin.version}`, leased: true }]);
      expect(run.receipt).toMatchObject({
        ok: true,
        command: expect.stringContaining(`${pin.npmPackage}@${pin.version}`),
        pinnedVersion: pin.version,
        verification: pin.verification,
        installedVersion: pin.version,
      });
      // A replacement that is still runnable is kept: nothing executes.
      const replaced = ensureAround(
        harness,
        { "release-tested": true },
        (w) => w.installNpm(pin.npmPackage, "50.0.0"),
        (w) => w.installNpm(pin.npmPackage, "999.0.0"),
      );
      expect(replaced.installs).toEqual([]);
      expect(replaced.receipt).toMatchObject({
        ok: true,
        pinnedVersion: "50.0.0",
        installedVersion: "999.0.0",
      });
    },
  );

  it("a missing bundled npm is a local refusal, never a registry outage with a retry remedy", () => {
    const io = captured();
    const w = world();
    // An empty fixture must not discover a vendor CLI in a host PATH fallback.
    vi.spyOn(core, "resolveHarnessBinary").mockReturnValue(null);
    const npmCli = join(w.root, "runner", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    rmSync(npmCli);
    const { spawn } = fakeSpawn(w);
    // Like node itself: a missing script makes the lookup fail, not answer.
    const realistic = vi.fn((binary: string, argv: readonly string[]) =>
      existsSync(argv[0]!) || !binary.endsWith("node")
        ? spawn(binary, argv)
        : ({ status: 1, stdout: "", stderr: "Cannot find module" } as never),
    );
    const invocations: ParsedArgs["flags"][] = [
      { "dry-run": true },
      { yes: true },
      { yes: true, "release-tested": true },
    ];
    for (const flags of invocations) {
      io.reset();
      expect(
        harnessInstallCommand(
          args(["harness", "install", "codex"], { target: "local", ...flags }),
          true,
          opts(w, realistic),
        ),
      ).toBe(1);
      const payload = io.json();
      expect(payload).toMatchObject({
        ok: false,
        code: "embedded_npm_missing",
        harness: "codex",
        installLocation: "~/.claudexor/node/bin",
      });
      const refusal = String(payload.refusal);
      expect(refusal).toContain(npmCli);
      expect(refusal).toContain("nothing was executed");
      expect(refusal).not.toContain("retry");
      expect(refusal).not.toContain("registry");
    }
    expect(runHarnessUpdate("codex", "latest", opts(w, realistic))).toMatchObject({
      ok: false,
      code: "embedded_npm_missing",
      mutation: "none",
    });
    expect(inspectHarness("codex", { ...opts(w, realistic), latest: true })).toMatchObject({
      available: null,
      availableProblem: { code: "embedded_npm_missing", retryable: false },
    });
    // No npm child at all: neither the latest lookup nor an install started.
    expect(realistic).not.toHaveBeenCalled();
  });

  it.each(["1.0.0", "2.0.0"])(
    "an exact target installs up or down from %s and records the proved previous one",
    (before) => {
      const w = world();
      w.installCodex(before);
      const { spawn, calls } = fakeSpawn(w);
      const receipt = runHarnessUpdate("codex", "1.2.3", opts(w, spawn));
      expect(receipt).toMatchObject({
        ok: true,
        mutation: "applied",
        requestedVersion: "1.2.3",
        resolvedVersion: "1.2.3",
        previousVersion: before,
        before: { version: before, selection: "managed", proved: true },
        after: { version: "1.2.3", selected: true, proved: true },
      });
      expect(calls.filter((call) => call.includes("install"))).toHaveLength(1);
      expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@1.2.3");
      expect(calls.filter((call) => call.includes("view"))).toHaveLength(0);
    },
  );

  it("the public Update command without a version selects latest, never the bundled baseline", () => {
    const w = world();
    w.installCodex("99.0.0");
    const { spawn, calls } = fakeSpawn(w, "100.0.0");
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = harnessUpdateCommand(
      args(["harness", "update", "codex"], { yes: true }),
      true,
      opts(w, spawn),
    );
    expect(code).toBe(0);
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@100.0.0");
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: true,
      before: { version: "99.0.0" },
      after: { version: "100.0.0", selected: true, proved: true },
      resolvedVersion: "100.0.0",
      mutation: "applied",
    });
  });

  it("latest is resolved ONCE to an exact version before the install", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn, calls } = fakeSpawn(w, "7.7.7");
    const receipt = runHarnessUpdate("codex", "latest", opts(w, spawn));
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("install"))?.at(-1)).toBe("@openai/codex@7.7.7");
    expect(receipt).toMatchObject({
      ok: true,
      requestedVersion: "latest",
      resolvedVersion: "7.7.7",
    });
  });

  it("a failed install keeps the proved before fact and reports an unknown effect", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn } = fakeSpawn(w, "7.7.7", false);
    const receipt = runHarnessUpdate("codex", "2.0.0", opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: false,
      mutation: "unknown",
      previousVersion: "1.0.0",
      before: { version: "1.0.0", proved: true },
    });
  });

  it("an explicit override is not falsely activated: no install, typed remedy", () => {
    const w = world();
    w.installCodex("1.0.0");
    const custom = exe(join(w.root, "custom", "codex"), "#!/bin/sh\necho codex-cli 5.0.0\n");
    const { spawn, calls } = fakeSpawn(w);
    const env = { ...w.sourceEnv, CLAUDEXOR_CODEX_BIN: custom };
    const row = inspectHarness("codex", { ...opts(w, spawn), sourceEnv: env });
    expect(row).toMatchObject({
      maintainable: false,
      targets: [],
      selection: {
        kind: "override",
        binary: custom,
        version: "5.0.0",
        overrideEnv: "CLAUDEXOR_CODEX_BIN",
      },
      installed: { version: "1.0.0", proved: true },
    });
    const receipt = runHarnessUpdate("codex", "2.0.0", { ...opts(w, spawn), sourceEnv: env });
    expect(receipt).toMatchObject({
      ok: false,
      code: "harness_not_maintainable",
      mutation: "none",
    });
    expect(calls.some((call) => call.includes("install"))).toBe(false);
  });

  it("a selected copy outside the managed prefix is not silently taken over", () => {
    const w = world();
    exe(join(w.home, ".local", "bin", "codex"), "#!/bin/sh\necho codex-cli 0.153.3\n");
    const { spawn } = fakeSpawn(w);
    const row = inspectHarness("codex", opts(w, spawn));
    expect(row).toMatchObject({
      maintainable: false,
      selection: { kind: "path", version: "0.153.3" },
      installed: { version: null, proved: false },
    });
    expect(row.remedy).toContain("outside Claudexor's managed prefix");
  });

  it("inspection never installs or logs in; --latest is one registry read", () => {
    const w = world();
    w.installCodex("1.0.0");
    const { spawn, calls } = fakeSpawn(w, "3.0.0");
    const row = inspectHarness("codex", { ...opts(w, spawn), latest: true });
    expect(row.available?.version).toBe("3.0.0");
    expect(row.releaseTested.version).toBe(CODEX_VENDOR_CLI_VERSION);
    expect(row.selection.version).toBe("1.0.0");
    expect(calls.some((call) => call.includes("install") || call.includes("login"))).toBe(false);
    expect(calls.filter((call) => call.includes("view"))).toHaveLength(1);
  });

  it("Windows: Codex and Claude keep their supported npm entrypoint; others keep their facts", () => {
    for (const harness of ["codex", "claude"] as const) {
      expect(localPlatformRefusal(harness, "win32", "x64")).toBeNull();
      expect(localPlatformRefusal(harness, "win32", "arm64")).toBeNull();
      expect(harnessMaintenanceRecipe(harness, "win32").mechanism).toBe("managed_npm");
    }
    expect(localPlatformRefusal("copilot", "win32", "x64")?.code).toBe("unsupported_platform");
    expect(localPlatformRefusal("opencode", "win32", "x64")?.code).toBe("unsupported_platform");
    expect(harnessMaintenanceRecipe("cursor", "win32")).toMatchObject({
      mechanism: "vendor_script",
      targets: [],
    });
    expect(harnessMaintenanceRecipe("agy", "darwin").targets).toEqual(["latest"]);
  });
});

describe("vendor updater (cursor/agy): latest only, canonical HOME launcher", () => {
  /** A Cursor-shaped install: the canonical launcher reads a version file that
   * its own `update` rewrites, so the re-probe observes the real effect. */
  function cursorWorld(updateTo: string | null) {
    const w = world();
    const state = join(w.root, "cursor-version");
    writeFileSync(state, "2026.08.11-e8db854");
    const launcher = exe(
      join(w.home, ".local", "bin", "cursor-agent"),
      `#!/bin/sh\ncat ${state}\n`,
    );
    const calls: string[][] = [];
    const spawn = vi.fn((binary: string, argv: readonly string[]) => {
      calls.push([binary, ...argv]);
      if (argv.includes("--version"))
        return { status: 0, stdout: `${readFileSync(state, "utf8")}\n`, stderr: "" } as never;
      if (argv[0] === "update") {
        if (updateTo !== null) writeFileSync(state, updateTo);
        return { status: 0 } as never;
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    });
    return { w, launcher, spawn, calls };
  }

  it("runs the selected launcher's own update and re-probes the new version", () => {
    const { w, launcher, spawn, calls } = cursorWorld("2026.10.01-e373342");
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(calls.find((call) => call.at(-1) === "update")?.[0]).toBe(launcher);
    expect(receipt).toMatchObject({
      ok: true,
      mechanism: "vendor_updater",
      mutation: "applied",
      before: { version: "2026.08.11-e8db854", binary: launcher, selection: "path" },
      after: { version: "2026.10.01-e373342", binary: launcher, selected: true },
    });
    expect(receipt.limitations).toContain("vendor_resolves_latest");
  });

  it("an unchanged version after exit 0 is 'no change observed', never 'updated'", () => {
    const { w, spawn } = cursorWorld(null);
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(receipt).toMatchObject({ ok: true, mutation: "none", resolvedVersion: null });
    expect(receipt.limitations).toContain("no_version_change_observed");
  });

  it("exit zero without a post-update version leaves possible mutation unknown", () => {
    const { w, spawn } = cursorWorld("");
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: false,
      code: "install_verification_failed",
      mutation: "unknown",
      after: { version: null, proved: false },
    });
  });

  it("declares no latest check, and an explicit check is a typed unsupported problem", () => {
    const { w, spawn, calls } = cursorWorld(null);
    const row = inspectHarness("cursor", { ...opts(w, spawn), latest: true });
    expect(row).toMatchObject({
      maintainable: true,
      canCheckLatest: false,
      targets: ["latest"],
      available: null,
      availableProblem: { code: "latest_check_unsupported", retryable: false },
    });
    expect(calls.some((call) => call.at(-1) === "update" || call.includes("view"))).toBe(false);
    expect(inspectHarness("codex", opts(w, spawn)).canCheckLatest).toBe(true);
  });

  it("refuses an exact version: the vendor resolves latest itself", () => {
    const { w, spawn, calls } = cursorWorld("x");
    const receipt = runHarnessUpdate("cursor", "1.2.3", opts(w, spawn));
    expect(receipt).toMatchObject({ ok: false, code: "version_selection_unsupported" });
    expect(calls.some((call) => call.at(-1) === "update")).toBe(false);
  });

  it("a version-pinned override elsewhere is not updated through another launcher", () => {
    const { w, spawn, calls } = cursorWorld("x");
    const pinned = exe(
      join(w.home, ".local", "share", "cursor-agent", "versions", "old", "cursor-agent"),
      "#!/bin/sh\necho 2025.01.01-old\n",
    );
    const env = { ...w.sourceEnv, CLAUDEXOR_CURSOR_BIN: pinned };
    const row = inspectHarness("cursor", { ...opts(w, spawn), sourceEnv: env });
    expect(row).toMatchObject({
      maintainable: false,
      selection: { kind: "override", binary: pinned },
    });
    const receipt = runHarnessUpdate("cursor", undefined, { ...opts(w, spawn), sourceEnv: env });
    expect(receipt.code).toBe("harness_not_maintainable");
    expect(calls.some((call) => call.at(-1) === "update")).toBe(false);
  });

  it("an alias-only Cursor install (agent -> versions/<v>/cursor-agent) is the selected launcher", () => {
    const w = world();
    const state = join(w.root, "cursor-version");
    writeFileSync(state, "2026.08.11-e8db854");
    const payload = exe(
      join(
        w.home,
        ".local",
        "share",
        "cursor-agent",
        "versions",
        "2026.08.11-e8db854",
        "cursor-agent",
      ),
      `#!/bin/sh\ncat ${state}\n`,
    );
    mkdirSync(join(w.home, ".local", "bin"), { recursive: true });
    symlinkSync(payload, join(w.home, ".local", "bin", "agent"));
    const spawn = vi.fn((_binary: string, argv: readonly string[]) => {
      if (argv.includes("--version"))
        return { status: 0, stdout: `${readFileSync(state, "utf8")}\n`, stderr: "" } as never;
      if (argv[0] === "update") writeFileSync(state, "2026.10.01-e373342");
      return { status: 0, stdout: "", stderr: "" } as never;
    });
    const row = inspectHarness("cursor", opts(w, spawn));
    expect(row).toMatchObject({
      maintainable: true,
      selection: { kind: "path", binary: join(w.home, ".local", "bin", "agent") },
    });
    const receipt = runHarnessUpdate("cursor", undefined, opts(w, spawn));
    expect(receipt).toMatchObject({
      ok: true,
      mutation: "applied",
      after: { version: "2026.10.01-e373342" },
    });
  });

  it("an override naming the canonical launcher shares the vendor recipe", () => {
    const { w, launcher, spawn } = cursorWorld("2026.10.01-e373342");
    const env = { ...w.sourceEnv, CLAUDEXOR_CURSOR_BIN: launcher };
    const receipt = runHarnessUpdate("cursor", "latest", { ...opts(w, spawn), sourceEnv: env });
    expect(receipt).toMatchObject({
      ok: true,
      mutation: "applied",
      before: { selection: "override" },
    });
  });
});
