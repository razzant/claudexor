import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawnSync, SpawnSyncOptions } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessProgram } from "@claudexor/schema";
import { runCapture } from "./proc.js";
import { defineHarnessProgram, programPath } from "./program-registry.js";
import { normalizedHarnessPath } from "./runtime-env.js";
import {
  resolveSelectedProgram,
  resolveSelectedProgramAsync,
  selectProgramLauncher,
  verifyProgramSelection,
} from "./selected-program.js";

// Records the async version child's options; every call still runs the real capture.
vi.mock("./proc.js", async (original) => {
  const actual = await original<typeof import("./proc.js")>();
  return { ...actual, runCapture: vi.fn(actual.runCapture) };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
const fixture = defineHarnessProgram({
  id: "resolver-fixture",
  overrideEnv: "FIXTURE_BIN",
  launchers: [{ name: "fixture-program" }],
  installationEnv: [],
  platforms: {
    darwin: { launcherDirs: ["{home}/.vendor/bin"] },
    linux: { launcherDirs: ["{home}/.vendor/bin"] },
    win32: { launcherDirs: ["{localAppData}/Programs/Vendor/bin"] },
  },
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "program-"));
  roots.push(path);
  return path;
}
function executable(path: string, text = "1.0.0") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${text}'\n`);
  chmodSync(path, 0o755);
}

describe("selected program", () => {
  it.each(["immediate", "second", "never"])(
    "verifies with at most two immediate reads (%s answer)",
    (answer) => {
      const home = root();
      const path = join(home, "program");
      const marker = join(home, "asked");
      executable(path);
      writeFileSync(
        path,
        `#!/bin/sh
if [ '${answer}' = never ]; then exit 1; fi
if [ '${answer}' = second ] && [ ! -e '${marker}' ]; then : > '${marker}'; exit 1; fi
echo 1.0.0
`,
      );
      let asks = 0;
      const limitations: string[] = [];
      const observed = verifyProgramSelection(() => {
        asks++;
        return resolveSelectedProgram(fixture, {
          sourceEnv: { HOME: home, PATH: "", FIXTURE_BIN: path },
        });
      }, limitations);
      expect(observed.version).toBe(answer === "never" ? null : "1.0.0");
      expect(asks).toBe(answer === "immediate" ? 1 : 2);
      expect(limitations).toHaveLength(answer === "second" ? 1 : 0);
      if (answer === "second") expect(limitations[0]).toContain("next check answered");
    },
  );
  it.each([
    ["2.1.322 (Claude Code)", "2.1.322"],
    ["codex-cli 0.167.1", "0.167.1"],
    ["GitHub Copilot CLI 1.0.109.", "1.0.109"],
    ["2026.11.10-731fb78", "2026.11.10-731fb78"],
    ["1.5.5", "1.5.5"],
    ["1.0.77", "1.0.77"],
    ["1.19.5", "1.19.5"],
    ["vendor 1.2.3.4", "vendor 1.2.3.4"],
  ])("reads the real vendor answer %s without truncating dotted builds", (answer, version) => {
    const home = root();
    const path = join(home, "program");
    executable(path, answer);
    expect(
      resolveSelectedProgram(fixture, {
        sourceEnv: { HOME: home, PATH: "", FIXTURE_BIN: path },
      }),
    ).toMatchObject({ version, versionOutput: answer });
  });
  it("finds a vendor launcher installed after an earlier resolution without changing PATH", () => {
    const home = root();
    const sourceEnv = { HOME: home, PATH: "" };
    expect(
      resolveSelectedProgram(fixture, { sourceEnv, nodePath: "/absent/node" }).path,
    ).toBeNull();
    const path = join(home, ".vendor/bin/fixture-program");
    executable(path);
    const selected = resolveSelectedProgram(fixture, { sourceEnv, nodePath: "/absent/node" });
    expect(selected).toMatchObject({
      path,
      realPath: realpathSync(path),
      version: "1.0.0",
      overrideEnv: null,
    });
  });
  it("reports an explicit override outside every canonical folder and never substitutes for a broken override", () => {
    const home = root();
    const path = join(home, "custom/wrapper");
    executable(path, "vendor-cli 2.0.0");
    const sourceEnv = { HOME: home, PATH: "", FIXTURE_BIN: path };
    expect(resolveSelectedProgram(fixture, { sourceEnv, environment: sourceEnv })).toMatchObject({
      path,
      version: "2.0.0",
      overrideEnv: "FIXTURE_BIN",
      overrideValue: path,
    });
    rmSync(path);
    expect(resolveSelectedProgram(fixture, { sourceEnv, environment: sourceEnv }).path).toBeNull();
  });
  it("observes a version changed behind an unchanged wrapper and masks only an old launcher", () => {
    const home = root();
    const path = join(home, "old/fixture-program");
    const next = join(home, "new/fixture-program");
    executable(next);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nexec '${next}' "$@"\n`);
    chmodSync(path, 0o755);
    const environment = {
      HOME: home,
      PATH: [join(home, "old"), join(home, "new")].join(delimiter),
    };
    expect(resolveSelectedProgram(fixture, { environment }).version).toBe("1.0.0");
    executable(next, "2.0.0");
    expect(resolveSelectedProgram(fixture, { environment })).toMatchObject({
      path,
      version: "2.0.0",
    });
    expect(resolveSelectedProgram(fixture, { environment, maskedPaths: [path] }).path).toBe(next);
  });
  it("keeps the preferred launcher and accepts a generic alias only with declared real-path evidence", () => {
    const home = root();
    const path = join(home, "cursor-agent/versions/build/cursor-agent");
    executable(path);
    const alias = join(home, "agent");
    symlinkSync(path, alias);
    const program = {
      ...fixture,
      launchers: [
        { name: "cursor-agent" },
        { name: "agent", realPathPattern: "cursor-agent/versions/[^/]+/cursor-agent$" },
      ],
    };
    expect(selectProgramLauncher(program, {}, () => path)).toBe("cursor-agent");
    expect(selectProgramLauncher(program, {}, (name) => (name === "agent" ? alias : null))).toBe(
      alias,
    );
    rmSync(alias);
    executable(alias);
    expect(selectProgramLauncher(program, {}, (name) => (name === "agent" ? alias : null))).toBe(
      "cursor-agent",
    );
  });
  it("uses the same entry and own version in async native probes, including wrapper changes and failures", async () => {
    const home = root();
    const next = join(home, "vendor");
    executable(next, "vendor-cli 1.0.0");
    const path = join(home, "wrapper");
    writeFileSync(path, `#!/bin/sh\nexec '${next}' "$@"\n`, { mode: 0o755 });
    const options = {
      sourceEnv: { HOME: home, PATH: "", FIXTURE_BIN: path },
      nodePath: "/absent/node",
    };
    expect(await resolveSelectedProgramAsync(fixture, options)).toEqual(
      resolveSelectedProgram(fixture, options),
    );
    executable(next, "vendor-cli 2.0.0");
    expect(await resolveSelectedProgramAsync(fixture, options)).toMatchObject({
      path,
      version: "2.0.0",
      overrideValue: path,
    });
    writeFileSync(next, "#!/bin/sh\necho 'not a successful version'\nexit 1\n");
    expect(await resolveSelectedProgramAsync(fixture, options)).toMatchObject({
      path,
      version: null,
      versionOutput: null,
    });
  });
  it("omits an unset vendor directory input and expands an explicit one", () => {
    expect(programPath("{env:CODEX_INSTALL_DIR}", {})).toBe("");
    expect(programPath("{env:CODEX_INSTALL_DIR}", { CODEX_INSTALL_DIR: "/vendor/custom" })).toBe(
      "/vendor/custom",
    );
  });
  it("adds the declared Windows installer folder from LOCALAPPDATA", () => {
    const home = root();
    const local = join(home, "Local");
    expect(
      normalizedHarnessPath({ HOME: home, LOCALAPPDATA: local, PATH: "" }, "/absent/node", "win32"),
    ).toContain(join(local, "Programs/Vendor/bin"));
  });
});

describe("version question in the declared child-update mode", () => {
  // The same program as `fixture`, with update controls declared like Copilot's.
  const declared: HarnessProgram = {
    ...fixture,
    childUpdateArgs: ["--fixture-no-update"],
    childUpdateEnv: { FIXTURE_UPDATE: "off" },
  };
  /** Answers its installed version under the declared switch; a plain --version
   * reaches a newer cached copy instead, as Copilot does without --no-auto-update.
   * Logs each invocation's argv, FIXTURE_UPDATE, KEEP, PATH and physical cwd. */
  function vendor(path: string, log: string, own: string, cached: string, refuse = false) {
    mkdirSync(join(path, ".."), { recursive: true });
    const switched = refuse
      ? `echo "error: unknown option '--fixture-no-update'" >&2; exit 2`
      : `[ "$2" = --version ] && [ "$#" = 2 ] && echo "vendor ${own}" && exit 0`;
    writeFileSync(
      path,
      `#!/bin/sh
printf '%s|%s|%s|%s|%s\\n' "$*" "\${FIXTURE_UPDATE-unset}" "\${KEEP-unset}" "\${PATH-unset}" "$(pwd -P)" >> '${log}'
if [ "$1" = --fixture-no-update ]; then ${switched}; fi
[ "$1" = --version ] && [ "$#" = 1 ] && echo "vendor ${cached}" && exit 0
exit 9
`,
    );
    chmodSync(path, 0o755);
  }
  const logged = (log: string) =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("|"));
  const argvOf = (log: string) => logged(log).map(([argv]) => argv);

  it("asks both resolvers with the declared switch and values, keeping the caller's environment, PATH and cwd", async () => {
    const home = root();
    const bin = join(home, "patched bin");
    const log = join(home, "log");
    vendor(join(bin, "fixture-program"), log, "1.0.111", "1.0.112");
    const cwd = join(home, "work");
    mkdirSync(cwd);
    const environment = { HOME: home, PATH: bin, KEEP: "caller", FIXTURE_UPDATE: "on" };
    const sourceEnv = { HOME: home, PATH: "" };
    const before = structuredClone({ environment, sourceEnv });
    const options = { sourceEnv, environment, cwd };
    const asked = [
      resolveSelectedProgram(declared, options),
      await resolveSelectedProgramAsync(declared, options),
    ];
    const twin = [
      resolveSelectedProgram(fixture, options),
      await resolveSelectedProgramAsync(fixture, options),
    ];
    expect(asked[1]).toEqual(asked[0]);
    expect(twin[1]).toEqual(twin[0]);
    expect(twin[0]).toMatchObject({ path: join(bin, "fixture-program"), version: "1.0.112" });
    // Selection and provenance are the twin's; only the answer comes from the declared mode.
    expect(asked[0]).toEqual({ ...twin[0], version: "1.0.111", versionOutput: "vendor 1.0.111" });
    const physical = realpathSync(cwd);
    const switched = ["--fixture-no-update --version", "off", "caller", bin, physical];
    const plain = ["--version", "on", "caller", bin, physical];
    expect(logged(log)).toEqual([switched, switched, plain, plain]);
    expect({ environment, sourceEnv }).toEqual(before);
  });

  it("places the declared switch after a Windows npm entry script, not among node.exe options", () => {
    const home = root();
    const prefix = join(home, "npm prefix");
    const packageRoot = join(prefix, "node_modules/@fixture/tool");
    const script = join(packageRoot, "bin/tool.cjs");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "#!/usr/bin/env node --no-warnings\n");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@fixture/tool", bin: { tool: "bin/tool.cjs" } }),
    );
    const shims = fileURLToPath(new URL("./fixtures/npm-launch/", import.meta.url));
    writeFileSync(
      join(prefix, "tool.cmd"),
      readFileSync(join(shims, "node-options.cmd"), "utf8").replace(/\r?\n/g, "\r\n"),
    );
    // The PE minimum shape the injected-win32 resolver requires of node.exe.
    const node = join(prefix, "node.exe");
    const image = Buffer.alloc(512);
    image.write("MZ", 0, "latin1");
    image.writeUInt32LE(0x80, 0x3c);
    image.write("PE\0\0", 0x80, "latin1");
    writeFileSync(node, image);
    const environment = { HOME: home, PATH: prefix, KEEP: "caller" };
    const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      calls.push({ bin, args: [...args], env: opts.env });
      return { pid: 0, output: [], stdout: "tool 1.0.111\n", stderr: "", status: 0, signal: null };
    }) as unknown as typeof spawnSync;
    const program = { ...declared, launchers: [{ name: "tool" }] };
    expect(
      resolveSelectedProgram(program, {
        sourceEnv: environment,
        environment,
        platform: "win32",
        spawn,
      }),
    ).toMatchObject({ path: script, version: "1.0.111" });
    expect(calls).toEqual([
      {
        bin: node,
        args: ["--no-warnings", script, "--fixture-no-update", "--version"],
        env: expect.objectContaining({ KEEP: "caller", FIXTURE_UPDATE: "off" }),
      },
    ]);
  });

  it("answers in the declared mode after the target behind one unchanged forwarding override changes", async () => {
    const home = root();
    const log = join(home, "log");
    vendor(join(home, "v1/vendor"), log, "1.0.111", "1.0.112");
    vendor(join(home, "v2/vendor"), log, "1.0.113", "1.0.114");
    const current = join(home, "current");
    symlinkSync(join(home, "v1"), current);
    // Written once; only the downstream link changes, as a vendor version switch would.
    const wrapper = join(home, "custom/wrapper");
    mkdirSync(join(wrapper, ".."), { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nexec '${join(current, "vendor")}' "$@"\n`, { mode: 0o755 });
    const unchanged = () => {
      const { ino, size, mtimeMs } = statSync(wrapper);
      return { bytes: readFileSync(wrapper, "utf8"), ino, size, mtimeMs };
    };
    const wrapperBefore = unchanged();
    const options = {
      sourceEnv: { HOME: home, PATH: "", FIXTURE_BIN: wrapper },
      nodePath: "/absent/node",
    };
    const provenance = {
      path: wrapper,
      realPath: realpathSync(wrapper),
      overrideEnv: "FIXTURE_BIN",
      overrideValue: wrapper,
    };
    const answer = (version: string) => ({
      ...provenance,
      version,
      versionOutput: `vendor ${version}`,
    });
    expect(resolveSelectedProgram(declared, options)).toEqual(answer("1.0.111"));
    expect(await resolveSelectedProgramAsync(declared, options)).toEqual(answer("1.0.111"));
    symlinkSync(join(home, "v2"), `${current}.next`);
    renameSync(`${current}.next`, current);
    expect(unchanged()).toEqual(wrapperBefore);
    expect(resolveSelectedProgram(declared, options)).toEqual(answer("1.0.113"));
    expect(await resolveSelectedProgramAsync(declared, options)).toEqual(answer("1.0.113"));
    expect(argvOf(log)).toEqual(Array(4).fill("--fixture-no-update --version"));
  });

  it("leaves a refused declared switch unanswered, also on the second read, and never asks without it", async () => {
    const home = root();
    const path = join(home, "vendor");
    const log = join(home, "log");
    vendor(path, log, "1.0.111", "1.0.112", true);
    const sourceEnv = { HOME: home, PATH: "", FIXTURE_BIN: path };
    const limitations: string[] = [];
    expect(
      verifyProgramSelection(() => resolveSelectedProgram(declared, { sourceEnv }), limitations),
    ).toMatchObject({ path, version: null, versionOutput: null });
    expect(limitations).toEqual([]);
    expect(await resolveSelectedProgramAsync(declared, { sourceEnv })).toMatchObject({
      path,
      version: null,
      versionOutput: null,
    });
    // Control: the same file answers the undeclared question, so no answer above is a refusal.
    expect(resolveSelectedProgram(fixture, { sourceEnv }).version).toBe("1.0.112");
    expect(argvOf(log)).toEqual([...Array(3).fill("--fixture-no-update --version"), "--version"]);
  });

  it("keeps the unchanged limits, timeout and cancellation for the declared question", async () => {
    const home = root();
    const path = join(home, "vendor");
    const log = join(home, "log");
    vendor(path, log, "1.0.111", "1.0.112");
    const sourceEnv = { HOME: home, PATH: "", FIXTURE_BIN: path, KEEP: "caller" };
    const calls: Array<{ args: readonly string[]; options: SpawnSyncOptions }> = [];
    const timedOut = ((_bin: string, args: readonly string[], options: SpawnSyncOptions) => {
      calls.push({ args, options });
      return {
        pid: 0,
        output: [],
        stdout: "",
        stderr: "",
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
      };
    }) as unknown as typeof spawnSync;
    expect(resolveSelectedProgram(declared, { sourceEnv, spawn: timedOut })).toMatchObject({
      path,
      version: null,
    });
    expect(resolveSelectedProgram(fixture, { sourceEnv, spawn: timedOut }).version).toBeNull();
    const [question, twin] = calls;
    expect(calls).toHaveLength(2);
    expect(question!.args).toEqual(["--fixture-no-update", "--version"]);
    expect(twin!.args).toEqual(["--version"]);
    expect({ ...question!.options, env: null }).toEqual({ ...twin!.options, env: null });
    expect(question!.options).toMatchObject({ timeout: 10_000, maxBuffer: 1024 * 1024 });
    expect(question!.options.env).toEqual({ ...twin!.options.env, FIXTURE_UPDATE: "off" });

    const capture = vi.mocked(runCapture);
    capture.mockClear();
    expect((await resolveSelectedProgramAsync(declared, { sourceEnv })).version).toBe("1.0.111");
    expect((await resolveSelectedProgramAsync(fixture, { sourceEnv })).version).toBe("1.0.112");
    const [[, askedArgs, asked], [, twinArgs, plain]] = capture.mock.calls as Array<
      Parameters<typeof runCapture>
    >;
    expect(askedArgs).toEqual(["--fixture-no-update", "--version"]);
    expect(twinArgs).toEqual(["--version"]);
    expect({ ...asked, env: null }).toEqual({ ...plain, env: null });
    expect(asked).toMatchObject({
      inheritEnv: "clean",
      timeoutMs: 10_000,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    expect(asked!.env).toEqual({ ...plain!.env, FIXTURE_UPDATE: "off" });

    // A cancelled declared question stays unknown; the fixture would answer after 20 s.
    const slow = join(home, "slow");
    const slowLog = join(home, "slow-log");
    writeFileSync(
      slow,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${slowLog}'\n/bin/sleep 20\necho vendor 1.0.111\n`,
      { mode: 0o755 },
    );
    const controller = new AbortController();
    const asking = resolveSelectedProgramAsync(declared, {
      sourceEnv: { ...sourceEnv, FIXTURE_BIN: slow },
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(existsSync(slowLog)).toBe(true), { timeout: 10_000 });
    controller.abort();
    expect(await asking).toMatchObject({ path: slow, version: null });
    expect(readFileSync(slowLog, "utf8").trim().split("\n")).toEqual([
      "--fixture-no-update --version",
    ]);
  });
});
