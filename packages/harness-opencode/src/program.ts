import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{home}/.local/bin", "{home}/.opencode/bin"],
  newest: {
    url: "https://registry.npmjs.org/opencode-ai/latest",
    pick: {
      kind: "json",
      field: "version",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["upgrade"],
  },
  install: {
    kind: "script",
    url: "https://opencode.ai/install",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
  },
  exactVersion: {
    kind: "exec",
    command: "{program}",
    args: ["upgrade", "{version}"],
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const OPENCODE_PROGRAM = defineHarnessProgram({
  id: "opencode",
  launchers: [
    {
      name: "opencode",
    },
  ],
  versionScheme: "semver",
  overrideEnv: "CLAUDEXOR_OPENCODE_BIN",
  installationEnv: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
  legacyNpmPackage: "opencode-ai",
  majorVersion: 1,
  platforms: {
    darwin: posix,
    linux: posix,
    win32: {
      launcherDirs: [
        "{home}/.local/bin",
        "{home}/.opencode/bin",
        "{localAppData}/Microsoft/WinGet/Links",
      ],
      newest: {
        url: "https://registry.npmjs.org/opencode-ai/latest",
        pick: {
          kind: "json",
          field: "version",
        },
      },
      update: {
        kind: "exec",
        command: "{program}",
        args: ["upgrade"],
      },
      exactVersion: {
        kind: "exec",
        command: "{program}",
        args: ["upgrade", "{version}"],
      },
      reasons: {
        install: "OpenCode 1.x has no supported unattended Windows installer (#668).",
      },
    },
  },
});
