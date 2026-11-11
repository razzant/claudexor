import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgram } from "@claudexor/schema";
import type { MaintenanceOptions } from "../harness-maintenance.js";

export const SCRIPT = "#!/bin/sh\n# fixture installer target versions/2.0.0\n";
export function executable(path: string, version = "1.0.0") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}
export function result(stdout = "", status = 0) {
  return {
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
  } as ReturnType<typeof spawnSync>;
}
export function vendorFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "vendor-fixture-")));
  const program: HarnessProgram = defineHarnessProgram({
    id: "fixture",
    overrideEnv: "FIXTURE_BIN",
    launchers: [{ name: "fixture-harness" }],
    installationEnv: [
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ],
    legacyNpmPackage: "@fixture/harness",
    platforms: {
      darwin: {
        launcherDirs: ["{home}/.vendor/bin"],
        update: { kind: "exec", command: "{program}", args: ["update"] },
        install: {
          kind: "script",
          url: "https://example.invalid/install",
          interpreter: "/bin/sh",
          interpreterArgs: [],
          args: [],
        },
        exactVersion: {
          kind: "exec",
          command: "{program}",
          args: ["update", "--version", "{version}"],
        },
        newest: { url: "https://example.invalid/latest", pick: { kind: "text" } },
      },
    },
  });
  const installed = join(home, ".vendor/bin/fixture-harness");
  const options: MaintenanceOptions = {
    home,
    nodePath: "/absent/node",
    platform: "darwin",
    arch: "arm64",
    program,
    sourceEnv: { HOME: home, PATH: "" },
    fetch: async () => new Response(SCRIPT),
  };
  return { home, program, installed, options };
}
