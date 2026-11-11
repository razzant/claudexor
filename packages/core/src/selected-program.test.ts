import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { defineHarnessProgram, programPath } from "./program-registry.js";
import { normalizedHarnessPath } from "./runtime-env.js";
import {
  resolveSelectedProgram,
  resolveSelectedProgramAsync,
  selectProgramLauncher,
} from "./selected-program.js";

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
  it("finds a vendor launcher installed after an earlier resolution without changing PATH", () => {
    const home = root();
    const sourceEnv = { HOME: home, PATH: "" };
    expect(
      resolveSelectedProgram(fixture, { sourceEnv, nodePath: "/absent/node" }).path,
    ).toBeNull();
    const path = join(home, ".vendor/bin/fixture-program");
    executable(path);
    const selected = resolveSelectedProgram(fixture, { sourceEnv, nodePath: "/absent/node" });
    expect(selected).toMatchObject({ path, realPath: path, version: "1.0.0", overrideEnv: null });
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
