import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planCursorProfileProgramCleanup } from "../../harness-cursor/src/profile-program-cleanup.js";
import { inspectHarness, runHarnessUpdate } from "./harness-maintenance.js";
import {
  SCRIPT,
  executable,
  result,
  vendorFixture,
} from "./test-support/vendor-program-fixture.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
}, 0);
function world() {
  const w = vendorFixture();
  roots.push(w.home);
  return w;
}
function oldCopy(w: ReturnType<typeof world>, remote = false) {
  const prefix = join(w.home, remote ? ".claudexor/remote/vendor" : ".claudexor/node");
  const pkg = join(prefix, "lib/node_modules/@fixture/harness");
  const entry = join(pkg, "bin/fixture-harness");
  executable(entry);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@fixture/harness",
      version: "9.9.9",
      bin: { "fixture-harness": "bin/fixture-harness" },
    }),
  );
  const launcher = join(prefix, "bin/fixture-harness");
  mkdirSync(dirname(launcher), { recursive: true });
  symlinkSync(entry, launcher);
  if (remote) w.options.sourceEnv!.CLAUDEXOR_REMOTE_RUNTIME = "1";
  return { pkg, entry, launcher };
}

describe("selected vendor operation", () => {
  it.each([false, true])("updates an arbitrary selected entry (override: %s)", async (override) => {
    const w = world();
    const selected = join(w.home, "hand-placed", override ? "wrapper" : "fixture-harness");
    executable(selected);
    w.options.sourceEnv!.PATH = dirname(selected);
    if (override) w.options.sourceEnv!.FIXTURE_BIN = selected;
    const calls: string[] = [];
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      calls.push(bin);
      executable(selected, "2.0.0");
      return result("Updated selected program");
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, {
      ...w.options,
      activeRunsAtStart: 3,
      requester: { source: "test", requestId: "a" },
    });
    expect(calls).toEqual([selected]);
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "changed",
      mutation: "applied",
      activeRunsAtStart: 3,
      requester: { source: "test", requestId: "a" },
      before: { path: selected, version: "1.0.0", overrideEnv: override ? "FIXTURE_BIN" : null },
      after: { path: selected, version: "2.0.0" },
    });
  });
  it("runs a hand-placed engine-bin wrapper beside stale npm metadata without replacing it", async () => {
    const w = world();
    const old = oldCopy(w);
    rmSync(old.launcher);
    const wrapper = join(w.home, "custom/wrapper");
    executable(wrapper);
    symlinkSync(wrapper, old.launcher);
    const bytes = readFileSync(wrapper);
    const calls: string[] = [];
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      calls.push(bin);
      return result("Use your own installer to update this copy.");
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, w.options);
    expect(calls).toEqual([old.launcher]);
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "not_changed",
      mutation: "none",
      progress: ["Use your own installer to update this copy."],
    });
    expect(readFileSync(wrapper)).toEqual(bytes);
    expect(existsSync(old.pkg)).toBe(true);
  });
  it.each([false, true])(
    "converts a proven old npm copy only after a vendor copy answers (remote: %s)",
    async (remote) => {
      const w = world();
      const old = oldCopy(w, remote);
      const calls: string[] = [];
      w.options.spawn = ((
        bin: string,
        args: readonly string[] = [],
        opts: SpawnSyncOptions = {},
      ) => {
        if (args[0] === "--version") return spawnSync(bin, args, opts);
        calls.push(bin);
        executable(w.installed, "2.0.0");
        return result("Installed vendor copy");
      }) as typeof spawnSync;
      const receipt = await runHarnessUpdate("fixture", undefined, w.options);
      expect(calls).toEqual(["/bin/sh"]);
      expect(receipt).toMatchObject({
        ok: true,
        outcome: "changed",
        before: { path: old.launcher, version: "1.0.0" },
        after: { path: w.installed, version: "2.0.0" },
      });
      expect(existsSync(old.pkg)).toBe(false);
      expect(existsSync(old.launcher)).toBe(false);
      expect(receipt.commands[0]!.script).toEqual({
        url: "https://example.invalid/install",
        size: Buffer.byteLength(SCRIPT),
        sha256: createHash("sha256").update(SCRIPT).digest("hex"),
      });
      expect(existsSync(receipt.commands[0]!.args[0]!)).toBe(false);
    },
  );
  it.each([true, false])(
    "converts a Windows product npm .cmd shim only after a versioned replacement (verified: %s)",
    async (verified) => {
      const w = world(),
        prefix = join(w.home, ".claudexor/node");
      const pkg = join(prefix, "node_modules/@fixture/harness"),
        entry = join(pkg, "bin/fixture-harness.exe");
      const launcher = join(prefix, "fixture-harness.cmd"),
        installed = `${w.installed}.exe`;
      const image = (path: string) => {
        const bytes = Buffer.alloc(512);
        bytes.write("MZ");
        bytes.writeUInt32LE(128, 60);
        bytes.write("PE\0\0", 128);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      };
      image(entry);
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@fixture/harness",
          bin: { "fixture-harness": "bin/fixture-harness.exe" },
        }),
      );
      writeFileSync(
        launcher,
        [
          "@ECHO off",
          "GOTO start",
          ":find_dp0",
          "SET dp0=%~dp0",
          "EXIT /b",
          ":start",
          "SETLOCAL",
          "CALL :find_dp0",
          '"%dp0%\\node_modules\\@fixture\\harness\\bin\\fixture-harness.exe"   %*',
        ].join("\r\n"),
      );
      w.program.platforms.win32 = {
        ...w.program.platforms.darwin!,
        install: { kind: "exec", command: "fixture-installer.exe", args: [] },
      };
      image(join(w.home, "tools/fixture-installer.exe"));
      w.options.platform = "win32";
      w.options.sourceEnv!.PATH = join(w.home, "tools");
      const commands: string[] = [];
      w.options.spawn = ((bin: string, args: readonly string[] = []) => {
        if (args[0] === "--version")
          return result(
            bin === entry ? "1.0.0" : verified ? "2.0.0" : "",
            bin === entry || verified ? 0 : 1,
          );
        commands.push(bin);
        image(installed);
        return result("Installed vendor copy");
      }) as typeof spawnSync;
      expect((await inspectHarness("fixture", w.options)).actions.update.commands).toEqual([
        { kind: "exec", command: "fixture-installer.exe", args: [] },
      ]);
      const receipt = await runHarnessUpdate("fixture", undefined, w.options);
      expect(receipt.ok).toBe(verified);
      expect(commands).toEqual([join(w.home, "tools/fixture-installer.exe")]);
      expect(receipt.before).toMatchObject({ path: entry, realPath: entry, version: "1.0.0" });
      expect(receipt.after).toMatchObject({
        path: verified ? installed : entry,
        version: verified ? "2.0.0" : "1.0.0",
      });
      expect(existsSync(pkg)).toBe(!verified);
      expect(existsSync(launcher)).toBe(!verified);
    },
  );
  it.each(["installer", "missing-version", "explicit-old-override"])(
    "failed conversion preserves the old copy (%s)",
    async (failure) => {
      const w = world();
      const old = oldCopy(w);
      if (failure === "explicit-old-override") w.options.sourceEnv!.FIXTURE_BIN = old.launcher;
      w.options.spawn = ((
        bin: string,
        args: readonly string[] = [],
        opts: SpawnSyncOptions = {},
      ) => {
        if (args[0] === "--version") return spawnSync(bin, args, opts);
        if (failure !== "installer")
          executable(w.installed, failure === "missing-version" ? "" : "2.0.0");
        return result(
          failure === "installer" ? "Download failed" : "Installed",
          failure === "installer" ? 9 : 0,
        );
      }) as typeof spawnSync;
      const receipt = await runHarnessUpdate("fixture", undefined, w.options);
      expect(receipt.ok).toBe(false);
      expect(receipt.problem?.message).toMatch(
        failure === "installer" ? /Download failed/ : /old copy is unchanged/,
      );
      expect(existsSync(old.pkg)).toBe(true);
      expect((await inspectHarness("fixture", w.options)).selection).toMatchObject({
        path: old.launcher,
        version: "1.0.0",
      });
    },
  );
  it.each([false, true])(
    "converts before an exact native verb and retains the old copy if that verb fails (%s)",
    async (failExact) => {
      const w = world();
      const old = oldCopy(w);
      const prepared: unknown[] = [];
      w.options.beforeMutation = async (receipt) => {
        prepared.push(structuredClone(receipt.commands));
        expect(existsSync(old.pkg)).toBe(true);
      };
      w.options.spawn = ((
        bin: string,
        args: readonly string[] = [],
        options: SpawnSyncOptions = {},
      ) => {
        if (args[0] === "--version") return spawnSync(bin, args, options);
        if (bin === "/bin/sh") {
          executable(w.installed, "2.0.0");
          return result("Native installed");
        }
        expect(bin).toBe(w.installed);
        expect(args).toEqual(["update", "--version", "3.4.5"]);
        if (failExact) return result("Exact release unavailable", 7);
        executable(w.installed, "3.4.5");
        return result("Exact installed");
      }) as typeof spawnSync;
      const receipt = await runHarnessUpdate("fixture", "3.4.5", w.options);
      expect(prepared).toHaveLength(2);
      expect(receipt.commands).toHaveLength(2);
      expect(receipt.ok).toBe(!failExact);
      expect(existsSync(old.pkg)).toBe(failExact);
      expect(receipt.after).toMatchObject({
        path: failExact ? old.launcher : w.installed,
        version: failExact ? "1.0.0" : "3.4.5",
      });
      if (failExact)
        expect(receipt.progress).toEqual(["Native installed", "Exact release unavailable"]);
    },
  );
  it("offers conversion only when an override does not pin the old product copy", async () => {
    const w = world(),
      old = oldCopy(w);
    expect((await inspectHarness("fixture", w.options)).actions.update.available).toBe(true);
    w.options.sourceEnv!.FIXTURE_BIN = old.launcher;
    const row = await inspectHarness("fixture", w.options);
    expect(row.actions.update).toEqual({
      available: false,
      commands: [],
      reason: expect.stringMatching(
        /override pins.*old product-made.*clearing the override.*Update/,
      ),
    });
    expect(row.actions.exactVersion).toEqual(row.actions.update);
    expect(existsSync(old.entry)).toBe(true);
    delete w.options.sourceEnv!.FIXTURE_BIN;
    expect((await inspectHarness("fixture", w.options)).actions.update.available).toBe(true);
  });
  it.each([true, false])(
    "Install verifies the existing program without inventing a command exit (healthy: %s)",
    async (healthy) => {
      const w = world();
      executable(w.installed, healthy ? "1.0.0" : "");
      if (!healthy)
        writeFileSync(w.installed, "#!/bin/sh\necho 'missing runtime library' >&2\nexit 1\n");
      const receipt = await runHarnessUpdate("fixture", undefined, {
        ...w.options,
        installOnly: true,
      });
      expect(receipt).toMatchObject({
        ok: healthy,
        commands: [],
        exitCode: null,
        mutation: "none",
      });
      expect(receipt.problem).toEqual(
        healthy ? null : expect.objectContaining({ code: "program_verification_failed" }),
      );
      expect(receipt.after?.version).toBe(healthy ? "1.0.0" : null);
    },
  );
  it("states the missing vendor installer when a platform cannot convert its old npm copy", async () => {
    const w = world();
    const old = oldCopy(w);
    delete w.program.platforms.darwin!.install;
    w.program.platforms.darwin!.reasons = {
      install: "No unattended vendor installer on this platform (#fixture).",
    };
    const row = await inspectHarness("fixture", w.options);
    expect(row.actions.update).toEqual({
      available: false,
      reason: "No unattended vendor installer on this platform (#fixture).",
      commands: [],
    });
    expect(row.actions.exactVersion).toEqual(row.actions.update);
    expect((await runHarnessUpdate("fixture", "2.0.0", w.options)).ok).toBe(false);
    expect(existsSync(old.pkg)).toBe(true);
  });
  it("acknowledges profile cleanup paths before removal and records effects even when the program stays unchanged", async () => {
    const w = world();
    executable(w.installed);
    const removedPath = join(w.home, "obsolete-profile-program");
    writeFileSync(removedPath, "fixture");
    const acknowledgments: unknown[] = [];
    const receipt = await runHarnessUpdate("fixture", undefined, {
      ...w.options,
      credentialProfiles: [],
      planProfileProgramCleanup: () => ({
        paths: [removedPath],
        limitations: [],
        execute: () => {
          expect(acknowledgments).toHaveLength(2);
          rmSync(removedPath);
          return { removed: [removedPath], limitations: [] };
        },
      }),
      beforeMutation: async (evidence) => {
        acknowledgments.push(JSON.parse(JSON.stringify(evidence)));
        expect(existsSync(removedPath)).toBe(true);
      },
    });
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "not_changed",
      mutation: "applied",
      profileCleanup: { plannedPaths: [removedPath], removedPaths: [removedPath] },
    });
    expect((acknowledgments[1] as typeof receipt).profileCleanup?.removedPaths).toEqual([]);
  });
  it.each([false, true])(
    "verifies the selected program after cleanup (cleanup breaks selection: %s)",
    async (breaks) => {
      const w = world();
      executable(w.installed);
      const path = join(w.home, "obsolete");
      writeFileSync(path, "old");
      const receipt = await runHarnessUpdate("fixture", undefined, {
        ...w.options,
        credentialProfiles: [],
        planProfileProgramCleanup: () => ({
          paths: [path],
          limitations: [],
          execute() {
            rmSync(path);
            if (breaks) rmSync(w.installed);
            return { removed: [path], limitations: [] };
          },
        }),
      });
      expect(receipt.ok).toBe(!breaks);
      expect(receipt.after?.version).toBe(breaks ? null : "1.0.0");
      expect(receipt.problem).toEqual(
        breaks ? expect.objectContaining({ code: "program_verification_failed" }) : null,
      );
    },
  );
  it.each([false, true])(
    "preserves the running Cursor profile program behind a wrapper (override: %s)",
    async (override) => {
      const w = world();
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", w.home);
      const home = join(w.home, "profiles/cursor-a"),
        target = join(home, ".local/share/cursor-agent/versions/current/cursor-agent");
      executable(target);
      const wrapper = join(w.home, ".claudexor/node/bin/fixture-harness");
      executable(wrapper);
      writeFileSync(wrapper, `#!/bin/sh\nexec '${target}' "$@"\n`);
      if (override) w.options.sourceEnv!.FIXTURE_BIN = wrapper;
      const receipt = await runHarnessUpdate("fixture", undefined, {
        ...w.options,
        credentialProfiles: [
          {
            profile_id: "a",
            harness_id: "cursor",
            display_name: "A",
            credential_kind: "config_dir_login",
            isolation_locator: home,
            enabled: true,
            secret_ref: null,
            created_at: null,
          },
        ],
        planProfileProgramCleanup: planCursorProfileProgramCleanup,
      });
      expect(receipt).toMatchObject({ ok: true, after: { version: "1.0.0" } });
      expect(existsSync(target)).toBe(true);
      expect(receipt.limitations.join(" ")).toContain("independence");
    },
  );
  it("a newest read failure cannot block Update", async () => {
    const w = world();
    executable(w.installed);
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    w.options.fetch = fetcher;
    expect((await inspectHarness("fixture", { ...w.options, latest: true })).newest).toMatchObject({
      status: "unavailable",
      problem: { message: "offline" },
    });
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      executable(w.installed, "2.0.0");
      return result();
    }) as typeof spawnSync;
    expect((await runHarnessUpdate("fixture", undefined, w.options)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports a changed unselected copy while keeping the selected wrapper", async () => {
    const w = world();
    const selected = join(w.home, "wrapper");
    executable(selected);
    executable(w.installed);
    w.options.sourceEnv!.FIXTURE_BIN = selected;
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      executable(w.installed, "2.0.0");
      return result("Installed another copy");
    }) as typeof spawnSync;
    expect(await runHarnessUpdate("fixture", undefined, w.options)).toMatchObject({
      ok: true,
      outcome: "changed_elsewhere",
      mutation: "applied",
      before: { path: selected, version: "1.0.0" },
      after: { path: selected, version: "1.0.0" },
      elsewhere: { before: { version: "1.0.0" }, after: { version: "2.0.0" } },
    });
  });
  it("uses installation HOME and declared inputs in a clean environment, with bounded redacted vendor advice", async () => {
    const w = world();
    executable(w.installed);
    Object.assign(w.options.sourceEnv!, {
      CODEX_HOME: join(w.home, "codex-state"),
      XDG_CONFIG_HOME: join(w.home, "config"),
      ANTHROPIC_API_KEY: "unrelated-secret",
      RANDOM_SECRET: "also-secret",
    });
    let env: NodeJS.ProcessEnv | undefined;
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      env = opts.env;
      return result(
        Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") +
          "\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
      );
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, w.options);
    expect(env).toMatchObject({
      HOME: w.home,
      CODEX_HOME: join(w.home, "codex-state"),
      XDG_CONFIG_HOME: join(w.home, "config"),
    });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("RANDOM_SECRET");
    expect(receipt.progress).toHaveLength(40);
    expect(receipt.progress.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
  it("awaits durable evidence before mutation and does not mutate if it is rejected", async () => {
    const w = world();
    executable(w.installed);
    let mutated = false;
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      mutated = true;
      return result();
    }) as typeof spawnSync;
    const receipt = await runHarnessUpdate("fixture", undefined, {
      ...w.options,
      beforeMutation: async (evidence) => {
        expect(evidence).toMatchObject({
          phase: "installing",
          before: { version: "1.0.0" },
          commands: [{ binary: w.installed, args: ["update"] }],
        });
        throw new Error("store unavailable");
      },
    });
    expect(mutated).toBe(false);
    expect(receipt).toMatchObject({
      ok: false,
      mutation: "none",
      problem: { message: "store unavailable" },
    });
  });
  it("only a declared exact-version command can select an explicit target", async () => {
    const w = world();
    executable(w.installed);
    w.options.spawn = ((bin: string, args: readonly string[] = [], opts: SpawnSyncOptions = {}) => {
      if (args[0] === "--version") return spawnSync(bin, args, opts);
      expect(args).toEqual(["update", "--version", "3.4.5"]);
      executable(w.installed, "3.4.5");
      return result();
    }) as typeof spawnSync;
    expect(await runHarnessUpdate("fixture", "3.4.5", w.options)).toMatchObject({
      ok: true,
      after: { version: "3.4.5" },
    });
    for (const target of ["previous", "baseline", "^3.0.0", "$(echo bad)"])
      expect((await runHarnessUpdate("fixture", target, w.options)).problem?.message).toContain(
        "--vendor-version",
      );
  });
});
