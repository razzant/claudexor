import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{home}/.local/bin"],
  newest: {
    url: "https://registry.npmjs.org/@github/copilot/latest",
    pick: {
      kind: "json",
      field: "version",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["update"],
  },
  install: {
    kind: "script",
    url: "https://gh.io/copilot-install",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
  },
  exactVersion: {
    kind: "script",
    url: "https://gh.io/copilot-install",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
    env: {
      VERSION: "v{version}",
    },
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const COPILOT_PROGRAM = defineHarnessProgram({
  id: "copilot",
  launchers: [
    {
      name: "copilot",
    },
  ],
  versionScheme: "semver",
  overrideEnv: "CLAUDEXOR_COPILOT_BIN",
  installationEnv: [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "COPILOT_HOME",
    "COPILOT_CACHE_HOME",
  ],
  legacyNpmPackage: "@github/copilot",
  childUpdateArgs: ["--no-auto-update"],
  platforms: {
    darwin: posix,
    linux: posix,
    win32: {
      launcherDirs: [
        "{home}/.local/bin",
        "{localAppData}/Microsoft/WinGet/Links",
        "{localAppData}/Microsoft/WindowsApps",
      ],
      newest: {
        url: "https://registry.npmjs.org/@github/copilot/latest",
        pick: {
          kind: "json",
          field: "version",
        },
      },
      update: {
        kind: "exec",
        command: "{program}",
        args: ["update"],
      },
      exactVersion: {
        kind: "exec",
        command: "winget",
        args: [
          "install",
          "--id",
          "GitHub.Copilot",
          "--exact",
          "--version",
          "{version}",
          "--force",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
      },
      install: {
        kind: "exec",
        command: "winget",
        args: [
          "install",
          "--id",
          "GitHub.Copilot",
          "--exact",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
      },
    },
  },
});
