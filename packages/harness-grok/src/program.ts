import { defineHarnessProgram } from "@claudexor/core";
import type { HarnessProgramPlatform } from "@claudexor/schema";

const posix: HarnessProgramPlatform = {
  launcherDirs: ["{home}/.local/bin", "{home}/.grok/bin"],
  newest: {
    url: "https://x.ai/cli/stable",
    pick: {
      kind: "text",
    },
  },
  update: {
    kind: "exec",
    command: "{program}",
    args: ["update"],
  },
  install: {
    kind: "script",
    url: "https://x.ai/cli/install.sh",
    interpreter: "/bin/bash",
    interpreterArgs: [],
    args: [],
  },
  exactVersion: {
    kind: "exec",
    command: "{program}",
    args: ["update", "--version", "{version}"],
  },
};

/** Vendor distribution contract; fixture stamps never select an install. */
export const GROK_PROGRAM = defineHarnessProgram({
  id: "grok",
  launchers: [
    {
      name: "grok",
    },
  ],
  versionScheme: "semver",
  overrideEnv: "CLAUDEXOR_GROK_BIN",
  installationEnv: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
  childUpdateEnv: {
    GROK_DISABLE_AUTOUPDATER: "1",
  },
  platforms: {
    darwin: posix,
    linux: posix,
    win32: {
      launcherDirs: [
        "{home}/.local/bin",
        "{home}/.grok/bin",
        "{localAppData}/Microsoft/WinGet/Links",
      ],
      newest: {
        url: "https://x.ai/cli/stable",
        pick: {
          kind: "text",
        },
      },
      update: {
        kind: "exec",
        command: "{program}",
        args: ["update"],
      },
      install: {
        kind: "script",
        url: "https://x.ai/cli/install.ps1",
        interpreter: "powershell",
        interpreterArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
        args: [],
      },
      exactVersion: {
        kind: "exec",
        command: "{program}",
        args: ["update", "--version", "{version}"],
      },
    },
  },
});
