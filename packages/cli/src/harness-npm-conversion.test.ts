import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type PathLike,
  type RmOptions,
  type StatOptions,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHarnessUpdate } from "./harness-maintenance.js";
import { executable, result, vendorFixture } from "./test-support/vendor-program-fixture.js";

// The fixture counts calls at the filesystem boundary, not the number of times
// conversion enters a retry or a preflight. Uninjected file operations are real.
const faults = vi.hoisted(() => ({
  packageRoot: "",
  refusals: [] as string[],
  log: [] as string[],
  beforeStat: null as ((path: string, options?: StatOptions) => void) | null,
  afterRetire: null as (() => void) | null,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: ((path: PathLike, options?: StatOptions) => {
      faults.beforeStat?.(String(path), options);
      return actual.lstatSync(path, options);
    }) as typeof actual.lstatSync,
    rmSync(path: PathLike, options?: RmOptions) {
      actual.rmSync(path, options);
      if (String(path) === `${faults.packageRoot}.claudexor-converted`) faults.afterRetire?.();
    },
    renameSync(from: PathLike, to: PathLike) {
      const root = faults.packageRoot;
      if (root && String(from) === root && String(to) === `${root}.claudexor-converted`) {
        const code = faults.refusals.shift();
        faults.log.push(code ? `rename refused ${code}` : "rename");
        if (code)
          throw Object.assign(
            new Error(`${code}: synthetic refusal, rename '${root}' -> '${to}'`),
            {
              code,
              syscall: "rename",
              path: root,
              dest: String(to),
            },
          );
      }
      actual.renameSync(from, to);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(faults, {
    packageRoot: "",
    refusals: [],
    log: [],
    beforeStat: null,
    afterRetire: null,
  });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function virtualTime(duringFirstWait?: (advance: (ms: number) => void) => void) {
  let now = 0;
  const advance = (ms: number) => {
    now += ms;
  };
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const wait = vi.spyOn(Atomics, "wait").mockImplementation((...args: unknown[]) => {
    faults.log.push("wait");
    advance(args[3] as number);
    const during = duringFirstWait;
    duringFirstWait = undefined;
    during?.(advance);
    return "timed-out";
  });
  return { wait, elapsed: () => now };
}

const image = (path: string) => {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ");
  bytes.writeUInt32LE(128, 60);
  bytes.write("PE\0\0", 128);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};

/** Exercise the real maintenance receipt; the installer and version probes are scripted. */
function conversionFixture(platform: "win32" | "darwin" = "win32", installerExit = 0) {
  const w = vendorFixture();
  const versions = { old: "1.0.0", afterInstaller: "1.0.0" };
  w.program.versionScheme = "semver";
  roots.push(w.home);
  const windows = platform === "win32";
  const prefix = join(w.home, ".claudexor/node");
  const pkg = join(prefix, windows ? "node_modules" : "lib/node_modules", "@fixture/harness");
  const bin = `bin/fixture-harness${windows ? ".exe" : ""}`;
  const entry = join(pkg, bin);
  const launcher = join(prefix, windows ? "fixture-harness.cmd" : "bin/fixture-harness");
  const installed = windows ? `${w.installed}.exe` : w.installed;
  (windows ? image : executable)(entry);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@fixture/harness", version: "1.0.0", bin: { "fixture-harness": bin } }),
  );
  if (windows) {
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
    w.options.sourceEnv!.PATH = join(w.home, "tools");
  } else {
    mkdirSync(dirname(launcher), { recursive: true });
    symlinkSync(entry, launcher);
  }
  w.options.platform = platform;
  w.options.spawn = ((bin: string, args: readonly string[] = []) => {
    if (args[0] === "--version") {
      const old = bin === entry || bin === launcher;
      faults.log.push(old ? "probe old" : "probe new");
      const ordinary = faults.log.includes("install") ? versions.afterInstaller : versions.old;
      return result(old ? ordinary : "2.0.0");
    }
    if (args[0] === "query") {
      faults.log.push("probe registry");
      return result("", 1);
    }
    faults.log.push("install");
    if (windows) image(installed);
    else executable(installed, "2.0.0");
    return result("Installed vendor copy", installerExit);
  }) as typeof spawnSync;
  faults.packageRoot = pkg;
  return {
    pkg,
    entry,
    launcher,
    installed,
    versions,
    hidden: `${pkg}.claudexor-converted`,
    update: () => runHarnessUpdate(w.program.id, undefined, w.options),
  };
}

const renames = () => faults.log.filter((entry) => entry.startsWith("rename"));
const retryLines = (limitations: string[]) =>
  limitations.filter((entry) => entry.startsWith("Windows npm conversion:"));
function expectRetryReceipt(limitations: string[], code: string, ms: number) {
  expect(retryLines(limitations)).toEqual([
    `Windows npm conversion: first rename error ${code}; ${renames().length} attempts; elapsed ${ms} ms.`,
  ]);
}
function expectNoRetrySpawns() {
  const first = faults.log.findIndex((event) => event.startsWith("rename refused"));
  const last = faults.log.findLastIndex((event) => event === "wait" || event.startsWith("rename"));
  const spawned = faults.log.slice(first + 1, last).some((event) => /^(probe|install)/.test(event));
  expect(spawned).toBe(false);
  expect(faults.log.filter((event) => event === "install")).toHaveLength(1);
}

function expectOldCopy(copy: ReturnType<typeof conversionFixture>) {
  expect(existsSync(join(copy.pkg, "package.json"))).toBe(true);
  expect(existsSync(copy.hidden)).toBe(false);
  expect(existsSync(copy.launcher)).toBe(true);
}

describe("Windows npm conversion hide refusals", () => {
  it("refuses a replacement older than the just observed npm selection without another probe", async () => {
    const copy = conversionFixture();
    copy.versions.afterInstaller = "3.0.0";
    const receipt = await copy.update();
    expect(receipt).toMatchObject({
      ok: false,
      before: { version: "1.0.0" },
      outcome: "changed",
      mutation: "applied",
      problem: {
        code: "conversion_older_program",
        message: expect.stringContaining(
          `With the old npm launcher masked, ${copy.installed} version 2.0.0 is found first and is older than the selected 3.0.0`,
        ),
      },
      after: { path: copy.entry, version: "3.0.0" },
    });
    expect(renames()).toEqual([]);
    expect(faults.log.filter((event) => event === "install")).toHaveLength(1);
    // Initial, ordinary-before-hide and existing final observations, no new ask.
    expect(faults.log.filter((event) => event === "probe old")).toHaveLength(3);
    expectOldCopy(copy);
  });

  it.each([
    { state: "reoccupied", installerExit: 0 },
    { state: "reoccupied", installerExit: 17 },
    { state: "unreadable", installerExit: 17 },
  ])(
    "preserves the launcher when the normal path is $state after retirement (installer exit $installerExit)",
    async ({ state, installerExit }) => {
      const copy = conversionFixture("win32", installerExit);
      const script = readFileSync(copy.launcher);
      const bin = readFileSync(copy.entry);
      const manifestPath = join(copy.pkg, "package.json");
      const manifest = readFileSync(manifestPath, "utf8").replace("1.0.0", "3.0.0");
      faults.afterRetire = () => {
        if (state === "reoccupied") {
          mkdirSync(dirname(copy.entry), { recursive: true });
          writeFileSync(copy.entry, bin);
          writeFileSync(manifestPath, manifest);
          copy.versions.afterInstaller = "3.0.0";
        } else {
          faults.beforeStat = (path) => {
            if (path === copy.pkg)
              throw Object.assign(new Error("package path stat refused"), { code: "EACCES" });
          };
        }
      };
      const receipt = await copy.update();
      expect(readFileSync(copy.launcher)).toEqual(script);
      expect(existsSync(copy.hidden)).toBe(false);
      expect(receipt.limitations.join(" ")).toContain(
        state === "reoccupied" ? "the npm package path is occupied" : "package path stat refused",
      );
      if (state === "reoccupied") {
        expect(readFileSync(manifestPath, "utf8")).toBe(manifest);
        expect(receipt).toMatchObject({
          ok: false,
          after: { path: copy.entry, version: "3.0.0" },
          problem: {
            code: installerExit ? "vendor_command_failed" : "conversion_verification_failed",
          },
        });
        const reason = installerExit ? receipt.limitations.join(" ") : receipt.problem?.message;
        expect(reason).toContain("differs from the verified replacement");
        expect(receipt.limitations.join(" ")).not.toContain("but conversion completed");
      } else {
        expect(receipt).toMatchObject({
          ok: true,
          after: { path: copy.installed, version: "2.0.0" },
        });
      }
    },
  );

  it.each([null, "EPERM", "EACCES", "EBUSY"])(
    "finishes an ordinary hide or retries only the refused rename (%s)",
    async (code) => {
      const copy = conversionFixture();
      if (code) faults.refusals = [code, "EBUSY"];
      const time = virtualTime();
      const receipt = await copy.update();
      expect(receipt).toMatchObject({
        ok: true,
        problem: null,
        after: { path: copy.installed, version: "2.0.0" },
      });
      if (code) {
        expect(renames()).toEqual([`rename refused ${code}`, "rename refused EBUSY", "rename"]);
        expect(time.elapsed()).toBeGreaterThan(0);
        expectRetryReceipt(receipt.limitations, code, time.elapsed());
        expectNoRetrySpawns();
      } else {
        expect(renames()).toEqual(["rename"]);
        expect(time.wait).not.toHaveBeenCalled();
        expect(retryLines(receipt.limitations)).toEqual([]);
      }
      // The replacement must answer again after hiding the old copy.
      expect(faults.log[faults.log.indexOf("rename") + 1]).toBe("probe new");
      for (const path of [copy.pkg, copy.hidden, copy.launcher])
        expect(existsSync(path)).toBe(false);
    },
  );

  it("reports the first persistent refusal at the 2 s boundary and keeps the old copy", async () => {
    const copy = conversionFixture();
    faults.refusals = ["EPERM", ...Array<string>(64).fill("EACCES")];
    const time = virtualTime();
    const receipt = await copy.update();
    expect(receipt).toMatchObject({
      ok: false,
      problem: { code: "EPERM", message: expect.stringContaining("synthetic refusal, rename") },
      after: { path: copy.entry, version: "1.0.0" },
    });
    expect(renames().length).toBeGreaterThan(1);
    expect(faults.refusals.length).toBeGreaterThan(0);
    expect(time.elapsed()).toBe(2_000);
    expectRetryReceipt(receipt.limitations, "EPERM", 2_000);
    expectNoRetrySpawns();
    expectOldCopy(copy);
  });

  it.each(["wake", "launcher proof", "sibling check"] as const)(
    "does not start a retry when the deadline passes during the %s",
    async (where) => {
      const copy = conversionFixture();
      faults.refusals = ["EPERM"];
      let lateRead = false;
      const time = virtualTime((advance) => {
        if (where === "wake") advance(2_001);
        faults.beforeStat = (path, options) => {
          const hit =
            where === "wake"
              ? path === copy.pkg && options?.bigint
              : path === (where === "launcher proof" ? copy.launcher : copy.hidden);
          if (!hit) return;
          lateRead = true;
          if (where !== "wake") advance(2_001);
          faults.beforeStat = null;
        };
      });
      const receipt = await copy.update();
      expect(receipt).toMatchObject({ ok: false, problem: { code: "EPERM" } });
      expect(lateRead).toBe(where !== "wake");
      expect(renames()).toEqual(["rename refused EPERM"]);
      expect(time.wait).toHaveBeenCalledOnce();
      expect(time.elapsed()).toBeGreaterThan(2_000);
      expectRetryReceipt(receipt.limitations, "EPERM", time.elapsed());
      expectOldCopy(copy);
    },
  );

  it.each([
    { refusals: ["EXDEV"], code: "EXDEV" },
    { refusals: ["EPERM", "ENOENT"], code: "ENOENT" },
  ])("reports another rename error as itself ($code)", async ({ refusals, code }) => {
    const copy = conversionFixture();
    faults.refusals = [...refusals];
    const time = virtualTime();
    const receipt = await copy.update();
    expect(receipt).toMatchObject({
      ok: false,
      problem: { code },
      after: { path: copy.entry, version: "1.0.0" },
    });
    expect(renames()).toEqual(refusals.map((refusal) => `rename refused ${refusal}`));
    if (refusals.length === 1) {
      expect(time.wait).not.toHaveBeenCalled();
      expect(retryLines(receipt.limitations)).toEqual([]);
    } else expectRetryReceipt(receipt.limitations, "EPERM", time.elapsed());
    expectOldCopy(copy);
  });

  it.each([false, true])(
    "does not retry an EACCES checking the sibling (after rename: %s)",
    async (afterRename) => {
      const copy = conversionFixture();
      if (afterRename) faults.refusals = ["EPERM"];
      faults.beforeStat = (path) => {
        const ready = afterRename ? faults.log.includes("wait") : faults.log.includes("install");
        if (path === copy.hidden && ready)
          throw Object.assign(new Error("Fixture sibling stat failed"), {
            code: "EACCES",
            syscall: "lstat",
          });
      };
      const time = virtualTime();
      const receipt = await copy.update();
      expect(receipt).toMatchObject({ ok: false, problem: { code: "EACCES" } });
      expect(renames()).toEqual(afterRename ? ["rename refused EPERM"] : []);
      expect(time.wait).toHaveBeenCalledTimes(afterRename ? 1 : 0);
      if (afterRename) expectRetryReceipt(receipt.limitations, "EPERM", time.elapsed());
      else expect(retryLines(receipt.limitations)).toEqual([]);
      expectOldCopy(copy);
    },
  );

  it.skipIf(process.platform === "win32")("does not retry a POSIX copy's EPERM", async () => {
    const copy = conversionFixture("darwin");
    faults.refusals = ["EPERM"];
    const time = virtualTime();
    const receipt = await copy.update();
    expect(receipt).toMatchObject({ ok: false, problem: { code: "EPERM" } });
    expect(renames()).toEqual(["rename refused EPERM"]);
    expect(time.wait).not.toHaveBeenCalled();
    expect(retryLines(receipt.limitations)).toEqual([]);
    expectOldCopy(copy);
  });

  it.each([
    "replaced directory",
    "linked directory",
    "changed launcher",
    "changed relation",
    "removed replacement",
    "occupied sibling",
    "existing hidden copy without source",
  ] as const)("preserves paths and counts one rename with a %s", async (change) => {
    const copy = conversionFixture();
    const moved = `${copy.pkg}.moved`;
    const changeDirectory = change === "replaced directory" || change === "linked directory";
    const siblingExists =
      change === "occupied sibling" || change === "existing hidden copy without source";
    const occupySibling = () => {
      mkdirSync(copy.hidden);
      writeFileSync(join(copy.hidden, "occupant"), "kept");
    };
    faults.refusals = ["EPERM"];
    const time = virtualTime(() => {
      if (changeDirectory) {
        renameSync(copy.pkg, moved);
        // A Windows junction needs neither Developer Mode nor symlink privilege.
        if (change === "linked directory") symlinkSync(moved, copy.pkg, "junction");
        else cpSync(moved, copy.pkg, { recursive: true });
      }
      if (change === "changed launcher") {
        const touched = new Date("2000-01-01T00:00:00Z");
        utimesSync(copy.launcher, touched, touched);
      }
      if (change === "changed relation") {
        const manifest = join(copy.pkg, "package.json");
        const before = JSON.parse(readFileSync(manifest, "utf8"));
        writeFileSync(manifest, JSON.stringify({ ...before, name: "@fixture/other" }));
      }
      if (change === "removed replacement") rmSync(copy.installed);
      if (change === "occupied sibling") occupySibling();
      if (change === "existing hidden copy without source") {
        // The shared helper normally recognizes an interrupted hide. A retry
        // after a failed forward rename must not adopt this newly occupied path.
        faults.beforeStat = (path) => {
          if (path !== copy.hidden) return;
          faults.beforeStat = null;
          renameSync(copy.pkg, moved);
          occupySibling();
        };
      }
    });
    const receipt = await copy.update();
    expect(receipt).toMatchObject({
      ok: false,
      problem: {
        code: change === "occupied sibling" ? "maintenance_failed" : "conversion_source_changed",
      },
    });
    expect(renames()).toEqual(["rename refused EPERM"]);
    expect(time.wait).toHaveBeenCalledOnce();
    expectRetryReceipt(receipt.limitations, "EPERM", time.elapsed());
    if (siblingExists) expect(readFileSync(join(copy.hidden, "occupant"), "utf8")).toBe("kept");
    else expect(existsSync(copy.hidden)).toBe(false);
    if (changeDirectory || change === "existing hidden copy without source")
      expect(existsSync(join(moved, "package.json"))).toBe(true);
    if (change !== "existing hidden copy without source")
      expect(lstatSync(copy.pkg).isSymbolicLink()).toBe(change === "linked directory");
    expect(existsSync(copy.launcher)).toBe(true);
  });

  it.each([
    { file: "manifest", afterProof: false },
    { file: "bin", afterProof: false },
    { file: "manifest", afterProof: true },
    { file: "bin", afterProof: true },
  ])(
    "preserves an updated $file at the same path (after proof: $afterProof)",
    async ({ file, afterProof }) => {
      const copy = conversionFixture();
      const path = file === "manifest" ? join(copy.pkg, "package.json") : copy.entry;
      const original = readFileSync(path);
      const updated = Buffer.from(original);
      if (file === "manifest") updated.write("1.1.0", original.indexOf("1.0.0"));
      else updated[updated.length - 1] = 1; // Keep the executable header and length.
      const updateFile = () => {
        writeFileSync(path, updated);
        if (file === "bin") {
          const touched = new Date("2000-01-01T00:00:00Z");
          utimesSync(path, touched, touched);
        }
      };
      faults.refusals = ["EPERM"];
      const time = virtualTime(() => {
        if (!afterProof) updateFile();
        else {
          // The sibling check runs after the retry's reproof but before its rename.
          faults.beforeStat = (path) => {
            if (path !== copy.hidden) return;
            faults.beforeStat = null;
            updateFile();
          };
        }
      });
      const receipt = await copy.update();
      expect(receipt).toMatchObject({
        ok: false,
        problem: {
          code: "conversion_source_changed",
          message:
            file === "manifest"
              ? expect.stringContaining("manifest changed")
              : expect.stringContaining("fixture-harness.exe changed"),
        },
        after: { path: copy.entry, version: "1.0.0" },
      });
      expect(renames()).toEqual(
        afterProof ? ["rename refused EPERM", "rename"] : ["rename refused EPERM"],
      );
      expectRetryReceipt(receipt.limitations, "EPERM", time.elapsed());
      expectNoRetrySpawns();
      expectOldCopy(copy);
      expect(readFileSync(path)).toEqual(updated);
    },
  );

  it("restores the package when a proven entry cannot be read after the hide", async () => {
    const copy = conversionFixture();
    faults.beforeStat = (path) => {
      if (path === join(copy.hidden, "bin/fixture-harness.exe"))
        throw Object.assign(new Error("Fixture hidden entry stat failed"), { code: "EACCES" });
    };
    const receipt = await copy.update();
    expect(receipt).toMatchObject({
      ok: false,
      problem: {
        code: "conversion_source_changed",
        message: expect.stringContaining("could not be reverified"),
      },
      after: { path: copy.entry, version: "1.0.0" },
    });
    expect(renames()).toEqual(["rename"]);
    expectOldCopy(copy);
  });

  it("keeps the launcher and both packages if npm reoccupies the old path after hide", async () => {
    const copy = conversionFixture();
    faults.refusals = ["EPERM"];
    virtualTime(() => {
      faults.beforeStat = (path) => {
        if (path !== join(copy.hidden, "bin/fixture-harness.exe")) return;
        faults.beforeStat = null;
        // An npm update has recreated the package root but not its launcher yet.
        mkdirSync(copy.pkg);
        writeFileSync(join(copy.pkg, "package.json"), "new package");
      };
    });
    const receipt = await copy.update();
    expect(receipt).toMatchObject({
      ok: false,
      problem: {
        code: "conversion_source_changed",
        message: expect.stringContaining("was reoccupied before pruning"),
      },
    });
    expect(renames()).toEqual(["rename refused EPERM", "rename"]);
    expect(readFileSync(join(copy.pkg, "package.json"), "utf8")).toBe("new package");
    expect(existsSync(copy.hidden)).toBe(true);
    expect(existsSync(copy.launcher)).toBe(true);
  });
});
